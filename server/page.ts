/**
 * Web pages for the server, in the manner of server/wiki.ts. See docs/pages.md for the rules it
 * follows and why.
 *
 *   article(url)        the page as a lead and a list of sections (server/pageHtml.ts), from the
 *                       snapshot cache, else read once (server/pageFetch.ts) and kept.
 *   summary(url)        title, site, author, date and the lead's first sentence, from the same
 *                       snapshot. { cacheOnly: true } answers from the cache alone, never the network.
 *   media(u)            an image that a kept snapshot shows (a picture, or a video's still: its
 *                       poster, YouTube's thumbnail), read through the same fetcher.
 *   reload(url)         read the page again at the reader's request: a page that no longer answers
 *                       keeps its last copy, marked stale; one whose text is unchanged keeps what a
 *                       model made of it.
 *   material(url)       what server/pageArrange.ts arranges, from the cache alone;
 *   keepModel(url, w)   and where it keeps what the model made of it.
 *
 * Page text is never stored in a library: only the Ref is. A snapshot lives in
 * <EX_DATA>/page-cache/<sha1(normUrl(url))>.json until the reader asks for it again with Reload:
 * pages have no revisions, and a silent re-read would move section ids under open panes. At most
 * 500 are kept; the least recently read goes first. A page that cannot be shown is remembered for
 * a day, so reopening it does not ask the site again at once (Reload asks at once).
 * A snapshot keeps the outline made without a model; what a model made (a summary, perhaps
 * sections m1, m2…) is kept beside it for the text it was made from, and laid over it when served.
 * Nothing here throws into a caller: failures come back as { ok: false, reason }.
 *
 * The types below are what the routes return, for the browser to import as it imports
 * server/wiki.ts's.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { normUrl } from "../src/llm/web";
import { IMAGE_MAX_BYTES, PAGE_MAX_BYTES, PAGE_TYPES, PageFetcher, type FetchFail, type Fetched } from "./pageFetch";
import { extractPage, firstSentence, pageMeta, plainToHtml, type Outline, type PageUnit } from "./pageHtml";
import { dataDir, writeAtomic } from "./util";
import type { Uncached } from "./wiki";

// ---- the shapes the routes return ----

/** One section: `id` is "h3", "p2" or "c1" (headings, pseudo-headings, parts by length). */
export interface WebSection {
  id: string;
  level: number;
  heading: string;
  /** The enclosing section's id, null at the top. */
  parent: string | null;
  /** Sanitised HTML. */
  html: string;
}
export interface WebAttribution {
  /** The address read, after redirects. */
  url: string;
  site: string;
  title: string;
  author?: string;
  /** ISO date (or date and time) the page gives for itself. */
  published?: string;
  /** ISO time it was read. */
  retrieved: string;
  /** What the app changed, each a phrase: "navigation and scripts removed". */
  adapted: string[];
  /** A Reload found the page gone; this is the last copy read. */
  stale?: boolean;
}
export interface WebArticle {
  /** The address read, after redirects. */
  url: string;
  /** The address asked for. */
  requested: string;
  canonical?: string;
  title: string;
  description?: string;
  /** Sanitised HTML. */
  lead: string;
  leadFrom: "intro" | "page-description" | "none";
  sections: WebSection[];
  outline: Outline | "model";
  /** Of the text units, not the raw HTML: unchanged text gives the same hash. */
  hash: string;
  words: number;
  attribution: WebAttribution;
  /**
   * What a model added at the reader's request (POST /api/page/arrange), never the page's own
   * words: a summary, and whether the sections are the model's (outline "model").
   */
  model?: { summary: string; sections: boolean; by?: string; at: string; note?: string };
}
export type WebUnusableReason = "robots" | "refused" | "type" | "empty" | "too-large" | "offline" | "error" | "off";
/** A page that is not shown: the reader is offered the original, with the reason in plain words. */
export interface WebUnusable {
  ok: false;
  reason: WebUnusableReason;
  message: string;
  title?: string;
  description?: string;
  site?: string;
  url: string;
}
/** For a link card or a model prompt: never more than the page says of itself and its first sentence. */
export interface WebSummary {
  url: string;
  requested: string;
  title: string;
  site: string;
  author?: string;
  published?: string;
  description?: string;
  /** The first sentence of the lead. */
  sentence: string;
}
export interface PageOk<V> {
  ok: true;
  value: V;
  /** Served from the snapshot cache without a request. */
  cached: boolean;
}
export type PageResult<V> = PageOk<V> | WebUnusable;
/** The caller went away before the answer: nothing to send. */
export interface Aborted {
  ok: false;
  reason: "aborted";
}
export type MediaResult = { ok: true; type: string; body: Uint8Array } | { ok: false; status: number; message: string };

// ---- configuration ----

const MAX_SNAPSHOTS = 500;
const UNUSABLE_TTL = 24 * 3600 * 1000;
const MEMO = 20;
/** What every web page shown has had done to it. */
const ADAPTED = "navigation and scripts removed";
const BY_LENGTH = "divided into parts by length";
export const BY_MODEL = "sections arranged by a model";
export const SUMMARY_BY_MODEL = "summary written by a model";

export interface PageOptions {
  dataDir?: string;
  /** Write snapshots to disk (default true; the mock keeps them in memory). */
  persist?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Least time between requests to one host (default 1 s). */
  spacingMs?: number;
  maxSnapshots?: number;
}

// ---- the snapshot cache ----

interface Snapshot {
  v: 1;
  requested: string;
  /** When it was read (ms). */
  at: number;
  article?: WebArticle;
  unusable?: WebUnusable;
  /** Unusable pages only: asked again after this (ms). */
  exp?: number;
  /** Image addresses the html shows. */
  media: string[];
  /** Headings of the sections left out as junk. */
  dropped: string[];
  /** The units of the lead and sections, for a model to arrange (absent in a snapshot read before arranging was). */
  units?: PageUnit[];
  /** How many of `units` are the lead's. */
  leadUnits?: number;
  /** What a model made of the page, for the text whose hash it carries. */
  model?: ModelWork;
  /** A Reload found the page gone: why, in words. */
  staleWhy?: string;
}

/** What a model made of a page (server/pageArrange.ts), kept in its snapshot. */
export interface ModelWork {
  /** The article's hash when it was made: it is laid over the page only while the text is the same. */
  hash: string;
  /** When (ms). */
  at: number;
  summary: string;
  /** Sections m1…, or null: the page keeps its own outline. */
  sections: WebSection[] | null;
  /** The model's name. */
  by?: string;
  /** Why a page that was to be arranged has only a summary. */
  note?: string;
}

/** What server/pageArrange.ts needs of a kept page. */
export interface PageMaterial {
  /** The page as read, without anything a model made. */
  article: WebArticle;
  /** The page as served. */
  view: WebArticle;
  units?: PageUnit[];
  leadUnits: number;
  model?: ModelWork;
}

interface IndexEntry {
  /** Last read (ms). */
  read: number;
  media: string[];
}

/**
 * One JSON file per snapshot, plus index.json: when each was last read and which images it shows,
 * so the media route can answer without opening every snapshot. A lost index is rebuilt from the
 * files; a damaged snapshot is only a cache, and is read as missing.
 */
class SnapshotStore {
  private memo = new Map<string, Snapshot>();
  private index: Map<string, IndexEntry> | null = null;
  private media: Map<string, number> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private dir: string | null,
    private now: () => number,
    private max: number,
  ) {}

  private file(name: string) {
    return join(this.dir!, `${name}.json`);
  }

  private load(): Map<string, IndexEntry> {
    if (this.index) return this.index;
    this.index = new Map();
    if (this.dir && existsSync(this.dir)) {
      try {
        const data = JSON.parse(readFileSync(this.file("index"), "utf8")) as { entries: [string, IndexEntry][] };
        for (const [k, e] of data.entries ?? []) this.index.set(k, e);
      } catch {
        // No index, or a damaged one: rebuilt from the files below.
      }
      // The index is written a second after a change: snapshots written since are read once here.
      const files = new Set(readdirSync(this.dir).filter((f) => /^[0-9a-f]{40}\.json$/.test(f)).map((f) => f.slice(0, -5)));
      for (const k of [...this.index.keys()]) if (!files.has(k)) this.index.delete(k);
      for (const k of files) {
        if (this.index.has(k)) continue;
        const s = this.readFile(k);
        if (s) this.index.set(k, { read: s.at, media: s.media });
      }
    }
    this.media = new Map();
    for (const e of this.index.values()) for (const m of e.media) this.media.set(m, (this.media.get(m) ?? 0) + 1);
    return this.index;
  }

  private readFile(name: string): Snapshot | undefined {
    try {
      const s = JSON.parse(readFileSync(this.file(name), "utf8")) as Snapshot;
      return s?.v === 1 ? s : undefined;
    } catch {
      return undefined;
    }
  }

  get(name: string): Snapshot | undefined {
    const index = this.load();
    let s = this.memo.get(name);
    if (!s && this.dir && index.has(name)) s = this.readFile(name);
    if (!s) return undefined;
    this.remember(name, s);
    const e = index.get(name);
    if (e) (e.read = this.now()), this.schedule();
    return s;
  }

  set(name: string, s: Snapshot) {
    const index = this.load();
    this.forget(name);
    index.set(name, { read: this.now(), media: s.media });
    for (const m of s.media) this.media!.set(m, (this.media!.get(m) ?? 0) + 1);
    this.remember(name, s);
    if (this.dir) {
      try {
        writeAtomic(this.file(name), JSON.stringify(s));
      } catch (e) {
        warnOnce(`page cache: could not write ${this.file(name)}: ${(e as Error).message}`);
      }
    }
    while (index.size > this.max) {
      let oldest: string | null = null;
      for (const [k, e] of index) if (oldest === null || e.read < index.get(oldest)!.read) oldest = k;
      this.drop(oldest!);
    }
    this.schedule();
  }

  /** Whether some kept snapshot shows this image. */
  hasMedia(u: string): boolean {
    this.load();
    return (this.media!.get(u) ?? 0) > 0;
  }

  get size(): number {
    return this.load().size;
  }

  private forget(name: string) {
    const e = this.index!.get(name);
    if (!e) return;
    for (const m of e.media) {
      const n = (this.media!.get(m) ?? 1) - 1;
      if (n > 0) this.media!.set(m, n);
      else this.media!.delete(m);
    }
    this.index!.delete(name);
  }

  private drop(name: string) {
    this.forget(name);
    this.memo.delete(name);
    if (this.dir) rmSync(this.file(name), { force: true });
  }

  private remember(name: string, s: Snapshot) {
    this.memo.delete(name);
    this.memo.set(name, s);
    if (this.memo.size > MEMO) this.memo.delete(this.memo.keys().next().value as string);
  }

  private schedule() {
    if (!this.dir || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1000);
    this.timer.unref?.();
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dir || !this.index) return;
    try {
      writeAtomic(this.file("index"), JSON.stringify({ version: 1, entries: [...this.index] }));
    } catch (e) {
      warnOnce(`page cache: could not write the index: ${(e as Error).message}`);
    }
  }
}

let warned = false;
function warnOnce(message: string) {
  if (!warned) console.warn(message);
  warned = true;
}

// ---- decoding ----

/** Text from bytes: the header's charset, else a <meta> one in the first 2 KB, else UTF-8. */
export function decodeBody(body: Uint8Array, charset?: string): string {
  let label = charset;
  if (!label) {
    const head = Buffer.from(body.subarray(0, 2048)).toString("latin1");
    label = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(label?.toLowerCase() || "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

const hostOf = (u: string) => {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return u;
  }
};

/** A bot check announced in the headers (Cloudflare, DataDome). */
function challenged(h: Headers | undefined): boolean {
  if (!h) return false;
  return h.get("cf-mitigated")?.toLowerCase() === "challenge" || /datadome/i.test(h.get("server") ?? "") || h.has("x-datadome") || h.has("x-datadome-cid");
}

/** Reasons worth remembering for a day: the site answered, and answered no. */
const LASTING = new Set<WebUnusableReason>(["robots", "refused", "type", "empty", "too-large"]);

// ---- the client ----

export class PageClient {
  private fetcher: PageFetcher;
  private store: SnapshotStore;
  private now: () => number;
  private building = new Map<string, Promise<Snapshot | WebUnusable>>();

  constructor(o: PageOptions = {}) {
    this.now = o.now ?? Date.now;
    const persist = o.persist !== false;
    this.store = new SnapshotStore(persist ? join(o.dataDir ?? dataDir(), "page-cache") : null, this.now, o.maxSnapshots ?? MAX_SNAPSHOTS);
    this.fetcher = new PageFetcher({ fetch: o.fetch, now: this.now, sleep: o.sleep, spacingMs: o.spacingMs });
  }

  /** Requests sent so far, robots.txt and images included. */
  get requests(): number {
    return this.fetcher.requests;
  }

  /** Snapshots kept. */
  get snapshots(): number {
    return this.store.size;
  }

  /** Write the cache's index now (it is otherwise written within a second). */
  flush() {
    this.store.flush();
  }

  /** A kept snapshot still in date, or undefined. */
  private kept(url: string): Snapshot | undefined {
    const s = this.store.get(key(url));
    if (!s) return undefined;
    if (s.unusable && (s.exp ?? 0) <= this.now()) return undefined;
    return s;
  }

  /** The kept snapshot, else one read now; one read per address however many ask at once. */
  private async snapshot(url: string, signal?: AbortSignal): Promise<{ s: Snapshot; cached: boolean } | WebUnusable | Aborted> {
    const have = this.kept(url);
    if (have) return { s: have, cached: true };
    const k = key(url);
    let p = this.building.get(k);
    if (!p) {
      p = this.read(url).finally(() => this.building.delete(k));
      this.building.set(k, p);
    }
    const r = await (signal ? Promise.race([p, whenAborted(signal)]) : p);
    if ("v" in r) return { s: r, cached: false };
    return r;
  }

  /** Read and extract a page, and keep what came of it (a transient failure is not kept). */
  private async read(url: string): Promise<Snapshot | WebUnusable> {
    const s = await this.fresh(url);
    if ("v" in s) this.store.set(key(url), s);
    return s;
  }

  /** Read and extract a page, keeping nothing. */
  private async fresh(url: string): Promise<Snapshot | WebUnusable> {
    try {
      const r = await this.fetcher.get(url, { types: PAGE_TYPES, maxBytes: PAGE_MAX_BYTES });
      return r.ok ? this.extract(url, r) : this.failed(url, r);
    } catch (e) {
      return { ok: false, reason: "error", message: `The page could not be read: ${(e as Error).message ?? e}`, url };
    }
  }

  /**
   * Read a page again (Reload). A new copy replaces the old, keeping what a model made of it when
   * the text is unchanged. When the page no longer answers (or no longer can be shown), a page
   * shown before keeps its last copy, marked stale, with the reason; one never shown is kept as
   * unusable as on a first read. One read per address however many ask at once.
   */
  private async renew(url: string): Promise<Snapshot | WebUnusable> {
    const k = key(url);
    const old = this.store.get(k);
    const s = await this.fresh(url);
    if ("v" in s && s.article) {
      if (old?.model && old.article?.hash === s.article.hash) s.model = old.model;
      this.store.set(k, s);
      return s;
    }
    if (old?.article) {
      const kept: Snapshot = { ...old, article: { ...old.article, attribution: { ...old.article.attribution, stale: true } }, staleWhy: "v" in s ? s.unusable!.message : s.message };
      this.store.set(k, kept);
      return kept;
    }
    if ("v" in s) this.store.set(k, s);
    return s;
  }

  private failed(url: string, r: FetchFail): Snapshot | WebUnusable {
    const bot = challenged(r.headers);
    const message = bot ? "The site answered with a bot check instead of the page." : r.status === 403 || r.status === 401 ? `The site refused to let this program read the page (it answered ${r.status}).` : r.message;
    const unusable: WebUnusable = { ok: false, reason: r.reason, message, url: r.url, site: hostOf(r.url) };
    return LASTING.has(r.reason) ? this.unusableSnapshot(url, unusable) : unusable;
  }

  private unusableSnapshot(url: string, unusable: WebUnusable): Snapshot {
    const at = this.now();
    return { v: 1, requested: url, at, exp: at + UNUSABLE_TTL, unusable, media: [], dropped: [] };
  }

  private extract(url: string, r: Fetched): Snapshot {
    const text = decodeBody(r.body, r.charset);
    const html = r.type === "text/plain" ? plainToHtml(text) : text;
    if (challenged(r.headers)) {
      const m = pageMeta(html, r.url);
      return this.unusableSnapshot(url, { ok: false, reason: "refused", message: "The site answered with a bot check instead of the page.", url: r.url, site: m.site });
    }
    const ex = extractPage(html, r.url);
    const meta = ex.meta;
    if (!ex.ok) {
      return this.unusableSnapshot(url, {
        ok: false,
        reason: ex.reason,
        message: ex.message,
        url: r.url,
        // The host stands in for a missing title in an article, but is not offered as one here.
        ...(ex.reason === "refused" || meta.title === hostOf(r.url) ? {} : { title: meta.title }),
        ...(meta.description ? { description: meta.description } : {}),
        site: meta.site,
      });
    }
    const adapted = [ADAPTED];
    if (ex.dropped.length) adapted.push(`sections left out: ${ex.dropped.join(", ")}`);
    if (ex.outline === "chunks") adapted.push(BY_LENGTH);
    const at = this.now();
    const article: WebArticle = {
      url: r.url,
      requested: url,
      ...(meta.canonical ? { canonical: meta.canonical } : {}),
      title: meta.title,
      ...(meta.description ? { description: meta.description } : {}),
      lead: ex.lead,
      leadFrom: ex.leadFrom,
      sections: ex.sections,
      outline: ex.outline,
      hash: ex.hash,
      words: ex.words,
      attribution: {
        url: r.url,
        site: meta.site,
        title: meta.title,
        ...(meta.author ? { author: meta.author } : {}),
        ...(meta.published ? { published: meta.published } : {}),
        retrieved: new Date(at).toISOString(),
        adapted,
      },
    };
    return { v: 1, requested: url, at, article, media: ex.media, dropped: ex.dropped, units: ex.units, leadUnits: ex.leadUnits };
  }

  /** The page as a lead and sections. */
  async article(url: string, o: { signal?: AbortSignal } = {}): Promise<PageResult<WebArticle> | Aborted> {
    const r = await this.snapshot(url, o.signal);
    if (!("s" in r)) return r;
    return r.s.article ? { ok: true, value: served(r.s)!, cached: r.cached } : r.s.unusable!;
  }

  /**
   * Read the page again, now (the reader's Reload). `stale` is set, with the reason, when the page
   * no longer answers and the last copy is what comes back.
   */
  async reload(url: string, o: { signal?: AbortSignal } = {}): Promise<(PageOk<WebArticle> & { stale?: string }) | WebUnusable | Aborted> {
    const k = key(url);
    let p = this.building.get(k);
    if (!p) {
      p = this.renew(url).finally(() => this.building.delete(k));
      this.building.set(k, p);
    }
    const r = await (o.signal ? Promise.race([p, whenAborted(o.signal)]) : p);
    if (!("v" in r)) return r;
    if (!r.article) return r.unusable!;
    return { ok: true, value: served(r)!, cached: false, ...(r.article.attribution.stale && r.staleWhy ? { stale: r.staleWhy } : {}) };
  }

  /** A kept page as server/pageArrange.ts arranges it, from the cache alone; null if it is not kept or not shown. */
  material(url: string): PageMaterial | null {
    const s = this.store.get(key(url));
    if (!s?.article) return null;
    return { article: s.article, view: served(s)!, units: s.units, leadUnits: s.leadUnits ?? 0, ...(s.model ? { model: s.model } : {}) };
  }

  /** Keep what a model made of a page, if the page still reads as it did; the page as now served, or null. */
  keepModel(url: string, work: ModelWork): WebArticle | null {
    const k = key(url);
    const s = this.store.get(k);
    if (!s?.article || s.article.hash !== work.hash) return null;
    const next: Snapshot = { ...s, model: work };
    this.store.set(k, next);
    return served(next) ?? null;
  }

  /**
   * Title, site, author, date and first sentence. With cacheOnly, from a kept snapshot or
   * "uncached", and never a request: for a link card on hover, or a model prompt.
   */
  async summary(url: string, o: { signal?: AbortSignal; cacheOnly?: boolean } = {}): Promise<PageResult<WebSummary> | Uncached | Aborted> {
    if (o.cacheOnly) {
      const s = this.store.get(key(url));
      if (!s) return { ok: false, reason: "uncached", message: `Nothing from ${url} is cached` };
      return s.article ? { ok: true, value: summaryOf(s.article), cached: true } : s.unusable!;
    }
    const r = await this.snapshot(url, o.signal);
    if (!("s" in r)) return r;
    return r.s.article ? { ok: true, value: summaryOf(r.s.article), cached: r.cached } : r.s.unusable!;
  }

  /** An image a kept snapshot shows (never any other address), read through the same fetcher. */
  async media(u: string, o: { signal?: AbortSignal } = {}): Promise<MediaResult | Aborted> {
    if (!this.store.hasMedia(u)) return { ok: false, status: 404, message: "This image is not in a page read here." };
    const r = await this.fetcher.get(u, { types: ["image/*"], maxBytes: IMAGE_MAX_BYTES, signal: o.signal });
    if (o.signal?.aborted) return { ok: false, reason: "aborted" };
    if (r.ok) return { ok: true, type: r.type, body: r.body };
    const status = r.reason === "type" ? 415 : r.reason === "too-large" ? 413 : r.reason === "robots" || r.reason === "refused" ? 403 : 502;
    const message = r.reason === "type" ? "This address does not answer with an image." : r.reason === "too-large" ? "The image is larger than 10 MB." : r.message;
    return { ok: false, status, message };
  }
}

/**
 * A snapshot's article as served: with what a model made of it laid over it, while the text is
 * the one it was made from. The model's sections replace parts by length; the page's own
 * sections are never replaced.
 */
function served(s: Snapshot): WebArticle | undefined {
  const a = s.article;
  const m = s.model;
  if (!a || !m || m.hash !== a.hash) return a;
  const adapted = a.attribution.adapted.filter((x) => !(m.sections && x === BY_LENGTH));
  if (m.sections) adapted.push(BY_MODEL);
  if (m.summary) adapted.push(SUMMARY_BY_MODEL);
  return {
    ...a,
    ...(m.sections ? { sections: m.sections, outline: "model" as const } : {}),
    attribution: { ...a.attribution, adapted },
    model: { summary: m.summary, sections: !!m.sections, ...(m.by ? { by: m.by } : {}), at: new Date(m.at).toISOString(), ...(m.note ? { note: m.note } : {}) },
  };
}

function summaryOf(a: WebArticle): WebSummary {
  const at = a.attribution;
  return {
    url: a.url,
    requested: a.requested,
    title: a.title,
    site: at.site,
    ...(at.author ? { author: at.author } : {}),
    ...(at.published ? { published: at.published } : {}),
    ...(a.description ? { description: a.description } : {}),
    sentence: firstSentence(a.lead || a.sections[0]?.html || ""),
  };
}

/** The cache key: the address as compared for sameness (no fragment, no trailing slash). */
const key = (url: string) => createHash("sha1").update(normUrl(url)).digest("hex");

const whenAborted = (signal: AbortSignal) =>
  new Promise<Aborted>((done) => {
    if (signal.aborted) return done({ ok: false, reason: "aborted" });
    signal.addEventListener("abort", () => done({ ok: false, reason: "aborted" }), { once: true });
  });

let shared: PageClient | null = null;
/** The server's client, keeping its cache under EX_DATA. */
export function pages(): PageClient {
  if (!shared) {
    shared = new PageClient();
    process.once("exit", () => shared?.flush());
  }
  return shared;
}
