/**
 * Link discovery (server/links): the extractor, the tiering rule, density and first mention,
 * self and ancestor exclusion, declined phrases, marks, degraded text-only mode, the incremental
 * node index, background jobs, and accept/reject. Offline: the mock Wikipedia and the hashed-words
 * embedder (IE_EMBED=fake).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { UndoManager } from "loro-crdt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyLinks, linkIndex } from "../src/core/links";
import { Doc, SYSTEM_ORIGIN, notesOf, type NodeId } from "../src/core/model";
import { history, verifyHistory } from "../src/core/repo";
import { Embedder, fakeLoader, type Loader } from "../server/embed";
import { extract, phraseKey } from "../server/links/extract";
import { Jobs, type JobState } from "../server/links/jobs";
import { NodeIndex } from "../server/links/nodeIndex";
import { PendingStore } from "../server/links/pending";
import { linkRoutes, scopeNodes } from "../server/links/routes";
import { Linker, TUNING, judge, type ScanInput, type Tuning } from "../server/links/scan";
import { rank, singular } from "../server/links/words";
import { WikiClient } from "../server/wiki";
import { makeMockWikiFetch } from "../server/wikiMock";

const W = (title: string) => ({ kind: "wiki" as const, title, lang: "en" });

function library() {
  const doc = Doc.library("tester");
  const lib = doc.snap().root;
  const { created } = doc.apply(
    [
      { op: "create", parent: lib, title: "Octopus minds", body: "An essay on minds that evolved apart from ours." },
      { op: "create", parent: "$0" as NodeId, title: "Arms", body: "The cephalopod arm tastes what it touches. Fred Hoyle never studied one." },
      { op: "create", parent: lib, title: "Recursion", body: "How a function can call itself without a name." },
      { op: "create", parent: "$2" as NodeId, title: "Lambda calculus", body: "Church built it from abstraction and application alone." },
      { op: "create", parent: "$3" as NodeId, title: "The Y combinator", body: "In the lambda calculus a fixed-point combinator gives recursion." },
      { op: "create", parent: lib, title: "Notes", body: "Elsewhere the lambda calculus comes up again." },
    ],
    "Base",
    { actor: "llm" },
  );
  const [minds, arms, recursion, lambda, ycomb, notes] = created;
  return { doc, lib, minds, arms, recursion, lambda, ycomb, notes };
}

function setup(doc: Doc, o: { embedder?: Embedder | null; tuning?: Partial<Tuning>; wiki?: WikiClient | null } = {}) {
  const embedder = o.embedder === undefined ? new Embedder({ model: "fake", loader: fakeLoader }) : o.embedder;
  const wiki = o.wiki === undefined ? new WikiClient({ fetch: makeMockWikiFetch(0), spacingMs: 0, persist: false, offlineHoldMs: 0 }) : o.wiki;
  const index = new NodeIndex(() => doc, { file: null, embedder, delayMs: 0 });
  const linker = new Linker({ doc: () => doc, wiki: () => wiki, embedder, index, tuning: o.tuning });
  return { linker, index, wiki, embedder };
}

const scan = (l: Linker, input: ScanInput) => l.scan(input);
const quotes = (r: { suggestions: { quote: string }[] }) => r.suggestions.map((s) => s.quote);

describe("the extractor", () => {
  it("finds names, terms and uncommon nouns in the text's own casing, and skips the ordinary", () => {
    const c = extract("Large nervous systems evolved twice, in vertebrates and in the cephalopod molluscs. Fred Hoyle predicted the Hoyle state of carbon-12. It is a big brain.");
    const texts = c.map((x) => x.text);
    expect(texts).toEqual(expect.arrayContaining(["Fred Hoyle", "Hoyle state", "carbon-12", "cephalopod", "cephalopod molluscs", "vertebrates", "nervous systems"]));
    // A phrase does not end on a verb, a lone common word is no candidate, and nothing spans a sentence.
    expect(texts).not.toContain("Hoyle predicted");
    expect(texts).not.toContain("brain");
    expect(texts.some((t) => t.includes("."))).toBe(false);
    expect(c.find((x) => x.text === "Fred Hoyle")!.kind).toBe("name");
    expect(c.find((x) => x.text === "cephalopod molluscs")!.variants).toContain("cephalopod mollusc");
  });

  it("reads a sentence's first word in lower case unless it is a name, and stops at a possessive", () => {
    const c = extract("Octopuses are clever. The octopus's arms decide. Alonzo Church agreed.");
    expect(c.find((x) => x.text === "Octopuses")?.variants[0]).toBe("octopuses");
    expect(c.find((x) => x.text === "Alonzo Church")?.kind).toBe("name");
    expect(c.map((x) => x.text)).not.toContain("octopus's arms");
  });

  it("skips code, excluded spans and skipped phrases, and always keeps marked ones", () => {
    const text = "Use `cephalopod` here; the nautilus and the cuttlefish stay.";
    const c = extract(text, { exclude: [[text.indexOf("nautilus"), text.indexOf("nautilus") + 8]], skip: new Set(["cuttlefish"]), forced: [{ start: 0, end: 3, phrase: "Use" }] });
    const texts = c.map((x) => x.text);
    expect(texts).not.toContain("cephalopod");
    expect(texts).not.toContain("nautilus");
    expect(texts).not.toContain("cuttlefish");
    expect(c[0]).toMatchObject({ text: "Use", kind: "forced" });
  });

  it("normalises phrases for comparison, and ranks words by frequency", () => {
    expect(phraseKey("The Fixed-Point Theorems")).toBe("fixed point theorem");
    expect(phraseKey("octopus's")).toBe("octopus");
    expect(singular("cephalopods")).toBe("cephalopod");
    expect(singular("theories")).toBe("theory");
    expect(rank("the")).toBeLessThan(10);
    expect(rank("cephalopod")).toBeGreaterThan(20_000);
  });
});

describe("the tiering rule", () => {
  const hit = (over: Record<string, unknown>) =>
    ({ c: { kind: "name", rarity: 50_000, words: 2, text: "Fred Hoyle", key: "fred hoyle", start: 0, end: 10, variants: [], sentenceStart: false }, target: W("Fred Hoyle"), source: "wikipedia", title: "Fred Hoyle", description: "British astronomer", fit: 0.75, exact: true, redirect: false, sense: false, searched: false, central: false, firstInDoc: true, ...over }) as never;

  it("applies an exact, well-fitting name without asking", () => {
    expect(judge(hit({})).tier).toBe("auto");
  });

  it("only suggests what is plausible but unsure, and drops what does not fit", () => {
    expect(judge(hit({ sense: true, margin: 0.1 })).tier).toBe("suggest");
    expect(judge(hit({ fit: 0.5 })).tier).toBe(null);
    expect(judge(hit({ description: "1999 album by a band" })).tier).not.toBe("auto");
    const common = { kind: "noun", rarity: 3000, words: 1, text: "shell", key: "shell", start: 0, end: 5, variants: [], sentenceStart: false };
    expect(judge(hit({ c: common, fit: 0.62 })).tier).toBe(null);
  });

  it("applies a link unasked only at a concept's first mention in the document; later mentions are suggested", () => {
    expect(judge(hit({ firstInDoc: false })).tier).toBe("suggest");
  });

  it("applies a library title unasked only when it has several words; a one-word title is at most suggested", () => {
    const lib = (key: string, words: number) => hit({ source: "library", target: { kind: "node", id: "1@1" }, sameDoc: true, fit: 0.9, c: { kind: "noun", rarity: 50_000, words, text: key, key, start: 0, end: key.length, variants: [], sentenceStart: false } });
    expect(judge(lib("comma", 1)).tier).toBe("suggest");
    expect(judge(lib("diagonal lemma", 2)).tier).toBe("auto");
  });

  it("links a concept central to the document once, at its first mention, and only as a suggestion", () => {
    expect(judge(hit({ central: true, firstInDoc: false })).tier).toBe(null);
    expect(judge(hit({ central: true, firstInDoc: true })).tier).toBe("suggest");
  });

  it("never applies a disambiguation sense, a country or a surname page unasked", () => {
    expect(judge(hit({ sense: true, margin: 0.2, fit: 0.9 })).tier).toBe("suggest");
    expect(judge(hit({ description: "Country in Central America" })).tier).toBe(null);
    expect(judge(hit({ description: "Surname list" })).tier).toBe(null);
    // A single common word needs much more than a multi-word term.
    for (const k of ["term", "name", "noun", "library"] as const) expect(TUNING.auto[k]).toBeGreaterThanOrEqual(TUNING.suggest[k] - 0.1);
    expect(TUNING.auto.noun).toBeGreaterThan(TUNING.auto.term);
  });
});

describe("scanning a node", () => {
  it("finds Wikipedia articles and library sections, with tiers and reasons", async () => {
    const { doc, arms } = library();
    const { linker } = setup(doc);
    const r = await scan(linker, { node: arms });
    const by = Object.fromEntries(r.suggestions.map((s) => [s.quote, s]));
    expect(by["Fred Hoyle"]).toMatchObject({ target: W("Fred Hoyle"), source: "wikipedia" });
    expect(by["cephalopod"]).toMatchObject({ target: W("Cephalopod") });
    expect(r.suggestions.every((s) => s.why.length > 0 && ["auto", "suggest"].includes(s.tier))).toBe(true);
    expect(r.degraded).toEqual([]);
  });

  it("never links a section to itself or its ancestors, and prefers a section in another document", async () => {
    const { doc, ycomb, notes, lambda } = library();
    const { linker } = setup(doc, { wiki: null });
    // "lambda calculus" in its own child: the title is its parent's, so no library link.
    const own = await scan(linker, { node: ycomb });
    expect(own.suggestions.filter((s) => s.source === "library")).toEqual([]);
    const other = await scan(linker, { node: notes });
    expect(other.suggestions.find((s) => s.quote === "lambda calculus")).toMatchObject({ source: "library", target: { kind: "node", id: lambda } });
  });

  it("links only the first mention of each target in a node, and keeps to a few links a paragraph", async () => {
    const doc = Doc.library("t");
    const { created } = doc.apply([{ op: "create", parent: doc.snap().root, title: "Sea", body: "An octopus met another octopus.\n\nCephalopod, Fred Hoyle and the Hoyle state and carbon-12 and lambda calculus." }], "x");
    const { linker } = setup(doc, { tuning: { perParagraph: 2 } });
    const r = await scan(linker, { node: created[0] });
    expect(quotes(r).filter((q) => q === "octopus")).toHaveLength(1);
    expect(r.suggestions.find((s) => s.quote === "octopus")!.range[0]).toBe(3);
    const second = r.suggestions.filter((s) => s.range[0] > doc.snap().nodes[created[0]].body.indexOf("\n\n"));
    expect(second.length).toBeLessThanOrEqual(2);
  });

  it("does not offer a phrase the writer declined in that node, even after an edit elsewhere in it", async () => {
    const { doc, arms } = library();
    const { linker } = setup(doc);
    expect(quotes(await scan(linker, { node: arms }))).toContain("cephalopod");
    doc.apply([{ op: "update", id: arms, nolink: ["cephalopod"] }], "Decline");
    doc.apply([{ op: "update", id: arms, body: "Indeed, the cephalopod arm tastes what it touches. Fred Hoyle never studied one." }], "Edit");
    const r = await scan(linker, { node: arms });
    expect(quotes(r)).not.toContain("cephalopod");
    expect(quotes(r)).toContain("Fred Hoyle");
  });

  it("verifies marked phrases: a library node by handle, an article by lookup, and says which found nothing", async () => {
    const { doc, arms, lambda } = library();
    const { linker } = setup(doc);
    const text = "The Hoyle state and the abstraction engine and a mollusc with no article.";
    const r = await scan(linker, {
      node: arms,
      text,
      forced: [
        { start: 4, end: 15, phrase: "Hoyle state" },
        { start: 24, end: 42, phrase: "abstraction engine", handle: lambda },
        { start: 49, end: 72, phrase: "mollusc with no article" },
      ],
    });
    expect(r.suggestions.find((s) => s.quote === "Hoyle state")).toMatchObject({ target: W("Hoyle state"), tier: "auto", kind: "forced" });
    expect(r.suggestions.find((s) => s.quote === "abstraction engine")).toMatchObject({ target: { kind: "node", id: lambda }, tier: "auto" });
    expect(r.unresolved).toEqual(["mollusc with no article"]);
  });

  it("chooses a disambiguation sense by fit with the text", async () => {
    const doc = Doc.library("t");
    const { created } = doc.apply([{ op: "create", parent: doc.snap().root, title: "Sky", body: "The innermost planet, Mercury, is the first planet from the Sun." }], "x");
    const { linker } = setup(doc);
    const r = await scan(linker, { node: created[0] });
    expect(r.suggestions.find((s) => s.quote === "Mercury")?.target).toEqual(W("Mercury (planet)"));
  });

  it("degrades to text only without embeddings, and says so", async () => {
    const { doc, notes, arms } = library();
    const off = new Embedder({ off: true });
    const { linker } = setup(doc, { embedder: off });
    const r = await scan(linker, { node: notes });
    expect(r.degraded[0]).toMatch(/embeddings unavailable/);
    expect(r.suggestions.find((s) => s.quote === "lambda calculus")?.source).toBe("library");
    const w = await scan(linker, { node: arms });
    // Without fit nothing from Wikipedia is applied unasked.
    expect(w.suggestions.filter((s) => s.source === "wikipedia" && s.tier === "auto")).toEqual([]);
    expect((await linker.related(arms)).degraded[0]).toMatch(/embeddings unavailable/);
  });
});

describe("the node index", () => {
  it("re-embeds only what changed", async () => {
    const { doc, arms } = library();
    const seen: string[] = [];
    const loader: Loader = async (spec) => async (texts) => (seen.push(...texts), (await fakeLoader(spec, ""))(texts));
    const embedder = new Embedder({ model: "fake", loader });
    const index = new NodeIndex(() => doc, { file: null, embedder, delayMs: 0 });
    index.watch(doc);
    await index.refresh();
    const first = seen.length;
    expect(first).toBe(6);
    doc.apply([{ op: "update", id: arms, body: "Each arm decides for itself." }], "Edit");
    await index.refresh();
    expect(seen.length - first).toBe(1);
    expect(seen[seen.length - 1]).toContain("Each arm decides");
    await index.refresh();
    expect(seen.length - first).toBe(1);
  });

  it("gives a Related list from other documents only", async () => {
    const { doc, ycomb, notes } = library();
    const { linker } = setup(doc);
    const r = await linker.related(notes);
    expect(r.related.length).toBeGreaterThan(0);
    expect(r.related.every((x) => x.doc !== "Notes")).toBe(true);
    expect(r.related.map((x) => x.node)).toContain(ycomb);
  });
});

describe("background jobs", () => {
  it("report progress and can be cancelled part-way", async () => {
    const doc = Doc.library("t");
    const ops = Array.from({ length: 30 }, (_, i) => ({ op: "create" as const, parent: doc.snap().root, title: `Doc ${i}`, body: `The octopus number ${i} meets a cephalopod.` }));
    doc.apply(ops, "x");
    const { linker, index, wiki } = setup(doc);
    // A slow scanner, so the cancel lands mid-way.
    const slow = { scan: async (i: ScanInput, s?: AbortSignal) => (await new Promise((r) => setTimeout(r, 5)), linker.scan(i, s)) } as unknown as Linker;
    const seen: JobState[] = [];
    const pending = new PendingStore(null);
    const jobs = new Jobs({ snap: () => doc.snap(), linker: () => slow, wiki: () => wiki, index, pending, announce: (s) => seen.push({ ...s }) });
    const nodes = scopeNodes(doc.snap(), null);
    const job = jobs.start("library", nodes, "the library");
    expect(job.total).toBe(30);
    while (job.done < 5) await new Promise((r) => setTimeout(r, 2));
    expect(jobs.cancel()).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(job.state).toBe("cancelled");
    expect(job.done).toBeLessThan(30);
    expect(seen.some((s) => s.state === "running" && s.done > 0)).toBe(true);
    expect(seen[seen.length - 1].state).toBe("cancelled");
    expect(pending.size).toBeGreaterThan(0);

    const again = jobs.start("library", nodes, "the library");
    while (again.state === "running") await new Promise((r) => setTimeout(r, 5));
    expect(again).toMatchObject({ state: "done", done: 30 });
  });
});

describe("accepting and rejecting", () => {
  let server: Server;
  let base: string;
  let doc: Doc;
  let ids: ReturnType<typeof library>;
  beforeAll(async () => {
    ids = library();
    doc = ids.doc;
    const { linker, index } = setup(doc);
    const pending = new PendingStore(null);
    const jobs = new Jobs({ snap: () => doc.snap(), linker: () => linker, wiki: () => null, index, pending, announce: () => {} });
    const handle = linkRoutes({ main: () => doc, linker: () => linker, index, pending, jobs, embedder: null, wrote: () => {} });
    server = createServer(async (req, res) => {
      if (!(await handle(req, res, new URL(req.url ?? "/", "http://x")))) (res.writeHead(418), res.end());
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());
  const post = (path: string, body: unknown) => fetch(`${base}/api/links/${path}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());

  it("lists pending suggestions with what a reviewer needs, and applies accepted ones as one commit by the linker", async () => {
    const scanned = await post("scan", { node: ids.arms });
    expect(scanned.suggestions.length).toBeGreaterThan(1);
    const list = await (await fetch(`${base}/api/links/pending?doc=octopus-minds`)).json();
    expect(list.total).toBe(scanned.suggestions.length);
    expect(list.suggestions[0]).toMatchObject({ nodeTitle: "Arms", document: "Octopus minds", docSlug: "octopus-minds" });
    expect(list.suggestions[0].sentence.length).toBeGreaterThan(10);
    const hoyle = list.suggestions.find((s: { quote: string }) => s.quote === "Fred Hoyle");
    const before = history(doc).length;
    const r = await post("accept", { ids: [hoyle.id] });
    expect(r.created).toHaveLength(1);
    expect(history(doc).length).toBe(before + 1);
    expect(history(doc)[0]).toMatchObject({ by: "linker", tag: "autolink" });
    expect(linkIndex(doc).mentions("en", "Fred Hoyle")).toHaveLength(1);
    expect(verifyHistory(doc).mismatches).toEqual([]);
    const after = await (await fetch(`${base}/api/links/pending?node=${encodeURIComponent(ids.arms)}`)).json();
    expect(after.suggestions.map((s: { quote: string }) => s.quote)).not.toContain("Fred Hoyle");
  });

  it("remembers a rejection in the node, so the phrase is not suggested again", async () => {
    const list = await (await fetch(`${base}/api/links/pending?node=${encodeURIComponent(ids.arms)}`)).json();
    const ceph = list.suggestions.find((s: { quote: string }) => s.quote === "cephalopod");
    expect(await post("reject", { ids: [ceph.id] })).toMatchObject({ rejected: 1 });
    expect(doc.snap().nodes[ids.arms].nolink).toEqual(["cephalopod"]);
    const again = await post("scan", { node: ids.arms });
    expect(again.suggestions.map((s: { quote: string }) => s.quote)).not.toContain("cephalopod");
    expect((await post("accept", { ids: "nope" })).error).toBeTruthy();
  });
});

describe("rejections and the linker's commits in the library", () => {
  it("syncs rejections from two replicas without losing either, and keeps history verifiable", () => {
    const { doc, arms } = library();
    const other = doc.fork("other");
    doc.apply([{ op: "update", id: arms, nolink: ["cephalopod"] }], "Decline here");
    other.apply([{ op: "update", id: arms, nolink: ["fred hoyle"] }], "Decline there");
    doc.loro.import(other.loro.export({ mode: "update" }));
    doc.touch();
    expect(doc.snap().nodes[arms].nolink).toEqual(["cephalopod", "fred hoyle"]);
    expect(verifyHistory(doc).mismatches).toEqual([]);
  });

  it("an automatic link is an ordinary commit by the linker, which undo takes back", () => {
    const { doc, arms } = library();
    const undo = new UndoManager(doc.loro, { mergeInterval: 0, excludeOriginPrefixes: [SYSTEM_ORIGIN] });
    doc.group = { start: () => undo.groupStart(), end: () => undo.groupEnd() };
    const r = applyLinks(doc, [{ node: arms, quote: "Fred Hoyle", target: W("Fred Hoyle") }, { node: arms, quote: "cephalopod", target: W("Cephalopod") }], { author: "linker", actor: "llm", tag: "autolink" });
    expect(r.created).toHaveLength(2);
    expect(history(doc)[0]).toMatchObject({ by: "linker", tag: "autolink", message: "Add 2 links" });
    expect(notesOf(doc.snap(), arms)).toHaveLength(2);
    undo.undo();
    doc.touch();
    expect(notesOf(doc.snap(), arms)).toHaveLength(0);
  });
});
