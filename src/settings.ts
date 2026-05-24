import { App, PluginSettingTab, Setting } from "obsidian";
import type JcodePlugin from "./main";
import type { SavedJcodeSession } from "./session-state";

export interface JcodeSettings {
	/** Enable Layer 1: broadcast current-note context to other jcode clients. */
	contextBroadcastEnabled: boolean;

	/** Override default context file path. Empty string = use default. */
	contextFilePath: string;

	/** Maximum characters of selection to include in broadcast. */
	maxSelectionChars: number;

	/** Layer 2: which transport /askjcode uses. */
	transport: "stdio" | "repl" | "websocket";

	/** Path to the jcode CLI binary (used by stdio transport). */
	jcodeBinary: string;

	/** Layer 2 websocket only: pairing host (jcode gateway). */
	pairingHost: string;

	/** Layer 2 websocket only: pairing token issued by `jcode pair`. */
	pairingToken: string;

	/** Provider override (-p flag). Empty = auto. */
	provider: string;

	/** When set, /askjcode resumes this session to keep conversation state. */
	resumeSessionId: string;
	activeSessionLabel: string;
	knownSessions: SavedJcodeSession[];

	/** Hotkey for /askjcode submit. (Display only; actual key bound via command.) */
	askjcodeHotkeyHint: string;

	/** Status bar verbosity for /askjcode streaming. */
	statusBarStreaming: boolean;

	/** B3 — TODO aggregator. */
	todoEnabled: boolean;
	todoOutputPath: string;
	todoIgnoreGlobs: string;
	todoRunOnSave: boolean;

	/** B2 — Auto-tag from title. */
	autoTagEnabled: boolean;
	autoTagMode: "suggest" | "auto";
	autoTagOnCreate: boolean;

	/** B5 — Spaced repetition daily picker. */
	spacedRepEnabled: boolean;
	spacedRepOutputPath: string;
	spacedRepDailyPickCount: number;
	spacedRepDefaultInterval: number;
	spacedRepTagBoost: number;
	spacedRepIgnoreGlobs: string;
}

export const DEFAULT_SETTINGS: JcodeSettings = {
	contextBroadcastEnabled: true,
	contextFilePath: "",
	maxSelectionChars: 12000,
	transport: "stdio",
	jcodeBinary: "jcode",
	pairingHost: "",
	pairingToken: "",
	provider: "",
	resumeSessionId: "",
	activeSessionLabel: "",
	knownSessions: [],
	askjcodeHotkeyHint: "Ctrl+Enter (on a /askjcode line)",
	statusBarStreaming: true,
	todoEnabled: true,
	todoOutputPath: "todo.md",
	todoIgnoreGlobs: "templates/**\n.trash/**\ntodo.md",
	todoRunOnSave: false,
	autoTagEnabled: true,
	autoTagMode: "suggest",
	autoTagOnCreate: false,
	spacedRepEnabled: true,
	spacedRepOutputPath: "today-review.md",
	spacedRepDailyPickCount: 5,
	spacedRepDefaultInterval: 7,
	spacedRepTagBoost: 1.5,
	spacedRepIgnoreGlobs: "templates/**\n.trash/**\ntoday-review.md",
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

		containerEl.createEl("h3", { text: "Layer 2 — /askjcode (transport)" });

		new Setting(containerEl)
			.setName("Transport")
			.setDesc(
				"How /askjcode talks to jcode. 'persisted run' appends turns to the selected jcode session so terminal resume sees them. 'REPL' is live but currently keeps some turns in-process only."
			)
			.addDropdown((dd) =>
				dd
					.addOption("repl", "persistent REPL (recommended)")
					.addOption("stdio", "stdio (spawn jcode CLI)")
					.addOption("websocket", "websocket (gateway pair)")
					.setValue(this.plugin.settings.transport)
					.onChange(async (v) => {
						this.plugin.settings.transport = v as "stdio" | "repl" | "websocket";
						await this.plugin.saveSettings();
						this.plugin.rebuildTransport();
					})
			);

		new Setting(containerEl)
			.setName("jcode binary path")
			.setDesc("Used by stdio transport. Defaults to `jcode` on PATH.")
			.addText((t) =>
				t
					.setPlaceholder("jcode")
					.setValue(this.plugin.settings.jcodeBinary)
					.onChange(async (v) => {
						this.plugin.settings.jcodeBinary = v.trim() || "jcode";
						await this.plugin.saveSettings();
						this.plugin.rebuildTransport();
					})
			);

		new Setting(containerEl)
			.setName("Provider (-p flag)")
			.setDesc(
				"Optional. e.g. claude, openai, copilot. Leave blank to let jcode auto-select."
			)
			.addText((t) =>
				t
					.setPlaceholder("(auto)")
					.setValue(this.plugin.settings.provider)
					.onChange(async (v) => {
						this.plugin.settings.provider = v.trim();
						await this.plugin.saveSettings();
					})
			);

			new Setting(containerEl)
				.setName("Active Obsidian jcode client")
				.setDesc(
					`Live client used by /askjcode while Obsidian is open: ${this.plugin.getActiveClientName()}. Rename only changes the display title, not the underlying jcode session id.`
				)
				.addText((t) =>
					t
						.setPlaceholder("Display title, e.g. Obsidian")
						.setValue(this.plugin.settings.activeSessionLabel)
						.onChange(async (v) => {
							this.plugin.settings.activeSessionLabel = v;
							await this.plugin.saveSettings();
						})
				)
				.addButton((b) =>
					b.setButtonText("Start new client")
						.setTooltip("Clear current resume session and start a fresh Obsidian jcode client")
						.onClick(async () => {
							await this.plugin.startNewSessionFromSettings();
							this.display();
						})
				);

			const savedSessions = this.plugin.listResumeSessions();
			new Setting(containerEl)
				.setName("Resume jcode client")
				.setDesc(
					"Choose any local jcode session to become Obsidian's live /askjcode client. Names are derived from session ids, e.g. session_penguin_... → Penguin."
				)
				.addDropdown((dd) => {
					dd.addOption("__new__", "✨ Start new client");
					for (const session of savedSessions) {
						const suffix = session.id === this.plugin.settings.resumeSessionId ? "  • active" : "";
						dd.addOption(session.id, `${this.plugin.getClientDisplayLabel(session.id, session.label)}${suffix}`);
					}
					dd.setValue(this.plugin.settings.resumeSessionId || "__new__").onChange(async (v) => {
						if (v === "__new__") await this.plugin.startNewSessionFromSettings();
						else await this.plugin.activateSavedSession(v);
						this.display();
					});
				});

			new Setting(containerEl)
				.setName("Resume session id")
				.setDesc(
					"Advanced. The current active jcode session id. Usually you should use the dropdown above instead of editing this directly."
				)
				.addText((t) =>
					t
						.setPlaceholder("(none)")
						.setValue(this.plugin.settings.resumeSessionId)
						.onChange(async (v) => {
							this.plugin.settings.resumeSessionId = v.trim();
							await this.plugin.syncActiveSessionLabelFromResumeId();
							await this.plugin.saveSettings();
							this.plugin.rebuildTransport();
						})
				);

		containerEl.createEl("h4", { text: "WebSocket transport (advanced)" });
		containerEl.createEl("p", {
			text: "Only required if transport=websocket. Run `jcode pair` in a terminal, then paste the host and token here.",
		});

		new Setting(containerEl)
			.setName("Pairing host")
			.setDesc("e.g. ws://127.0.0.1:7643 (issued by `jcode pair`)")
			.addText((t) =>
				t
					.setPlaceholder("ws://127.0.0.1:7643")
					.setValue(this.plugin.settings.pairingHost)
					.onChange(async (v) => {
						this.plugin.settings.pairingHost = v.trim();
						await this.plugin.saveSettings();
						this.plugin.rebuildTransport();
					})
			);

		new Setting(containerEl)
			.setName("Pairing token")
			.setDesc("Token from `jcode pair`. Stored only in this vault's plugin data.")
			.addText((t) =>
				t
					.setPlaceholder("(empty until paired)")
					.setValue(this.plugin.settings.pairingToken)
					.onChange(async (v) => {
						this.plugin.settings.pairingToken = v.trim();
						await this.plugin.saveSettings();
						this.plugin.rebuildTransport();
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

		containerEl.createEl("h3", { text: "Layer 3 — TODO aggregator (no AI)" });
		containerEl.createEl("p", {
			text: "Scans the vault for unchecked `- [ ]` items and notes tagged #notdone, then writes a consolidated TODO note. Runs on save (debounced) and via command palette. Zero LLM cost.",
		});

		new Setting(containerEl)
			.setName("Enable TODO aggregator")
			.setDesc("Turn the whole feature on or off.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.todoEnabled).onChange(async (v) => {
					this.plugin.settings.todoEnabled = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Output note path")
			.setDesc("Where to write the generated TODO. Vault-relative.")
			.addText((t) =>
				t
					.setPlaceholder("todo.md")
					.setValue(this.plugin.settings.todoOutputPath)
					.onChange(async (v) => {
						this.plugin.settings.todoOutputPath = v.trim() || "todo.md";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Ignore globs")
			.setDesc("One glob per line. Matching files are skipped (e.g. templates/**).")
			.addTextArea((t) =>
				t
					.setValue(this.plugin.settings.todoIgnoreGlobs)
					.onChange(async (v) => {
						this.plugin.settings.todoIgnoreGlobs = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Run on save")
			.setDesc("Re-aggregate whenever a note is modified (debounced 2s).")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.todoRunOnSave).onChange(async (v) => {
					this.plugin.settings.todoRunOnSave = v;
					await this.plugin.saveSettings();
				})
			);

		containerEl.createEl("h3", { text: "B2 — Auto-tag from title (low AI cost)" });
		containerEl.createEl("p", {
			text: "When a new note is created, jcode picks 1-3 tags using only the title and the vault's existing tag pool. The note body is NOT sent. Suggest mode notifies you; auto mode writes tags into frontmatter immediately.",
		});

		new Setting(containerEl)
			.setName("Enable auto-tag")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autoTagEnabled).onChange(async (v) => {
					this.plugin.settings.autoTagEnabled = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Mode")
			.setDesc("'suggest' = preview only. 'auto' = apply tags into frontmatter immediately.")
			.addDropdown((d) =>
				d
					.addOption("suggest", "suggest (safe)")
					.addOption("auto", "auto (writes frontmatter)")
					.setValue(this.plugin.settings.autoTagMode)
					.onChange(async (v) => {
						this.plugin.settings.autoTagMode = v as "suggest" | "auto";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Trigger on file create")
			.setDesc("Run automatically whenever a new .md file appears in the vault.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autoTagOnCreate).onChange(async (v) => {
					this.plugin.settings.autoTagOnCreate = v;
					await this.plugin.saveSettings();
				})
			);

		containerEl.createEl("h3", { text: "B5 — Spaced repetition daily picker (no AI)" });
		containerEl.createEl("p", {
			text: "Picks notes to review each day from frontmatter dates and tags, then writes a managed block to a review note. Zero LLM cost.",
		});
		new Setting(containerEl)
			.setName("Enable spaced-rep picker")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.spacedRepEnabled).onChange(async (v) => {
					this.plugin.settings.spacedRepEnabled = v;
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("Output note path")
			.addText((t) =>
				t.setPlaceholder("today-review.md")
					.setValue(this.plugin.settings.spacedRepOutputPath)
					.onChange(async (v) => {
						this.plugin.settings.spacedRepOutputPath = v.trim() || "today-review.md";
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Daily pick count")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.spacedRepDailyPickCount)).onChange(async (v) => {
					const n = Number.parseInt(v, 10);
					if (Number.isFinite(n) && n > 0) {
						this.plugin.settings.spacedRepDailyPickCount = n;
						await this.plugin.saveSettings();
					}
				})
			);
		new Setting(containerEl)
			.setName("Default interval days")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.spacedRepDefaultInterval)).onChange(async (v) => {
					const n = Number.parseInt(v, 10);
					if (Number.isFinite(n) && n > 0) {
						this.plugin.settings.spacedRepDefaultInterval = n;
						await this.plugin.saveSettings();
					}
				})
			);
		new Setting(containerEl)
			.setName("#spaced-rep tag boost")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.spacedRepTagBoost)).onChange(async (v) => {
					const n = Number.parseFloat(v);
					if (Number.isFinite(n) && n > 0) {
						this.plugin.settings.spacedRepTagBoost = n;
						await this.plugin.saveSettings();
					}
				})
			);
		new Setting(containerEl)
			.setName("Ignore globs")
			.setDesc("One glob per line.")
			.addTextArea((t) =>
				t.setValue(this.plugin.settings.spacedRepIgnoreGlobs).onChange(async (v) => {
					this.plugin.settings.spacedRepIgnoreGlobs = v;
					await this.plugin.saveSettings();
				})
			);
	}
}
