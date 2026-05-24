export interface SavedJcodeSession {
	id: string;
	label: string;
	lastUsedAt: string;
}

const MAX_SAVED_SESSIONS = 20;

export function normalizeSessionLabel(label: string): string {
	return label.replace(/\s+/g, " ").trim();
}

export function deriveInitialSessionLabel(sectionTitle: string | null, noteBasename: string | null): string {
	const section = normalizeSessionLabel(sectionTitle ?? "");
	if (section) return section;
	const note = normalizeSessionLabel(noteBasename ?? "");
	if (note) return note;
	return "Conversation";
}

export function upsertSavedSession(
	sessions: SavedJcodeSession[],
	session: SavedJcodeSession
): SavedJcodeSession[] {
	const cleanId = session.id.trim();
	const cleanLabel = normalizeSessionLabel(session.label);
	if (!cleanId || !cleanLabel) return sessions.slice();
	const filtered = sessions.filter((s) => s.id !== cleanId);
	filtered.unshift({ id: cleanId, label: cleanLabel, lastUsedAt: session.lastUsedAt });
	return filtered.slice(0, MAX_SAVED_SESSIONS);
}

export function findSavedSessionLabel(
	sessions: SavedJcodeSession[],
	sessionId: string
): string | null {
	const hit = sessions.find((s) => s.id === sessionId.trim());
	return hit ? hit.label : null;
}

export const _internals = { MAX_SAVED_SESSIONS };
