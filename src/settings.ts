import { App, PluginSettingTab, Setting } from "obsidian";
import type JcodePlugin from "./main";

export interface JcodeSettings {
	/** Enable Layer 1: broadcast current-note context to other jcode clients. */
	contextBroadcastEnabled: boolean;

	/** Override default context file path. Empty string = use default. */
	contextFilePath: string;

	/** Maximum characters of selection to include in broadcast. */
	maxSelectionChars: number;

	/** Layer 2: pairing host (jcode server). Empty until paired. */
	pairingHost: string;

	/** Layer 2: pairing token issued by `jcode pair`. */
	pairingToken: string;

	/** Hotkey for /askjcode submit. (Display only; actual key bound via command.) */
	askjcodeHotkeyHint: string;

	/** Status bar verbosity for /askjcode streaming. */
	statusBarStreaming: boolean;
}

export const DEFAULT_SETTINGS: JcodeSettings = {
	contextBroadcastEnabled: true,
	contextFilePath: "",
	maxSelectionChars: 12000,
	pairingHost: "",
	pairingToken: "",
	askjcodeHotkeyHint: "Ctrl+Enter (on a /askjcode line)",
	statusBarStreaming: true,
};

export class JcodeSettingTab extends PluginSettingTab {
	plugin: JcodePlugin;

	constructor(app: App, plugin: JcodePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "jcode" });
		containerEl.createEl("p", {
			text: "Join the jcode swarm from Obsidian. See docs/PLAN.md in the plugin repo for details.",
		});

		containerEl.createEl("h3", { text: "Layer 1 — Context broadcast" });

		new Setting(containerEl)
			.setName("Enable context broadcast")
			.setDesc(
				"Write the current note's path and selection to a state file so other jcode clients (TUI, panel, VSCode) know what you are looking at."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.contextBroadcastEnabled).onChange(async (v) => {
					this.plugin.settings.contextBroadcastEnabled = v;
					await this.plugin.saveSettings();
					this.plugin.applyContextBroadcastSetting();
				})
			);

		new Setting(containerEl)
			.setName("Context file path")
			.setDesc(
				"Override path to the context JSON file. Leave blank to use the default: $XDG_STATE_HOME/jcode-panel/contexts/obsidian.json"
			)
			.addText((t) =>
				t
					.setPlaceholder("(default)")
					.setValue(this.plugin.settings.contextFilePath)
					.onChange(async (v) => {
						this.plugin.settings.contextFilePath = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max selection chars")
			.setDesc("Truncate broadcast selection to avoid huge state writes.")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.maxSelectionChars)).onChange(async (v) => {
					const n = Number.parseInt(v, 10);
					if (Number.isFinite(n) && n > 0) {
						this.plugin.settings.maxSelectionChars = n;
						await this.plugin.saveSettings();
					}
				})
			);

		containerEl.createEl("h3", { text: "Layer 2 — Pairing (WebSocket)" });
		containerEl.createEl("p", {
			text: "Run `jcode pair` in a terminal, then paste the host and token here. Pairing enables /askjcode.",
		});

		new Setting(containerEl)
			.setName("Pairing host")
			.setDesc("e.g. ws://127.0.0.1:7878 or wss://... (issued by `jcode pair`)")
			.addText((t) =>
				t
					.setPlaceholder("ws://127.0.0.1:7878")
					.setValue(this.plugin.settings.pairingHost)
					.onChange(async (v) => {
						this.plugin.settings.pairingHost = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Pairing token")
			.setDesc("Token from `jcode pair`. Kept in local Obsidian data only.")
			.addText((t) =>
				t
					.setPlaceholder("(empty until paired)")
					.setValue(this.plugin.settings.pairingToken)
					.onChange(async (v) => {
						this.plugin.settings.pairingToken = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Stream progress in status bar")
			.setDesc("Show /askjcode token-by-token progress in the Obsidian status bar.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.statusBarStreaming).onChange(async (v) => {
					this.plugin.settings.statusBarStreaming = v;
					await this.plugin.saveSettings();
				})
			);
	}
}
