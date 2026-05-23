import { App, Editor, EditorPosition, EditorSuggest, EditorSuggestContext, TFile } from "obsidian";
import {
	AskJcodeCompletion,
	detectAskJcodeSlashTrigger,
	getAskJcodeCompletions,
} from "./askjcode-suggest-core";

export class AskJcodeSuggest extends EditorSuggest<AskJcodeCompletion> {
	constructor(app: App) {
		super(app);
	}

	onTrigger(cursor: EditorPosition, editor: Editor, file: TFile): EditorSuggestContext | null {
		const line = editor.getLine(cursor.line);
		const trigger = detectAskJcodeSlashTrigger(line, cursor);
		if (!trigger) return null;
		return { editor, file, start: trigger.start, end: trigger.end, query: trigger.query };
	}

	getSuggestions(context: EditorSuggestContext): AskJcodeCompletion[] {
		return getAskJcodeCompletions(context.query);
	}

	renderSuggestion(value: AskJcodeCompletion, el: HTMLElement): void {
		el.createDiv({ text: value.label, cls: "jcode-suggest-title" });
		el.createDiv({ text: value.detail, cls: "jcode-suggest-detail" });
	}

	selectSuggestion(value: AskJcodeCompletion): void {
		if (!this.context) return;
		this.context.editor.replaceRange(value.insert, this.context.start, this.context.end);
		this.close();
	}
}
