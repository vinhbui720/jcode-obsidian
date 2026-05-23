#!/usr/bin/env bash
# Install the built plugin into the user's Obsidian vault via symlink.
# Idempotent and dev-friendly: edits to main.js in this repo show up in Obsidian
# after reloading the plugin.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VAULT="${OBSIDIAN_VAULT:-$HOME/Documents/Obsidian Vault}"
PLUGIN_DIR="$VAULT/.obsidian/plugins/jcode-obsidian"

if [ ! -d "$VAULT" ]; then
  echo "Vault not found at: $VAULT"
  echo "Set OBSIDIAN_VAULT env var to override."
  exit 1
fi

if [ ! -f "$REPO_DIR/main.js" ]; then
  echo "Build artifact main.js missing. Run: npm run build"
  exit 1
fi

mkdir -p "$PLUGIN_DIR"

link_or_copy() {
  local src="$1"
  local dst="$2"
  ln -sf "$src" "$dst"
}

link_or_copy "$REPO_DIR/main.js" "$PLUGIN_DIR/main.js"
link_or_copy "$REPO_DIR/manifest.json" "$PLUGIN_DIR/manifest.json"

# styles.css optional (no styles yet, but template-friendly).
if [ -f "$REPO_DIR/styles.css" ]; then
  link_or_copy "$REPO_DIR/styles.css" "$PLUGIN_DIR/styles.css"
fi

echo "Installed to: $PLUGIN_DIR"
echo "Open Obsidian → Settings → Community plugins → enable 'jcode'."
