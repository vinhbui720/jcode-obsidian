import type { App, TFile } from "obsidian";

export interface SpacedRepSettings {
	outputPath: string;
	ignore: string[];
	dailyPickCount: number;
	defaultIntervalDays: number;
	tagBoost: number;
}

export interface SpacedRepDeps {
	app: App;
	getSettings: () => SpacedRepSettings;
	notify?: (msg: string) => void;
	today?: () => Date;
}

export interface Candidate {
	file: TFile;
	path: string;
	title: string;
	folder: string;
	mtimeMs: number;
	lastReviewed: string | null;
	lastReviewedDate: Date | null;
	intervalDays: number;
	hasBoostTag: boolean;
	neverReviewed: boolean;
	overdueDays: number;
	daysSinceEdit: number;
	score: number;
}

const START = "<!-- jcode-spaced-rep:start (auto-generated, do not edit) -->";
const END = "<!-- jcode-spaced-rep:end -->";
const DAY = 24 * 60 * 60 * 1000;

export class SpacedRepPicker {
	constructor(private deps: SpacedRepDeps) {}

	collectCandidates(today = startOfDay(this.today())): Candidate[] {
		const s = this.deps.getSettings();
		const ignore = compileIgnore(s.ignore);
		const out = s.outputPath;
		return this.deps.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path !== out && !ignore(f.path))
			.map((f) => this.toCandidate(f, today));
	}

	scoreCandidate(c: Candidate): number {
		let score = c.neverReviewed ? 1_000_000 : Math.max(0, c.overdueDays) * 100;
		score += Math.min(c.daysSinceEdit, 365) * 0.1;
		if (c.hasBoostTag) score *= this.deps.getSettings().tagBoost;
		return score;
	}

	pickTop(candidates: Candidate[], n: number): Candidate[] {
		const pool = candidates.map((c) => ({ ...c, score: this.scoreCandidate(c) }));
		const picked: Candidate[] = [];
		const folderCounts = new Map<string, number>();
		while (picked.length < n && pool.length) {
			pool.sort((a, b) => compareCandidates(adjustScore(a, folderCounts), adjustScore(b, folderCounts)));
			const next = pool.shift()!;
			picked.push(next);
			folderCounts.set(next.folder, (folderCounts.get(next.folder) ?? 0) + 1);
		}
		return picked;
	}

	renderBlock(picks: Candidate[], today = startOfDay(this.today())): string {
		const date = isoDate(today);
		const lines = [`> [!review]+ Daily review picks — ${date}`];
		if (picks.length === 0) lines.push("> No due notes today.");
		for (const p of picks) lines.push(`> - [[${p.path}|${p.title}]] — ${describe(p, today)}`);
		return wrap(lines.join("\n"));
	}

	async rebuild(): Promise<{ picks: Candidate[]; outputPath: string }> {
		const s = this.deps.getSettings();
		const today = startOfDay(this.today());
		const candidates = this.collectCandidates(today);
		const picks = this.pickTop(candidates, s.dailyPickCount);
		await this.writeOutput(this.renderBlock(picks, today));
		return { picks, outputPath: s.outputPath };
	}

	async markReviewed(file: TFile, today = startOfDay(this.today())): Promise<void> {
		await this.deps.app.fileManager.processFrontMatter(file, (fm) => {
			fm["last-reviewed"] = isoDate(today);
			const n = Number(fm["review-count"] ?? 0);
			fm["review-count"] = Number.isFinite(n) ? n + 1 : 1;
		});
		await this.rebuild();
	}

	private toCandidate(f: TFile, today: Date): Candidate {
		const s = this.deps.getSettings();
		const cache = this.deps.app.metadataCache.getFileCache(f);
		const fm = cache?.frontmatter ?? {};
		const lrRaw = typeof fm["last-reviewed"] === "string" ? fm["last-reviewed"] : null;
		const lr = lrRaw ? parseIsoDate(lrRaw) : null;
		const intervalRaw = Number(fm["review-interval-days"] ?? s.defaultIntervalDays);
		const intervalDays = Number.isFinite(intervalRaw) && intervalRaw > 0 ? intervalRaw : s.defaultIntervalDays;
		const daysSinceEdit = Math.max(0, Math.floor((today.getTime() - startOfDay(new Date(f.stat.mtime)).getTime()) / DAY));
		const overdueDays = lr ? Math.floor((today.getTime() - addDays(lr, intervalDays).getTime()) / DAY) : Number.POSITIVE_INFINITY;
		const hasBoostTag = Boolean(fm["spaced-rep"] === true || hasTag(cache?.tags, "spaced-rep") || hasFmTag(fm.tags, "spaced-rep"));
		const c: Candidate = {
			file: f,
			path: f.path,
			title: f.basename,
			folder: folderOf(f.path),
			mtimeMs: f.stat.mtime,
			lastReviewed: lrRaw,
			lastReviewedDate: lr,
			intervalDays,
			hasBoostTag,
			neverReviewed: !lr,
			overdueDays,
			daysSinceEdit,
			score: 0,
		};
		c.score = this.scoreCandidate(c);
		return c;
	}

	private async writeOutput(generated: string) {
		const path = this.deps.getSettings().outputPath;
		const existing = this.deps.app.vault.getAbstractFileByPath(path);
		if (existing && "stat" in existing) {
			const file = existing as TFile;
			const old = await this.deps.app.vault.read(file);
			const next = replaceManaged(old, generated);
			if (next !== old) await this.deps.app.vault.modify(file, next);
			return;
		}
		await this.deps.app.vault.create(path, `# Today review\n\n${generated}\n`);
	}

	private today(): Date {
		return this.deps.today ? this.deps.today() : new Date();
	}
}

function compareCandidates(a: Candidate, b: Candidate): number {
	if (a.neverReviewed !== b.neverReviewed) return a.neverReviewed ? -1 : 1;
	if (a.neverReviewed && b.neverReviewed) {
		if (a.score !== b.score) return b.score - a.score;
		return a.mtimeMs - b.mtimeMs;
	}
	if (a.score !== b.score) return b.score - a.score;
	if (a.overdueDays !== b.overdueDays) return b.overdueDays - a.overdueDays;
	return a.path.localeCompare(b.path);
}

function adjustScore(c: Candidate, folderCounts: Map<string, number>): Candidate {
	const count = folderCounts.get(c.folder) ?? 0;
	return count === 0 ? c : { ...c, score: c.score / (1 + count * 0.35) };
}

function describe(p: Candidate, today = startOfDay(new Date())): string {
	if (p.neverReviewed) return `never reviewed${p.hasBoostTag ? ", #spaced-rep" : ""}`;
	const since = p.lastReviewedDate ? Math.max(0, Math.floor((today.getTime() - p.lastReviewedDate.getTime()) / DAY)) : 0;
	const overdue = p.overdueDays > 0 ? `overdue ${p.overdueDays}d` : `due in ${Math.abs(p.overdueDays)}d`;
	return `last reviewed ${since}d ago, interval ${p.intervalDays}d (${overdue})${p.hasBoostTag ? ", #spaced-rep" : ""}`;
}

function hasTag(tags: Array<{ tag: string }> | undefined, name: string): boolean {
	return Boolean(tags?.some((t) => stripHash(t.tag) === name));
}
function hasFmTag(tags: unknown, name: string): boolean {
	if (Array.isArray(tags)) return tags.some((t) => stripHash(String(t)) === name);
	if (typeof tags === "string") return stripHash(tags) === name;
	return false;
}
function stripHash(s: string): string { return s.startsWith("#") ? s.slice(1) : s; }
function folderOf(path: string): string { const i = path.lastIndexOf("/"); return i === -1 ? "" : path.slice(0, i); }
function startOfDay(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d: Date, n: number): Date { return new Date(d.getTime() + n * DAY); }
function isoDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}
function parseIsoDate(s: string): Date | null { const d = new Date(`${s}T00:00:00`); return Number.isNaN(d.getTime()) ? null : startOfDay(d); }
function wrap(body: string): string { return `${START}\n${body}\n${END}`; }
function replaceManaged(existing: string, replacement: string): string {
	const start = existing.indexOf(START), end = existing.indexOf(END);
	if (start === -1 || end === -1 || end < start) return `${existing.trimEnd()}\n\n${replacement}\n`;
	return `${existing.slice(0, start)}${replacement}${existing.slice(end + END.length)}`;
}
function compileIgnore(patterns: string[]): (path: string) => boolean {
	const rs = patterns.filter(Boolean).map(globToRegex);
	return (path) => rs.some((r) => r.test(path));
}
function globToRegex(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "::DOUBLE::").replace(/\*/g, "[^/]*").replace(/::DOUBLE::/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`);
}

export const _internals = { START, END, DAY, compileIgnore, globToRegex, replaceManaged, wrap, isoDate, parseIsoDate, startOfDay, describe, compareCandidates };
