/**
 * /askjcode inline command handler.
 *
 * Flow:
 *   1. User types a line starting with `/askjcode `, then hits Ctrl+Enter.
 *   2. We detect the prompt on the current line (or selection), strip the
 *      `/askjcode` prefix, and send the remainder to the configured transport.
 *   3. While streaming, we update Obsidian's status bar with progress.
 *   4. On completion we insert a `> [!jcode]` callout block below the prompt
 *      line. Optional flags:
 *           --vault     Include current note text as additional context.
 *           --notebooklm Route via NotebookLM (M5; rejected with a polite error today).
 *
 * Design note: never write to the file while jcode is streaming. We accumulate
 * the response in memory and do a single insert at the end. This avoids
 * conflicts when the user keeps typing.
 */
import type { Editor } from "obsidian";
import { JcodeTransport, JcodeEvent, AskOptions } from "./jcode-client";

export interface AskJcodeContext {
	/** Editor for the active Markdown view. */
	editor: Editor;
	/** Full current-note text (used for --vault). */
	noteText: string;
	/** Absolute path of the current note (for jcode CLI cwd hint). */
	notePath: string | null;
	/** Vault root absolute path; used as jcode `--cwd`. */
	vaultRoot: string;
}

export interface AskJcodeDeps {
	transport: JcodeTransport;
	statusBar: {
		setText(text: string): void;
		clear(): void;
	};
	statusBarStreaming?: boolean;
	/** Surface a user-visible toast. In tests we pass a stub. */
	notify?: (msg: string) => void;
	resumeSessionId?: string;
	saveSessionId?: (id: string) => void;
	provider?: string;
	displayTitle?: string;
}

const PREFIX = "/askjcode";

/** Public entry; returns false if there is no /askjcode line under cursor. */
export async function runAskJcode(ctx: AskJcodeContext, deps: AskJcodeDeps): Promise<boolean> {
	const notify = deps.notify ?? ((m: string) => console.warn(m));
	const statusBarStreaming = deps.statusBarStreaming ?? true;
	const trigger = findTrigger(ctx.editor);
	if (!trigger) {
		notify('jcode: no "/askjcode ..." line at cursor. Type /askjcode then your question.');
		return false;
	}

	const { line, prompt, flags } = trigger;
	const title = deps.displayTitle?.trim() || findSectionTitle(ctx.editor, line) || "Conversation";

	if (flags.has("notebooklm")) {
		notify("jcode: --notebooklm route lands in M5. Use plain /askjcode for now.");
		return false;
	}

	let composed = prompt;
	if (flags.has("vault")) {
		composed = `Context (current note):\n${ctx.noteText}\n\n---\n\nQuestion: ${prompt}`;
	}

	deps.statusBar.setText("jcode: connecting…");
	const liveBlock = insertLiveStatus(ctx.editor, line, title, "thinking…");

	let accumulated = "";
	let sessionId = deps.resumeSessionId;
	let errored = false;
	const liveState = createLiveState("thinking…");
	const runState = createRunState();
	let activeEntryId: string | null = null;
	let monitorTimer: ReturnType<typeof setInterval> | null = null;
	const monitor = () => {
		liveState.stuckLine = buildStuckLine(liveState, Date.now());
		updateLiveTranscript(ctx.editor, liveBlock, title, liveState);
	};

	const onEvent = (e: JcodeEvent) => {
		switch (e.type) {
			case "start":
				if (e.sessionId) {
					sessionId = e.sessionId;
					deps.saveSessionId?.(e.sessionId);
				}
				if (statusBarStreaming) {
					deps.statusBar.setText(`jcode: ${e.model || e.provider || "ready"} streaming…`);
				}
				updateLiveTranscript(ctx.editor, liveBlock, title, liveState);
				break;
			case "status":
				if (statusBarStreaming) deps.statusBar.setText(`jcode: ${e.detail}`);
				if (shouldPersistStatusAsProse(e.detail)) pushProseLine(runState, e.detail);
				if (shouldShowLiveStatus(e.detail)) {
					liveState.introLine = cleanFeedbackLine(e.detail);
					updateLiveTranscript(ctx.editor, liveBlock, title, liveState);
				}
				break;
			case "delta":
				accumulated += e.text;
				pushDeltaText(runState, e.text);
				activeEntryId = absorbDeltaIntoLiveState(liveState, activeEntryId, e.text, Date.now());
				if (statusBarStreaming) deps.statusBar.setText(`jcode: ${accumulated.length} chars…`);
				updateLiveTranscript(ctx.editor, liveBlock, title, liveState);
				break;
			case "tool":
				if (statusBarStreaming) {
					deps.statusBar.setText(
						`jcode: tool ${e.name} ${e.status === "start" ? "running" : "done"}`
					);
				}
				if (e.status === "start") {
					flushCurrentProse(runState);
					activeEntryId = upsertTimelineEntry(liveState, activeEntryId, formatToolLine(e), "running", Date.now());
					if (!monitorTimer) monitorTimer = setInterval(monitor, 1500);
				} else {
					activeEntryId = finalizeTimelineEntry(liveState, activeEntryId, formatToolLine(e), e.status === "end" ? "done" : "error", Date.now());
					liveState.stuckLine = buildStuckLine(liveState, Date.now());
				}
				updateLiveTranscript(ctx.editor, liveBlock, title, liveState);
				break;
			case "end":
				flushCurrentProse(runState);
				if (e.text && e.text.trim().length > accumulated.trim().length) accumulated = e.text;
				if (monitorTimer) {
					clearInterval(monitorTimer);
					monitorTimer = null;
				}
				liveState.stuckLine = "";
				deps.statusBar.setText("jcode: done");
				break;
			case "error":
				errored = true;
				flushCurrentProse(runState);
				if (monitorTimer) {
					clearInterval(monitorTimer);
					monitorTimer = null;
				}
				deps.statusBar.setText(`jcode: error`);
				activeEntryId = finalizeTimelineEntry(liveState, activeEntryId, cleanFeedbackLine(e.message), "error", Date.now());
				liveState.stuckLine = "";
				updateLiveTranscript(ctx.editor, liveBlock, title, liveState);
				break;
		}
	};

	const askOpts: AskOptions = {
		message: composed,
		cwd: ctx.vaultRoot || undefined,
		provider: deps.provider,
		resumeSessionId: sessionId,
	};

	try {
		await deps.transport.ask(askOpts, onEvent);
	} catch (err) {
		errored = true;
		accumulated =
			accumulated ||
				`jcode error: ${err instanceof Error ? err.message : String(err)}`;
	}
	if (monitorTimer) clearInterval(monitorTimer);

	replaceLiveStatusWithCallout(ctx.editor, liveBlock, title, accumulated, errored, runState);

	setTimeout(() => deps.statusBar.clear(), 4000);
	return true;
}

interface Trigger {
	/** Zero-indexed line where the /askjcode prefix appears. */
	line: number;
	prompt: string;
	flags: Set<string>;
}

/**
 * Look at the line containing the cursor. If it (or any selected line) starts
 * with `/askjcode`, parse out flags and the prompt.
 */
export function findTrigger(editor: Editor): Trigger | null {
	const cursor = editor.getCursor();
	// If user has a multi-line selection, use the first line that matches.
	if (editor.somethingSelected()) {
		const sel = editor.getSelection();
		const lines = sel.split("\n");
		const startLine = editor.getCursor("from").line;
		for (let i = 0; i < lines.length; i++) {
			const parsed = parseLine(lines[i]);
			if (parsed) return { line: startLine + i, ...parsed };
		}
	}

	const text = editor.getLine(cursor.line);
	const parsed = parseLine(text);
	if (parsed) return { line: cursor.line, ...parsed };
	return null;
}

function parseLine(raw: string): { prompt: string; flags: Set<string> } | null {
	const trimmed = raw.trimStart();
	if (!trimmed.startsWith(PREFIX)) return null;
	const rest = trimmed.slice(PREFIX.length).trim();
	if (!rest) return { prompt: "", flags: new Set() };

	const tokens = rest.split(/\s+/);
	const flags = new Set<string>();
	const promptTokens: string[] = [];
	for (const t of tokens) {
		if (t.startsWith("--")) flags.add(t.slice(2));
		else promptTokens.push(t);
	}
	return { prompt: promptTokens.join(" "), flags };
}

/**
 * Insert the rendered callout after the trigger line.
 * If the next line already has content, prepend a blank line so the callout
 * doesn't visually merge with following text.
 */
export function insertCallout(
	editor: Editor,
	triggerLine: number,
	text: string,
	errored: boolean
) {
	const kind = errored ? "danger" : "jcode";
	const label = errored ? "jcode error" : "jcode";
	const safe = text.trim() || (errored ? "(no output)" : "(empty response)");
	const quoted = safe
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");
	const callout = `> [!${kind}]+ ${label}\n${quoted}\n`;

	const insertAtLine = triggerLine + 1;
	const lineCount = editor.lineCount();
	const needsLeadingBlank =
		insertAtLine < lineCount && editor.getLine(insertAtLine).trim() !== "";
	const block = (needsLeadingBlank ? "" : "") + callout + (needsLeadingBlank ? "\n" : "");

	editor.replaceRange(
		block,
		{ line: insertAtLine, ch: 0 },
		{ line: insertAtLine, ch: 0 }
	);
}

interface LiveBlock {
	startLine: number;
	lineCount: number;
}

interface LiveState {
	introLine: string;
	timeline: LiveTimelineEntry[];
	stuckLine: string;
}

interface LiveTimelineEntry {
	id: string;
	text: string;
	status: "running" | "done" | "error";
	startedAtMs: number;
}

interface RunState {
	proseSegments: string[];
	currentProseLines: string[];
}

function insertLiveStatus(
	editor: Editor,
	triggerLine: number,
	title: string,
	status: string
): LiveBlock {
	const insertAtLine = triggerLine + 1;
	const block = renderLiveBlock(title, { introLine: status, timeline: [], stuckLine: "" });
	editor.replaceRange(block, { line: insertAtLine, ch: 0 }, { line: insertAtLine, ch: 0 });
	return { startLine: insertAtLine, lineCount: block.split("\n").length - 1 };
}

function updateLiveTranscript(
	editor: Editor,
	live: LiveBlock,
	title: string,
	state: LiveState
) {
	const block = renderLiveBlock(title, state);
	replaceLiveBlock(editor, live, block);
}

function replaceLiveStatusWithCallout(
	editor: Editor,
	live: LiveBlock,
	title: string,
	text: string,
	errored: boolean,
	runState: RunState
) {
	const kind = errored ? "danger" : "note";
	const renderedKind = errored ? "danger" : "jcode";
	const label = errored ? `${title} error` : title;
	const parsed = splitFinalAssistantText(text);
	const structured = buildStructuredResult(runState);
	const feedbacks = errored
		? []
		: (structured.feedbacks.length > 0 ? structured.feedbacks : parsed.feedbacks);
	const parsedAnswer = parsed.answer.trim();
	const structuredAnswer = structured.answer.trim();
	const preferredAnswer = parsedAnswer || structuredAnswer;
	const safe = errored
		? (text.trim() || "(no output)")
		: (preferredAnswer || "(empty response)");
	const lines = [`> [!${renderedKind}]+ ${label}`];
	for (const feedback of feedbacks) lines.push(`> - ${feedback}`);
	if (feedbacks.length > 0) lines.push(">");
	for (const l of safe.split("\n")) lines.push(`> ${l}`);
	replaceLiveBlock(editor, live, `${lines.join("\n")}\n`);
}

function replaceLiveBlock(editor: Editor, live: LiveBlock, replacement: string) {
	editor.replaceRange(
		replacement,
		{ line: live.startLine, ch: 0 },
		{ line: live.startLine + live.lineCount, ch: 0 }
	);
	live.lineCount = replacement.split("\n").length - 1;
}

function renderStatusBlock(title: string, status: string): string {
	return `> [!jcode]+ ${title}\n> - ${status}\n`;
}

function renderLiveBlock(title: string, state: LiveState): string {
	const lines = [`> [!jcode]+ ${title}`];
	if (state.introLine.trim()) lines.push(`> - ${state.introLine.trim()}`);
	for (const entry of state.timeline) lines.push(`> - ${entry.text}`);
	if (state.stuckLine.trim()) lines.push(`> - ${state.stuckLine.trim()}`);
	return `${lines.join("\n")}\n`;
}

function createLiveState(toolLine: string): LiveState {
	return { introLine: toolLine, timeline: [], stuckLine: "" };
}

function createRunState(): RunState {
	return { proseSegments: [], currentProseLines: [] };
}

function upsertTimelineEntry(
	state: LiveState,
	activeEntryId: string | null,
	text: string,
	status: "running" | "done" | "error",
	nowMs: number
): string {
	if (activeEntryId) {
		const entry = state.timeline.find((x) => x.id === activeEntryId);
		if (entry) {
			entry.text = text;
			entry.status = status;
			return activeEntryId;
		}
	}
	const id = `tool-${nowMs}-${state.timeline.length}`;
	state.timeline.push({ id, text, status, startedAtMs: nowMs });
	return id;
}

function finalizeTimelineEntry(
	state: LiveState,
	activeEntryId: string | null,
	text: string,
	status: "done" | "error",
	nowMs: number
): string | null {
	if (!activeEntryId) {
		const id = `tool-${nowMs}-${state.timeline.length}`;
		state.timeline.push({ id, text, status, startedAtMs: nowMs });
		return null;
	}
	const entry = state.timeline.find((x) => x.id === activeEntryId);
	if (entry) {
		entry.text = text;
		entry.status = status;
	}
	return null;
}

function buildStuckLine(state: LiveState, nowMs: number): string {
	const active = [...state.timeline].reverse().find((x) => x.status === "running");
	if (!active) return "";
	const elapsed = nowMs - active.startedAtMs;
	if (elapsed < 12_000) return "";
	return `Có vẻ đang chờ hơi lâu: ${active.text}`;
}

function formatToolLine(e: Extract<JcodeEvent, { type: "tool" }>): string {
	const name = e.name || "tool";
	const label = prettifyToolName(name);
	if (e.status === "start") {
		return e.summary
			? `Đang dùng ${label} để ${cleanFeedbackSummary(e.summary)}.`
			: `Đang dùng ${label}...`;
	}
	return e.summary
		? `${label} xong: ${cleanFeedbackSummary(e.summary)}.`
		: `${label} đã xong.`;
}

function shouldShowLiveStatus(detail: string): boolean {
	const s = detail.trim().toLowerCase();
	if (!s) return false;
	if (s.includes("opening websocket")) return false;
	if (s.includes("persistent jcode client running")) return false;
	if (s.includes("sending prompt to persistent jcode client")) return false;
	if (s.includes("session_")) return false;
	return true;
}

function absorbDeltaIntoLiveState(
	state: LiveState,
	activeEntryId: string | null,
	text: string,
	nowMs: number
): string | null {
	let active = activeEntryId;
	for (const rawLine of text.replace(/\r/g, "").split("\n")) {
		const line = cleanFeedbackLine(rawLine);
		if (!line || isMetricsLine(line) || isToolCommandLine(line)) continue;
		const tool = parseRawToolLine(line);
		if (tool) {
			active = tool.status === "start"
				? upsertTimelineEntry(state, active, tool.text, "running", nowMs)
				: finalizeTimelineEntry(state, active, tool.text, "done", nowMs);
			continue;
		}
		if (isToolTreeLine(line)) continue;
		if (shouldShowLiveStatus(line)) state.introLine = line;
	}
	state.stuckLine = buildStuckLine(state, nowMs);
	return active;
}

function parseRawToolLine(line: string): { status: "start" | "end"; text: string } | null {
	const toolStart = /^tool:\s*([a-z0-9_-]+)(?:\s*[-–—:]\s*(.+))?$/i.exec(line);
	if (toolStart) {
		const name = prettifyToolName(toolStart[1]);
		const summary = cleanFeedbackSummary(toolStart[2] ?? "");
		return { status: "start", text: summary ? `Đang dùng ${name} để ${summary}.` : `Đang dùng ${name}...` };
	}
	const done = /^[✓✔]\s+([a-z0-9_-]+)(?:\s*·\s*(.+?))?(?:\s*·\s*.+)?$/i.exec(line);
	if (done) {
		const name = prettifyToolName(done[1]);
		const summary = cleanFeedbackSummary(done[2] ?? "");
		return { status: "end", text: summary ? `${name} xong: ${summary}.` : `${name} đã xong.` };
	}
	return null;
}

function isToolCommandLine(trimmed: string): boolean {
	return /^\$\s*/.test(trimmed) || /^[a-z0-9_-]+:\s+\$\s*/i.test(trimmed);
}

function splitFinalAssistantText(raw: string): { feedbacks: string[]; answer: string } {
	const lines = raw.replace(/\r/g, "").split("\n");
	const proseSegments: string[] = [];
	let currentProse: string[] = [];

	const flushProse = () => {
		const text = normalizeProseBlock(currentProse);
		if (text) proseSegments.push(text);
		currentProse = [];
	};

	for (const rawLine of lines) {
		const trimmed = rawLine.trim();
		if (!trimmed) {
			if (currentProse.length > 0 && currentProse[currentProse.length - 1] !== "") {
				currentProse.push("");
			}
			continue;
		}
		if (isMetricsLine(trimmed)) continue;
		if (isToolTreeLine(trimmed)) {
			flushProse();
			continue;
		}
		currentProse.push(trimmed);
	}
	flushProse();
	if (proseSegments.length === 0) return { feedbacks: [], answer: "" };
	if (proseSegments.length === 1) return { feedbacks: [], answer: proseSegments[0] };
	const feedbacks = proseSegments.slice(0, -1);
	const answer = proseSegments[proseSegments.length - 1] ?? "";
	if (!answer && feedbacks.length > 0) {
		const final = feedbacks.pop() ?? "";
		return { feedbacks, answer: final };
	}
	return { feedbacks, answer };
}

function isToolTreeLine(trimmed: string): boolean {
	if (/^[┌└│├─]/.test(trimmed)) return true;
	if (/^[✓✗]\s+/.test(trimmed)) return true;
	if (/^[│└├].*[✓✗]/.test(trimmed)) return true;
	if (/^\[[a-z0-9_-]+\]$/i.test(trimmed)) return true;
	if (/^tool:\s+/i.test(trimmed)) return true;
	if (isToolCommandLine(trimmed)) return true;
	return false;
}

function isMetricsLine(trimmed: string): boolean {
	return /^\d+(?:\.\d+)?s\s+·\s+/.test(trimmed);
}

function cleanFeedbackLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function pushDeltaText(state: RunState, text: string) {
	for (const part of text.replace(/\r/g, "").split("\n")) {
		const trimmed = part.trim();
		if (!trimmed) {
			if (state.currentProseLines.length > 0 && state.currentProseLines[state.currentProseLines.length - 1] !== "") {
				state.currentProseLines.push("");
			}
			continue;
		}
		pushProseLine(state, trimmed);
	}
}

function pushProseLine(state: RunState, line: string) {
	const trimmed = cleanFeedbackLine(line);
	if (!trimmed) return;
	if (isToolTreeLine(trimmed) || isMetricsLine(trimmed)) return;
	state.currentProseLines.push(trimmed);
}

function flushCurrentProse(state: RunState) {
	const text = normalizeProseBlock(state.currentProseLines);
	if (text) state.proseSegments.push(text);
	state.currentProseLines = [];
}

function buildStructuredResult(state: RunState): { feedbacks: string[]; answer: string } {
	flushCurrentProse(state);
	if (state.proseSegments.length === 0) return { feedbacks: [], answer: "" };
	if (state.proseSegments.length === 1) return { feedbacks: [], answer: state.proseSegments[0] };
	return {
		feedbacks: state.proseSegments.slice(0, -1),
		answer: state.proseSegments[state.proseSegments.length - 1] ?? "",
	};
}

function prettifyToolName(name: string): string {
	const clean = cleanFeedbackLine(name).toLowerCase();
	if (clean === "bash") return "bash";
	if (clean === "batch") return "batch";
	if (clean === "todo") return "todo";
	if (clean === "skill_manage") return "skill";
	return clean || "tool";
}

function cleanFeedbackSummary(s: string): string {
	let text = cleanFeedbackLine(s);
	text = text.replace(/^\[[^\]]+\]\s*/i, "");
	text = text.replace(/^tool:\s*/i, "");
	text = text.replace(/[.;:,\s]+$/g, "");
	return text;
}

function shouldPersistStatusAsProse(detail: string): boolean {
	const s = cleanFeedbackLine(detail);
	if (!shouldShowLiveStatus(s)) return false;
	if (/^thinking(…|\.\.\.)?$/i.test(s)) return false;
	if (/^connected/i.test(s)) return false;
	if (/streaming/i.test(s)) return false;
	return /[.。!！?？:]$/.test(s) || s.length > 40;
}

function normalizeProseBlock(lines: string[]): string {
	if (lines.length === 0) return "";
	const pieces: string[] = [];
	let currentParagraph: string[] = [];

	const flushParagraph = () => {
		if (currentParagraph.length === 0) return;
		pieces.push(cleanFeedbackLine(currentParagraph.join(" ")));
		currentParagraph = [];
	};

	for (const raw of lines) {
		const line = raw.trim();
		if (!line) {
			flushParagraph();
			if (pieces.length > 0 && pieces[pieces.length - 1] !== "") pieces.push("");
			continue;
		}
		if (/^[•*-]\s+/.test(line)) {
			flushParagraph();
			pieces.push(line);
			continue;
		}
		currentParagraph.push(line);
	}
	flushParagraph();
	while (pieces.length > 0 && pieces[pieces.length - 1] === "") pieces.pop();
	return pieces.join("\n").trim();
}

function activityKey(s: string): string {
	return s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80) || "status";
}

function findSectionTitle(editor: Editor, triggerLine: number): string | null {
	for (let i = triggerLine; i >= 0; i--) {
		const line = editor.getLine(i);
		const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (m) return m[2].replace(/#+\s*$/, "").trim() || null;
	}
	return null;
}

// Exposed for tests.
export const _parseLine = parseLine;
export const _internals = {
	findSectionTitle,
	renderStatusBlock,
	renderLiveBlock,
	activityKey,
	shouldShowLiveStatus,
	formatToolLine,
	splitFinalAssistantText,
	prettifyToolName,
	cleanFeedbackSummary,
	shouldPersistStatusAsProse,
	buildStructuredResult,
	upsertTimelineEntry,
	finalizeTimelineEntry,
	buildStuckLine,
	absorbDeltaIntoLiveState,
};
