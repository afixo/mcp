#!/usr/bin/env node
/**
 * Turns one page of the `documents` repo (Starlight .md/.mdx) into the plain markdown bundled in
 * docs/ — used by scripts/sync-docs.sh, never at runtime.
 *
 *   node scripts/mdx-to-md.mjs <source path relative to src/content/docs> < page.mdx > docs/<slug>.md
 *
 * What changes, deterministically:
 *   - `import … from '@astrojs/starlight/components'` lines are dropped.
 *   - <Aside type="…" title="…">…</Aside> and `:::note[Title] … :::` become a blockquote led by the title.
 *   - <Steps>…</Steps> wrappers disappear (the ordered list inside stays).
 *   - <Tabs><TabItem label="…">…</TabItem></Tabs> become a bold label followed by the tab's content.
 *   - Site-relative links `](/concepts/purposes/)` become absolute `](https://docs.afixo.io/concepts/purposes/)`.
 *   - The front-matter gains `url:` — the page's canonical address on docs.afixo.io — and keeps `title`
 *     and `description`, which src/docs.ts reads at module load.
 * Everything else is copied verbatim.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SITE = "https://docs.afixo.io";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const source = process.argv[2];
  if (!source) {
    console.error("usage: mdx-to-md.mjs <source path> < input.mdx > output.md");
    process.exit(2);
  }
  process.stdout.write(convert(readFileSync(0, "utf8"), source));
}

/**
 * @param {string} text
 * @param {string} sourcePath e.g. "api/machine.mdx"
 */
export function convert(text, sourcePath) {
  const lines = text.split("\n");
  const out = [];
  /** open wrappers; each entry is { kind, quote } — `quote` wrappers prefix their body with "> " */
  const stack = [];
  let inFrontMatter = false;
  let frontMatterDone = false;

  const depth = () => stack.filter((s) => s.kind !== "Steps").length;
  const quoting = () => stack.some((s) => s.quote);

  for (const raw of lines) {
    // --- front-matter: copied, plus the canonical URL ---
    if (!frontMatterDone) {
      if (!inFrontMatter && raw.trim() === "---" && out.length === 0) {
        inFrontMatter = true;
        out.push(raw);
        continue;
      }
      if (inFrontMatter) {
        if (raw.trim() === "---") {
          out.push(`url: ${pageUrl(sourcePath)}`);
          out.push(raw);
          inFrontMatter = false;
          frontMatterDone = true;
        } else {
          out.push(raw);
        }
        continue;
      }
      frontMatterDone = true; // no front-matter at all
    }

    // --- MDX imports ---
    if (/^import\s.*\sfrom\s+['"][^'"]+['"];?\s*$/.test(raw)) continue;

    const stripped = raw.replace(/^\s+/, "");
    const leadingSpaces = raw.slice(0, raw.length - raw.trimStart().length).replace(/\t/g, "");

    // --- component wrappers ---
    let m;
    if ((m = /^<Aside\b([^>]*)>\s*$/.exec(stripped))) {
      const title = attr(m[1], "title") ?? capitalise(attr(m[1], "type") ?? "note");
      blank(out);
      out.push(`${leadingSpaces}> **${title}**`);
      out.push(`${leadingSpaces}>`);
      stack.push({ kind: "Aside", quote: true });
      continue;
    }
    if (/^<\/Aside>\s*$/.test(stripped)) {
      stack.pop();
      blank(out);
      continue;
    }
    if ((m = /^:::(\w+)(?:\[([^\]]*)\])?\s*$/.exec(stripped))) {
      const title = m[2] ?? capitalise(m[1]);
      blank(out);
      out.push(`${leadingSpaces}> **${title}**`);
      out.push(`${leadingSpaces}>`);
      stack.push({ kind: "Directive", quote: true });
      continue;
    }
    if (/^:::\s*$/.test(stripped) && stack.at(-1)?.kind === "Directive") {
      stack.pop();
      blank(out);
      continue;
    }
    if (/^<\/?Steps>\s*$/.test(stripped)) {
      if (stripped.startsWith("</")) stack.pop();
      else stack.push({ kind: "Steps", quote: false });
      blank(out);
      continue;
    }
    if (/^<Tabs>\s*$/.test(stripped)) {
      stack.push({ kind: "Tabs", quote: false });
      blank(out);
      continue;
    }
    if (/^<\/Tabs>\s*$/.test(stripped)) {
      stack.pop();
      blank(out);
      continue;
    }
    if ((m = /^<TabItem\b([^>]*)>\s*$/.exec(stripped))) {
      blank(out);
      out.push(`${leadingSpaces}**${attr(m[1], "label") ?? "Tab"}**`);
      out.push("");
      stack.push({ kind: "TabItem", quote: false });
      continue;
    }
    if (/^<\/TabItem>\s*$/.test(stripped)) {
      stack.pop();
      blank(out);
      continue;
    }

    // --- ordinary line: undo the wrappers' tab indentation, quote inside asides, absolute links ---
    let line = raw;
    if (depth() > 0) {
      const spaces = raw.match(/^ */)[0];
      let rest = raw.slice(spaces.length);
      for (let i = 0; i < depth() && rest.startsWith("\t"); i++) rest = rest.slice(1);
      line = spaces + rest;
    }
    line = line.replace(/\]\(\/(?!\/)/g, `](${SITE}/`);
    if (quoting()) {
      const spaces = line.match(/^ */)[0];
      const rest = line.slice(spaces.length);
      line = rest.length > 0 ? `${spaces}> ${rest}` : `${spaces}>`;
    }
    out.push(line);
  }

  // collapse runs of blank lines, drop trailing ones, end with one newline
  const collapsed = [];
  for (const line of out) {
    if (line.trim() === "" && collapsed.at(-1)?.trim() === "") continue;
    collapsed.push(line.replace(/[ \t]+$/, ""));
  }
  while (collapsed.at(-1)?.trim() === "") collapsed.pop();
  return `${collapsed.join("\n")}\n`;
}

function pageUrl(sourcePath) {
  const path = sourcePath.replace(/\.(mdx?|md)$/, "").replace(/\/index$/, "");
  return `${SITE}/${path}/`;
}

/** Pushes one blank line unless the output already ends with one. */
function blank(out) {
  if (out.length > 0 && out.at(-1).trim() !== "") out.push("");
}

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? m[1] : undefined;
}

function capitalise(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
