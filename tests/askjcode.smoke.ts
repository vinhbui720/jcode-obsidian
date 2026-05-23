/**
 * Tests for /askjcode line parsing, callout rendering, and event normalisation.
 * Run: npx tsx tests/askjcode.smoke.ts
 */
import { _parseLine, insertCallout } from "../src/askjcode";
import { _normaliseEvent } from "../src/jcode-client";

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
	replaceRange(
		text: string,
		from: { line: number; ch: number },
		_to: { line: number; ch: number }
	) {
		const inserted = text.split("\n");
		// At-cursor insert; we ignore `to` since the tests only insert at line start.
		const before = this.lines.slice(0, from.line);
		const after = this.lines.slice(from.line);
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

(() => {
	testParseLine();
	testNormaliseEvent();
	testInsertCallout();
	if (failures > 0) {
		console.error(`\n${failures} TEST(S) FAILED`);
		process.exit(1);
	}
	console.log("\nAll askjcode tests passed.");
})();
