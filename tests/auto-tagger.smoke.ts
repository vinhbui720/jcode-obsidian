/**
 * Tests for the auto-tagger pure functions.
 * Run: npx tsx tests/auto-tagger.smoke.ts
 */
import { AutoTagger, _internals } from "../src/auto-tagger";
import { JcodeEvent, JcodeTransport, AskOptions } from "../src/jcode-client";

let failures = 0;
function eq<T>(a: T, b: T, label: string) {
	const sa = JSON.stringify(a);
	const sb = JSON.stringify(b);
	if (sa !== sb) {
		failures++;
		console.error(`FAIL ${label}\n  expected: ${sb}\n  actual:   ${sa}`);
	} else {
		console.log(`PASS ${label}`);
	}
}
function truthy(v: unknown, label: string) {
	if (!v) {
		failures++;
		console.error(`FAIL ${label}`);
	} else {
		console.log(`PASS ${label}`);
	}
}

// ---------- stripJsonFences ----------
function testStrip() {
	const { stripJsonFences } = _internals;
	eq(stripJsonFences('{"tags":["a"]}'), '{"tags":["a"]}', "strip: raw json passthrough");
	eq(stripJsonFences('```json\n{"tags":["a"]}\n```'), '{"tags":["a"]}', "strip: json fences");
	eq(stripJsonFences('```\n{"tags":["x"]}\n```'), '{"tags":["x"]}', "strip: bare fences");
	eq(
		stripJsonFences('here are the tags:\n{"tags":["b","c"]}\nhope this helps'),
		'{"tags":["b","c"]}',
		"strip: prose around json"
	);
}

// ---------- parseResponse ----------
function testParse() {
	const at = mkTagger("suggest");
	eq(at.parseResponse('{"tags":["ielts","study"]}'), ["ielts", "study"], "parse: basic");
	eq(at.parseResponse('```json\n{"tags":["#ielts","band-7"]}\n```'), ["ielts", "band-7"], "parse: strips #");
	eq(at.parseResponse('{"tags":["IELTS","STUDY"]}'), ["ielts", "study"], "parse: lowercases");
	eq(at.parseResponse('{"tags":["a","b","c","d","e"]}'), ["a", "b", "c"], "parse: capped at MAX_TAGS");
	eq(at.parseResponse('{"tags":["bad tag","ok"]}'), ["ok"], "parse: rejects spaces");
	eq(at.parseResponse('{"tags":["123start","mid-1"]}'), ["123start", "mid-1"], "parse: numbers OK");
	eq(at.parseResponse('not json at all'), [], "parse: invalid → empty");
	eq(at.parseResponse('{"other":1}'), [], "parse: missing tags key → empty");
}

// ---------- buildPrompt ----------
function testPrompt() {
	const at = mkTagger("suggest");
	const p1 = at.buildPrompt("IELTS Band 7", ["ielts", "study", "writing"]);
	truthy(p1.includes("IELTS Band 7"), "prompt: includes title");
	truthy(p1.includes("ielts, study, writing"), "prompt: includes pool");
	truthy(p1.includes("strict JSON only"), "prompt: instructs strict JSON");

	const p2 = at.buildPrompt("Lonely note", []);
	truthy(p2.includes("(empty)"), "prompt: handles empty pool");
}

// ---------- collectTagPool / shouldProcess via fake App ----------
function testCollectAndShould() {
	const app = mkApp([
		{ path: "a.md", basename: "a", extension: "md", _tags: ["#ielts", "#study"] },
		{ path: "b.md", basename: "b", extension: "md", _fmTags: ["writing", "study"] },
		{ path: "c.md", basename: "c", extension: "md", _fmTags: "writing" },
		{ path: "d.md", basename: "d", extension: "md", _fmTags: ["already-tagged"] },
		{ path: "img.png", basename: "img", extension: "png" },
	]);
	const at = new AutoTagger(
		{ app: app as never, transport: mkTransport('{"tags":["x"]}') },
		{ mode: "suggest" }
	);
	const pool = at.collectTagPool();
	eq(pool.sort(), ["already-tagged", "ielts", "study", "writing"].sort(), "pool: union, no #");

	// shouldProcess: ext gates and existing tag gates
	const dFile = app.vault.getMarkdownFiles().find((f) => f.path === "d.md")!;
	const aFile = app.vault.getMarkdownFiles().find((f) => f.path === "a.md")!;
	eq(at.shouldProcess(dFile), false, "shouldProcess: skip files already with fm.tags");
	eq(at.shouldProcess(aFile), true, "shouldProcess: accept files with only body tags");
	const pngLike = { path: "x.png", basename: "x", extension: "png" } as unknown as Parameters<typeof at.shouldProcess>[0];
	eq(at.shouldProcess(pngLike), false, "shouldProcess: reject non-md");
}

// ---------- suggest + apply (with mock transport returning JSON) ----------
async function testSuggestAndApply() {
	const fmStore = new Map<string, Record<string, unknown>>();
	const app = mkApp([
		{ path: "ielts-band-7.md", basename: "ielts-band-7", extension: "md" },
		{ path: "old.md", basename: "old", extension: "md", _fmTags: ["study"] },
	]);
	// processFrontMatter mock
	app.fileManager = {
		processFrontMatter: async (
			f: { path: string },
			fn: (fm: Record<string, unknown>) => void
		) => {
			const fm = fmStore.get(f.path) ?? {};
			fn(fm);
			fmStore.set(f.path, fm);
		},
	};

	const at = new AutoTagger(
		{
			app: app as never,
			transport: mkTransport('{"tags":["ielts","band-7","study"]}'),
		},
		{ mode: "auto" }
	);
	const file = app.vault.getMarkdownFiles().find((f) => f.path === "ielts-band-7.md")!;
	const s = await at.suggest(file);
	truthy(s, "suggest: returns a suggestion");
	eq(s!.tags, ["ielts", "band-7", "study"], "suggest: parses tags");
	eq(s!.reusedFromPool, ["study"], "suggest: classifies reused");
	eq(s!.novel.sort(), ["band-7", "ielts"], "suggest: classifies novel");

	await at.apply(s!);
	eq(fmStore.get("ielts-band-7.md"), { tags: ["ielts", "band-7", "study"] }, "apply: writes fm.tags");
}

// ---------- helpers ----------
function mkTagger(mode: "suggest" | "auto") {
	return new AutoTagger(
		{ app: mkApp([]) as never, transport: mkTransport('{"tags":[]}') },
		{ mode }
	);
}

function mkTransport(finalText: string): JcodeTransport {
	return {
		cancel() {},
		async ask(_opts: AskOptions, on: (e: JcodeEvent) => void) {
			on({ type: "start", sessionId: "s", model: "m", provider: "p" });
			const e: JcodeEvent = { type: "end", text: finalText };
			on(e);
			return e;
		},
	};
}

interface MockFile {
	path: string;
	basename: string;
	extension: string;
	_tags?: string[];
	_fmTags?: string[] | string;
}

function mkApp(files: MockFile[]) {
	return {
		vault: {
			getMarkdownFiles: () => files.filter((f) => f.extension === "md"),
		},
		metadataCache: {
			getFileCache: (f: MockFile) => {
				const cache: { tags?: Array<{ tag: string }>; frontmatter?: Record<string, unknown> } = {};
				if (f._tags) cache.tags = f._tags.map((t) => ({ tag: t }));
				if (f._fmTags !== undefined) cache.frontmatter = { tags: f._fmTags };
				return cache;
			},
		},
		fileManager: {
			processFrontMatter: async () => {
				/* overridden in tests */
			},
		},
	};
}

(async () => {
	testStrip();
	testParse();
	testPrompt();
	testCollectAndShould();
	await testSuggestAndApply();
	if (failures > 0) {
		console.error(`\n${failures} TEST(S) FAILED`);
		process.exit(1);
	}
	console.log("\nAll auto-tagger tests passed.");
})();
