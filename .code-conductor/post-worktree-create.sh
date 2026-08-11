#!/usr/bin/env bash
# Symlink node_modules from the parent repo into this worktree.
#
# Reusing the parent checkout's already-installed dependencies avoids a slow
# (and, on flaky-DNS hosts, unreliable) `npm install` in every new worktree.
#
# Run by code-conductor after creating a worktree, with cwd in the new
# worktree. CC_PARENT_PATH is set by the orchestrator to the parent checkout's
# absolute path (see code-conductor src/worktrees.ts).

set -e

if [ -e node_modules ] || [ -L node_modules ]; then
    echo "[post-worktree-create] node_modules already exists - skipping symlink."
    exit 0
fi

if [ -z "${CC_PARENT_PATH}" ]; then
    echo "[post-worktree-create] WARNING: CC_PARENT_PATH unset; skipping node_modules symlink." >&2
    exit 0
fi

PARENT_NM="${CC_PARENT_PATH}/node_modules"

if [ ! -d "$PARENT_NM" ]; then
    echo "[post-worktree-create] WARNING: ${PARENT_NM} not found; skipping node_modules symlink." >&2
    exit 0
fi

ln -s "$PARENT_NM" node_modules
echo "[post-worktree-create] Symlinked node_modules from ${PARENT_NM}."
