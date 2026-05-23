/**
 * Smoke test for ContextBroadcaster.
 * Run: npx tsx tests/context-broadcaster.smoke.ts
 * Exits 0 on pass, 1 on fail.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ContextBroadcaster, ViewWithEditor } from "../src/context-broadcaster";

interface BuildArgs {
	hasFile: boolean;
	selection: string;
	tagsFromCache?: string[];
	frontmatter?: Record<string, unknown>;
	cursorLine?: number;
	cursorCh?: number;
}

function buildMockApp(args: BuildArgs) {
	const view: ViewWithEditor | null = args.hasFile
		? {
				file: { path: "Notes/IELTS/band-7.md", basename: "band-7" },
				editor: {
					getCursor: () => ({ line: args.cursorLine ?? 4, ch: args.cursorCh ?? 12 }),
					getSelection: () => args.selection,
				},
		  }
		: null;

	const app = {
		vault: {
			getName: () => "MockVault",
			adapter: { basePath: "/home/test/Documents/MockVault" },
		},
		metadataCache: {
			getFileCache: () => ({
				tags: (args.tagsFromCache ?? []).map((t) => ({ tag: t })),
				frontmatter: args.frontmatter ?? undefined,
			}),
		},
	};

	return { app, viewResolver: () => view };
}

async function readJson(p: string) {
	const raw = await fs.promises.readFile(p, "utf8");
	return JSON.parse(raw) as Record<string, unknown>;
}

async function withTempFile<T>(fn: (p: string) => Promise<T>): Promise<T> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "jcode-obs-test-"));
	const file = path.join(dir, "obsidian.json");
	try {
		return await fn(file);
	} finally {
		await fs.promises.rm(dir, { recursive: true, force: true });
	}
}

let failures = 0;
function eq<T>(actual: T, expected: T, label: string) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		failures++;
		console.error(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`);
	} else {
		console.log(`PASS ${label}`);
	}
}
function contains(actual: string, needle: string, label: string) {
	if (!actual.includes(needle)) {
		failures++;
		console.error(`FAIL ${label}: '${needle}' not in '${actual}'`);
	} else {
		console.log(`PASS ${label}`);
	}
}

async function testHappyPath() {
	await withTempFile(async (file) => {
		const { app, viewResolver } = buildMockApp({
			hasFile: true,
			selection: "band 7 means listening 6.0+",
			tagsFromCache: ["#ielts"],
			frontmatter: { tags: ["study"], status: "in-progress" },
			cursorLine: 9,
			cursorCh: 3,
		});
		const b = new ContextBroadcaster(app as never, {
			filePath: file,
			maxSelectionChars: 12000,
			viewResolver,
		});
		b.scheduleWrite();
		await new Promise((r) => setTimeout(r, 300));

		const payload = await readJson(file);
		eq(payload.app, "obsidian", "happy.app");
		eq(payload.line, 10, "happy.line (1-indexed)");
		eq(payload.column, 4, "happy.column (1-indexed)");
		eq(payload.selection, "band 7 means listening 6.0+", "happy.selection");
		eq(payload.noteTitle, "band-7", "happy.noteTitle");
		eq(payload.vaultName, "MockVault", "happy.vaultName");
		contains(payload.file as string, "Notes/IELTS/band-7.md", "happy.file path joined");
		eq(payload.tags, ["#ielts", "#study"], "happy.tags merged from cache+frontmatter");
		eq((payload.frontmatter as Record<string, unknown>).status, "in-progress", "happy.frontmatter passthrough");
	});
}

async function testNoActiveFile() {
	await withTempFile(async (file) => {
		const { app, viewResolver } = buildMockApp({ hasFile: false, selection: "" });
		const b = new ContextBroadcaster(app as never, {
			filePath: file,
			maxSelectionChars: 12000,
			viewResolver,
		});
		b.scheduleWrite();
		await new Promise((r) => setTimeout(r, 300));
		const payload = await readJson(file);
		eq(payload.app, "obsidian", "nofile.app");
		eq(payload.file, "", "nofile.file empty");
		eq(payload.vaultName, "MockVault", "nofile.vaultName still present");
	});
}

async function testSelectionTruncation() {
	await withTempFile(async (file) => {
		const big = "x".repeat(20000);
		const { app, viewResolver } = buildMockApp({ hasFile: true, selection: big });
		const b = new ContextBroadcaster(app as never, {
			filePath: file,
			maxSelectionChars: 500,
			viewResolver,
		});
		b.scheduleWrite();
		await new Promise((r) => setTimeout(r, 300));
		const payload = await readJson(file);
		eq((payload.selection as string).length, 500, "trunc.selection length");
	});
}

async function testDedup() {
	await withTempFile(async (file) => {
		const { app, viewResolver } = buildMockApp({ hasFile: true, selection: "same" });
		const b = new ContextBroadcaster(app as never, {
			filePath: file,
			maxSelectionChars: 12000,
			viewResolver,
		});
		b.scheduleWrite();
		await new Promise((r) => setTimeout(r, 300));
		const stat1 = await fs.promises.stat(file);

		// Need slight delay or filesystem might give us same mtime even on rewrite.
		await new Promise((r) => setTimeout(r, 50));

		b.scheduleWrite();
		await new Promise((r) => setTimeout(r, 300));
		const stat2 = await fs.promises.stat(file);
		eq(stat2.mtimeMs, stat1.mtimeMs, "dedup.no rewrite on identical payload");
	});
}

async function testOfflineMarker() {
	await withTempFile(async (file) => {
		const { app, viewResolver } = buildMockApp({ hasFile: true, selection: "x" });
		const b = new ContextBroadcaster(app as never, {
			filePath: file,
			maxSelectionChars: 12000,
			viewResolver,
		});
		await b.writeOfflineMarker();
		const payload = await readJson(file);
		eq(payload.online, false, "offline.flag set");
		eq(payload.file, "", "offline.file empty");
	});
}

async function testAtomicWriteSurvivesMkdir() {
	await withTempFile(async (file) => {
		// Force a non-existent parent dir.
		const deep = path.join(path.dirname(file), "a", "b", "c", "obsidian.json");
		const { app, viewResolver } = buildMockApp({ hasFile: true, selection: "x" });
		const b = new ContextBroadcaster(app as never, {
			filePath: deep,
			maxSelectionChars: 12000,
			viewResolver,
		});
		b.scheduleWrite();
		await new Promise((r) => setTimeout(r, 300));
		const stat = await fs.promises.stat(deep);
		eq(stat.isFile(), true, "atomic.created nested path");
	});
}

(async () => {
	console.log("ContextBroadcaster smoke tests\n");
	await testHappyPath();
	await testNoActiveFile();
	await testSelectionTruncation();
	await testDedup();
	await testOfflineMarker();
	await testAtomicWriteSurvivesMkdir();
	if (failures > 0) {
		console.error(`\n${failures} TEST(S) FAILED`);
		process.exit(1);
	}
	console.log("\nAll tests passed.");
})();
