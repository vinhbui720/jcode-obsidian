import { SpacedRepPicker, _internals } from "../src/spaced-rep";

let failures = 0;
function eq<T>(a: T, b: T, label: string) { if (JSON.stringify(a) !== JSON.stringify(b)) { failures++; console.error(`FAIL ${label}\n  expected ${JSON.stringify(b)}\n  actual   ${JSON.stringify(a)}`); } else console.log(`PASS ${label}`); }
function ok(v: unknown, label: string) { if (!v) { failures++; console.error(`FAIL ${label}`); } else console.log(`PASS ${label}`); }
const today = new Date("2026-05-23T00:00:00");
const ms = (s: string) => new Date(`${s}T00:00:00`).getTime();

type F = { path: string; basename: string; extension: string; stat: { mtime: number }; fm?: Record<string, unknown>; tags?: string[] };
function file(path: string, fm: Record<string, unknown> = {}, tags: string[] = [], mtime = "2026-05-01"): F { return { path, basename: path.split("/").pop()!.replace(/\.md$/, ""), extension: "md", stat: { mtime: ms(mtime) }, fm, tags }; }
function app(files: F[], contents = new Map<string, string>()) {
	const fmStore = new Map(files.map((f) => [f.path, { ...(f.fm ?? {}) }]));
	return {
		vault: {
			getMarkdownFiles: () => files,
			getAbstractFileByPath: (p: string) => files.find((f) => f.path === p) ?? null,
			read: async (f: F) => contents.get(f.path) ?? "",
			modify: async (f: F, text: string) => contents.set(f.path, text),
			create: async (p: string, text: string) => { contents.set(p, text); files.push(file(p)); },
		},
		metadataCache: { getFileCache: (f: F) => ({ frontmatter: fmStore.get(f.path) ?? {}, tags: (f.tags ?? []).map((tag) => ({ tag })) }) },
		fileManager: { processFrontMatter: async (f: F, fn: (fm: Record<string, unknown>) => void) => { const fm = fmStore.get(f.path) ?? {}; fn(fm); fmStore.set(f.path, fm); } },
		_fmStore: fmStore,
	};
}
function picker(files: F[], extra = {}, contents?: Map<string, string>) {
	const a = app(files, contents);
	const p = new SpacedRepPicker({ app: a as never, today: () => today, getSettings: () => ({ outputPath: "today-review.md", ignore: [], dailyPickCount: 5, defaultIntervalDays: 7, tagBoost: 1.5, ...extra }) });
	return { p, a };
}

function tests() {
	eq(_internals.isoDate(today), "2026-05-23", "iso date");
	eq(_internals.isoDate(_internals.parseIsoDate("2026-05-20")!), "2026-05-20", "parse iso");
	eq(_internals.parseIsoDate("bad"), null, "parse bad iso");
	ok(_internals.compileIgnore(["templates/**"])("templates/a.md"), "ignore double star");
	ok(_internals.compileIgnore(["*.md"])("a.md"), "ignore star root");
	eq(_internals.compileIgnore(["*.md"])("x/a.md"), false, "star does not cross slash");

	let { p } = picker([file("old.md", {}, [], "2026-01-01"), file("new.md", { "last-reviewed": "2026-05-20" })]);
	let picks = p.pickTop(p.collectCandidates(), 2);
	eq(picks[0].path, "old.md", "never reviewed beats reviewed");
	eq(picks[0].neverReviewed, true, "never reviewed flag");
	eq(picks[0].overdueDays, Infinity, "never reviewed overdue infinity");
	eq(picks[1].neverReviewed, false, "reviewed flag false");

	({ p } = picker([file("due.md", { "last-reviewed": "2026-05-10" }), file("notdue.md", { "last-reviewed": "2026-05-20" })]));
	const cs = p.collectCandidates();
	eq(cs.find((c) => c.path === "due.md")!.overdueDays, 6, "overdue days correct");
	eq(cs.find((c) => c.path === "notdue.md")!.overdueDays, -4, "negative overdue means not due");
	eq(cs.find((c) => c.path === "due.md")!.intervalDays, 7, "default interval used");

	({ p } = picker([file("custom.md", { "last-reviewed": "2026-05-10", "review-interval-days": 3 })]));
	eq(p.collectCandidates()[0].overdueDays, 10, "custom interval applied");

	({ p } = picker([file("tag.md", { "last-reviewed": "2026-05-10" }, ["#spaced-rep"]), file("plain.md", { "last-reviewed": "2026-05-10" })]));
	const scored = p.collectCandidates();
	ok(scored.find((c) => c.path === "tag.md")!.score > scored.find((c) => c.path === "plain.md")!.score, "body tag boost");
	ok(scored.find((c) => c.path === "tag.md")!.hasBoostTag, "body tag detected");

	({ p } = picker([file("fm-tag.md", { tags: ["spaced-rep"] }), file("fm-bool.md", { "spaced-rep": true })]));
	eq(p.collectCandidates().map((c) => c.hasBoostTag), [true, true], "fm tag and bool boost detected");

	({ p } = picker([file("a/one.md", {}, [], "2026-01-01"), file("a/two.md", {}, [], "2026-01-02"), file("b/three.md", {}, [], "2026-01-03")], { dailyPickCount: 3 }));
	eq(p.pickTop(p.collectCandidates(), 3).map((c) => c.folder), ["a", "b", "a"], "folder diversity penalty interleaves folders");

	({ p } = picker([file("skip.md"), file("keep.md")], { ignore: ["skip.md"] }));
	eq(p.collectCandidates().map((c) => c.path), ["keep.md"], "ignore globs skip files");

	({ p } = picker([file("today-review.md"), file("keep.md")]));
	eq(p.collectCandidates().map((c) => c.path), ["keep.md"], "output file skipped");

	({ p } = picker([file("note.md", { "last-reviewed": "2026-05-10" })]));
	const block = p.renderBlock(p.collectCandidates());
	ok(block.includes("jcode-spaced-rep:start"), "render start marker");
	ok(block.includes("Daily review picks — 2026-05-23"), "render date");
	ok(block.includes("[[note.md|note]]"), "render wikilink");
	ok(block.includes("last reviewed 13d ago"), "render reviewed age");
	ok(block.includes("overdue 6d"), "render overdue");
	ok(p.renderBlock([]).includes("No due notes today"), "render empty picks");

	const repl = _internals.wrap("NEW");
	eq(_internals.replaceManaged("before\n" + _internals.wrap("OLD") + "\nafter", repl), "before\n" + repl + "\nafter", "replace managed preserves outside");
	ok(_internals.replaceManaged("before", repl).includes("before\n\n" + repl), "append managed when missing");

	const contents = new Map<string, string>([["today-review.md", "intro\n" + _internals.wrap("OLD") + "\noutro"]]);
	({ p } = picker([file("today-review.md"), file("x.md")], {}, contents));
	return p.rebuild().then(async () => {
		ok((contents.get("today-review.md") ?? "").includes("intro"), "rebuild preserves intro");
		ok((contents.get("today-review.md") ?? "").includes("outro"), "rebuild preserves outro");
		const { p: p2, a } = picker([file("mark.md")]);
		await p2.markReviewed(a.vault.getMarkdownFiles()[0] as never);
		eq(a._fmStore.get("mark.md")!["last-reviewed"], "2026-05-23", "mark reviewed date");
		eq(a._fmStore.get("mark.md")!["review-count"], 1, "mark reviewed count first");
		await p2.markReviewed(a.vault.getMarkdownFiles()[0] as never);
		eq(a._fmStore.get("mark.md")!["review-count"], 2, "mark reviewed increments");
	});
}

Promise.resolve(tests()).then(() => {
	if (failures) { console.error(`\n${failures} TEST(S) FAILED`); process.exit(1); }
	console.log("\nAll spaced-rep tests passed.");
});
