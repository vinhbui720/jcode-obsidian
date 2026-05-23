import { Plugin, Notice, MarkdownView, TFile } from "obsidian";
import { ContextBroadcaster, ViewWithEditor } from "./context-broadcaster";
import { DEFAULT_SETTINGS, JcodeSettings, JcodeSettingTab } from "./settings";
import { createTransport, JcodeTransport } from "./jcode-client";
import { runAskJcode } from "./askjcode";
import { TodoAggregator } from "./todo-aggregator";

export default class JcodePlugin extends Plugin {
	settings: JcodeSettings = DEFAULT_SETTINGS;
	private broadcaster: ContextBroadcaster | null = null;
	private transport: JcodeTransport | null = null;
	private statusBarItem: HTMLElement | null = null;
	private currentRequestActive = false;
	private todoTimer: number | null = null;

	async onload() {
		await this.loadSettings();

		this.broadcaster = new ContextBroadcaster(this.app, {
			filePath: this.settings.contextFilePath,
			maxSelectionChars: this.settings.maxSelectionChars,
			viewResolver: () => this.resolveActiveMarkdownView(),
		});

		this.applyContextBroadcastSetting();
		this.rebuildTransport();

		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.setText("");

		this.addSettingTab(new JcodeSettingTab(this.app, this));

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
				if (this.currentRequestActive) {
					new Notice("jcode: a request is already in flight. Wait or cancel.");
					return;
				}
				if (!this.transport) {
					new Notice("jcode: transport not configured.");
					return;
				}
				const file = view instanceof MarkdownView ? view.file : null;
				const adapter = this.app.vault.adapter as unknown as { basePath?: string };
				const vaultRoot = adapter.basePath ?? "";

				const noteText = editor.getValue();

				this.currentRequestActive = true;
				try {
					await runAskJcode(
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
				} finally {
					this.currentRequestActive = false;
				}
			},
			hotkeys: [{ modifiers: ["Mod"], key: "Enter" }],
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

		// Initial aggregation a few seconds after load (let metadataCache warm up).
		if (this.settings.todoEnabled) {
			window.setTimeout(() => void this.runTodoAggregator(false), 3000);
		}

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
}
