#!/usr/bin/env bash
# Fast check run by the Claude Code Stop hook when tracked files changed (from the repository root):
# JavaScript syntax, then an offline build into a temporary folder.
set -euo pipefail

for file in site/assets/*.js scripts/*.mjs; do
  node --check "$file"
done

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
python3 scripts/build.py --offline -o "$out" > /dev/null
