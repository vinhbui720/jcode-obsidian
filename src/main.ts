import { Plugin, Notice, MarkdownView, TFile, type Editor } from "obsidian";
import { ContextBroadcaster, ViewWithEditor } from "./context-broadcaster";
import { DEFAULT_SETTINGS, JcodeSettings, JcodeSettingTab } from "./settings";
import { createTransport, JcodeTransport } from "./jcode-client";
import { findTrigger, runAskJcode } from "./askjcode";
import { TodoAggregator } from "./todo-aggregator";
import { AutoTagger, TagSuggestion } from "./auto-tagger";
import { SpacedRepPicker } from "./spaced-rep";
import { AskJcodeSuggest } from "./askjcode-suggest";

export default class JcodePlugin extends Plugin {
	settings: JcodeSettings = DEFAULT_SETTINGS;
	private broadcaster: ContextBroadcaster | null = null;
	private transport: JcodeTransport | null = null;
	private autoTagger: AutoTagger | null = null;
	private statusBarItem: HTMLElement | null = null;
	private currentRequestActive = false;
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
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) return;
			evt.preventDefault();
			evt.stopPropagation();
			void this.submitAskJcode(view.editor, view);
		};
		document.addEventListener("keydown", askHotkeyHandler, true);
		this.register(() => document.removeEventListener("keydown", askHotkeyHandler, true));

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
				this.settings.resumeSessionId = "";
				await this.saveData(this.settings);
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
		this.rebuildAutoTagger();
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
		if (!findTrigger(editor)) {
			new Notice('jcode: no "/askjcode ..." line at cursor. Type /askjcode then your question.');
			return;
		}
		if (this.currentRequestActive) {
			new Notice("jcode: a request is already in flight. Wait or cancel.");
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

		this.currentRequestActive = true;
		new Notice("jcode: started. Response will be inserted below the /askjcode line.");
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
					notify: (m) => new Notice(m),
					resumeSessionId: this.settings.resumeSessionId || undefined,
					provider: this.settings.provider || undefined,
					saveSessionId: (id) => {
						this.settings.resumeSessionId = id;
						void this.saveData(this.settings);
					},
				}
			);
			if (inserted) new Notice("jcode: done. Inserted response below the trigger line.");
		} finally {
			this.currentRequestActive = false;
		}
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

		const b = this.broadcaster;
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => b.scheduleWrite())
		);
		this.registerEvent(this.app.workspace.on("file-open", () => b.scheduleWrite()));
		this.registerEvent(
			this.app.workspace.on("editor-change", () => b.scheduleWrite())
		);
		this.registerEvent(this.app.vault.on("modify", () => b.scheduleWrite()));
		b.scheduleWrite();
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
