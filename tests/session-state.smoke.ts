import {
	deriveInitialSessionLabel,
	findSavedSessionLabel,
	normalizeSessionLabel,
	upsertSavedSession,
	_internals,
} from "../src/session-state";

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

function testNormalize() {
	eq(normalizeSessionLabel("  penguin   mode  "), "penguin mode", "normalize session label");
}

function testDerive() {
	eq(deriveInitialSessionLabel("  Thesis Chat ", "note"), "Thesis Chat", "derive prefers heading");
	eq(deriveInitialSessionLabel(null, "Robot Note"), "Robot Note", "derive falls back to note basename");
	eq(deriveInitialSessionLabel(null, null), "Conversation", "derive final fallback");
}

function testUpsert() {
	const now = "2026-05-24T00:00:00.000Z";
	const updated = upsertSavedSession(
		[
			{ id: "old", label: "Old", lastUsedAt: now },
			{ id: "keep", label: "Keep", lastUsedAt: now },
		],
		{ id: "old", label: "New Label", lastUsedAt: "2026-05-25T00:00:00.000Z" }
	);
	eq(updated[0].label, "New Label", "upsert moves updated session to front");
	eq(updated.length, 2, "upsert dedupes by id");
	eq(findSavedSessionLabel(updated, "old"), "New Label", "find saved session label");
	eq(findSavedSessionLabel(updated, "missing"), null, "find missing session label");
}

function testCap() {
	let list = [] as { id: string; label: string; lastUsedAt: string }[];
	for (let i = 0; i < _internals.MAX_SAVED_SESSIONS + 2; i++) {
		list = upsertSavedSession(list, {
			id: `s${i}`,
			label: `Session ${i}`,
			lastUsedAt: `2026-05-24T00:00:${String(i).padStart(2, "0")}.000Z`,
		});
	}
	eq(list.length, _internals.MAX_SAVED_SESSIONS, "saved sessions capped");
}

(() => {
	testNormalize();
	testDerive();
	testUpsert();
	testCap();
	if (failures > 0) {
		console.error(`\n${failures} TEST(S) FAILED`);
		process.exit(1);
	}
	console.log("\nAll session-state tests passed.");
})();
