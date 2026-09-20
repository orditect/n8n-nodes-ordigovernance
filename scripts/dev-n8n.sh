#!/usr/bin/env bash
# Dev n8n launcher with the ordigovernance community nodes synced.
# Pairs with scripts/dev-gateway.sh (gateway on :8180, n8n on :5678).
# Usage: scripts/dev-n8n.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve the node package root for either repository layout:
#   1. this script lives INSIDE the package repo (scripts/ sits next
#      to package.json) -> the package root is one level up;
#   2. this script lives in a parent workspace with the package
#      checked out at <parent>/n8n-nodes-ordigovernance.
# NEVER resolve into a nested docs-only "n8n-nodes-ordigovernance/"
# directory that may exist INSIDE the package repo: it carries no
# package.json, npm run resolves the build script through the PARENT
# package.json, and the sync's cp step then fails from the wrong CWD,
# leaving an empty package dir in custom/ (the all-nodes
# "Unrecognized node type: CUSTOM.*" failure mode).
if [[ -f "$SCRIPT_DIR/../package.json" ]]; then
  NODES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [[ -f "$SCRIPT_DIR/../n8n-nodes-ordigovernance/package.json" ]]; then
  NODES_DIR="$(cd "$SCRIPT_DIR/../n8n-nodes-ordigovernance" && pwd)"
else
  echo "ERROR: node package not found (no package.json above $SCRIPT_DIR and no n8n-nodes-ordigovernance/ sibling)." >&2
  exit 1
fi

# 1. Build the node package (tsc + icons).
cd "$NODES_DIR"
npm run build

# Hard gate: die loudly when the build produced no node output, so a
# half-run can never leave an empty package dir in custom/.
if [[ ! -f "$NODES_DIR/dist/nodes/OrdigovernanceRun/OrdigovernanceRun.node.js" ]]; then
  echo "ERROR: npm run build produced no dist/nodes output; fix the build first." >&2
  exit 1
fi

# 2. Sync a PHYSICAL copy into n8n's custom extensions dir.
#    `npm install <local path>` creates a symlink; a physical copy is
#    loaded by every n8n version and survives editor-side rebuilds.
#    All paths are absolute: the copy must never depend on the CWD.
CUSTOM_DIR="${N8N_CUSTOM_DIR:-$HOME/.n8n/custom}"
PKG_DIR="$CUSTOM_DIR/node_modules/n8n-nodes-ordigovernance"
rm -rf "$PKG_DIR"
mkdir -p "$PKG_DIR"
cp -r "$NODES_DIR/package.json" "$NODES_DIR/dist" "$PKG_DIR/"

# Verification gate: the physical copy must be loadable.
if [[ ! -f "$PKG_DIR/dist/nodes/OrdigovernanceRun/OrdigovernanceRun.node.js" ]]; then
  echo "ERROR: sync verification failed (empty copy at $PKG_DIR)." >&2
  exit 1
fi

# 3. Stop any stale n8n process so the fresh copy is what gets loaded.
pkill -f "n8n start" 2>/dev/null || true
sleep 1

# 4. Resolve the n8n binary: PATH first, then the nvm installs, then
#    the npm global root. Non-interactive shells skip nvm init, so a
#    bare `exec n8n` fails here even when n8n is installed.
N8N_BIN="$(command -v n8n || true)"
if [ -z "$N8N_BIN" ]; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/n8n; do
    if [ -x "$candidate" ]; then
      N8N_BIN="$candidate"
    fi
  done
fi
if [ -z "$N8N_BIN" ]; then
  NPM_GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"
  if [ -n "$NPM_GLOBAL_ROOT" ] && [ -x "$NPM_GLOBAL_ROOT/n8n/bin/n8n" ]; then
    N8N_BIN="$NPM_GLOBAL_ROOT/n8n/bin/n8n"
  fi
fi
if [ -z "$N8N_BIN" ]; then
  echo "ERROR: n8n binary not found (PATH, ~/.nvm and npm global root scanned)." >&2
  exit 1
fi
echo "using n8n: $N8N_BIN"

# 5. Start n8n in the foreground.
#    N8N_COMMUNITY_PACKAGES_ENABLED=false hides the community-package
#    manager UI, including the "Install this node" banner on imported
#    workflows: the package is not on npm, so the manager can never
#    resolve it. Loading from ~/.n8n/custom is a separate mechanism
#    and is unaffected. Set it to "true" only if you rely on OTHER
#    community packages installed through the n8n UI.
export N8N_COMMUNITY_PACKAGES_ENABLED="${N8N_COMMUNITY_PACKAGES_ENABLED:-false}"
exec "$N8N_BIN" start