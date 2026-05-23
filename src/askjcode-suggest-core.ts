import type { EditorPosition } from "obsidian";

export interface AskJcodeCompletion {
	label: string;
	detail: string;
	insert: string;
}

export const ASKJCODE_COMPLETIONS: AskJcodeCompletion[] = [
	{ label: "/askjcode", detail: "Ask jcode. Submit with Ctrl/Cmd+Enter.", insert: "/askjcode " },
	{ label: "/askjcode --vault", detail: "Ask with the full current note as context.", insert: "/askjcode --vault " },
	{ label: "/askjcode --notebooklm", detail: "Reserved for the M5 knowledge backend route.", insert: "/askjcode --notebooklm " },
];

export interface SlashTrigger {
	query: string;
	start: EditorPosition;
	end: EditorPosition;
}

export function detectAskJcodeSlashTrigger(line: string, cursor: EditorPosition): SlashTrigger | null {
	const before = line.slice(0, cursor.ch);
	const slash = before.lastIndexOf("/");
	if (slash === -1) return null;
	if (slash > 0 && !/\s/.test(before[slash - 1])) return null;
	const query = before.slice(slash);
	const lower = query.toLowerCase();
	const head = lower.split(/\s+/)[0];
	const couldBeAsk = "/askjcode".startsWith(head) || lower.startsWith("/askjcode");
	const couldBeJcode = "/jcode".startsWith(head);
	if (!couldBeAsk && !couldBeJcode) return null;
	return { query, start: { line: cursor.line, ch: slash }, end: cursor };
}

export function getAskJcodeCompletions(query: string): AskJcodeCompletion[] {
	const q = query.trim().toLowerCase();
	if (q === "/" || q === "" || q.startsWith("/jcode")) return ASKJCODE_COMPLETIONS;
	return ASKJCODE_COMPLETIONS.filter((c) => c.label.toLowerCase().startsWith(q));
}
