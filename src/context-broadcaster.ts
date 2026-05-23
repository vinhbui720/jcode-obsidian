import type { App } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Layer 1: broadcast the currently-viewed Obsidian note to a JSON state file
 * so that other jcode clients (panel-tauri, VSCode extension, TUI) can read
 * what the user is looking at.
 *
 * Shape mirrors the existing VSCode extension at
 *   ~/.vscode/extensions/jcode-panel.jcode-panel-context-VERSION/extension.js
 * so jcode server's existing polling logic can read it without changes.
 *
 * Default path: $XDG_STATE_HOME/jcode-panel/contexts/obsidian.json
 *               (falls back to ~/.local/state/jcode-panel/contexts/obsidian.json)
 *
 * Design note: we deliberately do not import `MarkdownView` from `obsidian` at
 * the value level. Tests run outside Obsidian and would fail on the missing
 * module. The caller (main.ts) injects a `viewResolver` that returns a
 * duck-typed `ViewWithEditor | null`.
 */
export interface BroadcastPayload {
	app: "obsidian";
	file: string;
	line: number;
	column: number;
	selection: string;
	languageId: "markdown";
	workspaceRoot: string;
	vaultName: string;
	noteTitle: string;
	tags: string[];
	frontmatter: Record<string, unknown> | null;
	timestamp: string;
}

/** Minimal interface we need from a Markdown view (cursor, selection, file). */
export interface ViewWithEditor {
	file: { path: string; basename: string } | null;
	editor: {
		getCursor(): { line: number; ch: number };
		getSelection(): string;
	};
}

export type ViewResolver = () => ViewWithEditor | null;

export interface BroadcasterOptions {
	filePath: string;
	maxSelectionChars: number;
	viewResolver: ViewResolver;
}

export class ContextBroadcaster {
	private app: App | MinimalApp;
	private filePath: string;
	private maxSelectionChars: number;
	private resolveView: ViewResolver;
	private lastSerialized: string | null = null;
	private writeQueued: NodeJS.Timeout | null = null;

	constructor(app: App | MinimalApp, opts: BroadcasterOptions) {
		this.app = app;
		this.filePath = opts.filePath || ContextBroadcaster.defaultPath();
		this.maxSelectionChars = opts.maxSelectionChars;
		this.resolveView = opts.viewResolver;
	}

	static defaultPath(): string {
		const xdgState = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
		return path.join(xdgState, "jcode-panel", "contexts", "obsidian.json");
	}

	setMaxSelectionChars(n: number) {
		this.maxSelectionChars = n;
	}

	setFilePath(p: string) {
		const next = p || ContextBroadcaster.defaultPath();
		if (next !== this.filePath) {
			this.filePath = next;
			this.lastSerialized = null;
		}
	}

	/** Public entry point. Debounces rapid changes. */
	scheduleWrite() {
		if (this.writeQueued) clearTimeout(this.writeQueued);
		this.writeQueued = setTimeout(() => {
			this.writeQueued = null;
			void this.writeNow();
		}, 150);
	}

	private async writeNow() {
		const payload = this.buildPayload();
		if (!payload) {
			const empty = {
				app: "obsidian",
				file: "",
				selection: "",
				vaultName: this.vaultName(),
				timestamp: new Date().toISOString(),
			};
			await this.atomicWrite(JSON.stringify(empty, null, 2));
			return;
		}
		// Dedup on everything *except* timestamp; timestamp would otherwise force
		// a rewrite every call.
		const { timestamp: _ts, ...dedupKey } = payload;
		const serialized = JSON.stringify(dedupKey);
		if (serialized === this.lastSerialized) return;
		this.lastSerialized = serialized;
		await this.atomicWrite(JSON.stringify(payload, null, 2));
	}

	private buildPayload(): BroadcastPayload | null {
		const view = this.resolveView();
		if (!view || !view.file) return null;
		const file = view.file;

		const cursor = view.editor.getCursor();
		const selection = view.editor.getSelection().slice(0, this.maxSelectionChars);

		const adapter = (this.app.vault as unknown as { adapter?: { basePath?: string } }).adapter;
		const workspaceRoot = adapter?.basePath ?? "";

		const cache = this.metadataCacheFor(file.path);
		const tags: string[] = [];
		if (cache?.tags) for (const t of cache.tags) if (t?.tag) tags.push(t.tag);
		if (cache?.frontmatter?.tags) {
			const fmTags = cache.frontmatter.tags;
			if (Array.isArray(fmTags)) for (const t of fmTags) tags.push(`#${t}`);
			else if (typeof fmTags === "string") tags.push(`#${fmTags}`);
		}

		return {
			app: "obsidian",
			file: workspaceRoot ? path.join(workspaceRoot, file.path) : file.path,
			line: cursor.line + 1,
			column: cursor.ch + 1,
			selection,
			languageId: "markdown",
			workspaceRoot,
			vaultName: this.vaultName(),
			noteTitle: file.basename,
			tags,
			frontmatter: (cache?.frontmatter as Record<string, unknown> | undefined) ?? null,
			timestamp: new Date().toISOString(),
		};
	}

	private vaultName(): string {
		const v = (this.app as unknown as { vault?: { getName?: () => string } }).vault;
		return v?.getName?.() ?? "";
	}

	private metadataCacheFor(p: string): CacheEntry | undefined {
		const mc = (this.app as unknown as { metadataCache?: { getFileCache?: (f: unknown) => CacheEntry | undefined } }).metadataCache;
		if (!mc?.getFileCache) return undefined;
		return mc.getFileCache({ path: p });
	}

	private async atomicWrite(contents: string) {
		try {
			await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
			const tmp = `${this.filePath}.tmp-${process.pid}`;
			await fs.promises.writeFile(tmp, contents, "utf8");
			await fs.promises.rename(tmp, this.filePath);
		} catch (err) {
			console.error("[jcode-obsidian] context broadcast write failed:", err);
		}
	}

	async writeOfflineMarker() {
		const empty = {
			app: "obsidian",
			file: "",
			selection: "",
			vaultName: this.vaultName(),
			online: false,
			timestamp: new Date().toISOString(),
		};
		await this.atomicWrite(JSON.stringify(empty, null, 2));
	}

	getFilePath() {
		return this.filePath;
	}
}

/** Tests only: a minimal App-like shape. */
export interface MinimalApp {
	vault: { getName: () => string; adapter?: { basePath?: string } };
	metadataCache?: {
		getFileCache: (f: unknown) => CacheEntry | undefined;
	};
}

interface CacheEntry {
	tags?: Array<{ tag: string }>;
	frontmatter?: Record<string, unknown>;
}

export const defaultContextPath = ContextBroadcaster.defaultPath;
