/**
 * What the browser tests share: driving the page from the keyboard, reading the store the page
 * exposes as globalThis.__ie, waiting for it to settle, and the links written into the shared
 * library over the op API, as an outside agent would (every kind of target, a note that also links,
 * a cross-document node link, two documents mentioning one article, a link and a note on the same
 * words, links on the screenshot's cells; the articles are the mock
 * Wikipedia's fixtures in server/wikiMock.ts).
 */
import { writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import type { APIRequestContext, Page } from "@playwright/test";

/** A keypress → paint timing, as the page records it. */
export interface Sample {
  what: string;
  ms: number;
}

/** Run a function on the page's store and return what it returns. */
export const state = <T>(page: Page, fn: (s: any) => T): Promise<T> => page.evaluate(`(${fn})(globalThis.__ie)`) as Promise<T>;

/**
 * Let this page's layout follow the window, as a reader's does (`/view auto`), from its first load:
 * the tests start in the column (playwright.config.ts). Later loads keep what the page has set.
 */
export const autoLayout = (page: Page) =>
  page.addInitScript(() => {
    if (sessionStorage.getItem("e2e:auto")) return;
    sessionStorage.setItem("e2e:auto", "1");
    localStorage.removeItem("ie:settings");
  });

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
  nodes: Record<string, { id: string; parent: string | null; kind: string; title: string; body: string; ref?: unknown; anchors: { text: string }[]; children: string[] }>;
}

const W = (title: string) => ({ kind: "wiki", title, lang: "en" });

/** Find a section by its titles from the library root. */
function find(s: Snap, ...path: string[]): string {
  let at = s.root;
  for (const t of path) at = s.nodes[at]?.children.find((c) => s.nodes[c].kind === "section" && s.nodes[c].title === t) as string;
  if (!at) throw new Error(`no /${path.join("/")}`);
  return at;
}
const noteOn = (s: Snap, parent: string, quote: string) => s.nodes[parent].children.find((c) => s.nodes[c].kind === "note" && s.nodes[c].anchors[0]?.text === quote)!;

export async function seedLinks(request: APIRequestContext) {
  const s: Snap = await (await request.get("/api/tree")).json();
  const recursion = find(s, "Fixed points", "Recursion without names");
  if (s.nodes[recursion].children.some((c) => s.nodes[c].ref)) return; // already seeded by an earlier test
  const howY = find(s, "Fixed points", "Recursion without names", "How Y works");
  const triple = find(s, "Where the elements come from", "Fusion in ordinary stars", "The triple-alpha process");
  const separate = find(s, "Octopus minds", "A separate experiment");
  const ancestor = find(s, "Octopus minds", "A separate experiment", "The common ancestor");
  const programs = find(s, "What a proof is", "Proof assistants", "Proofs as programs");
  const kinds = find(s, "The one merger", "Two kinds of cell");
  const ops = [
    { op: "create", parent: recursion, kind: "note", quote: "fixed-point combinator", ref: W("Fixed-point combinator") },
    { op: "update", id: noteOn(s, recursion, "lambda calculus"), ref: W("Lambda calculus") },
    { op: "create", parent: recursion, kind: "note", quote: "Y combinator", ref: { kind: "node", id: howY, path: ["Fixed points", "Recursion without names", "How Y works"] } },
    { op: "create", parent: recursion, kind: "note", quote: "self-reference", ref: { kind: "url", url: "https://plato.stanford.edu/entries/self-reference/", title: "Self-Reference (Stanford Encyclopedia of Philosophy)" } },
    { op: "update", id: noteOn(s, triple, "an excited state at almost exactly the energy"), ref: W("Hoyle state") },
    { op: "create", parent: triple, kind: "note", quote: "Fred Hoyle", ref: W("Fred Hoyle") },
    { op: "create", parent: separate, kind: "note", quote: "octopus", ref: W("Octopus") },
    { op: "update", id: noteOn(s, separate, "cephalopod"), ref: W("Cephalopod") },
    // A link on words that already carry a note of their own: two notes on one span.
    { op: "create", parent: ancestor, kind: "note", quote: "The camera-like eye", ref: W("Cephalopod") },
    { op: "create", parent: programs, kind: "note", quote: "a function turning proofs", ref: W("Lambda calculus") },
    { op: "create", parent: programs, kind: "note", quote: "Several of the leading systems", ref: { kind: "node", id: recursion, path: ["Fixed points", "Recursion without names"] } },
    { op: "create", parent: kinds, kind: "note", quote: "Eukaryotes", ref: W("Eukaryote") },
    { op: "create", parent: kinds, kind: "note", quote: "Bacteria", ref: W("Bacteria") },
  ];
  const res = await request.post("/api/ops", { data: { author: "linker", message: "Seed links for the link tests", ops } });
  if (!res.ok()) throw new Error(`seeding links failed: ${res.status()} ${await res.text()}`);
}

/** A screenshot's pixels (a PNG of 8-bit RGB or RGBA, as Playwright writes them): px(x, y) is [r, g, b]. */
export function pixels(buf: Buffer): { w: number; h: number; px: (x: number, y: number) => [number, number, number] } {
  let at = 8;
  let w = 0;
  let h = 0;
  let type = 6;
  const data: Buffer[] = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const kind = buf.toString("ascii", at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (kind === "IHDR") {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      type = body[9];
    } else if (kind === "IDAT") data.push(body);
    at += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(data));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= bpp ? out[y * stride + i - bpp] : 0;
      const b = y ? out[(y - 1) * stride + i] : 0;
      const c = y && i >= bpp ? out[(y - 1) * stride + i - bpp] : 0;
      const p = a + b - c;
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      out[y * stride + i] = (x + [0, a, b, (a + b) >> 1, pr][f]) & 255;
    }
  }
  return { w, h, px: (x, y) => [out[y * stride + x * bpp], out[y * stride + x * bpp + 1], out[y * stride + x * bpp + 2]] };
}

/**
 * The curves' invariant, measured from the page: every curve drawn starts at what its pane was
 * opened from (the row, the words, or a link: within a few pixels of it), or, when that is out of
 * sight, on its pane's edge over it (dotted), or at the end of its folded pane's tab foot; and ends
 * in its pane's landing line: the rule under its title, along to the rule's end, or its tab's foot,
 * or just before its title. Returns what fails, as text (empty when all hold).
 */
export const curveFaults = (page: Page) =>
  page.evaluate(() => {
    const ie = (globalThis as any).__ie;
    const refKey = (p: any) => (p.kind === "node" ? `n:${p.id}` : `w:${p.title}${p.sec !== undefined ? `#${p.sec}` : ""}`);
    const kidClass = (key: string) => {
      let h = 5381;
      for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
      return `k${h.toString(36)}`;
    };
    const TAB = 30;
    const faults: string[] = [];
    const svg = document.querySelector<SVGSVGElement>(".curves")!.getBoundingClientRect();
    const box = { left: Math.round(svg.left), top: Math.round(svg.top) };
    const placed = new Map<number, any>(ie.panesPlaced.map((x: any) => [x.node.id, x]));
    for (const p of document.querySelectorAll<SVGPathElement>(".curves path:not(.foot)")) {
      const to = Number(p.dataset.to);
      const from = Number(p.dataset.from);
      const ce = document.querySelector<HTMLElement>(`.pane[data-tid="${to}"]`);
      const pe = document.querySelector<HTMLElement>(`.pane[data-tid="${from}"]`);
      const x = placed.get(to);
      if (!ce || !pe || !x) {
        faults.push(`${from}>${to}: no pane`);
        continue;
      }
      const a0 = p.getPointAtLength(0);
      const b0 = p.getPointAtLength(p.getTotalLength());
      const a = { x: a0.x + box.left, y: a0.y + box.top };
      const b = { x: b0.x + box.left, y: b0.y + box.top };
      const lost = p.classList.contains("lost");
      const name = `${from}>${to} ${ce.querySelector(".pane-head h2, .top h1, .wiki-head h2")?.textContent?.trim()}`;
      const cr = ce.getBoundingClientRect();
      const col = ce.parentElement!.getBoundingClientRect();
      const nextCol = (ce.parentElement!.nextElementSibling as HTMLElement | null)?.getBoundingClientRect().left ?? Infinity;
      // The end.
      const ruled = ce.dataset.ruled ?? "";
      if (ruled.includes("head")) {
        const head = ce.querySelector<HTMLElement>(":scope > .pane-scroll > .pane-body > .pane-head, :scope > .pane-scroll > .pane-body > .top h1, :scope > .pane-scroll > .pane-body > .wiki:not(.embedded) > .wiki-head")!;
        const r = head.getBoundingClientRect();
        if (Math.abs(b.y - (r.bottom - 0.5)) > 1.2) faults.push(`${name}: ends at y ${b.y}, its title's rule at ${r.bottom - 0.5}`);
        if (Math.abs(b.x - Math.min(r.right, nextCol, cr.right)) > 1.6) faults.push(`${name}: ends at x ${b.x}, its rule's end at ${Math.min(r.right, nextCol)}`);
      } else if (ruled.includes("tab") && !lost) {
        if (Math.abs(b.y - (cr.top + TAB - 0.5)) > 1.2) faults.push(`${name}: ends at y ${b.y}, its tab's foot at ${cr.top + TAB - 0.5}`);
      } else if (!lost) {
        if (b.x < col.left - 1 || b.x > col.left + 60 || b.y < cr.top - 1 || b.y > Math.min(cr.bottom, col.bottom) + 1) faults.push(`${name}: ends at ${b.x},${b.y}, outside its pane's head (${cr.top}..${cr.bottom})`);
      }
      // The start.
      const pr = pe.getBoundingClientRect();
      if (a.x < pr.left - 1 || a.x > Math.max(pr.right, pr.right) + 1) faults.push(`${name}: starts at x ${a.x}, outside its source pane ${pr.left}..${pr.right}`);
      const footStart = Math.abs(a.y - (pr.top + TAB - 0.5)) <= 1.2 && Math.abs(a.x - Math.min(pr.right - 1, col.left)) <= 2;
      if (lost || footStart) continue;
      const cands = [...pe.querySelectorAll<HTMLElement>(`.${kidClass(refKey(x.node.ref))}`)];
      const near = cands.some((c) => {
        const el = c.matches("li") ? (c.querySelector<HTMLElement>(":scope > .row") ?? c) : c;
        return [...el.getClientRects()].some((r) => a.x >= r.left - 2 && a.x <= r.right + 10 && a.y >= r.top - 4 && a.y <= r.bottom + 6);
      });
      if (!near) faults.push(`${name}: starts at ${a.x},${a.y}, not at its source (${cands.length} candidates)`);
    }
    // What peeks: its place left clear of every curve but its own; nothing left over once it is back.
    const peeked = [...document.querySelectorAll<HTMLElement>("[data-peek]")];
    const holes = [...document.querySelectorAll<SVGRectElement>("#ie-curve-holes rect.hole")].map((r) => ({ x: +r.getAttribute("x")! + box.left, y: +r.getAttribute("y")! + box.top, w: +r.getAttribute("width")!, h: +r.getAttribute("height")! }));
    const under = document.querySelector<SVGGElement>(".curves g.under");
    const over = [...document.querySelectorAll<SVGPathElement>(".curves g.over path")];
    for (const p of peeked) {
      const r = p.getBoundingClientRect();
      if (!holes.some((h) => Math.abs(h.x - r.left) < 1.5 && Math.abs(h.y - r.top) < 1.5 && Math.abs(h.w - r.width) < 1.5 && Math.abs(h.h - r.height) < 1.5)) faults.push(`peeking ${p.className}: its place is not clear of the curves`);
      if (under && under.getAttribute("mask") !== "url(#ie-curve-holes)") faults.push("peeking: the curves under it are not masked");
    }
    const owns = (id: string | undefined) => peeked.some((q) => q.contains(document.querySelector(`.pane[data-tid="${id}"]`)));
    for (const p of document.querySelectorAll<SVGPathElement>(".curves g.under path")) if (owns(p.dataset.from) || owns(p.dataset.to)) faults.push(`${p.dataset.key}: belongs to what peeks, but is under it`);
    for (const p of over) if (!owns(p.dataset.from) && !owns(p.dataset.to)) faults.push(`${p.dataset.key}: over what peeks, but not its own`);
    const bar = document.querySelector<HTMLElement>(".pane > .selbar");
    const barShown = !!bar && bar.style.visibility !== "hidden";
    if (!peeked.length && holes.length > (barShown ? 1 : 0)) faults.push(`nothing peeks, but ${holes.length} holes are left in the curves`);
    if (barShown) {
      const r = bar!.getBoundingClientRect();
      if (!holes.some((h) => Math.abs(h.x - r.left) < 1.5 && Math.abs(h.y - r.top) < 1.5)) faults.push("the selection bar's place is not clear of the curves");
    }
    return faults;
  });
