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
	/** Surface a user-visible toast. In tests we pass a stub. */
	notify?: (msg: string) => void;
	resumeSessionId?: string;
	saveSessionId?: (id: string) => void;
	provider?: string;
}

const PREFIX = "/askjcode";

/** Public entry; returns false if there is no /askjcode line under cursor. */
export async function runAskJcode(ctx: AskJcodeContext, deps: AskJcodeDeps): Promise<boolean> {
	const notify = deps.notify ?? ((m: string) => console.warn(m));
	const trigger = findTrigger(ctx.editor);
	if (!trigger) {
		notify('jcode: no "/askjcode ..." line at cursor. Type /askjcode then your question.');
		return false;
	}

	const { line, prompt, flags } = trigger;

	if (flags.has("notebooklm")) {
		notify("jcode: --notebooklm route lands in M5. Use plain /askjcode for now.");
		return false;
	}

	let composed = prompt;
	if (flags.has("vault")) {
		composed = `Context (current note):\n${ctx.noteText}\n\n---\n\nQuestion: ${prompt}`;
	}

	deps.statusBar.setText("jcode: connecting…");

	let accumulated = "";
	let sessionId = deps.resumeSessionId;
	let errored = false;

	const onEvent = (e: JcodeEvent) => {
		switch (e.type) {
			case "start":
				if (e.sessionId) {
					sessionId = e.sessionId;
					deps.saveSessionId?.(e.sessionId);
				}
				deps.statusBar.setText(`jcode: ${e.model || e.provider || "ready"} streaming…`);
				break;
			case "status":
				deps.statusBar.setText(`jcode: ${e.detail}`);
				break;
			case "delta":
				accumulated += e.text;
				deps.statusBar.setText(`jcode: ${accumulated.length} chars…`);
				break;
			case "tool":
				deps.statusBar.setText(
					`jcode: tool ${e.name} ${e.status === "start" ? "running" : "done"}`
				);
				break;
			case "end":
				if (e.text) accumulated = e.text;
				deps.statusBar.setText("jcode: done");
				break;
			case "error":
				errored = true;
				deps.statusBar.setText(`jcode: error`);
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

	insertCallout(ctx.editor, line, accumulated, errored);

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

// Exposed for tests.
export const _parseLine = parseLine;
