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

## Milestone commits

- `M0`: scaffold (this commit).
- `M1`: A3 context broadcast working, verified.
- `M2`: pairing flow + `/askjcode` inline command + callout insert.
- `M3`: B3 TODO aggregator.
- `M4`: B2 auto-tag.
- `M5`: A2 NotebookLM chat sidebar.
- `M6`: B5 spaced-rep picker.
