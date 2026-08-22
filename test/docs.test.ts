/**
 * The bundled documentation (docs/*.md through src/docs.ts): what scripts/sync-docs.sh must have
 * produced, the front-matter parser and the search used by afixo_search_docs.
 */
import { describe, expect, it } from "vitest";
import { DOCS, SEARCH_LIMIT_MAX, SNIPPET_MAX, docBySlug, parseDoc, searchDocs, snippetOf } from "../src/docs";

describe("bundled pages", () => {
  it("are the six pages, in order, with title, description and canonical URL from the front-matter", () => {
    expect(DOCS.map((doc) => [doc.slug, doc.title])).toEqual([
      ["getting-started", "Getting started"],
      ["api-overview", "API overview"],
      ["api-machine", "Machine API"],
      ["purposes", "Purposes"],
      ["disclosure-rules", "Disclosure rules"],
      ["decision-algorithm", "The decision algorithm"],
    ]);
    for (const doc of DOCS) {
      expect(doc.uri).toBe(`afixo://docs/${doc.slug}`);
      expect(doc.description.length, doc.slug).toBeGreaterThan(10);
      expect(doc.url, doc.slug).toMatch(/^https:\/\/docs\.afixo\.io\/[a-z/-]+\/$/);
      expect(doc.paragraphs.length, doc.slug).toBeGreaterThan(3);
    }
    expect(docBySlug("purposes")?.url).toBe("https://docs.afixo.io/concepts/purposes/");
    expect(docBySlug("nope")).toBeUndefined();
  });

  it("are plain markdown: heading first, no front-matter, no MDX, no site-relative links", () => {
    for (const doc of DOCS) {
      expect(doc.text.startsWith(`# ${doc.title}\n\n`), doc.slug).toBe(true);
      expect(doc.text, doc.slug).not.toMatch(/^---$/m);
      expect(doc.text, doc.slug).not.toMatch(/<\/?(Aside|Tabs|TabItem|Steps)\b/);
      expect(doc.text, doc.slug).not.toMatch(/^import\s/m);
      expect(doc.text, doc.slug).not.toMatch(/^:::/m);
      expect(doc.text, doc.slug).not.toContain("](/");
      expect(doc.text, doc.slug).not.toMatch(/\n{3,}/);
    }
    // the tabs of getting-started became labelled code blocks, inside the list item
    const started = docBySlug("getting-started")!.text;
    expect(started).toContain("   **HTTP Basic**\n\n   ```sh\n   curl -s https://api.afixo.io/oauth/token");
    expect(started).toContain("   **Form fields**\n\n   ```sh\n");
    expect(started).toContain("> **Status: skeleton");
    // the directive of purposes became a blockquote
    expect(docBySlug("purposes")!.text).toContain("> **Declared, not proven**\n>\n> The purpose is taken at face value");
  });
});

describe("parseDoc", () => {
  it("reads the front-matter, strips it and indexes paragraphs with their heading", () => {
    const doc = parseDoc("x", '---\ntitle: "Quoted: title"\ndescription: One line.\nurl: https://docs.afixo.io/x/\n---\n\nIntro.\n\n## Section one\n\nBody of one.\n\n```sh\ncode\n```\n');
    expect(doc.title).toBe("Quoted: title");
    expect(doc.description).toBe("One line.");
    expect(doc.url).toBe("https://docs.afixo.io/x/");
    expect(doc.text).toBe("# Quoted: title\n\nIntro.\n\n## Section one\n\nBody of one.\n\n```sh\ncode\n```\n");
    expect(doc.paragraphs).toEqual(["Intro.", "Section one: Body of one.", "```sh\ncode\n```"]);
  });

  it("tolerates a page without front-matter", () => {
    const doc = parseDoc("bare", "Just text.\n");
    expect(doc.title).toBe("bare");
    expect(doc.description).toBe("");
    expect(doc.text).toBe("# bare\n\nJust text.\n");
    expect(doc.paragraphs).toEqual(["Just text."]);
  });
});

describe("searchDocs", () => {
  it("matches case-insensitively and returns the best paragraph as the snippet", () => {
    const hits = searchDocs("Wildcards and SPECIFICITY");
    expect(hits[0]!.slug).toBe("disclosure-rules");
    expect(hits[0]!.snippet).toContain("Wildcards and specificity");
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(hits.map((h) => h.slug)).toContain("decision-algorithm");
  });

  it("ranks the page about a term above pages that mention it once", () => {
    const slugs = searchDocs("specificity").map((h) => h.slug);
    expect(slugs[0]).toBe("disclosure-rules");
    expect(slugs[1]).toBe("decision-algorithm");
    expect(slugs).toContain("purposes");
  });

  it("scores a whole-phrase match above scattered terms", () => {
    expect(searchDocs("fails closed")[0]!.snippet.toLowerCase()).toContain("fails closed");
    expect(searchDocs("purpose vocabulary")[0]!.snippet.toLowerCase()).toContain("purpose vocabulary");
    // no page says "client credentials" verbatim: the terms still find the client-credentials grant
    const grant = searchDocs("client credentials")[0]!;
    expect(["getting-started", "api-machine"]).toContain(grant.slug);
    expect(grant.snippet.toLowerCase()).toMatch(/client[_-]credentials/);
  });

  it("matches on the title alone", () => {
    const hits = searchDocs("getting started");
    expect(hits[0]!.slug).toBe("getting-started");
  });

  it("keeps inner punctuation in terms and drops the edges", () => {
    expect(searchDocs("decision_id.")[0]).toBeDefined();
    expect(searchDocs("/v1/disclose/").map((h) => h.slug)).toContain("api-machine");
  });

  it("clamps the limit to 1..10 and returns nothing for an empty or unmatched query", () => {
    expect(searchDocs("purpose", 0)).toHaveLength(1);
    expect(searchDocs("purpose", 100).length).toBeLessThanOrEqual(SEARCH_LIMIT_MAX);
    expect(searchDocs("purpose", 2)).toHaveLength(2);
    expect(searchDocs("   ")).toEqual([]);
    expect(searchDocs("zebra unicorn")).toEqual([]);
  });
});

describe("snippetOf", () => {
  const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");

  it("collapses whitespace and cuts long paragraphs at a word boundary with an ellipsis", () => {
    expect(snippetOf("  a\n  b\t c ")).toBe("a b c");
    const snippet = snippetOf(long);
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(snippet.endsWith("…")).toBe(true);
    const kept = snippet.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long.charAt(kept.length)).toBe(" "); // cut between words, not inside one
    expect(snippetOf("x".repeat(1000))).toHaveLength(SNIPPET_MAX); // no space to cut at: hard cut
  });

  it("windows a long paragraph around the first focus string it contains", () => {
    const snippet = snippetOf(long, ["nowhere", "word100"]);
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet).toContain("word100");
    expect(snippet).toContain("word90"); // context before the match is kept
    expect(snippet).toMatch(/^…word\d+ /); // starts on a word boundary
    expect(snippet.endsWith("word119")).toBe(true); // reached the end: no closing ellipsis

    const middle = snippetOf(long, ["word60"]);
    expect(middle.length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(middle.startsWith("…")).toBe(true);
    expect(middle.endsWith("…")).toBe(true);
    expect(middle).toContain("word60");
    expect(snippetOf(long, ["word3"])).toBe(snippetOf(long)); // an early match needs no window
  });
});
