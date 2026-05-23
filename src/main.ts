import { Plugin, Notice, MarkdownView } from "obsidian";
import { ContextBroadcaster, ViewWithEditor } from "./context-broadcaster";
import { DEFAULT_SETTINGS, JcodeSettings, JcodeSettingTab } from "./settings";

export default class JcodePlugin extends Plugin {
	settings: JcodeSettings = DEFAULT_SETTINGS;
	private broadcaster: ContextBroadcaster | null = null;

	async onload() {
		await this.loadSettings();

		this.broadcaster = new ContextBroadcaster(this.app, {
			filePath: this.settings.contextFilePath,
			maxSelectionChars: this.settings.maxSelectionChars,
			viewResolver: () => this.resolveActiveMarkdownView(),
		});

		this.applyContextBroadcastSetting();

		this.addSettingTab(new JcodeSettingTab(this.app, this));

		// Manual command for users to verify context broadcast.
		this.addCommand({
			id: "jcode-broadcast-now",
			name: "Broadcast current note to jcode swarm now",
			callback: () => {
				this.broadcaster?.scheduleWrite();
				new Notice(
					"jcode: context broadcast scheduled → " +
						this.broadcaster?.getFilePath()
				);
			},
		});

		// Placeholder commands for upcoming milestones (M2+) — kept here so users
		// can see the roadmap in the command palette. They will gain behavior in
		// later commits.
		this.addCommand({
			id: "jcode-askjcode-submit",
			name: "/askjcode: submit current line (M2 — pending)",
			editorCallback: () => {
				new Notice("jcode: /askjcode coming in M2. Pair the plugin first.");
			},
			hotkeys: [{ modifiers: ["Mod"], key: "Enter" }],
		});

		console.log("[jcode-obsidian] loaded. context file:", this.broadcaster.getFilePath());
	}

	async onunload() {
		try {
			await this.broadcaster?.writeOfflineMarker();
		} catch (err) {
			console.error("[jcode-obsidian] offline marker failed:", err);
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

	/**
	 * Wire / unwire the broadcaster's event listeners based on the toggle.
	 * Re-callable from settings tab.
	 */
	applyContextBroadcastSetting() {
		if (!this.broadcaster) return;
		if (!this.settings.contextBroadcastEnabled) {
			// Don't bother detaching: registerEvent already auto-cleans on unload.
			// Just stop scheduling future writes by writing offline once.
			void this.broadcaster.writeOfflineMarker();
			return;
		}

		const b = this.broadcaster;

		// Active leaf change (switch note).
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => b.scheduleWrite())
		);

		// File open.
		this.registerEvent(this.app.workspace.on("file-open", () => b.scheduleWrite()));

		// Selection / cursor change.
		this.registerEvent(
			this.app.workspace.on("editor-change", () => b.scheduleWrite())
		);

		// File save (metadata may have changed).
		this.registerEvent(this.app.vault.on("modify", () => b.scheduleWrite()));

		// Initial write on plugin load.
		b.scheduleWrite();
	}

	/** Adapt Obsidian's MarkdownView to the duck-typed interface used by the broadcaster. */
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
}
