/**
 * Integration test: actually spawn `jcode run --ndjson` and verify our
 * StdioTransport parses the stream correctly into JcodeEvent. Slow (1 LLM call).
 * Skipped if SKIP_INTEGRATION=1.
 *
 * Run: npx tsx tests/jcode-client.integration.ts
 */
import { createTransport, JcodeEvent } from "../src/jcode-client";

if (process.env.SKIP_INTEGRATION === "1") {
	console.log("SKIPPED (SKIP_INTEGRATION=1)");
	process.exit(0);
}

(async () => {
	const t = createTransport({ kind: "stdio", jcodeBinary: "jcode" });
	const events: JcodeEvent[] = [];
	const final = await t.ask(
		{ message: "say hi in exactly 3 words", timeoutMs: 120_000 },
		(e) => {
			events.push(e);
			if (e.type === "delta") process.stdout.write(e.text);
			if (e.type === "start") console.log(`\n[start ${e.sessionId} model=${e.model}]`);
		}
	);

	console.log("\n\n--- summary ---");
	console.log("final.type:", final.type);
	if (final.type === "end") {
		console.log("final.text:", JSON.stringify(final.text));
		console.log("final.tokens:", final.tokens);
	}

	const types = new Set(events.map((e) => e.type));
	let ok = true;
	for (const required of ["start", "delta", "end"] as const) {
		if (!types.has(required)) {
			console.error(`FAIL: missing event type '${required}'`);
			ok = false;
		}
	}
	if (final.type !== "end" || !final.text || !final.text.trim()) {
		console.error("FAIL: empty/missing final text");
		ok = false;
	}
	if (ok) {
		console.log("\nIntegration PASS");
		process.exit(0);
	} else {
		process.exit(1);
	}
})().catch((err) => {
	console.error("Integration FAIL:", err);
	process.exit(1);
});
