import { ASKJCODE_COMPLETIONS, detectAskJcodeSlashTrigger, getAskJcodeCompletions } from "../src/askjcode-suggest-core";

let failures = 0;
function eq<T>(a: T, b: T, label: string) {
	if (JSON.stringify(a) !== JSON.stringify(b)) {
		failures++;
		console.error(`FAIL ${label}\n  expected ${JSON.stringify(b)}\n  actual   ${JSON.stringify(a)}`);
	} else console.log(`PASS ${label}`);
}
function labels(q: string) { return getAskJcodeCompletions(q).map((c) => c.label); }
function trig(line: string) { return detectAskJcodeSlashTrigger(line, { line: 3, ch: line.length }); }

function run() {
	eq(ASKJCODE_COMPLETIONS.length, 3, "has three completions");
	eq(labels("/"), ["/askjcode", "/askjcode --vault", "/askjcode --notebooklm"], "slash returns all");
	eq(labels("/ask"), ["/askjcode", "/askjcode --vault", "/askjcode --notebooklm"], "partial /ask returns all askjcode variants");
	eq(labels("/askjcode --v"), ["/askjcode --vault"], "flag partial filters vault");
	eq(labels("/jcode"), ["/askjcode", "/askjcode --vault", "/askjcode --notebooklm"], "alias /jcode returns all");
	eq(labels("/unknown"), [], "unknown returns none");

	eq(trig("/")?.query, "/", "trigger bare slash");
	eq(trig("/ask")?.start, { line: 3, ch: 0 }, "trigger start position");
	eq(trig("/ask")?.end, { line: 3, ch: 4 }, "trigger end position");
	eq(trig("  /askjcode --v")?.start, { line: 3, ch: 2 }, "trigger after whitespace");
	eq(trig("hello /ask")?.query, "/ask", "trigger inline after whitespace");
	eq(trig("http://example.com"), null, "no trigger inside URL");
	eq(trig("abc/ask"), null, "no trigger after non-whitespace");
	eq(trig("/todo"), null, "no trigger unrelated slash command");
}

run();
if (failures) {
	console.error(`\n${failures} TEST(S) FAILED`);
	process.exit(1);
}
console.log("\nAll askjcode-suggest tests passed.");
