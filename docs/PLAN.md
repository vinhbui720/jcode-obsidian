# jcode-obsidian Implementation Plan

Decided via `/grill-me` session on 2026-05-23.

## Architectural decisions

| Decision | Choice | Reason |
|---|---|---|
| Client mode | (b) Full client embedded in plugin | Vault online only when Obsidian open; matches user mental model. |
| Transport | jcode pairing flow (WebSocket) + file-based context broadcast | Reuse existing jcode primitives; no new mesh needed. |
| Protocol | `JCODE_PANEL_PROTOCOL.md` (panel.* JSON Lines events) | Reuse panel-tauri / VSCode patterns. |
| Repo placement | Standalone repo `jcode-obsidian` | Independently publishable, remote to be added by user. |
| Build stack | esbuild + TypeScript | Obsidian official template. |
| Layer split | L1 file context, L2 WebSocket, L3 local scripts | Cheap features fast, expensive features later. |

## Feature priority

### P0 (tracer bullet, in order)

1. **A3 - Current-note context broadcast** (Layer 1)
   - Write `~/.local/state/jcode-panel/contexts/obsidian.json` on active-leaf change, file save, selection change.
   - Mirror VSCode extension shape (`app: "obsidian"`, `file`, `selection`, `workspaceRoot`).
2. **Inline `/askjcode` command** (Layer 2)
   - Trigger: type `/askjcode <question>` on a line, hit `Ctrl+Enter`.
   - Send via pairing WebSocket as `panel.prompt`.
   - Show progress in Obsidian status bar.
   - Insert response as `> [!jcode]` callout below.
   - Optional flags: `--vault` (include current note), `--notebooklm` (route to NotebookLM, later).

### P1

3. **B3 - TODO aggregator (script-only, no AI)**
   - Scan vault for unchecked `- [ ]` items + files tagged `#notdone`.
   - Write to `vault/todo.md` with backlinks.
   - Run on plugin load + file save (debounced).
4. **B2 - Auto-tag from title (low AI cost)**
   - On new note save, send `{title, existing_tag_pool}` to jcode session asking only "pick 1-3 tags from pool, or propose 1 new".
   - Apply tags to frontmatter.
5. **A2 - Chat-with-vault via NotebookLM**
   - Sidebar chat panel that routes to NotebookLM skill instead of jcode session.
   - Avoids burning jcode context on big vault RAG.
6. **B5 - Spaced-repetition picker**
   - Pick 3 notes/day based on last-reviewed timestamp + recency.
   - Write `vault/review-queue-YYYY-MM-DD.md`.

### Out of scope (skipped per user)

- B1 auto-link suggester
- B4 inbox processor
- C1-C4 mesh send-note / quick-capture (reconsider after MVP)

## M2 transport decision (2026-05-23, follow-up)

Verified state of jcode v0.12.3:

- `~/.jcode/config.toml [gateway] enabled = false port = 7643 bind_addr = "0.0.0.0"`.
  Gateway is opt-in; we cannot assume WebSocket is available on a clean install.
- `jcode://pair?host=` URL scheme exists in the binary, but the pairing handshake
  is not yet publicly documented.
- `jcode run -m <message>` and `jcode debug message <text>` both exist and stream
  JSON/text output to stdout reliably without any extra setup.

Therefore M2 ships **two transports**, with stdio as the default:

| Transport | Default? | When to use | How |
|---|---|---|---|
| `stdio` (child process) | yes | Same-machine, zero setup | spawn `jcode run --quiet -m <prompt>` |
| `websocket` (gateway pair) | opt-in | Cross-machine, real-time | requires `JCODE_GATEWAY_ENABLED=1`, then `jcode pair` |

The plugin's `askjcode` command queries `settings.transport`; both code paths
produce `panel.message`-shaped events internally so the rendering layer stays
identical.
