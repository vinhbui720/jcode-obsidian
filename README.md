# jcode-obsidian

An Obsidian plugin that joins the [jcode](https://github.com/1jehuang/jcode) swarm as a peer client.

When Obsidian is open, the plugin:

- Broadcasts the **current note** as context to all jcode clients (TUI, panel-tauri, VSCode), so any jcode session knows "the user is looking at note X".
- Lets you type `/askjcode <question>` inline and hit `Ctrl+Enter` to send the question to the jcode server, with the response inserted as a callout block.
- Provides script-driven vault automations (TODO aggregator, auto-tagging) that do not consume AI context.
- Optionally bridges to NotebookLM for vault-grounded chat that does not burn jcode context.

## Status

Pre-MVP scaffold. See `docs/PLAN.md` for the implementation roadmap.

## Architecture

```
┌─ Obsidian (when open) ────────────────────────────┐
│  jcode-obsidian plugin                            │
│    Layer 1: Context Broadcast (file-based)        │
│    Layer 2: Interactive (WebSocket / pairing)     │
│    Layer 3: Local Scripts (no AI)                 │
└─────────────────┬─────────────────────────────────┘
                  │
   writes ────────┼──────── ws:// pair
                  ▼                      ▼
       ~/.local/state/             jcode server 'lake'
       jcode-panel/contexts/       (WebSocket gateway)
       obsidian.json                   │
                  ▲                    │ swarm IPC
       polled by ─┘                    ▼
                              panel-tauri, TUI, VSCode ext
```

## Install (dev)

```bash
npm install
npm run build
npm run install-local   # symlinks dist into your vault's .obsidian/plugins/
```

## License

MIT
