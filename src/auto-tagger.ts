/**
 * B2 — Auto-tag from title (low LLM cost).
 *
 * For a newly created note, we ask jcode to pick 1-3 tags. To keep the prompt
 * tiny we send only:
 *   - the note title (filename without extension)
 *   - the set of tags that already exist anywhere in the vault
 *
 * We do NOT send the note body. This keeps cost predictable (typically a few
 * hundred input tokens regardless of vault size, because we deduplicate tags
 * and cap the pool at MAX_POOL).
 *
 * Output contract: the model returns strict JSON of the form
 *   {"tags":["foo","bar"]}
 * Plain words, no '#' prefix. We then patch the file's YAML frontmatter
 * (creating it if missing) using Obsidian's processFrontMatter API.
 *
 * Modes:
 *   - "suggest": surface a Notice with the proposed tags and a command to
 *     accept; never modifies the file automatically.
 *   - "auto":    apply tags immediately. Use with care.
 */
import type { App, TFile } from "obsidian";
import { JcodeTransport, AskOptions, JcodeEvent } from "./jcode-client";

const MAX_POOL = 80;
const MAX_TAGS = 3;

export interface AutoTaggerOptions {
	mode: "suggest" | "auto";
	provider?: string;
}

export interface AutoTaggerDeps {
	app: App;
	transport: JcodeTransport;
	notify?: (msg: string) => void;
}

export interface TagSuggestion {
	file: TFile;
	tags: string[];
	novel: string[];
	reusedFromPool: string[];
}

export class AutoTagger {
	constructor(private deps: AutoTaggerDeps, private opts: AutoTaggerOptions) {}

	setOptions(o: Partial<AutoTaggerOptions>) {
		this.opts = { ...this.opts, ...o };
	}

	/** Decide whether this file should be auto-tagged (no body sent yet). */
	shouldProcess(f: TFile): boolean {
		if (f.extension !== "md") return false;
		const cache = this.deps.app.metadataCache.getFileCache(f);
		const fm = cache?.frontmatter ?? null;
		if (fm && (fm.tags || fm["jcode-autotag"] === "skip")) return false;
		return true;
	}

	collectTagPool(): string[] {
		const seen = new Set<string>();
		const files = this.deps.app.vault.getMarkdownFiles();
		for (const f of files) {
			const cache = this.deps.app.metadataCache.getFileCache(f);
			if (!cache) continue;
			if (cache.tags) {
				for (const t of cache.tags) {
					if (t?.tag) seen.add(stripHash(t.tag));
				}
			}
			const fmTags = cache.frontmatter?.tags;
			if (Array.isArray(fmTags)) {
				for (const t of fmTags) seen.add(stripHash(String(t)));
			} else if (typeof fmTags === "string") {
				seen.add(stripHash(fmTags));
			}
		}
		// Stable order: most-common-first is ideal but we'd need a second pass.
		// Lexical is good enough for the LLM and keeps the prompt deterministic.
		const arr = Array.from(seen).sort();
		return arr.slice(0, MAX_POOL);
	}

	buildPrompt(title: string, pool: string[]): string {
		return [
			"You assign tags to Obsidian notes. Respond with strict JSON only, no prose.",
			"",
			"Rules:",
			`- Output JSON: {"tags":["a","b"]} with 1 to ${MAX_TAGS} tags.`,
			"- Prefer reusing tags from the EXISTING_POOL when relevant.",
			"- Propose at most ONE new tag if nothing in the pool fits.",
			"- Tags must be lowercase, kebab-case, no '#' prefix.",
			"",
			`NOTE_TITLE: ${title}`,
			"",
			`EXISTING_POOL (${pool.length}):`,
			pool.length === 0 ? "(empty)" : pool.join(", "),
		].join("\n");
	}

	parseResponse(raw: string): string[] {
		// jcode `run --ndjson` returns the model's final text in the `done` event.
		// We must be defensive: the model may add prose or markdown fences.
		const cleaned = stripJsonFences(raw);
		try {
			const obj = JSON.parse(cleaned) as { tags?: unknown };
			if (!obj || !Array.isArray(obj.tags)) return [];
			return obj.tags
				.map((t) => stripHash(String(t)).trim().toLowerCase())
				.filter((t) => /^[a-z0-9][a-z0-9_-]*$/.test(t))
				.slice(0, MAX_TAGS);
		} catch {
			return [];
		}
	}

	async suggest(f: TFile): Promise<TagSuggestion | null> {
		if (!this.shouldProcess(f)) return null;
		const pool = this.collectTagPool();
		const prompt = this.buildPrompt(f.basename, pool);

		let captured = "";
		const onEvent = (e: JcodeEvent) => {
			if (e.type === "delta") captured += e.text;
			if (e.type === "end" && e.text) captured = e.text;
		};
		const askOpts: AskOptions = {
			message: prompt,
			provider: this.opts.provider,
			timeoutMs: 90_000,
		};

		let final: JcodeEvent;
		try {
			final = await this.deps.transport.ask(askOpts, onEvent);
		} catch (err) {
			this.notify(
				`jcode auto-tag: error - ${err instanceof Error ? err.message : String(err)}`
			);
			return null;
		}
		const text = final.type === "end" ? final.text : captured;
		const tags = this.parseResponse(text);
		if (tags.length === 0) {
			this.notify(`jcode auto-tag: no usable tags returned for "${f.basename}"`);
			return null;
		}
		const poolSet = new Set(pool);
		return {
			file: f,
			tags,
			novel: tags.filter((t) => !poolSet.has(t)),
			reusedFromPool: tags.filter((t) => poolSet.has(t)),
		};
	}

	async apply(s: TagSuggestion): Promise<void> {
		await this.deps.app.fileManager.processFrontMatter(s.file, (fm) => {
			const existing = Array.isArray(fm.tags) ? (fm.tags as string[]) : [];
			const merged = Array.from(new Set([...existing, ...s.tags]));
			fm.tags = merged;
		});
	}

	/** Convenience: suggest, then either apply (mode=auto) or notify (mode=suggest). */
	async handleNewFile(f: TFile, accept?: (s: TagSuggestion) => Promise<void>) {
		const s = await this.suggest(f);
		if (!s) return null;
		if (this.opts.mode === "auto") {
			await this.apply(s);
			this.notify(
				`jcode auto-tag: applied [${s.tags.join(", ")}] to "${f.basename}"`
			);
		} else {
			// suggest mode: leave application to the caller (UI confirmation).
			if (accept) await accept(s);
			else {
				this.notify(
					`jcode auto-tag: suggests [${s.tags.join(", ")}] for "${f.basename}". Run 'Apply' command to accept.`
				);
			}
		}
		return s;
	}

	private notify(msg: string) {
		(this.deps.notify ?? ((m: string) => console.log(m)))(msg);
	}
}

function stripHash(t: string): string {
	return t.startsWith("#") ? t.slice(1) : t;
}

function stripJsonFences(s: string): string {
	const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (m) return m[1].trim();
	// Strict JSON might still be wrapped in prose; find first { ... last }.
	const start = s.indexOf("{");
	const end = s.lastIndexOf("}");
	if (start !== -1 && end !== -1 && end > start) return s.slice(start, end + 1);
	return s.trim();
}

// Exposed for tests.
export const _internals = { stripJsonFences, stripHash, MAX_POOL, MAX_TAGS };
