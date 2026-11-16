/**
 * What the browser tests share: driving the page from the keyboard, reading the store the page
 * exposes as globalThis.__ie, waiting for it to settle, and the links written into the shared
 * library over the op API, as an outside agent would (every kind of target, a note that also links,
 * a cross-document node link, two documents mentioning one article, a link and a note on the same
 * words, links on the screenshot's cells; the articles are the mock
 * Wikipedia's fixtures in server/wikiMock.ts).
 */
import { writeFileSync } from "node:fs";
import type { APIRequestContext, Page } from "@playwright/test";

/** A keypress → paint timing, as the page records it. */
export interface Sample {
  what: string;
  ms: number;
}

/** Run a function on the page's store and return what it returns. */
export const state = <T>(page: Page, fn: (s: any) => T): Promise<T> => page.evaluate(`(${fn})(globalThis.__ie)`) as Promise<T>;

/** Press space-separated keys, in order. */
export const keys = async (page: Page, seq: string) => {
  for (const k of seq.split(" ")) await page.keyboard.press(k);
};

/** / then a title then Enter: jump to a section. */
export const jump = async (page: Page, title: string) => {
  await page.keyboard.press("/");
  await page.keyboard.type(title);
  await page.keyboard.press("Enter");
};

/** : then text then Enter. */
export const command = async (page: Page, text: string) => {
  await page.keyboard.press(":");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
};

/** Wait until no generation, reconciliation or link scan is running. */
export const idle = (page: Page) =>
  page.waitForFunction(() => {
    const s = (globalThis as any).__ie;
    return s.busy === 0 && s.pending.size === 0 && s.links.busy === 0;
  });

/** Wait until the server has every edit the page made. */
export const synced = (page: Page) => page.waitForFunction(() => (globalThis as any).__ie.synced());

/** The tests share one server-side library: let each test's work reach it before the page closes. */
export async function settle(page: Page) {
  if (!(await page.evaluate(() => !!(globalThis as any).__ie?.ready).catch(() => false))) return;
  await idle(page);
  await synced(page);
}

export const focusedTitle = (page: Page) => state(page, (s) => s.snap.nodes[s.focus.node].title);
/** The selected words. */
export const selected = (page: Page) => state(page, (s) => (s.focus.range ? s.snap.nodes[s.focus.node].body.slice(s.focus.range[0], s.focus.range[1]) : "") as string);

/** Write a latency report to test-results/latency-<name>.json. */
export const writeReport = (name: string, report: unknown) => writeFileSync(`test-results/latency-${name}.json`, JSON.stringify(report, null, 2));

// ---- links written into the shared library ----

interface Snap {
  root: string;
  nodes: Record<string, { id: string; parent: string | null; kind: string; title: string; body: string; slug?: string; ref?: unknown; anchors: { text: string }[]; children: string[] }>;
}

const W = (title: string) => ({ kind: "wiki", title, lang: "en" });

/** Find a section by its document's slug and title path. */
function find(s: Snap, slug: string, ...path: string[]): string {
  let at = s.nodes[s.root].children.find((c) => s.nodes[c].slug === slug)!;
  for (const t of path) at = s.nodes[at].children.find((c) => s.nodes[c].kind === "section" && s.nodes[c].title === t)!;
  if (!at) throw new Error(`no ${slug}/${path.join("/")}`);
  return at;
}
const noteOn = (s: Snap, parent: string, quote: string) => s.nodes[parent].children.find((c) => s.nodes[c].kind === "note" && s.nodes[c].anchors[0]?.text === quote)!;

export async function seedLinks(request: APIRequestContext) {
  const s: Snap = await (await request.get("/api/tree")).json();
  const recursion = find(s, "fixed-points", "Recursion without names");
  if (s.nodes[recursion].children.some((c) => s.nodes[c].ref)) return; // already seeded by an earlier test
  const howY = find(s, "fixed-points", "Recursion without names", "How Y works");
  const triple = find(s, "origin-of-the-elements", "Fusion in ordinary stars", "The triple-alpha process");
  const separate = find(s, "octopus-minds", "A separate experiment");
  const ancestor = find(s, "octopus-minds", "A separate experiment", "The common ancestor");
  const programs = find(s, "what-a-proof-is", "Proof assistants", "Proofs as programs");
  const kinds = find(s, "the-eukaryotic-cell", "Two kinds of cell");
  const ops = [
    { op: "create", parent: recursion, kind: "note", quote: "fixed-point combinator", ref: W("Fixed-point combinator") },
    { op: "update", id: noteOn(s, recursion, "lambda calculus"), ref: W("Lambda calculus") },
    { op: "create", parent: recursion, kind: "note", quote: "Y combinator", ref: { kind: "node", id: howY, doc: "fixed-points", path: ["Recursion without names", "How Y works"] } },
    { op: "create", parent: recursion, kind: "note", quote: "self-reference", ref: { kind: "url", url: "https://plato.stanford.edu/entries/self-reference/", title: "Self-Reference (Stanford Encyclopedia of Philosophy)" } },
    { op: "update", id: noteOn(s, triple, "an excited state at almost exactly the energy"), ref: W("Hoyle state") },
    { op: "create", parent: triple, kind: "note", quote: "Fred Hoyle", ref: W("Fred Hoyle") },
    { op: "create", parent: separate, kind: "note", quote: "octopus", ref: W("Octopus") },
    { op: "update", id: noteOn(s, separate, "cephalopod"), ref: W("Cephalopod") },
    // A link on words that already carry a note of their own: two notes on one span.
    { op: "create", parent: ancestor, kind: "note", quote: "The camera-like eye", ref: W("Cephalopod") },
    { op: "create", parent: programs, kind: "note", quote: "a function turning proofs", ref: W("Lambda calculus") },
    { op: "create", parent: programs, kind: "note", quote: "Several of the leading systems", ref: { kind: "node", id: recursion, doc: "fixed-points", path: ["Recursion without names"] } },
    { op: "create", parent: kinds, kind: "note", quote: "Eukaryotes", ref: W("Eukaryote") },
    { op: "create", parent: kinds, kind: "note", quote: "Bacteria", ref: W("Bacteria") },
  ];
  const res = await request.post("/api/ops", { data: { author: "linker", message: "Seed links for the link tests", ops } });
  if (!res.ok()) throw new Error(`seeding links failed: ${res.status()} ${await res.text()}`);
}
