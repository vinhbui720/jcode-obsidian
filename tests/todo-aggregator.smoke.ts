/**
 * Tests for the TODO aggregator pure functions.
 * Run: npx tsx tests/todo-aggregator.smoke.ts
 */
import { _internals, renderMarkdown, TodoAggregator } from "../src/todo-aggregator";

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
		console.error(`FAIL ${label}: value was falsy`);
	} else {
		console.log(`PASS ${label}`);
	}
}

// ---------- regex sanity ----------
function testRegex() {
	const { UNCHECKED_RE, HEADING_RE, BODY_TAG_RE } = _internals;
	truthy(UNCHECKED_RE.exec("- [ ] write tests"), "UNCHECKED matches '- [ ] '");
	truthy(UNCHECKED_RE.exec("  * [ ] indented"), "UNCHECKED matches '  * [ ] '");
	truthy(UNCHECKED_RE.exec("+ [ ] alt bullet"), "UNCHECKED matches '+ [ ] '");
	eq(UNCHECKED_RE.exec("- [x] done"), null, "UNCHECKED does NOT match completed");
	eq(UNCHECKED_RE.exec("- [X] done"), null, "UNCHECKED does NOT match completed (cap X)");
	eq(UNCHECKED_RE.exec("just text"), null, "UNCHECKED does NOT match prose");

	truthy(HEADING_RE.exec("# Top"), "HEADING h1");
	truthy(HEADING_RE.exec("###### deep"), "HEADING h6");
	eq(HEADING_RE.exec("####### too deep"), null, "HEADING max h6");

	truthy(BODY_TAG_RE.exec("topic #notdone here"), "BODY tag #notdone in line");
	eq(BODY_TAG_RE.exec("#notdoneish"), null, "BODY tag boundary respected");
}

// ---------- renderMarkdown ----------
function testRender() {
	const md = renderMarkdown(
		[
			{ file: "a.md", line: 5, text: "buy milk", heading: "Errands" },
			{ file: "a.md", line: 9, text: "call mum", heading: null },
			{ file: "b/c.md", line: 1, text: "fix bug", heading: "Bugs" },
		],
		[{ file: "draft.md", title: "draft" }]
	);
	truthy(md.includes("[[a.md]]"), "render: groups by file with wikilink");
	truthy(md.includes("[[b/c.md]]"), "render: nested path");
	truthy(md.includes("[[draft.md|draft]]"), "render: notdone notes section");
	truthy(md.includes("Tasks: 3"), "render: header counts tasks");
	truthy(md.includes("#notdone"), "render: header counts notdone");
	truthy(md.includes("buy milk"), "render: includes task text");
	truthy(md.includes("(Errands)"), "render: includes heading hint");
	truthy(md.includes("line 5"), "render: includes line hint");
}

// ---------- replaceManaged ----------
function testReplace() {
	const { replaceManaged, wrap, MARKER_START, MARKER_END } = _internals;
	const fresh = "no markers here";
	const r1 = replaceManaged(fresh, wrap("BODY"));
	truthy(r1.includes(MARKER_START), "replace: appends block if no markers");
	truthy(r1.includes("BODY"), "replace: body present after append");

	const withBlock = `top\n${MARKER_START}\nOLD\n${MARKER_END}\nbottom`;
	const r2 = replaceManaged(withBlock, wrap("NEW"));
	truthy(r2.startsWith("top\n"), "replace: keeps text before markers");
	truthy(r2.endsWith("\nbottom"), "replace: keeps text after markers");
	truthy(r2.includes("NEW"), "replace: new body present");
	truthy(!r2.includes("OLD"), "replace: old body removed");
}

// ---------- globToRegex ----------
function testGlob() {
	const { globToRegex } = _internals;
	const star = globToRegex("templates/**");
	truthy(star.test("templates/anything"), "glob: templates/** matches subpath");
	truthy(star.test("templates/foo/bar.md"), "glob: ** matches deep");
	truthy(!star.test("notes/templates/x"), "glob: anchored at start");

	const single = globToRegex("*.md");
	truthy(single.test("a.md"), "glob: *.md matches file");
	truthy(!single.test("dir/a.md"), "glob: * does not cross /");
}

// ---------- full run with fake App ----------
async function testFullRun() {
	const files = [
		mkFile("notes/a.md", "## Errands\n- [ ] buy milk\n- [x] done thing\n\n# Other\n- [ ] call mum"),
		mkFile("notes/b.md", "no tasks here"),
		mkFile("templates/template.md", "- [ ] should be ignored via glob"),
		mkFile("drafts/c.md", "- [ ] in draft", { tags: ["notdone"] }),
		mkFile("todo.md", "old content\n"),
	];

	const writes: { path: string; content: string }[] = [];
	const app = {
		vault: {
			getMarkdownFiles: () => files,
			cachedRead: async (f: { content: string }) => f.content,
			getAbstractFileByPath: (p: string) => files.find((x) => x.path === p) ?? null,
			read: async (f: { content: string }) => f.content,
			modify: async (f: { content: string; path: string }, c: string) => {
				f.content = c;
				writes.push({ path: f.path, content: c });
			},
			create: async (p: string, c: string) => {
				writes.push({ path: p, content: c });
			},
		},
		metadataCache: {
			getFileCache: (f: { _fm?: { tags?: string[] } }) => ({ frontmatter: f._fm ?? null }),
		},
	};

	const agg = new TodoAggregator(app as never, {
		outputPath: "todo.md",
		ignore: ["templates/**", "todo.md"],
	});
	const res = await agg.run();
	eq(res.tasks.length, 3, "full: collected 3 unchecked tasks (a×2, c×1)");
	eq(res.notes.length, 1, "full: collected 1 notdone-tagged note");
	eq(writes.length, 1, "full: wrote exactly once");
	truthy(writes[0].content.includes("buy milk"), "full: output contains task");
	truthy(writes[0].content.includes("call mum"), "full: output contains second task");
	truthy(writes[0].content.includes("[[drafts/c.md|c]]"), "full: notdone wikilink");
	truthy(!writes[0].content.includes("should be ignored"), "full: ignored glob respected");
	truthy(writes[0].content.includes("old content"), "full: preserved pre-marker content");
}

function mkFile(
	path: string,
	content: string,
	frontmatter?: { tags?: string[] }
): { path: string; basename: string; extension: string; content: string; _fm?: { tags?: string[] }; stat: object } {
	const segs = path.split("/");
	const base = segs[segs.length - 1].replace(/\.md$/, "");
	return { path, basename: base, extension: "md", content, _fm: frontmatter, stat: {} };
}

(async () => {
	testRegex();
	testRender();
	testReplace();
	testGlob();
	await testFullRun();
	if (failures > 0) {
		console.error(`\n${failures} TEST(S) FAILED`);
		process.exit(1);
	}
	console.log("\nAll todo-aggregator tests passed.");
})();
