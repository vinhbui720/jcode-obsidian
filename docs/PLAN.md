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

## M4 shipped: B2 auto-tag from title (2026-05-23)

Auto-tag is implemented as a low-token jcode call:

- Input is only note title + deduped existing tag pool, capped to 80 tags.
- Output contract is strict JSON: `{ "tags": [...] }`, 1-3 tags.
- Default UX is `suggest`, not auto-write. User can run **Auto-tag: apply last suggestion**.
- `auto` mode is opt-in and writes `fm.tags` through Obsidian `processFrontMatter`.
- New-note trigger waits 8s so metadata and title settle.

## M6 shipped: B5 spaced-repetition picker (2026-05-23)

Spaced repetition is intentionally script-only, zero AI cost:

- Reads frontmatter `last-reviewed`, `review-interval-days`, `spaced-rep`, `tags` and file `mtime`.
- Never-reviewed notes are highest priority.
- Reviewed notes rank by overdue days, edit age, and optional `#spaced-rep` boost.
- Anti-clustering penalty reduces repeat picks from the same folder.
- Writes a managed block to `today-review.md` by default:
  `<!-- jcode-spaced-rep:start --> ... <!-- jcode-spaced-rep:end -->`.
- Preserves user text outside the managed block.
- Commands:
  - **Spaced-rep: rebuild today's picks now**
  - **Spaced-rep: mark current note as reviewed today**
- Runs once per day on plugin load using plugin data key `lastSpacedRepRunDate`.

## M5 pivot: SurfSense as NotebookLM alternative (2026-05-23)

User proposed <https://github.com/MODSetter/SurfSense> as an alternative to NotebookLM.
This looks better for the long-term A2 sidebar than NotebookLM browser automation:

- SurfSense is open source and self-hostable.
- It explicitly supports Obsidian/local-folder sync, so the vault can be indexed without scraping NotebookLM UI.
- It supports cited answers and hybrid search, matching the A2 requirement.
- It has a `surfsense_backend` service, likely a cleaner REST/FastAPI integration surface than the NotebookLM skill's Playwright session.

Updated M5 direction:

- Rename implementation concept from `NotebookLMClient` to backend-neutral `KnowledgeBackend`.
- Settings should include `knowledgeBackend: "surfsense" | "notebooklm" | "jcode"`.
- Prefer SurfSense if the user has a local/cloud SurfSense URL + token configured.
- Keep NotebookLM as fallback via existing `/notebooklm` skill, not primary.
- Do not bundle or install SurfSense inside the plugin; plugin should only call its API and document how to point SurfSense Desktop/local-folder sync at the Obsidian vault.
