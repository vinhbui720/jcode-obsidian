/**
 * Tests for /askjcode line parsing, callout rendering, and event normalisation.
 * Run: npx tsx tests/askjcode.smoke.ts
 */
import { _internals, _parseLine, insertCallout, runAskJcode } from "../src/askjcode";
import { _internals as clientInternals, _normaliseEvent } from "../src/jcode-client";

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

// ---------- parseLine ----------

function testParseLine() {
	eq(_parseLine("hello"), null, "parseLine: non-prefix returns null");
	eq(_parseLine("/askjcode"), { prompt: "", flags: new Set<string>() }, "parseLine: empty prompt");
	eq(
		_parseLine("/askjcode what is band 7"),
		{ prompt: "what is band 7", flags: new Set<string>() },
		"parseLine: basic prompt"
	);
	eq(
		_parseLine("/askjcode --vault summarise"),
		{ prompt: "summarise", flags: new Set(["vault"]) },
		"parseLine: with --vault flag"
	);
	eq(
		_parseLine("/askjcode --vault --notebooklm topic x"),
		{ prompt: "topic x", flags: new Set(["vault", "notebooklm"]) },
		"parseLine: multiple flags"
	);
	eq(
		_parseLine("   /askjcode  spaced   "),
		{ prompt: "spaced", flags: new Set<string>() },
		"parseLine: leading whitespace + collapsed inner spaces"
	);
}

// ---------- normaliseEvent ----------

function testNormaliseEvent() {
	eq(
		_normaliseEvent({ type: "start", session_id: "s1", model: "m", provider: "p" }),
		{ type: "start", sessionId: "s1", model: "m", provider: "p" },
		"normalise: start"
	);
	eq(
		_normaliseEvent({ type: "text_delta", text: "Hi" }),
		{ type: "delta", text: "Hi" },
		"normalise: text_delta → delta"
	);
	eq(
		_normaliseEvent({ type: "status_detail", detail: "opening websocket" }),
		{ type: "status", detail: "opening websocket" },
		"normalise: status_detail"
	);
	eq(
		_normaliseEvent({ type: "connection_phase", phase: "streaming" }),
		null,
		"normalise: connection_phase dropped"
	);
	eq(
		_normaliseEvent({ type: "message_end" }),
		null,
		"normalise: message_end dropped (folded into done)"
	);
	const done = _normaliseEvent({
		type: "done",
		text: "Hi there.",
		usage: {
			input_tokens: 100,
			output_tokens: 12,
			cache_read_input_tokens: 50,
			cache_creation_input_tokens: null,
		},
	});
	eq(
		done,
		{
			type: "end",
			text: "Hi there.",
			tokens: { input: 100, output: 12, cacheRead: 50, cacheCreate: null as unknown as number },
		},
		"normalise: done → end with tokens"
	);
}

function testReplLineNormalisation() {
	eq(clientInternals.normaliseReplTextLine("> Hello again! What", ""), "Hello again! What", "repl: strips prompt marker");
	eq(clientInternals.normaliseReplTextLine("would you like", "Hello again! What"), " would you like", "repl: joins wrapped prose with space");
	eq(clientInternals.normaliseReplTextLine("?", "Hello"), "?", "repl: punctuation attaches without space");
	eq(clientInternals.normaliseReplTextLine("   ", "Hello"), "", "repl: ignores blank lines");
}

// ---------- insertCallout (with a fake editor) ----------

class FakeEditor {
	lines: string[];
	cursor = { line: 0, ch: 0 };
	constructor(initial: string) {
		this.lines = initial.split("\n");
	}
	getLine(n: number) {
		return this.lines[n] ?? "";
	}
	lineCount() {
		return this.lines.length;
	}
	getCursor() {
		return this.cursor;
	}
	getValue() {
		return this.lines.join("\n");
	}
	somethingSelected() {
		return false;
	}
	getSelection() {
		return "";
	}
	replaceRange(
		text: string,
		from: { line: number; ch: number },
		_to: { line: number; ch: number }
	) {
		const to = _to;
		const inserted = text.split("\n");
		const before = this.lines.slice(0, from.line);
		const after = this.lines.slice(to.line);
		this.lines = [...before, ...inserted.slice(0, -1), inserted[inserted.length - 1] + (after[0] ?? ""), ...after.slice(1)];
	}
}

function testInsertCallout() {
	const e = new FakeEditor("/askjcode hi\nfollowing line");
	insertCallout(e as never, 0, "Hello there.", false);
	const result = e.getValue();
	eq(result.includes("> [!jcode]+ jcode"), true, "callout: header present");
	eq(result.includes("> Hello there."), true, "callout: body quoted");
	eq(result.includes("following line"), true, "callout: existing content preserved");

	const e2 = new FakeEditor("/askjcode broken\n");
	insertCallout(e2 as never, 0, "fail", true);
	eq(e2.getValue().includes("> [!danger]+ jcode error"), true, "callout: error variant");

	const e3 = new FakeEditor("/askjcode empty\n");
	insertCallout(e3 as never, 0, "   ", false);
	eq(e3.getValue().includes("(empty response)"), true, "callout: empty fallback");
}

async function testRunAskJcodeLiveBlock() {
	const e = new FakeEditor("# Speaking practice\n/askjcode say hi\nnext");
	e.cursor = { line: 1, ch: 16 };
	const statuses: string[] = [];
	const ok = await runAskJcode(
		{ editor: e as never, noteText: e.getValue(), notePath: "n.md", vaultRoot: "/tmp" },
		{
			transport: {
				cancel() {},
				async ask(_opts, on) {
					on({ type: "start", model: "mock" });
					on({ type: "delta", text: "Hello" });
					on({ type: "end", text: "Hello final" });
					return { type: "end", text: "Hello final" };
				},
			},
			statusBar: { setText: (s) => statuses.push(s), clear: () => statuses.push("clear") },
		}
	);
	eq(ok, true, "runAsk: returns true");
	const out = e.getValue();
	eq(out.includes("> [!jcode]+ Speaking practice"), true, "runAsk: uses nearest heading as title");
	eq(out.includes("> Hello final"), true, "runAsk: inserts final answer");
	eq(out.includes("_jcode: writing"), false, "runAsk: final replaces live status");
	eq(out.includes("next"), true, "runAsk: preserves following line");
	eq(statuses.includes("jcode: connecting…"), true, "runAsk: status bar connecting");
}

async function testRunAskJcodeRespectsStatusBarStreamingToggle() {
	const e = new FakeEditor("# Speaking practice\n/askjcode say hi");
	e.cursor = { line: 1, ch: 16 };
	const statuses: string[] = [];
	await runAskJcode(
		{ editor: e as never, noteText: e.getValue(), notePath: "n.md", vaultRoot: "/tmp" },
		{
			transport: {
				cancel() {},
				async ask(_opts, on) {
					on({ type: "start", model: "mock" });
					on({ type: "status", detail: "thinking" });
					on({ type: "delta", text: "Hello" });
					on({ type: "tool", name: "bash", status: "start" });
					on({ type: "end", text: "Hello final" });
					return { type: "end", text: "Hello final" };
				},
			},
			statusBar: { setText: (s) => statuses.push(s), clear: () => statuses.push("clear") },
			statusBarStreaming: false,
		}
	);
	eq(statuses.includes("jcode: connecting…"), true, "runAsk no-stream: initial connecting shown");
	eq(statuses.includes("jcode: mock streaming…"), false, "runAsk no-stream: start update suppressed");
	eq(statuses.includes("jcode: thinking"), false, "runAsk no-stream: status update suppressed");
	eq(statuses.includes("jcode: 5 chars…"), false, "runAsk no-stream: delta update suppressed");
	eq(statuses.includes("jcode: tool bash running"), false, "runAsk no-stream: tool update suppressed");
	eq(statuses.includes("jcode: done"), true, "runAsk no-stream: final done shown");
}

function testSectionInternals() {
	const e = new FakeEditor("# Top\ntext\n## Child ##\n/askjcode hi");
	eq(_internals.findSectionTitle(e as never, 3), "Child", "section title strips trailing hashes");
	eq(_internals.renderStatusBlock("Child", "connecting…"), "> [!jcode]+ Child\n> _jcode: connecting…_\n", "status block render");
	const live = _internals.renderLiveBlock("Child", "Hello\nWorld", new Map([
		["connection", "streaming…"],
		["tool:bash", "tool bash: running"],
	]));
	eq(live.includes("> Hello"), true, "live block includes first feedback line");
	eq(live.includes("> World"), true, "live block includes later feedback line");
	eq(live.includes("_jcode: streaming…_"), true, "live block includes status");
	eq(live.includes("_jcode: tool bash: running_"), true, "live block includes tool status");
	eq(_internals.activityKey("  A   Status  "), "a status", "activity key normalizes whitespace");
}

(async () => {
	testParseLine();
	testNormaliseEvent();
	testReplLineNormalisation();
	testInsertCallout();
	testSectionInternals();
	await testRunAskJcodeLiveBlock();
	await testRunAskJcodeRespectsStatusBarStreamingToggle();
	if (failures > 0) {
		console.error(`\n${failures} TEST(S) FAILED`);
		process.exit(1);
	}
	console.log("\nAll askjcode tests passed.");
})();
