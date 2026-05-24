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

async function testRunAskJcodeNaturalFeedbackTrail() {
	const e = new FakeEditor("# penguin\n/askjcode launch app");
	e.cursor = { line: 1, ch: 14 };
	await runAskJcode(
		{ editor: e as never, noteText: e.getValue(), notePath: "n.md", vaultRoot: "/tmp" },
		{
			transport: {
				cancel() {},
				async ask(_opts, on) {
					on({ type: "status", detail: "opening websocket" });
					on({ type: "tool", name: "bash", status: "start", summary: "gtk-launch jcode-panel" });
					on({
						type: "end",
						text:
							"I’m launching it now and checking that the process stays up.\n✓ batch · Launch installed app and verify runtime · 2 calls · 35 tok\n  ✓ bash · $ gtk-launch jcode-panel · 5 tok\n41s · 78.4 tps · ↑77k ↓76",
					});
					return { type: "end", text: "I’m launching it now and checking that the process stays up." };
				},
			},
			statusBar: { setText() {}, clear() {} },
		}
	);
	const out = e.getValue();
	eq(out.includes("> [!jcode]+ penguin"), true, "runAsk natural: title uses section name");
	eq(out.includes("> I’m launching it now and checking that the process stays up."), true, "runAsk natural: final answer kept");
	eq(out.includes("opening websocket"), false, "runAsk natural: transport noise removed");
	eq(out.includes("✓ batch"), false, "runAsk natural: tool tree removed");
	eq(out.includes("gtk-launch"), false, "runAsk natural: tool command removed");
}

async function testRunAskJcodeUsesSavedDisplayTitle() {
	const e = new FakeEditor("# local heading\n/askjcode say hi");
	e.cursor = { line: 1, ch: 16 };
	await runAskJcode(
		{ editor: e as never, noteText: e.getValue(), notePath: "n.md", vaultRoot: "/tmp" },
		{
			transport: {
				cancel() {},
				async ask(_opts, on) {
					on({ type: "end", text: "Done." });
					return { type: "end", text: "Done." };
				},
			},
			statusBar: { setText() {}, clear() {} },
			displayTitle: "saved session title",
		}
	);
	eq(e.getValue().includes("> [!jcode]+ saved session title"), true, "runAsk uses saved display title");
}

async function testRunAskJcodeBuildsAnswerFromStatusWhenFinalTextEmpty() {
	const e = new FakeEditor("# gog-vinh\n/askjcode check lịch tuần sau");
	e.cursor = { line: 1, ch: 20 };
	await runAskJcode(
		{ editor: e as never, noteText: e.getValue(), notePath: "n.md", vaultRoot: "/tmp" },
		{
			transport: {
				cancel() {},
				async ask(_opts, on) {
					on({ type: "status", detail: "Mình sẽ kiểm tra Calendar tuần sau cho account personal." });
					on({ type: "status", detail: "week.sh trả “next 7 days”, mình sẽ lọc đúng tuần sau theo lịch: 2026-05-25 đến 2026-06-01." });
					on({ type: "tool", name: "bash", status: "start", summary: "Check next week calendar" });
					on({ type: "tool", name: "bash", status: "end", summary: "Check next week calendar" });
					on({ type: "status", detail: "Reload complete — continuing because a recovery directive was pending." });
					on({ type: "end", text: "" });
					return { type: "end", text: "" };
				},
			},
			statusBar: { setText() {}, clear() {} },
		}
	);
	const out = e.getValue();
	eq(out.includes("> - Mình sẽ kiểm tra Calendar tuần sau cho account personal."), true, "runAsk status fallback keeps first feedback");
	eq(out.includes("week.sh trả “next 7 days”"), true, "runAsk status fallback keeps second feedback");
	eq(out.includes("Reload complete — continuing because a recovery directive was pending."), true, "runAsk status fallback uses last prose as answer");
	eq(out.includes("(empty response)"), false, "runAsk status fallback avoids empty response");
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
	eq(_internals.renderStatusBlock("Child", "connecting…"), "> [!jcode]+ Child\n> - connecting…\n", "status block render");
	const live = _internals.renderLiveBlock("Child", {
		introLine: "Đang xử lý...",
		timeline: [{ id: "1", text: "Đang dùng bash để kiểm tra lịch.", status: "running", startedAtMs: 0 }],
		stuckLine: "",
	});
	eq(live.includes("> - Đang xử lý..."), true, "live block includes intro line");
	eq(live.includes("> - Đang dùng bash để kiểm tra lịch."), true, "live block includes tool timeline line");
	eq(_internals.activityKey("  A   Status  "), "a status", "activity key normalizes whitespace");
	eq(_internals.shouldShowLiveStatus("opening websocket"), false, "live status hides websocket noise");
	eq(_internals.shouldShowLiveStatus("persistent jcode client running: session_x"), false, "live status hides session noise");
	eq(_internals.shouldShowLiveStatus("sending prompt to persistent jcode client"), false, "live status hides repl send noise");
	eq(_internals.shouldShowLiveStatus("thinking hard"), true, "live status keeps meaningful text");
	eq(_internals.prettifyToolName("skill_manage"), "skill", "prettify tool name");
	eq(_internals.cleanFeedbackSummary("[skill_manage] tool: bash."), "bash", "clean feedback summary");
	eq(_internals.formatToolLine({ type: "tool", name: "bash", status: "start", summary: "gtk-launch" }), "Đang dùng bash để gtk-launch.", "format tool line start");
	eq(_internals.formatToolLine({ type: "tool", name: "bash", status: "end", summary: "gtk-launch" }), "bash xong: gtk-launch.", "format tool line end");
	const timelineState = { introLine: "thinking…", timeline: [], stuckLine: "" };
	const activeId = _internals.upsertTimelineEntry(timelineState, null, "Đang dùng bash để kiểm tra lịch.", "running", 1000);
	eq(timelineState.timeline.length, 1, "timeline entry added");
	eq(_internals.buildStuckLine(timelineState, 14000).includes("Có vẻ đang chờ hơi lâu"), true, "stuck line appears after threshold");
	_internals.finalizeTimelineEntry(timelineState, activeId, "bash xong: kiểm tra lịch.", "done", 15000);
	eq(_internals.buildStuckLine(timelineState, 30000), "", "stuck line clears when no running entry");
	let rawActive: string | null = null;
	const rawLive = { introLine: "thinking…", timeline: [], stuckLine: "" };
	rawActive = _internals.absorbDeltaIntoLiveState(rawLive, rawActive, "Đang check mail tài khoản study cho tuần sau.\n", 1000);
	rawActive = _internals.absorbDeltaIntoLiveState(rawLive, rawActive, "tool: bash\n", 1001);
	rawActive = _internals.absorbDeltaIntoLiveState(rawLive, rawActive, "✓ bash · Search study mailbox f… · 210 tok\n", 1002);
	eq(rawLive.introLine, "Đang check mail tài khoản study cho tuần sau.", "raw delta feedback updates live intro");
	eq(rawLive.timeline.length, 1, "raw delta tool lines create timeline");
	eq(rawLive.timeline[0].text.includes("bash xong"), true, "raw delta completed tool is readable");
	eq(
		_internals.splitFinalAssistantText("I’m launching it now.\n✓ batch · Launch app\n  ✓ bash · run\n41s · 78.4 tps · ↑77k ↓76"),
		{ feedbacks: [], answer: "I’m launching it now." },
		"split final text strips tool tree and metrics"
	);
	eq(
		_internals.splitFinalAssistantText("First feedback.\n\nSecond feedback."),
		{ feedbacks: [], answer: "First feedback.\n\nSecond feedback." },
		"split final text keeps one prose block intact without tool separators"
	);
	eq(
		_internals.splitFinalAssistantText(
			"Mình sẽ kiểm tra nhanh lịch cá nhân chiều nay rồi tạo event 16:00 nếu không có xung đột rõ ràng.\n[skill_manage]\n\n  tool: bash\n  ✓ bash · Check personal calendar … · 32 tok\n    $ cd ~/.claude/s…-24T17:30:00+\n  ✓ bash · Create personal calenda… · 116 tok\n    $ GOG_KEYRING_PA…00' --to '202\n\nĐã đặt lịch Đi nha sĩ trên calendar cá nhân:\n\n• Hôm nay 16:00-17:00\n• Tài khoản: buiquangvinh720@gmail.com\n• Không thấy xung đột lịch quanh khung giờ này."
		),
		{
			feedbacks: ["Mình sẽ kiểm tra nhanh lịch cá nhân chiều nay rồi tạo event 16:00 nếu không có xung đột rõ ràng."],
			answer: "Đã đặt lịch Đi nha sĩ trên calendar cá nhân:\n\n• Hôm nay 16:00-17:00\n• Tài khoản: buiquangvinh720@gmail.com\n• Không thấy xung đột lịch quanh khung giờ này.",
		},
		"split final text keeps prose before and after skill/tool block"
	);
	const studyMailRaw = `Đang check mail tài khoản study cho tuần sau.
Đã thấy email quan trọng. Mình check thêm keyword ngày tuần sau để không sót deadline/sự kiện.
  ✓ skill_manage · Load requested… · 791 tok

  tool: bash
  ✓ bash · Search study mailbox f… · 210 tok
    $ cd … d
Reload complete — continuing because 
a recovery directive was pending.

19s · 72.1 tps · ↑24k ↓20`;
	const parsedStudyMail = _internals.splitFinalAssistantText(studyMailRaw);
	eq(parsedStudyMail.feedbacks, ["Đang check mail tài khoản study cho tuần sau. Đã thấy email quan trọng. Mình check thêm keyword ngày tuần sau để không sót deadline/sự kiện."], "split final study mail keeps feedback before tools");
	eq(parsedStudyMail.answer, "Reload complete — continuing because a recovery directive was pending.", "split final study mail keeps recovery answer");
}

(async () => {
	testParseLine();
	testNormaliseEvent();
	testReplLineNormalisation();
	testInsertCallout();
	testSectionInternals();
	await testRunAskJcodeLiveBlock();
	await testRunAskJcodeNaturalFeedbackTrail();
	await testRunAskJcodeUsesSavedDisplayTitle();
	await testRunAskJcodeBuildsAnswerFromStatusWhenFinalTextEmpty();
	await testRunAskJcodeRespectsStatusBarStreamingToggle();
	if (failures > 0) {
		console.error(`\n${failures} TEST(S) FAILED`);
		process.exit(1);
	}
	console.log("\nAll askjcode tests passed.");
})();
