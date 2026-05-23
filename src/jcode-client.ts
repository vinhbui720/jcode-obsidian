/**
 * jcode client abstraction.
 *
 * Two transports are supported:
 *
 *   - `stdio`: spawn `jcode run --ndjson --quiet -m <message>` as a child
 *     process and parse the NDJSON stream. Works on any machine that has the
 *     jcode CLI installed. No setup required.
 *   - `websocket`: connect to the jcode gateway (opt-in feature). Only used
 *     when the user explicitly configures it. Not yet implemented for M2;
 *     stubbed so the rest of the plugin can switch transports later.
 *
 * Both transports normalise output to a `JcodeEvent` stream. The rest of the
 * plugin only deals with `JcodeEvent`, never directly with NDJSON or WS frames.
 */
import { spawn, ChildProcess } from "child_process";
import * as readline from "readline";

/** Events surfaced to UI layers. Independent of transport. */
export type JcodeEvent =
	| { type: "start"; sessionId: string; model: string; provider: string }
	| { type: "status"; detail: string }
	| { type: "delta"; text: string }
	| { type: "tool"; name: string; status: "start" | "end"; summary?: string }
	| { type: "end"; text: string; tokens?: TokenUsage }
	| { type: "error"; message: string };

export interface TokenUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheCreate?: number;
}

export interface AskOptions {
	message: string;
	cwd?: string;
	/** Forwarded to jcode CLI as -p flag. Leave undefined to use auto. */
	provider?: string;
	/** Resume an existing session id (so the conversation keeps context). */
	resumeSessionId?: string;
	/** Timeout in ms; default 5 min. */
	timeoutMs?: number;
}

export interface JcodeTransport {
	ask(opts: AskOptions, onEvent: (e: JcodeEvent) => void): Promise<JcodeEvent>;
	cancel(): void;
}

export type TransportKind = "stdio" | "websocket";

export interface ClientConfig {
	kind: TransportKind;
	jcodeBinary: string;
	/** For websocket only. */
	host?: string;
	token?: string;
}

export function createTransport(cfg: ClientConfig): JcodeTransport {
	if (cfg.kind === "stdio") return new StdioTransport(cfg.jcodeBinary);
	if (cfg.kind === "websocket") return new WebSocketTransport(cfg.host ?? "", cfg.token ?? "");
	throw new Error(`unknown transport: ${cfg.kind as string}`);
}

class StdioTransport implements JcodeTransport {
	private child: ChildProcess | null = null;
	constructor(private bin: string) {}

	cancel() {
		if (this.child && !this.child.killed) {
			this.child.kill("SIGTERM");
		}
	}

	async ask(opts: AskOptions, onEvent: (e: JcodeEvent) => void): Promise<JcodeEvent> {
		const args = ["run", "--ndjson", "--quiet", "--no-update"];
		if (opts.provider) args.push("-p", opts.provider);
		if (opts.cwd) args.push("-C", opts.cwd);
		if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
		args.push(opts.message);

		const child = spawn(this.bin, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, JCODE_NON_INTERACTIVE: "1" },
		});
		this.child = child;
		const stdout = child.stdout!;
		const stderr = child.stderr!;

		let timer: NodeJS.Timeout | null = null;
		const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				onEvent({ type: "error", message: `jcode timed out after ${timeoutMs}ms` });
				child.kill("SIGTERM");
			}, timeoutMs);
		}

		const rl = readline.createInterface({ input: stdout });

		let finalText = "";
		let finalEvent: JcodeEvent | null = null;
		let stderrBuf = "";
		stderr.on("data", (b: Buffer) => {
			stderrBuf += b.toString();
		});

		const settle = new Promise<JcodeEvent>((resolve, reject) => {
			rl.on("line", (line) => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line) as Record<string, unknown>;
					const norm = normaliseEvent(event);
					if (!norm) return;
					if (norm.type === "delta") finalText += norm.text;
					if (norm.type === "end") {
						finalEvent = { ...norm, text: norm.text || finalText };
					}
					onEvent(norm);
				} catch (err) {
					// Non-JSON lines: surface as raw delta so user sees something.
					onEvent({ type: "delta", text: line });
					finalText += line;
				}
			});

			child.on("error", (err) => {
				if (timer) clearTimeout(timer);
				const e: JcodeEvent = { type: "error", message: err.message };
				onEvent(e);
				reject(err);
			});

			child.on("close", (code) => {
				if (timer) clearTimeout(timer);
				this.child = null;
				if (finalEvent) {
					resolve(finalEvent);
					return;
				}
				if (code === 0) {
					const e: JcodeEvent = { type: "end", text: finalText };
					onEvent(e);
					resolve(e);
				} else {
					const msg =
						stderrBuf.trim().slice(-500) ||
						`jcode exited with code ${code ?? "?"}`;
					const e: JcodeEvent = { type: "error", message: msg };
					onEvent(e);
					reject(new Error(msg));
				}
			});
		});

		return settle;
	}
}

/**
 * Stub WebSocket transport. Surface intentionally identical to stdio so that
 * settings.transport='websocket' can be switched on without changing callers.
 * Actual WS handshake will be added in a follow-up commit once the gateway
 * protocol is documented.
 */
class WebSocketTransport implements JcodeTransport {
	constructor(_host: string, _token: string) {}
	cancel() {}
	async ask(_opts: AskOptions, onEvent: (e: JcodeEvent) => void): Promise<JcodeEvent> {
		const e: JcodeEvent = {
			type: "error",
			message:
				"WebSocket transport is not implemented yet. Set transport=stdio in jcode settings, or enable jcode gateway and wait for M2.1.",
		};
		onEvent(e);
		throw new Error(e.type === "error" ? e.message : "unknown");
	}
}

/**
 * Normalise jcode's wire events to the simpler `JcodeEvent` shape.
 * Documented forms we observed from `jcode run --ndjson`:
 *   {type:"start", session_id, model, provider}
 *   {type:"status_detail", detail}
 *   {type:"connection_phase", phase}    -> dropped (noise)
 *   {type:"connection_type", connection} -> dropped
 *   {type:"text_delta", text}
 *   {type:"message_end"}
 *   {type:"tokens", input, output, cache_read_input, cache_creation_input}
 *   {type:"done", text, usage, ...}     -> final summary
 *   {type:"tool_call_start"|"tool_call_end", name, summary?}
 */
function normaliseEvent(raw: Record<string, unknown>): JcodeEvent | null {
	const type = String(raw.type ?? "");
	switch (type) {
		case "start":
			return {
				type: "start",
				sessionId: String(raw.session_id ?? ""),
				model: String(raw.model ?? ""),
				provider: String(raw.provider ?? ""),
			};
		case "status_detail":
			return { type: "status", detail: String(raw.detail ?? "") };
		case "text_delta":
			return { type: "delta", text: String(raw.text ?? "") };
		case "tool_call_start":
			return {
				type: "tool",
				status: "start",
				name: String(raw.name ?? ""),
				summary: raw.summary ? String(raw.summary) : undefined,
			};
		case "tool_call_end":
			return {
				type: "tool",
				status: "end",
				name: String(raw.name ?? ""),
				summary: raw.summary ? String(raw.summary) : undefined,
			};
		case "done": {
			const usage = (raw.usage as Record<string, number> | undefined) ?? {};
			return {
				type: "end",
				text: String(raw.text ?? ""),
				tokens: {
					input: usage.input_tokens,
					output: usage.output_tokens,
					cacheRead: usage.cache_read_input_tokens,
					cacheCreate: usage.cache_creation_input_tokens,
				},
			};
		}
		case "message_end":
			// Handled by `done`; ignore to avoid duplicate end events.
			return null;
		case "tokens":
			return null; // folded into "done"
		case "connection_phase":
		case "connection_type":
			return null; // noise
		case "error":
			return { type: "error", message: String(raw.message ?? "unknown jcode error") };
		default:
			return null;
	}
}

// Exposed for tests.
export const _normaliseEvent = normaliseEvent;
