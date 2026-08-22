/**
 * The documentation bundled into the Worker: docs/*.md, copies of pages from the `documents` repo
 * (docs.afixo.io) refreshed by scripts/sync-docs.sh and imported here as text modules (the
 * wrangler.jsonc `rules` entry for `**\/*.md`).
 *
 * Each page is an MCP resource `afixo://docs/<slug>` (text/markdown) and a search target for the
 * afixo_search_docs tool. Everything here is static and computed once per isolate: no I/O, no auth.
 */
import apiMachine from "../docs/api-machine.md";
import apiOverview from "../docs/api-overview.md";
import decisionAlgorithm from "../docs/decision-algorithm.md";
import disclosureRules from "../docs/disclosure-rules.md";
import gettingStarted from "../docs/getting-started.md";
import purposes from "../docs/purposes.md";

export const DOCS_URI = "afixo://docs";
export const DOC_URI_PREFIX = `${DOCS_URI}/`;

/** The longest snippet afixo_search_docs returns, in characters (the ellipsis included). */
export const SNIPPET_MAX = 400;
export const SEARCH_LIMIT_DEFAULT = 5;
export const SEARCH_LIMIT_MAX = 10;

export interface Doc {
  /** the resource is `afixo://docs/<slug>`; the file is docs/<slug>.md */
  slug: string;
  uri: string;
  /** front-matter `title` */
  title: string;
  /** front-matter `description` */
  description: string;
  /** the page on docs.afixo.io (front-matter `url`, written by scripts/sync-docs.sh) */
  url: string;
  /** what a resource read returns: `# <title>` followed by the page body (front-matter removed) */
  text: string;
  /** the searchable blocks: blank-line separated, a heading joined to the block after it */
  paragraphs: string[];
}

export interface DocHit {
  slug: string;
  uri: string;
  title: string;
  /** the best-matching paragraph, whitespace collapsed, at most SNIPPET_MAX characters */
  snippet: string;
}

/** In the order they are listed and, on equal search scores, ranked. */
export const DOCS: readonly Doc[] = [
  parseDoc("getting-started", gettingStarted),
  parseDoc("api-overview", apiOverview),
  parseDoc("api-machine", apiMachine),
  parseDoc("purposes", purposes),
  parseDoc("disclosure-rules", disclosureRules),
  parseDoc("decision-algorithm", decisionAlgorithm),
];

export function docBySlug(slug: string): Doc | undefined {
  return DOCS.find((doc) => doc.slug === slug);
}

/**
 * Case-insensitive search. A paragraph scores for the whole query as a phrase and for each distinct
 * query term it contains; a page's score is its best paragraph, plus one point per matching paragraph
 * (capped: a page *about* the term beats a page that mentions it once), plus a bonus when the title
 * matches. Pages with no matching paragraph and no matching title are not returned. Never throws.
 */
export function searchDocs(query: string, limit = SEARCH_LIMIT_DEFAULT): DocHit[] {
  const phrase = query.toLowerCase().replace(/\s+/g, " ").trim();
  if (phrase.length === 0) return [];
  // terms keep inner punctuation ("decision_id", "/v1/disclose", "no-store") but not the edges ("token.")
  const terms = [
    ...new Set(
      phrase
        .split(/[^\p{L}\p{N}_.\-/]+/u)
        .map((term) => term.replace(/^[.\-/]+|[.\-/]+$/g, ""))
        .filter((term) => term.length >= 2),
    ),
  ];
  if (terms.length === 0) terms.push(phrase);
  const max = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.floor(limit)));

  const hits: { doc: Doc; score: number; paragraph: string }[] = [];
  for (const doc of DOCS) {
    let best = 0;
    let matching = 0;
    let paragraph = doc.paragraphs[0] ?? "";
    for (const candidate of doc.paragraphs) {
      const score = scoreText(candidate.toLowerCase(), phrase, terms);
      if (score > 0) matching++;
      // on equal scores the shorter paragraph is the denser match and the better snippet
      if (score > best || (score > 0 && score === best && candidate.length < paragraph.length)) {
        best = score;
        paragraph = candidate;
      }
    }
    const title = scoreText(doc.title.toLowerCase(), phrase, terms);
    if (best === 0 && title === 0) continue;
    hits.push({ doc, score: best + Math.min(matching, 5) + title * 2, paragraph });
  }
  hits.sort((a, b) => b.score - a.score); // stable: equal scores keep DOCS order
  return hits.slice(0, max).map(({ doc, paragraph }) => ({
    slug: doc.slug,
    uri: doc.uri,
    title: doc.title,
    snippet: snippetOf(paragraph, [phrase, ...terms]),
  }));
}

function scoreText(text: string, phrase: string, terms: readonly string[]): number {
  let score = 0;
  if (terms.length > 1 || phrase !== terms[0]) score += 10 * count(text, phrase);
  let occurrences = 0;
  for (const term of terms) {
    const n = count(text, term);
    if (n > 0) {
      score += 3;
      occurrences += n;
    }
  }
  return score + Math.min(occurrences, 6);
}

function count(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) n++;
  return n;
}

/** Context kept before the first match when a long paragraph is windowed, in characters. */
const SNIPPET_LEAD = 120;

/**
 * The paragraph on one line, at most SNIPPET_MAX characters. A longer paragraph is windowed around
 * the first `focus` string it contains (tried in order), cut on word boundaries, with an ellipsis
 * for whatever is left out on either side.
 */
export function snippetOf(paragraph: string, focus: readonly string[] = []): string {
  const flat = paragraph.replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET_MAX) return flat;

  const lower = flat.toLowerCase();
  let at = -1;
  for (const needle of focus) {
    if (needle.length === 0) continue;
    at = lower.indexOf(needle);
    if (at !== -1) break;
  }

  let start = 0;
  let prefix = "";
  if (at > SNIPPET_LEAD) {
    const boundary = flat.indexOf(" ", at - SNIPPET_LEAD) + 1;
    start = boundary > 0 && boundary <= at ? boundary : at - SNIPPET_LEAD;
    prefix = "…";
  }

  const budget = SNIPPET_MAX - prefix.length;
  const rest = flat.slice(start);
  if (rest.length <= budget) return `${prefix}${rest}`;
  const room = budget - 1; // for the closing ellipsis
  const cut = rest.lastIndexOf(" ", room);
  return `${prefix}${rest.slice(0, cut >= room / 2 ? cut : room).trimEnd()}…`;
}

/** Splits `---` front-matter from the body and indexes the body's paragraphs. Tolerant: never throws. */
export function parseDoc(slug: string, raw: string): Doc {
  const meta: Record<string, string> = {};
  let body = raw;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (match) {
    body = raw.slice(match[0].length);
    for (const line of match[1]!.split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon > 0) meta[line.slice(0, colon).trim()] = unquote(line.slice(colon + 1).trim());
    }
  }
  body = body.trim();
  const title = meta["title"] ?? slug;
  return {
    slug,
    uri: `${DOC_URI_PREFIX}${slug}`,
    title,
    description: meta["description"] ?? "",
    url: meta["url"] ?? "",
    text: `# ${title}\n\n${body}\n`,
    paragraphs: paragraphsOf(body),
  };
}

/** Blank-line separated blocks; a heading block is prepended (as "Heading: ") to the block after it. */
function paragraphsOf(body: string): string[] {
  const out: string[] = [];
  let heading: string | undefined;
  for (const block of body.split(/\n[ \t]*\n/)) {
    const text = block.trim();
    if (text.length === 0) continue;
    if (/^#{1,6}\s/.test(text) && !text.includes("\n")) {
      heading = text.replace(/^#+\s*/, "");
      continue;
    }
    out.push(heading ? `${heading}: ${text}` : text);
    heading = undefined;
  }
  if (heading) out.push(heading);
  return out;
}

function unquote(value: string): string {
  return /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;
}
