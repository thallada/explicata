/**
 * The link reviewer and what it decides (server/links/review.ts, pending.ts): determinations kept
 * across scans, a person's decisions, approved links handed out once, batching many proposals to a
 * call, skipping what was judged before, falling back (no model, a failed call, the call budget),
 * a pending file from before determinations, background jobs that review as they go, and the scan
 * route in review mode. Offline: the mock model (whose verdicts follow the scanner's tier), the mock
 * Wikipedia and the hashed-words embedder.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Doc, type NodeId } from "../src/core/model";
import { mockLLM, mockLinks } from "../src/llm/mock";
import type { JsonReq, LLM } from "../src/llm/types";
import { Embedder, fakeLoader } from "../server/embed";
import { Jobs, type JobState } from "../server/links/jobs";
import { NodeIndex } from "../server/links/nodeIndex";
import { PendingStore } from "../server/links/pending";
import { BATCH, REVIEW_SYSTEM, Reviewer } from "../server/links/review";
import { linkRoutes, scopeNodes } from "../server/links/routes";
import { Linker, type Suggestion } from "../server/links/scan";
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
      { op: "create", parent: lib, title: "Stars", body: "The cephalopod met Fred Hoyle.\n\nHe spoke of the Hoyle state of carbon-12 and of the lambda calculus." },
    ],
    "Base",
    { actor: "llm" },
  );
  const [minds, arms, stars] = created;
  return { doc, lib, minds, arms, stars };
}

function setup(doc: Doc) {
  const embedder = new Embedder({ model: "fake", loader: fakeLoader });
  const wiki = new WikiClient({ fetch: makeMockWikiFetch(0), spacingMs: 0, persist: false, offlineHoldMs: 0 });
  const index = new NodeIndex(() => doc, { file: null, embedder, delayMs: 0 });
  const linker = new Linker({ doc: () => doc, wiki: () => wiki, embedder, index });
  return { linker, index, wiki, embedder };
}

/** The mock model, counting its review calls and what each was sent; `fail` makes every call throw. */
function counting(o: { fail?: boolean; delay?: number } = {}) {
  const inner = mockLLM({ delay: o.delay });
  const calls: JsonReq[] = [];
  const llm: LLM = {
    ...inner,
    async json<T>(req: JsonReq, signal?: AbortSignal) {
      calls.push(req);
      if (o.fail) throw new Error("rate limited");
      return inner.json<T>(req, signal);
    },
  };
  return { llm, calls };
}

/** A made-up suggestion in a node. */
const sugg = (node: NodeId, quote: string, at: number, more: Partial<Suggestion> = {}): Suggestion => ({
  id: `${node}:${quote}:${at}`, node, range: [at, at + quote.length], quote, key: quote.toLowerCase(), target: W(quote[0].toUpperCase() + quote.slice(1)), score: 0.7, tier: "suggest", why: "", source: "wikipedia", title: quote, description: null, kind: "term", ...more,
});

describe("the determination store", () => {
  it("keeps verdicts and decisions across scans of a node, and records what a scan no longer finds", () => {
    const { doc, arms } = library();
    const p = new PendingStore(null);
    const body = doc.snap().nodes[arms].body;
    const ceph = sugg(arms, "cephalopod", body.indexOf("cephalopod"));
    const hoyle = sugg(arms, "Fred Hoyle", body.indexOf("Fred Hoyle"), { tier: "auto" });
    p.put(arms, [ceph, hoyle]);
    p.review(ceph.id, { link: false, reason: "too general", at: 1 });
    p.review(hoyle.id, { link: true, reason: "a named person", at: 1 });
    // A later scan finds Fred Hoyle again (at new offsets, so a new id) and skips the rejected phrase.
    doc.apply([{ op: "update", id: arms, body: `Indeed. ${body}` }], "Edit");
    const moved = sugg(arms, "Fred Hoyle", body.indexOf("Fred Hoyle") + 8, { tier: "auto" });
    p.put(arms, [moved]);
    const stored = p.of(arms);
    expect(stored.find((s) => s.quote === "Fred Hoyle")).toMatchObject({ id: moved.id, review: { link: true, reason: "a named person" } });
    expect(stored.find((s) => s.quote === "cephalopod")?.review).toMatchObject({ link: false });
    expect(p.rejectedKeys(arms)).toEqual(["cephalopod"]);
    // Nothing judged is offered to the reviewer again; the default list leaves out what the reviewer rejected.
    expect(p.undecided(doc.snap(), [arms])).toEqual([]);
    expect(p.list(doc.snap()).map((s) => s.quote)).toEqual(["Fred Hoyle"]);
    expect(p.list(doc.snap(), undefined, true).map((s) => s.quote).sort()).toEqual(["Fred Hoyle", "cephalopod"]);
    // A person overrules the reviewer: the phrase is no longer skipped.
    expect(p.decide([stored.find((s) => s.quote === "cephalopod")!.id], true, "tyler")).toBe(1);
    expect(p.rejectedKeys(arms)).toEqual([]);
  });

  it("hands an approved link out once, to whichever page asks first", () => {
    const { doc, arms } = library();
    const p = new PendingStore(null);
    const body = doc.snap().nodes[arms].body;
    const hoyle = sugg(arms, "Fred Hoyle", body.indexOf("Fred Hoyle"));
    p.put(arms, [hoyle]);
    expect(p.claim(doc.snap())).toEqual([]);
    p.review(hoyle.id, { link: true, reason: "yes", at: 1 });
    expect(p.claim(doc.snap(), [arms]).map((s) => s.quote)).toEqual(["Fred Hoyle"]);
    expect(p.claim(doc.snap(), [arms])).toEqual([]);
    // Found again by a later scan, it is still marked as handed out.
    p.put(arms, [hoyle]);
    expect(p.claim(doc.snap())).toEqual([]);
  });

  it("reads a pending file written before determinations existed: its suggestions are pending, its declines stay declined", () => {
    const { doc, arms } = library();
    doc.apply([{ op: "update", id: arms, nolink: ["fred hoyle"] }], "Decline");
    const body = doc.snap().nodes[arms].body;
    const dir = mkdtempSync(join(tmpdir(), "ie-pending-"));
    const file = join(dir, "pending.json");
    // The shape earlier versions wrote: { node: { at, suggestions } }, no verdicts.
    const old = { [arms]: { at: 1, suggestions: [sugg(arms, "cephalopod", body.indexOf("cephalopod")), sugg(arms, "Fred Hoyle", body.indexOf("Fred Hoyle"))].map(({ review, decided, applied, ...s }) => s) } };
    writeFileSync(file, JSON.stringify(old));
    const p = new PendingStore(file);
    expect(p.list(doc.snap()).map((s) => s.quote)).toEqual(["cephalopod"]);
    expect(p.undecided(doc.snap(), [arms]).map((s) => s.quote)).toEqual(["cephalopod"]);
    // Listed in full, the declined one is there too (the page shows it as declined, by the node's nolink).
    expect(p.list(doc.snap(), undefined, true)).toHaveLength(2);
    p.flush();
    expect(new PendingStore(file).of(arms)).toHaveLength(2);
  });
});

describe("the reviewer", () => {
  /** n made-up proposals spread over the library's sections, on words that are there. */
  function proposals(doc: Doc, ids: NodeId[], n: number) {
    const p = new PendingStore(null);
    const out: Suggestion[] = [];
    for (let i = 0; i < n; i++) {
      const node = ids[i % ids.length];
      const body = doc.snap().nodes[node].body;
      const quote = [["minds", "An essay"], ["cephalopod", "Fred Hoyle"]][Math.min(1, i % ids.length)][i % 2];
      out.push(sugg(node, quote, body.indexOf(quote), { id: `s${i}`, key: `k${i}`, target: W(`T${i}`) }));
    }
    for (const id of ids) p.put(id, out.filter((s) => s.node === id));
    return { p, list: out };
  }

  it("judges many proposals a call, grouped by tree and section, with what it takes to judge each", async () => {
    const { doc, minds, arms, stars } = library();
    const { p, list } = proposals(doc, [minds, arms, stars], BATCH * 2 + 10);
    const { llm, calls } = counting();
    const r = new Reviewer({ llm: () => llm, wiki: () => null, pending: p, snap: () => doc.snap() });
    const budget = { calls: 0, max: 10 };
    const rep = await r.review(list, budget);
    expect(calls).toHaveLength(3);
    expect(budget.calls).toBe(3);
    const yes = list.filter((s) => mockLinks(s.quote)).length;
    expect(yes).toBeGreaterThan(0);
    expect(yes).toBeLessThan(list.length);
    expect(rep).toMatchObject({ calls: 3, left: 0, approved: yes, rejected: list.length - yes });
    expect(rep.fallback).toBeUndefined();
    const first = calls[0];
    expect(first).toMatchObject({ schema: "review", system: REVIEW_SYSTEM, effort: "low" });
    expect(first.prompt).toContain("# Tree: Octopus minds");
    expect(first.prompt).toContain("## Section: Arms");
    expect(first.prompt).toContain("“cephalopod” → Wikipedia article “T4” [scanner: unsure]");
    expect(first.prompt).toContain("in: “The cephalopod arm tastes what it touches.”");
    expect(first.prompt).toContain("Already linked in this section");
    // Each verdict is stored with its reason; nothing is left for a second pass.
    expect(p.of(arms).every((s) => s.review && s.review.reason.startsWith("mock:"))).toBe(true);
    expect(p.undecided(doc.snap(), [minds, arms, stars])).toEqual([]);
  });

  it("says how a library target stands to the section, so a parent never links its own child", async () => {
    const { doc, minds, arms } = library();
    const p = new PendingStore(null);
    const body = doc.snap().nodes[minds].body;
    const s = sugg(minds, "minds", body.indexOf("minds"), { target: { kind: "node", id: arms }, source: "library", title: "Arms" });
    p.put(minds, [s]);
    const { llm, calls } = counting();
    await new Reviewer({ llm: () => llm, wiki: () => null, pending: p, snap: () => doc.snap() }).review([s], { calls: 0, max: 1 });
    expect(calls[0].prompt).toContain("library section “Arms”, a subsection of this section");
    expect(calls[0].prompt).toContain("It begins: The cephalopod arm tastes what it touches.");
  });

  it("falls back, leaving everything pending and saying why: no model, a failed call, the budget spent", async () => {
    const { doc, minds, arms, stars } = library();
    const { p, list } = proposals(doc, [minds, arms, stars], BATCH + 5);
    const none = await new Reviewer({ llm: () => null, wiki: () => null, pending: p, snap: () => doc.snap() }).review(list, { calls: 0, max: 5 });
    expect(none).toMatchObject({ calls: 0, left: list.length, fallback: "no model is configured" });
    const failing = counting({ fail: true });
    const failed = await new Reviewer({ llm: () => failing.llm, wiki: () => null, pending: p, snap: () => doc.snap() }).review(list, { calls: 0, max: 5 });
    expect(failed).toMatchObject({ calls: 1, left: list.length, approved: 0 });
    expect(failed.fallback).toContain("the reviewer failed: rate limited");
    expect(p.undecided(doc.snap(), [minds, arms, stars])).toHaveLength(list.length);
    // The mock's own failure: a proposal that says mockfail.
    const mock = await new Reviewer({ llm: () => mockLLM(), wiki: () => null, pending: p, snap: () => doc.snap() }).review([{ ...list[0], quote: "mockfail" }], { calls: 0, max: 5 });
    expect(mock.fallback).toContain("mock reviewer: the call failed");
    // A budget of one call reviews the first batch only.
    const ok = counting();
    const capped = await new Reviewer({ llm: () => ok.llm, wiki: () => null, pending: p, snap: () => doc.snap() }).review(list, { calls: 0, max: 1 });
    expect(capped).toMatchObject({ calls: 1, left: 5 });
    expect(capped.fallback).toContain("limit of 1 model call was reached");
  });
});

describe("background jobs with review", () => {
  it("review what they find, many proposals a call, report it, and never ask about the same thing twice", async () => {
    const doc = Doc.library("t");
    const ops = Array.from({ length: 40 }, (_, i) => ({ op: "create" as const, parent: doc.snap().root, title: `Doc ${i}`, body: `Fred Hoyle number ${i} met a cephalopod and the lambda calculus.` }));
    doc.apply(ops, "x");
    const { linker, index, wiki } = setup(doc);
    const pending = new PendingStore(null);
    const { llm, calls } = counting();
    const reviewer = new Reviewer({ llm: () => llm, wiki: () => wiki, pending, snap: () => doc.snap() });
    const seen: JobState[] = [];
    const jobs = new Jobs({ snap: () => doc.snap(), linker: () => linker, wiki: () => wiki, index, pending, announce: (s) => seen.push(structuredClone(s)), reviewer, reviewCalls: 5 });
    const nodes = scopeNodes(doc.snap(), null);
    const job = jobs.start("library", nodes, "the library", undefined, true);
    while (job.state === "running") await new Promise((r) => setTimeout(r, 5));
    expect(job.state).toBe("done");
    const found = job.auto + job.suggest;
    expect(found).toBeGreaterThan(BATCH);
    expect(job.review).toMatchObject({ max: 5, left: 0 });
    // Many proposals a call: far fewer calls than proposals.
    expect(job.review!.calls).toBe(calls.length);
    expect(calls.length).toBe(Math.ceil(found / BATCH));
    expect(job.review!.approved + job.review!.rejected).toBe(found);
    expect(seen.some((s) => s.state === "running" && (s.review?.calls ?? 0) > 0)).toBe(true);
    // Run again: everything was judged, so the model is not asked at all.
    const again = jobs.start("library", nodes, "the library", undefined, true);
    while (again.state === "running") await new Promise((r) => setTimeout(r, 5));
    expect(again.review).toMatchObject({ calls: 0, approved: 0, rejected: 0 });
    expect(calls.length).toBe(Math.ceil(found / BATCH));
    // A job without review asks nothing.
    const plain = jobs.start("library", nodes, "the library");
    while (plain.state === "running") await new Promise((r) => setTimeout(r, 5));
    expect(plain.review).toBeUndefined();
  });

  it("stop reviewing when cancelled, keeping the verdicts so far", async () => {
    const doc = Doc.library("t");
    doc.apply(Array.from({ length: 40 }, (_, i) => ({ op: "create" as const, parent: doc.snap().root, title: `D ${i}`, body: `Fred Hoyle ${i} met a cephalopod and the lambda calculus.` })), "x");
    const { linker, index, wiki } = setup(doc);
    const pending = new PendingStore(null);
    const slow = counting({ delay: 40 });
    const seen: JobState[] = [];
    const jobs = new Jobs({ snap: () => doc.snap(), linker: () => linker, wiki: () => wiki, index, pending, announce: (s) => seen.push(structuredClone(s)), reviewer: new Reviewer({ llm: () => slow.llm, wiki: () => wiki, pending, snap: () => doc.snap() }), reviewCalls: 10 });
    const job = jobs.start("library", scopeNodes(doc.snap(), null), "the library", undefined, true);
    while (slow.calls.length < 2) await new Promise((r) => setTimeout(r, 2));
    expect(jobs.cancel()).toBe(true);
    await new Promise((r) => setTimeout(r, 120));
    expect(job.state).toBe("cancelled");
    expect(seen[seen.length - 1].state).toBe("cancelled");
    expect(slow.calls).toHaveLength(2);
    // The first call's verdicts are kept; the rest wait.
    expect(job.review!.approved + job.review!.rejected).toBe(BATCH);
    expect(pending.undecided(doc.snap(), scopeNodes(doc.snap(), null)).length).toBeGreaterThan(0);
  });

  it("stop at the job's cap, leaving the rest pending, and say so", async () => {
    const doc = Doc.library("t");
    doc.apply(Array.from({ length: 40 }, (_, i) => ({ op: "create" as const, parent: doc.snap().root, title: `D ${i}`, body: `Fred Hoyle ${i} met a cephalopod and the lambda calculus.` })), "x");
    const { linker, index, wiki } = setup(doc);
    const pending = new PendingStore(null);
    const { llm } = counting();
    const jobs = new Jobs({ snap: () => doc.snap(), linker: () => linker, wiki: () => wiki, index, pending, announce: () => {}, reviewer: new Reviewer({ llm: () => llm, wiki: () => wiki, pending, snap: () => doc.snap() }), reviewCalls: 1 });
    const job = jobs.start("library", scopeNodes(doc.snap(), null), "the library", undefined, true);
    while (job.state === "running") await new Promise((r) => setTimeout(r, 5));
    expect(job.review).toMatchObject({ calls: 1, approved: expect.any(Number) });
    expect(job.review!.left).toBe(job.auto + job.suggest - BATCH);
    expect(job.review!.fallback).toContain("limit of 1 model call");
    expect(pending.list(doc.snap())).toHaveLength(job.review!.left + job.review!.approved);
  });
});

describe("the scan route in review mode", () => {
  let server: Server;
  let base: string;
  let ids: ReturnType<typeof library>;
  let calls: JsonReq[];
  beforeAll(async () => {
    ids = library();
    const doc = ids.doc;
    const { linker, index, wiki } = setup(doc);
    const pending = new PendingStore(null);
    const c = counting();
    calls = c.calls;
    const reviewer = new Reviewer({ llm: () => c.llm, wiki: () => wiki, pending, snap: () => doc.snap() });
    const jobs = new Jobs({ snap: () => doc.snap(), linker: () => linker, wiki: () => wiki, index, pending, announce: () => {}, reviewer });
    const handle = linkRoutes({ main: () => doc, linker: () => linker, index, pending, jobs, embedder: null, reviewer, wrote: () => {} });
    server = createServer(async (req, res) => {
      if (!(await handle(req, res, new URL(req.url ?? "/", "http://x")))) (res.writeHead(418), res.end());
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());
  const post = (path: string, body: unknown) => fetch(`${base}/api/links/${path}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());

  it("reviews what a scan finds, hands out the approved links once, and never asks about them again", async () => {
    const r = await post("scan", { node: ids.stars, review: "all" });
    expect(r.suggestions.length).toBeGreaterThan(1);
    expect(r.review).toMatchObject({ calls: 1, left: 0 });
    expect(r.review.approved + r.review.rejected).toBe(r.suggestions.length);
    expect(r.apply.map((s: Suggestion) => s.quote).sort()).toEqual(r.suggestions.filter((s: Suggestion) => mockLinks(s.quote)).map((s: Suggestion) => s.quote).sort());
    expect(r.entries.every((s: Suggestion) => s.review)).toBe(true);
    // The same text scanned again: nothing new to judge, nothing handed out twice, and what was rejected is not looked for again.
    const again = await post("scan", { node: ids.stars, review: "all" });
    expect(again.review).toMatchObject({ calls: 0, approved: 0, rejected: 0 });
    expect(again.apply).toEqual([]);
    expect(calls).toHaveLength(1);
    const rejected = r.entries.filter((s: Suggestion) => !s.review?.link).map((s: Suggestion) => s.quote);
    expect(rejected).toEqual(["cephalopod"]);
    for (const q of rejected) expect(again.suggestions.map((s: Suggestion) => s.quote)).not.toContain(q);
    // The full list still shows them, with the reviewer's reasons.
    const all = await (await fetch(`${base}/api/links/pending?node=${encodeURIComponent(ids.stars)}&all=1`)).json();
    expect(all.suggestions.filter((s: Suggestion) => s.review?.link === false).map((s: Suggestion) => s.quote).sort()).toEqual([...rejected].sort());
  });

  it("records a person's decision, and leaves a person's own marks out of the review", async () => {
    const all = await (await fetch(`${base}/api/links/pending?node=${encodeURIComponent(ids.stars)}&all=1`)).json();
    const one = all.suggestions.find((s: Suggestion) => s.review?.link === false);
    expect(await post("decide", { ids: [one.id], link: true, by: "tyler" })).toEqual({ decided: 1 });
    const after = await (await fetch(`${base}/api/links/pending?node=${encodeURIComponent(ids.stars)}&all=1`)).json();
    expect(after.suggestions.find((s: Suggestion) => s.id === one.id).decided).toMatchObject({ link: true, by: "tyler" });
    expect((await post("decide", { ids: [one.id] })).error).toBeTruthy();
    const text = "A note on Fred Hoyle.";
    const marked = await post("scan", { node: ids.arms, text, forced: [{ start: 10, end: 20, phrase: "Fred Hoyle" }], review: "unmarked" });
    expect(marked.suggestions.find((s: Suggestion) => s.kind === "forced")).toBeTruthy();
    expect(marked.entries.find((s: Suggestion) => s.kind === "forced").review).toBeUndefined();
  });
});

describe("the links list in the page", () => {
  it("shows each stored suggestion as it stands, links nothing accounts for, and old declines as the phrase alone", async () => {
    const { Linker: PageLinker } = await import("../src/ui/linker");
    const { arms, doc } = library();
    const body = doc.snap().nodes[arms].body;
    // An old decline with no stored target, a link made by hand, and two stored suggestions: one the reviewer rejected, one waiting.
    doc.apply([{ op: "update", id: arms, nolink: ["tastes"] }, { op: "create", parent: arms, kind: "note", quote: "arm", ref: W("Arm") }], "Earlier");
    const page = new PageLinker({ doc: () => doc, user: () => "tyler", mode: () => "review", generating: () => true, say: () => {}, emit: () => {}, rendered: () => false });
    const rejected = sugg(arms, "cephalopod", body.indexOf("cephalopod"), { review: { link: false, reason: "too general", at: 1 } });
    const waiting = sugg(arms, "Fred Hoyle", body.indexOf("Fred Hoyle"));
    (page as unknown as { byNode: Map<NodeId, Suggestion[]> }).byNode.set(arms, [rejected, waiting]);
    const rows = page.rows([arms], doc.snap());
    const by = (q: string) => rows.find((r) => r.quote === q)!;
    expect(by("cephalopod")).toMatchObject({ status: "rejected", by: "reviewer", reason: "too general" });
    expect(by("Fred Hoyle")).toMatchObject({ status: "pending", by: null });
    expect(by("arm")).toMatchObject({ status: "linked", by: null, title: "Arm" });
    expect(by("tastes")).toMatchObject({ status: "rejected", target: null, range: null });
    // Only the waiting one is drawn as a suggestion.
    expect(page.forNode(arms, doc.snap()).map((s) => s.quote)).toEqual(["Fred Hoyle"]);
    // A person overrules the reviewer: linked by them, the reviewer's no still shown.
    expect(page.accept([rejected], true)).toBe(1);
    expect(page.rows([arms], doc.snap()).find((r) => r.quote === "cephalopod")).toMatchObject({ status: "linked", by: "tyler", verdict: false });
    // Removing a link declines its words in the node, in one commit.
    const note = page.rows([arms], doc.snap()).find((r) => r.quote === "cephalopod")!.note!;
    expect(page.removeLink(note)).toBe("cephalopod");
    expect(doc.snap().nodes[arms].nolink).toEqual(["cephalopod", "tastes"]);
    expect(page.rows([arms], doc.snap()).find((r) => r.quote === "cephalopod")).toMatchObject({ status: "rejected", by: "tyler" });
  });
});
