import { Plugin, Notice, MarkdownView, TFile, type Editor } from "obsidian";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ContextBroadcaster, ViewWithEditor } from "./context-broadcaster";
import { DEFAULT_SETTINGS, JcodeSettings, JcodeSettingTab } from "./settings";
import { createTransport, JcodeTransport } from "./jcode-client";
import { findTrigger, runAskJcode } from "./askjcode";
import { TodoAggregator } from "./todo-aggregator";
import { AutoTagger, TagSuggestion } from "./auto-tagger";
import { SpacedRepPicker } from "./spaced-rep";
import { AskJcodeSuggest } from "./askjcode-suggest";
import {
	deriveInitialSessionLabel,
	findSavedSessionLabel,
	normalizeSessionLabel,
	upsertSavedSession,
} from "./session-state";

export default class JcodePlugin extends Plugin {
	settings: JcodeSettings = DEFAULT_SETTINGS;
	private broadcaster: ContextBroadcaster | null = null;
	private transport: JcodeTransport | null = null;
	private autoTagger: AutoTagger | null = null;
	private statusBarItem: HTMLElement | null = null;
	private currentRequestActive = false;
	private lastAskSubmitAt = 0;
	private todoTimer: number | null = null;
	private lastSuggestion: TagSuggestion | null = null;

	async onload() {
		await this.loadSettings();

		this.broadcaster = new ContextBroadcaster(this.app, {
			filePath: this.settings.contextFilePath,
			maxSelectionChars: this.settings.maxSelectionChars,
			viewResolver: () => this.resolveActiveMarkdownView(),
		});

		this.applyContextBroadcastSetting();
			this.rebuildTransport();
			this.rebuildAutoTagger();
			this.registerContextBroadcastEvents();

			this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.setText("");

		this.addSettingTab(new JcodeSettingTab(this.app, this));
		this.registerEditorSuggest(new AskJcodeSuggest(this.app));

		// Layer-1: manual broadcast trigger.
		this.addCommand({
			id: "jcode-broadcast-now",
			name: "Broadcast current note to jcode swarm now",
			callback: () => {
				this.broadcaster?.scheduleWrite();
				new Notice(
					"jcode: context broadcast → " + this.broadcaster?.getFilePath()
				);
			},
		});

		// Layer-2: /askjcode submit (Ctrl/Cmd+Enter on a /askjcode line).
		this.addCommand({
			id: "jcode-askjcode-submit",
			name: "/askjcode: submit current line",
			editorCallback: async (editor, view) => {
				const markdownView = view instanceof MarkdownView
					? view
					: this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!markdownView) {
					new Notice("jcode: no active Markdown editor.");
					return;
				}
				await this.submitAskJcode(editor, markdownView);
			},
			hotkeys: [{ modifiers: ["Mod"], key: "Enter" }],
		});

		// Some Obsidian/Linux setups do not dispatch plugin command hotkeys for
		// Ctrl+Enter while the CodeMirror editor owns focus. CodeMirror may also
		// stop propagation before Obsidian's command layer sees the event, so this
		// fallback MUST listen in capture phase. `registerDomEvent` only listens in
		// bubble phase, so we wire and unregister manually.
		const askHotkeyHandler = (evt: KeyboardEvent) => {
			if (evt.key !== "Enter") return;
			if (!(evt.ctrlKey || evt.metaKey)) return;
			if (evt.shiftKey || evt.altKey) return;
			if (evt.repeat) return;
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) return;
			evt.preventDefault();
			evt.stopPropagation();
			evt.stopImmediatePropagation();
			void this.submitAskJcode(view.editor, view);
		};
		window.addEventListener("keydown", askHotkeyHandler, true);
		document.addEventListener("keydown", askHotkeyHandler, true);
		this.register(() => {
			window.removeEventListener("keydown", askHotkeyHandler, true);
			document.removeEventListener("keydown", askHotkeyHandler, true);
		});

		// Layer-2: cancel in-flight request.
		this.addCommand({
			id: "jcode-cancel",
			name: "/askjcode: cancel in-flight request",
			callback: () => {
				this.transport?.cancel();
				this.statusBarItem?.setText("jcode: cancelled");
				setTimeout(() => this.statusBarItem?.setText(""), 2000);
			},
		});

		// Layer-2: clear resume session (start fresh next /askjcode).
		this.addCommand({
			id: "jcode-clear-session",
			name: "/askjcode: clear resume session id",
			callback: async () => {
				await this.startNewSessionFromSettings();
				new Notice("jcode: session cleared. Next /askjcode starts fresh.");
			},
		});

		// Layer-3: TODO aggregator manual run.
		this.addCommand({
			id: "jcode-todo-rebuild",
			name: "TODO aggregator: rebuild now",
			callback: () => void this.runTodoAggregator(true),
		});

		// Layer-3: TODO aggregator on save (debounced).
		this.registerEvent(
			this.app.vault.on("modify", (f) => {
				if (!this.settings.todoEnabled) return;
				if (!this.settings.todoRunOnSave) return;
				if (!(f instanceof TFile) || f.extension !== "md") return;
				if (f.path === this.settings.todoOutputPath) return; // avoid loop
				this.scheduleTodoRebuild();
			})
		);

		// Do not scan the whole vault on plugin load. TODO aggregation is manual
		// or save-triggered only, because large vaults should not be touched just
		// because the plugin loaded.

		// B5: spaced-repetition daily picker.
		this.addCommand({
			id: "jcode-spaced-rep-rebuild",
			name: "Spaced-rep: rebuild today's picks now",
			callback: () => void this.runSpacedRep(true),
		});
		this.addCommand({
			id: "jcode-spaced-rep-mark-reviewed",
			name: "Spaced-rep: mark current note as reviewed today",
			editorCallback: async (_editor, view) => {
				const file = view instanceof MarkdownView ? view.file : null;
				if (!file) return;
				await this.markSpacedRepReviewed(file);
			},
		});
		// Do not scan the whole vault on plugin load. Spaced-rep runs only through
		// the manual command or after marking a note as reviewed.

		// B2 auto-tag: command palette entries.
		this.addCommand({
			id: "jcode-autotag-current",
			name: "Auto-tag: suggest tags for current note",
			editorCallback: async (_e, view) => {
				const file = view instanceof MarkdownView ? view.file : null;
				if (!file) return;
				await this.suggestTagsFor(file, true);
			},
		});

		this.addCommand({
			id: "jcode-autotag-apply-last",
			name: "Auto-tag: apply last suggestion",
			callback: async () => {
				if (!this.lastSuggestion || !this.autoTagger) {
					new Notice("jcode auto-tag: no pending suggestion.");
					return;
				}
				try {
					await this.autoTagger.apply(this.lastSuggestion);
					new Notice(
						`jcode auto-tag: applied [${this.lastSuggestion.tags.join(", ")}]`
					);
					this.lastSuggestion = null;
				} catch (err) {
					new Notice(
						`jcode auto-tag: apply failed - ${err instanceof Error ? err.message : String(err)}`
					);
				}
			},
		});

		// B2 auto-tag: trigger on new file.
		this.registerEvent(
			this.app.vault.on("create", (f) => {
				if (!this.settings.autoTagEnabled) return;
				if (!this.settings.autoTagOnCreate) return;
				if (!(f instanceof TFile) || f.extension !== "md") return;
				// Wait a moment so the user has time to give the file a real title
				// and so metadataCache has indexed it.
				window.setTimeout(() => {
					if (!(f instanceof TFile)) return;
					void this.suggestTagsFor(f, false);
				}, 8000);
			})
		);

			void this.runSpacedRepOncePerDay();

			console.log("[jcode-obsidian] loaded. context file:", this.broadcaster.getFilePath());
	}

	async onunload() {
		try {
			this.transport?.cancel();
			await this.broadcaster?.writeOfflineMarker();
		} catch (err) {
			console.error("[jcode-obsidian] onunload error:", err);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if (!Array.isArray(this.settings.knownSessions)) this.settings.knownSessions = [];
		const resumeId = this.settings.resumeSessionId?.trim() ?? "";
		if (resumeId) this.settings.activeSessionLabel = this.sessionDisplayName(resumeId) || normalizeSessionLabel(this.settings.activeSessionLabel || "");
		const activeLabel = normalizeSessionLabel(this.settings.activeSessionLabel || "");
		if (resumeId && activeLabel && !this.settings.knownSessions.some((s) => s.id === resumeId)) {
			this.settings.knownSessions = upsertSavedSession(this.settings.knownSessions, {
				id: resumeId,
				label: activeLabel,
				lastUsedAt: new Date().toISOString(),
			});
			await this.saveData(this.settings);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
		if (this.broadcaster) {
			this.broadcaster.setFilePath(this.settings.contextFilePath);
			this.broadcaster.setMaxSelectionChars(this.settings.maxSelectionChars);
		}
	}

	rebuildTransport() {
		this.transport?.cancel();
		this.transport = createTransport({
			kind: this.settings.transport,
			jcodeBinary: this.settings.jcodeBinary || "jcode",
			host: this.settings.pairingHost,
			token: this.settings.pairingToken,
		});
		this.warmPersistentClient();
		this.rebuildAutoTagger();
	}

	private warmPersistentClient() {
		if (!this.transport?.start || this.settings.transport !== "repl") return;
		const adapter = this.app.vault.adapter as unknown as { basePath?: string };
		this.transport.start(
			{
				cwd: adapter.basePath ?? undefined,
				provider: this.settings.provider || undefined,
				resumeSessionId: this.settings.resumeSessionId || undefined,
			},
				(e) => {
					if (e.type === "status") this.statusBarItem?.setText(`jcode: ${e.detail}`);
					if (e.type === "start" && e.sessionId) {
						void this.recordActiveSession(e.sessionId, this.getActiveSessionLabel());
					}
				}
			);
	}

	getActiveClientName() {
		return this.settings.resumeSessionId ? this.getClientDisplayLabel(this.settings.resumeSessionId, this.settings.activeSessionLabel) : "✨ New jcode client";
	}

	listResumeSessions() {
		const byId = new Map<string, { id: string; label: string; lastUsedAt: string }>();
		for (const session of this.settings.knownSessions) {
			if (session.id?.trim()) byId.set(session.id.trim(), { ...session, label: session.label || this.sessionDisplayName(session.id) });
		}
		for (const session of this.discoverJcodeSessions()) {
			if (!byId.has(session.id)) byId.set(session.id, session);
		}
		return [...byId.values()].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)).slice(0, 80);
	}

	private discoverJcodeSessions() {
		const dir = path.join(os.homedir(), ".jcode", "sessions");
		try {
			return fs.readdirSync(dir)
				.filter((name) => name.endsWith(".json"))
				.map((name) => {
					const file = path.join(dir, name);
					try {
						const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { id?: string; title?: string | null; short_name?: string; updated_at?: string; last_active_at?: string; created_at?: string };
						const id = raw.id || name.replace(/\.json$/, "");
						return {
							id,
							label: normalizeSessionLabel(raw.title || raw.short_name || this.sessionDisplayName(id) || id),
							lastUsedAt: raw.updated_at || raw.last_active_at || raw.created_at || "",
						};
					} catch {
						const id = name.replace(/\.json$/, "");
						return { id, label: this.sessionDisplayName(id) || id, lastUsedAt: "" };
					}
				});
		} catch {
			return [];
		}
	}

	getClientDisplayLabel(sessionId: string, label?: string) {
		const name = this.sessionDisplayName(sessionId) || normalizeSessionLabel(label || "") || sessionId;
		return `${this.sessionIcon(name)} ${name}`;
	}

	private sessionIcon(name: string) {
		const key = name.toLowerCase();
		const icons: Record<string, string> = {
			ant: "🐜", bear: "🐻", beaver: "🦫", bee: "🐝", beetle: "🪲", bison: "🦬", buffalo: "🐃",
			camel: "🐫", cat: "🐱", chicken: "🐔", cow: "🐄", crab: "🦀", cricket: "🦗", crocodile: "🐊",
			deer: "🦌", dodo: "🦤", dove: "🕊️", duck: "🦆", eagle: "🦅", elephant: "🐘", falcon: "🦅",
			fish: "🐟", frog: "🐸", giraffe: "🦒", goat: "🐐", goose: "🪿", hamster: "🐹", hawk: "🦅",
			hedgehog: "🦔", hippo: "🦛", horse: "🐴", jaguar: "🐆", jellyfish: "🪼", kangaroo: "🦘",
			koala: "🐨", ladybug: "🐞", lion: "🦁", llama: "🦙", lobster: "🦞", mosquito: "🦟", moth: "🦋",
			octopus: "🐙", ox: "🐂", parrot: "🦜", peacock: "🦚", penguin: "🐧", pig: "🐷", "polar-bear": "🐻‍❄️",
			ram: "🐏", rat: "🐀", scorpion: "🦂", shark: "🦈", sheep: "🐑", shrimp: "🦐", snake: "🐍",
			spider: "🕷️", squid: "🦑", swan: "🦢", tiger: "🐯", turkey: "🦃", turtle: "🐢", unicorn: "🦄",
			wolf: "🐺", worm: "🪱",
		};
		return icons[key] || "🤖";
	}

	private sessionDisplayName(sessionId: string) {
		const match = /^session_([^_]+)_/.exec(sessionId.trim());
		if (!match) return "";
		return match[1].split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("-");
	}

	getActiveSessionLabel() {
		return normalizeSessionLabel(this.settings.activeSessionLabel || "");
	}

	async syncActiveSessionLabelFromResumeId() {
		const id = this.settings.resumeSessionId.trim();
		if (!id) return;
		const saved = findSavedSessionLabel(this.settings.knownSessions, id);
		if (saved) this.settings.activeSessionLabel = this.sessionDisplayName(id) || saved;
	}

	async activateSavedSession(sessionId: string) {
		const id = sessionId.trim();
		if (!id) return;
		const saved = this.settings.knownSessions.find((s) => s.id === id);
		this.settings.resumeSessionId = id;
		this.settings.activeSessionLabel = this.sessionDisplayName(id) || saved?.label || id;
		await this.saveSettings();
		this.transport?.setSessionId?.(id);
		this.rebuildTransport();
	}

	async startNewSessionFromSettings() {
		this.settings.resumeSessionId = "";
		this.settings.activeSessionLabel = normalizeSessionLabel(this.settings.activeSessionLabel || "");
		await this.saveSettings();
		this.rebuildTransport();
	}

	private async recordActiveSession(sessionId: string, label: string) {
		const cleanId = sessionId.trim();
		const cleanLabel = this.sessionDisplayName(cleanId) || normalizeSessionLabel(label);
		if (!cleanId || !cleanLabel) return;
		this.settings.resumeSessionId = cleanId;
		this.settings.activeSessionLabel = cleanLabel;
		this.settings.knownSessions = upsertSavedSession(this.settings.knownSessions, {
			id: cleanId,
			label: cleanLabel,
			lastUsedAt: new Date().toISOString(),
		});
		this.transport?.setSessionId?.(cleanId);
		await this.saveSettings();
	}

	rebuildAutoTagger() {
		if (!this.transport) {
			this.autoTagger = null;
			return;
		}
		this.autoTagger = new AutoTagger(
			{
				app: this.app,
				transport: this.transport,
				notify: (m) => new Notice(m),
			},
			{ mode: this.settings.autoTagMode, provider: this.settings.provider || undefined }
		);
	}

	private async submitAskJcode(editor: Editor, view: MarkdownView) {
		const now = Date.now();
		if (now - this.lastAskSubmitAt < 1000) return;
		this.lastAskSubmitAt = now;

		if (!findTrigger(editor)) {
			if (await this.maybeAutoTagEmptyNote(editor, view)) return;
			new Notice('jcode: no "/askjcode ..." line at cursor. Type /askjcode then your question.');
			return;
		}
		if (this.currentRequestActive) {
			// If another real request is running, update the status bar but avoid
			// toast spam from key repeats or command+DOM double dispatch.
			this.statusBarItem?.setText("jcode: request already running");
			return;
		}
		if (!this.transport) {
			new Notice("jcode: transport not configured.");
			return;
		}

		const file = view.file;
		const adapter = this.app.vault.adapter as unknown as { basePath?: string };
		const vaultRoot = adapter.basePath ?? "";
		const noteText = editor.getValue();
		const activeLabel =
			normalizeSessionLabel(this.settings.activeSessionLabel || "") ||
			deriveInitialSessionLabel(this.findCurrentHeading(editor), file?.basename ?? null);
		if (!normalizeSessionLabel(this.settings.activeSessionLabel || "")) {
			this.settings.activeSessionLabel = activeLabel;
			await this.saveSettings();
		}

		this.currentRequestActive = true;
		try {
			const inserted = await runAskJcode(
				{
					editor,
					noteText,
					notePath: file?.path ?? null,
					vaultRoot,
				},
				{
					transport: this.transport,
					statusBar: {
						setText: (s) => this.statusBarItem?.setText(s),
						clear: () => this.statusBarItem?.setText(""),
					},
					statusBarStreaming: this.settings.statusBarStreaming,
					displayTitle: activeLabel,
					notify: (m) => new Notice(m),
					resumeSessionId: this.settings.resumeSessionId || undefined,
					provider: this.settings.provider || undefined,
					saveSessionId: (id) => void this.recordActiveSession(id, activeLabel),
				}
			);
			if (inserted) new Notice("jcode: done. Inserted response below the trigger line.");
		} finally {
			this.currentRequestActive = false;
		}
	}

	private async maybeAutoTagEmptyNote(editor: Editor, view: MarkdownView): Promise<boolean> {
		const file = view.file;
		if (!file || file.extension !== "md") return false;
		if (!this.settings.autoTagEnabled) return false;
		if (editor.getValue().trim() !== "") return false;
		new Notice("jcode auto-tag: empty note detected, suggesting tags from title only.");
		await this.suggestTagsFor(file, true);
		return true;
	}

	private async suggestTagsFor(f: TFile, manual: boolean) {
		if (!this.autoTagger) return;
		if (!this.settings.autoTagEnabled) {
			if (manual) new Notice("jcode auto-tag is disabled in settings.");
			return;
		}
		this.autoTagger.setOptions({ mode: this.settings.autoTagMode });
		const s = await this.autoTagger.handleNewFile(f);
		if (s) this.lastSuggestion = s;
	}

	applyContextBroadcastSetting() {
		if (!this.broadcaster) return;
		if (!this.settings.contextBroadcastEnabled) {
			void this.broadcaster.writeOfflineMarker();
			return;
		}
		this.broadcaster.scheduleWrite();
	}

	private registerContextBroadcastEvents() {
		const scheduleIfEnabled = () => {
			if (!this.settings.contextBroadcastEnabled) return;
			this.broadcaster?.scheduleWrite();
		};
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", scheduleIfEnabled)
		);
		this.registerEvent(this.app.workspace.on("file-open", scheduleIfEnabled));
		this.registerEvent(this.app.workspace.on("editor-change", scheduleIfEnabled));
		this.registerEvent(this.app.vault.on("modify", scheduleIfEnabled));
	}

	private resolveActiveMarkdownView(): ViewWithEditor | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return null;
		return {
			file: view.file ? { path: view.file.path, basename: view.file.basename } : null,
			editor: {
				getCursor: () => view.editor.getCursor(),
				getSelection: () => view.editor.getSelection(),
			},
		};
	}

	private findCurrentHeading(editor: Editor): string | null {
		const line = editor.getCursor().line;
		for (let i = line; i >= 0; i--) {
			const raw = editor.getLine(i);
			const m = /^(#{1,6})\s+(.+?)\s*$/.exec(raw);
			if (m) return m[2].replace(/#+\s*$/, "").trim() || null;
		}
		return null;
	}

	private scheduleTodoRebuild() {
		if (this.todoTimer !== null) window.clearTimeout(this.todoTimer);
		this.todoTimer = window.setTimeout(() => {
			this.todoTimer = null;
			void this.runTodoAggregator(false);
		}, 2000);
	}

	private async runTodoAggregator(announce: boolean) {
		if (!this.settings.todoEnabled) return;
		try {
			const agg = new TodoAggregator(this.app, {
				outputPath: this.settings.todoOutputPath,
				ignore: this.settings.todoIgnoreGlobs
					.split("\n")
					.map((s) => s.trim())
					.filter(Boolean),
			});
			const res = await agg.run();
			if (announce) {
				new Notice(
					`jcode: TODO updated → ${res.outputPath} (${res.tasks.length} tasks, ${res.notes.length} notes)`
				);
			}
		} catch (err) {
			console.error("[jcode-obsidian] todo aggregator failed:", err);
			if (announce) new Notice("jcode: TODO aggregator failed (see console)");
		}
	}

	private makeSpacedRepPicker() {
		return new SpacedRepPicker({
			app: this.app,
			getSettings: () => ({
				outputPath: this.settings.spacedRepOutputPath,
				ignore: this.settings.spacedRepIgnoreGlobs
					.split("\n")
					.map((s) => s.trim())
					.filter(Boolean),
				dailyPickCount: this.settings.spacedRepDailyPickCount,
				defaultIntervalDays: this.settings.spacedRepDefaultInterval,
				tagBoost: this.settings.spacedRepTagBoost,
			}),
			notify: (m) => new Notice(m),
		});
	}

	private async runSpacedRep(announce: boolean) {
		if (!this.settings.spacedRepEnabled) return;
		try {
			const res = await this.makeSpacedRepPicker().rebuild();
			if (announce) {
				new Notice(
					`jcode: spaced-rep updated → ${res.outputPath} (${res.picks.length} picks)`
				);
			}
		} catch (err) {
			console.error("[jcode-obsidian] spaced-rep failed:", err);
			if (announce) new Notice("jcode: spaced-rep failed (see console)");
		}
	}

	private async runSpacedRepOncePerDay() {
		const today = new Date().toISOString().slice(0, 10);
		const data = (await this.loadData()) as JcodeSettings & { lastSpacedRepRunDate?: string };
		if (data?.lastSpacedRepRunDate === today) return;
		await this.runSpacedRep(false);
		this.settings = { ...this.settings, lastSpacedRepRunDate: today } as JcodeSettings & { lastSpacedRepRunDate: string };
		await this.saveData(this.settings);
	}

	private async markSpacedRepReviewed(file: TFile) {
		if (!this.settings.spacedRepEnabled) {
			new Notice("jcode spaced-rep is disabled in settings.");
			return;
		}
		try {
			await this.makeSpacedRepPicker().markReviewed(file);
			new Notice(`jcode: marked reviewed → ${file.basename}`);
		} catch (err) {
			console.error("[jcode-obsidian] mark reviewed failed:", err);
			new Notice("jcode: mark reviewed failed (see console)");
		}
	}
}
