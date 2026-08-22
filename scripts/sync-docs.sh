#!/usr/bin/env bash
# Refreshes the documentation bundled into the Worker (docs/*.md — the afixo://docs/<slug> resources
# and what afixo_search_docs searches) from the `documents` repo, the source of docs.afixo.io.
#
#   scripts/sync-docs.sh [path/to/documents/src/content/docs]    # default: ../documents/src/content/docs
#
# Each page goes through scripts/mdx-to-md.mjs (MDX components → plain markdown, relative links →
# absolute, `url:` added to the front-matter). The copies are committed: review the diff, then commit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${1:-$ROOT/../documents/src/content/docs}"
DEST="$ROOT/docs"

if [ ! -d "$SRC" ]; then
  echo "sync-docs: source directory not found: $SRC" >&2
  echo "           clone git@github.com:afixo/documents.git next to this repo, or pass its src/content/docs path" >&2
  exit 1
fi

# "<source page relative to src/content/docs>:<slug>" — the slug names both docs/<slug>.md and the
# MCP resource afixo://docs/<slug>. Adding a page here also needs an import in src/docs.ts.
PAGES=(
  "getting-started.mdx:getting-started"
  "api/overview.md:api-overview"
  "api/machine.mdx:api-machine"
  "concepts/purposes.md:purposes"
  "concepts/disclosure-rules.md:disclosure-rules"
  "concepts/decision-algorithm.md:decision-algorithm"
)

mkdir -p "$DEST"
for entry in "${PAGES[@]}"; do
  page="${entry%%:*}"
  slug="${entry##*:}"
  if [ ! -f "$SRC/$page" ]; then
    echo "sync-docs: missing source page: $SRC/$page" >&2
    exit 1
  fi
  node "$ROOT/scripts/mdx-to-md.mjs" "$page" < "$SRC/$page" > "$DEST/$slug.md"
  echo "docs/$slug.md  <-  $page"
done
