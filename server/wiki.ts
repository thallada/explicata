/**
 * A small Wikipedia client, used only by the server. See docs/wikipedia.md for the rules it
 * follows and why.
 *
 *   lookup(phrases)     batched existence check: canonical title, redirect, disambiguation,
 *                       short description, missing. 50 titles per request (the API's limit).
 *   senses(title)       the articles a disambiguation page lists, with their descriptions.
 *   suggest(prefix)     title autocomplete (REST search/title).
 *   search(query)       full-text search with snippets (REST search/page; CirrusSearch syntax).
 *   summary(title)      extract, description, thumbnail, canonical URL, revision (REST page/summary).
 *                       { cacheOnly: true } answers from the cache alone, never the network.
 *   article(title)      lead plus the section list; section(title, id) one section. The whole page
 *                       is fetched once (action=parse), split at its headings, sanitised (images
 *                       dropped), cached. { sections: true } returns every section's html too.
 *
 * Every request goes through one serial queue with a minimum spacing, priority for interactive
 * calls, Retry-After / 429 / 503 / maxlag handling, and a descriptive User-Agent. Results are
 * cached on disk under <EX_DATA>/wiki-cache/, so scanning the same text twice costs nothing.
 * Nothing here throws into a caller: failures come back as { ok: false, reason }.
 *
 * Only the candidate phrase or the search query itself is ever sent, never surrounding text.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, writeAtomic as write } from "./util";
import { snippet, splitArticle } from "./wikiHtml";

// ---- results ----

/**
 * interactive: a person is waiting (an article, a preview, autocomplete). bulk: a background job.
 * scan: the link scan that follows an edit, which nobody is waiting on as such: it goes last, so
 * opening an article is never stuck behind it, except that one waiting over SCAN_STARVE_MS is let
 * ahead of a long bulk job, so scans still finish while a library is being scanned.
 */
export type Priority = "interactive" | "bulk" | "scan";
const SCAN_STARVE_MS = 30_000;
export interface CallOpts {
  /** interactive: a person is waiting (jumps the queue, no maxlag). bulk: background jobs. scan: after an edit (last). */
  priority?: Priority;
  /** Abort while queued (e.g. a superseded keystroke): the request is then never sent. */
  signal?: AbortSignal;
}
export type UnavailableReason = "offline" | "rate-limited" | "server" | "bad-response" | "aborted";
export interface Unavailable {
  ok: false;
  reason: UnavailableReason;
  message: string;
  /** Seconds until the client will try the network again, when known. */
  retryAfter?: number;
}
export interface Missing {
  ok: false;
  reason: "missing";
  message: string;
}
/** A cache-only call found nothing cached. */
export interface Uncached {
  ok: false;
  reason: "uncached";
  message: string;
}
export interface Ok<V> {
  ok: true;
  value: V;
  /** Served from the disk cache without a request. */
  cached: boolean;
  /** Served from an expired cache entry because the network failed. */
  stale?: boolean;
}
export type Result<V> = Ok<V> | Unavailable | Missing;

export type LookupItem =
  | {
      input: string;
      status: "found";
      title: string;
      pageId: number;
      /** The input was a redirect to `title`. */
      redirect: boolean;
      /** Section the redirect points at, if any. */
      fragment?: string;
      disambiguation: boolean;
      description: string | null;
      url: string;
      cached: boolean;
    }
  | { input: string; status: "missing"; cached: boolean }
  | { input: string; status: "invalid"; reason: string; cached: boolean }
  | { input: string; status: "unavailable"; reason: UnavailableReason; cached: false };

export interface Sense {
  title: string;
  description: string | null;
  url: string;
}
export interface TitleSuggestion {
  title: string;
  description: string | null;
  thumbnail: string | null;
  url: string;
}
export interface SearchHit {
  title: string;
  pageId: number;
  description: string | null;
  /** Plain text of the snippet. */
  snippet: string;
  /** The snippet with matches in <mark>, everything else escaped. */
  snippetHtml: string;
  thumbnail: string | null;
  url: string;
}
export interface Attribution {
  title: string;
  url: string;
  revisionId: number | null;
  revisionUrl: string | null;
  historyUrl: string;
  license: { name: "CC BY-SA 4.0"; url: string };
  /** One line the UI must show next to the text. */
  text: string;
  /** What the app removed, which the licence asks us to indicate. Null if shown unmodified. */
  modified: string | null;
}
export interface Summary {
  title: string;
  pageId: number | null;
  description: string | null;
  extract: string;
  thumbnail: { url: string; width: number; height: number } | null;
  url: string;
  revisionId: number | null;
  disambiguation: boolean;
  attribution: Attribution;
}
export interface SectionInfo {
  /** 1-based, in page order; equals the API's section index for sections written on the page. */
  id: number;
  level: number;
  heading: string;
  anchor: string;
  /** "2.1" style number from the table of contents, when available. */
  number: string | null;
  /** id of the enclosing section, 0 for top level. */
  parent: number;
}
export interface Article {
  title: string;
  pageId: number;
  revisionId: number;
  url: string;
  /** A disambiguation page: a list of other articles rather than an article. */
  disambiguation: boolean;
  /** Sanitised HTML of the lead (section 0). */
  lead: string;
  sections: SectionInfo[];
  attribution: Attribution;
}
/** article(title, { sections: true }): every section with its sanitised HTML. */
export interface FullArticle extends Article {
  sections: (SectionInfo & { html: string })[];
}
export interface Section extends SectionInfo {
  title: string;
  revisionId: number;
  html: string;
  attribution: Attribution;
}

// ---- configuration ----

const DEFAULT_LANG = "en";
const TITLES_PER_REQUEST = 50;
const DAY = 24 * 3600 * 1000;
const TTL = {
  found: 30 * DAY,
  missing: 3 * DAY,
  invalid: 30 * DAY,
  senses: 14 * DAY,
  summary: 14 * DAY,
  article: 7 * DAY,
  suggest: 1 * DAY,
  search: 1 * DAY,
};
/** Spacing with a recognised contact in the User-Agent: 1 request/s, well under 200/min. */
const SPACING_IDENTIFIED_MS = 1000;
/** Without one the gateway may treat us as "unidentified" (10/min): stay under it. */
const SPACING_ANONYMOUS_MS = 6500;
/** After a network failure, answer "offline" without trying again for this long. */
const OFFLINE_HOLD_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const MAX_WAIT: Record<Priority, number> = { interactive: 8_000, bulk: 120_000, scan: 120_000 };

/**
 * A contact the gateway can recognise: an email address, an http(s) URL, or a wiki user
 * ("User:Name"), with no spaces or parentheses. Anything else is ignored.
 */
export function validContact(contact: string | undefined): string | null {
  const c = contact?.trim();
  if (!c || /[\s();]/.test(c) || c.length > 100) return null;
  if (/^[^@]+@[^@]+\.[^@]+$/.test(c) || /^https?:\/\/[^/]+\.[^/]+/.test(c) || /^User:\S+$/.test(c)) return c;
  return null;
}

/** The User-Agent: generic by default; never the owner's name, host or paths unless they supply a contact. */
export function userAgent(contact: string | null): string {
  return contact ? `Explicata/0.1 (${contact})` : "Explicata/0.1 (personal knowledge tool)";
}

interface WikiOptions {
  dataDir?: string;
  lang?: string;
  contact?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  spacingMs?: number;
  /** Write the cache to disk (default true). */
  persist?: boolean;
  /** How long a network failure holds the client offline (default 30 s; the mock uses 0). */
  offlineHoldMs?: number;
}

/** A Wikipedia language code, or the default. */
export function wikiLang(lang: string | undefined): string {
  return /^[a-z][a-z0-9-]{1,15}$/.test(lang ?? "") ? lang! : DEFAULT_LANG;
}

// ---- the queue ----

interface Fetched {
  ok: true;
  status: number;
  headers: Headers;
  text: string;
}
type Outcome = Fetched | Unavailable;

interface Job {
  url: string;
  priority: Priority;
  /** When it was queued. */
  at: number;
  signal?: AbortSignal;
  resolve: (o: Outcome) => void;
}

const unavailable = (reason: UnavailableReason, message: string, retryAfter?: number): Unavailable => ({
  ok: false,
  reason,
  message,
  ...(retryAfter !== undefined ? { retryAfter } : {}),
});

/** Retry-After is seconds or an HTTP date. Returns milliseconds, or null. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    if (signal?.aborted) return done();
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true });
  });

/**
 * One request at a time, at least `spacingMs` apart, interactive jobs first. A 429 or 503 (or an
 * Action API maxlag error) pauses the whole queue for Retry-After, or 5 s doubling; a job whose
 * wait would exceed its priority's patience gets "rate-limited" at once. A network failure marks
 * the client offline for `offlineHoldMs` (30 s) so that typing does not hammer a dead connection.
 */
class RequestQueue {
  private lanes: Record<Priority, Job[]> = { interactive: [], bulk: [], scan: [] };
  private busy = false;
  private lastStart = -Infinity;
  pausedUntil = 0;
  offlineUntil = 0;
  requests = 0;

  constructor(
    private o: {
      fetch: typeof fetch;
      userAgent: string;
      spacingMs: number;
      offlineHoldMs: number;
      now: () => number;
      sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    },
  ) {}

  get spacing() {
    return this.o.spacingMs;
  }

  get(url: string, priority: Priority, signal?: AbortSignal): Promise<Outcome> {
    if (signal?.aborted) return Promise.resolve(unavailable("aborted", "aborted"));
    return new Promise((resolve) => {
      const job: Job = { url, priority, at: this.o.now(), signal, resolve };
      this.lanes[priority].push(job);
      signal?.addEventListener(
        "abort",
        () => {
          const lane = this.lanes[priority];
          const i = lane.indexOf(job);
          if (i >= 0) {
            lane.splice(i, 1);
            resolve(unavailable("aborted", "aborted"));
          }
        },
        { once: true },
      );
      void this.pump();
    });
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const starved = this.lanes.scan[0] && this.o.now() - this.lanes.scan[0].at > SCAN_STARVE_MS;
        const job = this.lanes.interactive.shift() ?? (starved ? this.lanes.scan.shift() : undefined) ?? this.lanes.bulk.shift() ?? this.lanes.scan.shift();
        if (!job) break;
        job.resolve(await this.execute(job).catch((e) => unavailable("bad-response", String(e))));
      }
    } finally {
      this.busy = false;
    }
  }

  private async execute(job: Job): Promise<Outcome> {
    const patience = MAX_WAIT[job.priority];
    for (let attempt = 0; ; attempt++) {
      const now = this.o.now();
      if (now < this.offlineUntil) {
        return unavailable("offline", "Wikipedia could not be reached", Math.ceil((this.offlineUntil - now) / 1000));
      }
      const paused = this.pausedUntil - now;
      if (paused > patience) {
        return unavailable("rate-limited", "Wikipedia asked us to slow down", Math.ceil(paused / 1000));
      }
      const wait = Math.max(paused, this.lastStart + this.o.spacingMs - now, 0);
      if (wait > 0) await this.o.sleep(wait, job.signal);
      if (job.signal?.aborted) return unavailable("aborted", "aborted");
      this.lastStart = this.o.now();
      this.requests++;
      let res: Response;
      let text: string;
      try {
        const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(job.signal ? [job.signal] : [])];
        res = await this.o.fetch(job.url, {
          headers: { "user-agent": this.o.userAgent, "accept-encoding": "gzip", accept: "application/json, text/html" },
          signal: AbortSignal.any(signals),
        });
        text = await res.text();
      } catch (e) {
        if (job.signal?.aborted) return unavailable("aborted", "aborted");
        this.offlineUntil = this.o.now() + this.o.offlineHoldMs;
        return unavailable("offline", `Wikipedia could not be reached: ${(e as Error).message ?? e}`, Math.ceil(this.o.offlineHoldMs / 1000));
      }
      const maxlag = res.status === 200 && text.length < 2000 && /"code"\s*:\s*"maxlag"/.test(text);
      if (res.status === 429 || res.status === 503 || maxlag) {
        const ra = parseRetryAfter(res.headers.get("retry-after"), this.o.now());
        const backoff = ra ?? 5000 * 2 ** attempt;
        this.pausedUntil = this.o.now() + backoff;
        if (attempt + 1 >= MAX_ATTEMPTS || backoff > patience) {
          return unavailable(
            res.status === 503 && !ra ? "server" : "rate-limited",
            `Wikipedia answered ${maxlag ? "maxlag" : res.status}`,
            Math.ceil(backoff / 1000),
          );
        }
        continue;
      }
      return { ok: true, status: res.status, headers: res.headers, text };
    }
  }
}

// ---- disk cache ----

interface Entry<V> {
  v: V;
  exp: number;
}

/** A key-value map with expiry, held in memory and written to one JSON file (debounced, atomic). */
class KvStore<V> {
  private map: Map<string, Entry<V>> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private file: string | null,
    private now: () => number,
    private maxEntries = 200_000,
  ) {}

  private load(): Map<string, Entry<V>> {
    if (this.map) return this.map;
    this.map = new Map();
    if (this.file && existsSync(this.file)) {
      try {
        const data = JSON.parse(readFileSync(this.file, "utf8")) as { entries: [string, Entry<V>][] };
        for (const [k, e] of data.entries ?? []) this.map.set(k, e);
      } catch {
        // A damaged cache is only a cache: start again.
      }
    }
    return this.map;
  }

  get(key: string): { value: V; fresh: boolean } | undefined {
    const e = this.load().get(key);
    return e ? { value: e.v, fresh: e.exp > this.now() } : undefined;
  }

  set(key: string, v: V, ttl: number) {
    const map = this.load();
    map.delete(key);
    map.set(key, { v, exp: this.now() + ttl });
    while (map.size > this.maxEntries) map.delete(map.keys().next().value as string);
    this.schedule();
  }

  private schedule() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1000);
    this.timer.unref?.();
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file || !this.map) return;
    writeAtomic(this.file, JSON.stringify({ version: 1, entries: [...this.map] }));
  }
}

/** Large values (whole articles), one file per key. */
class BlobStore<V> {
  private memo = new Map<string, Entry<V>>();
  constructor(
    private dir: string | null,
    private now: () => number,
  ) {}
  private path(key: string) {
    return join(this.dir!, createHash("sha1").update(key).digest("hex") + ".json");
  }
  get(key: string): { value: V; fresh: boolean } | undefined {
    let e = this.memo.get(key);
    if (!e && this.dir && existsSync(this.path(key))) {
      try {
        e = JSON.parse(readFileSync(this.path(key), "utf8")) as Entry<V>;
        this.remember(key, e);
      } catch {
        e = undefined;
      }
    }
    return e ? { value: e.v, fresh: e.exp > this.now() } : undefined;
  }
  set(key: string, v: V, ttl: number) {
    const e = { v, exp: this.now() + ttl };
    this.remember(key, e);
    if (this.dir) writeAtomic(this.path(key), JSON.stringify(e));
  }
  private remember(key: string, e: Entry<V>) {
    this.memo.delete(key);
    this.memo.set(key, e);
    if (this.memo.size > 50) this.memo.delete(this.memo.keys().next().value as string);
  }
}

let warnedWrite = false;
function writeAtomic(file: string, data: string) {
  try {
    write(file, data);
  } catch (e) {
    if (!warnedWrite) console.warn(`wiki cache: could not write ${file}: ${(e as Error).message}`);
    warnedWrite = true;
  }
}

// ---- titles ----

/** Characters MediaWiki never allows in a title. */
const ILLEGAL = /[#<>[\]|{}\u0000-\u001f\u007f�]/;

/** The form MediaWiki would normalise a main-namespace title to (spaces, first letter). */
export function prepareTitle(input: string): { title: string } | { invalid: string } {
  const t = input.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return { invalid: "empty" };
  if (ILLEGAL.test(t)) return { invalid: "illegal character" };
  if (Buffer.byteLength(t) > 255) return { invalid: "too long" };
  if (t.startsWith(":") || /^\.\.?(\/|$)/.test(t) || t.includes("/./") || t.includes("/../")) return { invalid: "not a page title" };
  const first = String.fromCodePoint(t.codePointAt(0)!);
  return { title: first.toUpperCase() + t.slice(first.length) };
}

// ---- the client ----

type LookupValue =
  | { status: "found"; title: string; pageId: number; redirect: boolean; fragment?: string; disambiguation: boolean; description: string | null }
  | { status: "missing" }
  | { status: "invalid"; reason: string };

interface CachedArticle {
  title: string;
  pageId: number;
  revisionId: number;
  /** Absent in entries cached before it was recorded: read as false. */
  disambiguation?: boolean;
  lead: string;
  sections: (SectionInfo & { html: string })[];
}

export class WikiClient {
  readonly lang: string;
  readonly userAgent: string;
  readonly contact: string | null;
  private queue: RequestQueue;
  private now: () => number;
  private titles: KvStore<LookupValue>;
  private small: KvStore<unknown>;
  private articles: BlobStore<CachedArticle>;

  constructor(o: WikiOptions = {}) {
    this.lang = wikiLang(o.lang);
    this.contact = validContact(o.contact);
    this.userAgent = userAgent(this.contact);
    this.now = o.now ?? Date.now;
    const persist = o.persist !== false;
    const dir = persist ? join(o.dataDir ?? dataDir(), "wiki-cache", this.lang) : null;
    this.titles = new KvStore(dir && join(dir, "titles.json"), this.now);
    this.small = new KvStore(dir && join(dir, "small.json"), this.now, 20_000);
    this.articles = new BlobStore(dir && join(dir, "articles"), this.now);
    this.queue = new RequestQueue({
      fetch: o.fetch ?? fetch,
      userAgent: this.userAgent,
      spacingMs: o.spacingMs ?? (this.contact ? SPACING_IDENTIFIED_MS : SPACING_ANONYMOUS_MS),
      offlineHoldMs: o.offlineHoldMs ?? OFFLINE_HOLD_MS,
      now: this.now,
      sleep: o.sleep ?? defaultSleep,
    });
  }

  /** Requests sent to Wikipedia so far. */
  get requests(): number {
    return this.queue.requests;
  }

  /** How many of these phrases a lookup would have to ask Wikipedia about (none fresh in the cache). */
  uncached(inputs: string[]): number {
    const seen = new Set<string>();
    for (const input of inputs) {
      const p = prepareTitle(input);
      if ("title" in p && !this.titles.get(p.title)?.fresh) seen.add(p.title);
    }
    return seen.size;
  }

  /** Milliseconds the queue leaves between requests. */
  get spacingMs(): number {
    return this.queue.spacing;
  }

  /** Write pending cache entries now (they are otherwise written within a second). */
  flush() {
    this.titles.flush();
    this.small.flush();
  }

  private get site() {
    return `https://${this.lang}.wikipedia.org`;
  }
  articleUrl(title: string) {
    return `${this.site}/wiki/${encodeURIComponent(title.replace(/ /g, "_")).replace(/%2F/g, "/").replace(/%3A/g, ":")}`;
  }
  private restTitle(title: string) {
    return encodeURIComponent(title.replace(/ /g, "_"));
  }

  attribution(title: string, revisionId: number | null, modified: string | null): Attribution {
    const enc = this.restTitle(title);
    return {
      title,
      url: this.articleUrl(title),
      revisionId,
      revisionUrl: revisionId ? `${this.site}/w/index.php?title=${enc}&oldid=${revisionId}` : null,
      historyUrl: `${this.site}/w/index.php?title=${enc}&action=history`,
      license: { name: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" },
      text: `From the Wikipedia article “${title}”${revisionId ? ` (revision ${revisionId})` : ""}, by its contributors, under CC BY-SA 4.0.${modified ? ` ${modified}` : ""}`,
      modified,
    };
  }

  private async getJson(url: string, o: CallOpts): Promise<{ ok: true; status: number; json: any } | Unavailable> {
    const r = await this.queue.get(url, o.priority ?? "interactive", o.signal);
    if (!r.ok) return r;
    try {
      return { ok: true, status: r.status, json: JSON.parse(r.text) };
    } catch {
      if (r.status >= 500) return unavailable("server", `Wikipedia answered ${r.status}`);
      return unavailable("bad-response", `Wikipedia answered ${r.status} with something other than JSON`);
    }
  }

  private actionUrl(params: Record<string, string>, o: CallOpts) {
    const p = new URLSearchParams({ action: "query", format: "json", formatversion: "2", ...params });
    // maxlag is for work nobody is waiting on (Manual:Maxlag_parameter).
    if ((o.priority ?? "interactive") !== "interactive") p.set("maxlag", "5");
    return `${this.site}/w/api.php?${p}`;
  }

  /** Read through the small-value cache: fresh hit, else fetch, else stale on failure. */
  private async cachedSmall<V>(key: string, ttl: number, load: () => Promise<Result<V>>): Promise<Result<V>> {
    const hit = this.small.get(key) as { value: V; fresh: boolean } | undefined;
    if (hit?.fresh) return { ok: true, value: hit.value, cached: true };
    const r = await load();
    if (r.ok) this.small.set(key, r.value, ttl);
    else if (r.reason !== "missing" && r.reason !== "aborted" && hit) return { ok: true, value: hit.value, cached: true, stale: true };
    return r;
  }

  // -- lookup --

  /**
   * Which of these phrases are article titles. Inputs are deduplicated after normalisation;
   * uncached ones are asked in batches of 50 (the Action API's limit for clients without
   * apihighlimits). Found, missing and invalid answers are all cached.
   */
  async lookup(inputs: string[], o: CallOpts = {}): Promise<LookupItem[]> {
    try {
      const prepared = inputs.map((input) => ({ input, p: prepareTitle(input) }));
      const answers = new Map<string, { v: LookupValue; cached: boolean } | { unavailable: UnavailableReason }>();
      const need: string[] = [];
      const stale = new Map<string, LookupValue>();
      for (const { p } of prepared) {
        if (!("title" in p) || answers.has(p.title) || need.includes(p.title)) continue;
        const hit = this.titles.get(p.title);
        if (hit?.fresh) {
          answers.set(p.title, { v: hit.value, cached: true });
        } else {
          if (hit) stale.set(p.title, hit.value);
          need.push(p.title);
        }
      }
      for (const batch of batches(need)) {
        const r = await this.getJson(
          this.actionUrl(
            { titles: batch.join("|"), redirects: "1", prop: "pageprops|description", ppprop: "disambiguation" },
            o,
          ),
          o,
        );
        const mapped = r.ok ? mapQuery(batch, r.json) : null;
        for (const t of batch) {
          const v = mapped?.get(t);
          if (v) {
            answers.set(t, { v, cached: false });
            this.titles.set(t, v, v.status === "found" ? TTL.found : v.status === "missing" ? TTL.missing : TTL.invalid);
          } else if (stale.has(t)) {
            answers.set(t, { v: stale.get(t)!, cached: true });
          } else {
            answers.set(t, { unavailable: r.ok ? "bad-response" : r.reason });
          }
        }
      }
      return prepared.map(({ input, p }): LookupItem => {
        if (!("title" in p)) return { input, status: "invalid", reason: p.invalid, cached: true };
        const a = answers.get(p.title)!;
        if ("unavailable" in a) return { input, status: "unavailable", reason: a.unavailable, cached: false };
        const v = a.v;
        if (v.status === "found") return { input, ...v, url: this.articleUrl(v.title), cached: a.cached };
        return { input, ...v, cached: a.cached };
      });
    } catch (e) {
      console.warn("wiki lookup:", e);
      return inputs.map((input) => ({ input, status: "unavailable", reason: "bad-response", cached: false }));
    }
  }

  /** The main-namespace articles a disambiguation page links to, with short descriptions. */
  async senses(title: string, o: CallOpts = {}): Promise<Result<Sense[]>> {
    const p = prepareTitle(title);
    if (!("title" in p)) return { ok: false, reason: "missing", message: p.invalid };
    return this.cachedSmall(`senses:${p.title}`, TTL.senses, async () => {
      const r = await this.getJson(
        this.actionUrl(
          { titles: p.title, redirects: "1", generator: "links", gplnamespace: "0", gpllimit: "max", prop: "description|pageprops", ppprop: "disambiguation" },
          o,
        ),
        o,
      );
      if (!r.ok) return r;
      const pages: any[] = r.json?.query?.pages ?? [];
      const senses = pages
        .filter((pg) => !pg.missing && !pg.invalid && pg.pageprops?.disambiguation === undefined)
        .map((pg): Sense => ({ title: String(pg.title), description: pg.description ?? null, url: this.articleUrl(String(pg.title)) }));
      return { ok: true, value: senses, cached: false };
    });
  }

  // -- search --

  /** Title autocomplete: what the REST search/title endpoint is documented for ("typeahead"). */
  async suggest(prefix: string, limit = 8, o: CallOpts = {}): Promise<Result<TitleSuggestion[]>> {
    const q = prefix.replace(/\s+/g, " ").trim();
    if (!q) return { ok: true, value: [], cached: true };
    const n = clamp(limit, 1, 20);
    return this.cachedSmall(`suggest:${n}:${q.toLowerCase()}`, TTL.suggest, async () => {
      const r = await this.getJson(`${this.site}/w/rest.php/v1/search/title?${new URLSearchParams({ q, limit: String(n) })}`, o);
      if (!r.ok) return r;
      if (r.status !== 200 || !Array.isArray(r.json?.pages)) return unavailable("bad-response", `search/title answered ${r.status}`);
      return {
        ok: true,
        cached: false,
        value: r.json.pages.map((pg: any): TitleSuggestion => ({
          title: String(pg.title),
          description: pg.description ?? null,
          thumbnail: absolute(pg.thumbnail?.url),
          url: this.articleUrl(String(pg.title)),
        })),
      };
    });
  }

  /**
   * Full-text search (CirrusSearch). The query may use its syntax: "quoted phrases",
   * intitle:, morelike:Title, -exclusions. Only the query is sent.
   */
  async search(query: string, limit = 10, o: CallOpts = {}): Promise<Result<SearchHit[]>> {
    const q = query.replace(/\s+/g, " ").trim();
    if (!q) return { ok: true, value: [], cached: true };
    const n = clamp(limit, 1, 50);
    return this.cachedSmall(`search:${n}:${q}`, TTL.search, async () => {
      const r = await this.getJson(`${this.site}/w/rest.php/v1/search/page?${new URLSearchParams({ q, limit: String(n) })}`, o);
      if (!r.ok) return r;
      if (r.status !== 200 || !Array.isArray(r.json?.pages)) return unavailable("bad-response", `search/page answered ${r.status}`);
      return {
        ok: true,
        cached: false,
        value: r.json.pages.map((pg: any): SearchHit => {
          const s = snippet(String(pg.excerpt ?? ""));
          return {
            title: String(pg.title),
            pageId: Number(pg.id),
            description: pg.description ?? null,
            snippet: s.text,
            snippetHtml: s.html,
            thumbnail: absolute(pg.thumbnail?.url),
            url: this.articleUrl(String(pg.title)),
          };
        }),
      };
    });
  }

  // -- summary --

  /**
   * A preview: REST page/summary (edge-cached), falling back to the Action API if it fails.
   * With cacheOnly, a cached summary (fresh or expired) or "uncached", and never a request: for
   * callers that must not wait on the network, such as building a model prompt.
   */
  async summary(title: string, o: CallOpts & { cacheOnly: true }): Promise<Result<Summary> | Uncached>;
  async summary(title: string, o?: CallOpts & { cacheOnly?: false }): Promise<Result<Summary>>;
  async summary(title: string, o: CallOpts & { cacheOnly?: boolean } = {}): Promise<Result<Summary> | Uncached> {
    const p = prepareTitle(title);
    if (!("title" in p)) return { ok: false, reason: "missing", message: p.invalid };
    if (o.cacheOnly) {
      const hit = this.small.get(`summary:${p.title}`) as { value: Summary; fresh: boolean } | undefined;
      if (!hit) return { ok: false, reason: "uncached", message: `No summary of “${p.title}” is cached` };
      return { ok: true, value: hit.value, cached: true, ...(hit.fresh ? {} : { stale: true }) };
    }
    return this.cachedSmall(`summary:${p.title}`, TTL.summary, async () => {
      const r = await this.getJson(`${this.site}/api/rest_v1/page/summary/${this.restTitle(p.title)}?redirect=true`, o);
      if (r.ok && r.status === 404) return { ok: false, reason: "missing", message: `No article “${p.title}”` };
      if (r.ok && r.status === 200 && typeof r.json?.title === "string") {
        const j = r.json;
        const t = String(j.titles?.normalized ?? j.title);
        return this.summaryOf(t, j.revision ? Number(j.revision) : null, j, j.content_urls?.desktop?.page ?? this.articleUrl(t), j.type === "disambiguation");
      }
      if (!r.ok && r.reason !== "bad-response" && r.reason !== "server") return r;
      return this.summaryFromAction(p.title, o);
    });
  }

  private async summaryFromAction(title: string, o: CallOpts): Promise<Result<Summary>> {
    const r = await this.getJson(
      this.actionUrl(
        {
          titles: title,
          redirects: "1",
          prop: "extracts|pageimages|description|info|pageprops",
          exintro: "1",
          explaintext: "1",
          piprop: "thumbnail",
          pithumbsize: "330",
          ppprop: "disambiguation",
        },
        o,
      ),
      o,
    );
    if (!r.ok) return r;
    const pg = r.json?.query?.pages?.[0];
    if (!pg) return unavailable("bad-response", "no page in answer");
    if (pg.missing || pg.invalid) return { ok: false, reason: "missing", message: `No article “${title}”` };
    const t = String(pg.title);
    return this.summaryOf(t, pg.lastrevid ?? null, pg, this.articleUrl(t), pg.pageprops?.disambiguation !== undefined);
  }

  /** A summary from either API's page record (the REST summary or an action=query page). */
  private summaryOf(t: string, rev: number | null, pg: { pageid?: number; description?: string; extract?: unknown; thumbnail?: { source: string; width: number; height: number } }, url: string, disambiguation: boolean): Result<Summary> {
    return {
      ok: true,
      cached: false,
      value: {
        title: t,
        pageId: pg.pageid ?? null,
        description: pg.description ?? null,
        extract: String(pg.extract ?? ""),
        thumbnail: pg.thumbnail ? { url: absolute(pg.thumbnail.source)!, width: pg.thumbnail.width, height: pg.thumbnail.height } : null,
        url,
        revisionId: rev,
        disambiguation,
        attribution: this.attribution(t, rev, null),
      },
    };
  }

  // -- article --

  private async loadArticle(title: string, o: CallOpts): Promise<Result<CachedArticle>> {
    const p = prepareTitle(title);
    if (!("title" in p)) return { ok: false, reason: "missing", message: p.invalid };
    // The "|0" suffix keeps existing cache files valid.
    const key = `${p.title}|0`;
    const hit = this.articles.get(key);
    if (hit?.fresh) return { ok: true, value: hit.value, cached: true };
    const r = await this.getJson(
      this.actionUrl(
        {
          action: "parse",
          page: p.title,
          redirects: "1",
          prop: "text|tocdata|revid|displaytitle|properties",
          disableeditsection: "1",
          disablelimitreport: "1",
          disabletoc: "1",
        },
        o,
      ),
      o,
    );
    if (!r.ok) return hit ? { ok: true, value: hit.value, cached: true, stale: true } : r;
    if (r.json?.error) {
      if (r.json.error.code === "missingtitle" || r.json.error.code === "invalidtitle") {
        return { ok: false, reason: "missing", message: `No article “${p.title}”` };
      }
      return hit ? { ok: true, value: hit.value, cached: true, stale: true } : unavailable("bad-response", String(r.json.error.info ?? r.json.error.code));
    }
    const parse = r.json?.parse;
    if (!parse || typeof parse.text !== "string") return unavailable("bad-response", "no text in parse answer");
    const split = splitArticle(parse.text, this.lang);
    const toc: any[] = parse.tocdata?.sections ?? [];
    if (toc.length === split.sections.length) split.sections.forEach((s, i) => (s.number = toc[i].number ?? null));
    const value: CachedArticle = {
      title: String(parse.title),
      pageId: Number(parse.pageid),
      revisionId: Number(parse.revid),
      disambiguation: pageProperties(parse.properties).has("disambiguation"),
      ...split,
    };
    this.articles.set(key, value, TTL.article);
    return { ok: true, value, cached: false };
  }

  /**
   * The lead and the section list. One request per article per week at most; sections then cost
   * nothing. With sections: true each section carries its html too, from the same cached page.
   */
  async article(title: string, o: CallOpts & { sections: true }): Promise<Result<FullArticle>>;
  async article(title: string, o?: CallOpts & { sections?: boolean }): Promise<Result<Article>>;
  async article(title: string, o: CallOpts & { sections?: boolean } = {}): Promise<Result<Article>> {
    try {
      const r = await this.loadArticle(title, o);
      if (!r.ok) return r;
      const a = r.value;
      return {
        ...r,
        value: {
          title: a.title,
          pageId: a.pageId,
          revisionId: a.revisionId,
          url: this.articleUrl(a.title),
          disambiguation: a.disambiguation ?? false,
          lead: a.lead,
          sections: o.sections ? a.sections : a.sections.map(({ html: _html, ...info }) => info),
          attribution: this.attribution(a.title, a.revisionId, MODIFIED),
        },
      };
    } catch (e) {
      return unavailable("bad-response", String(e));
    }
  }

  /** One section, by the id from article(). */
  async section(title: string, id: number, o: CallOpts = {}): Promise<Result<Section>> {
    try {
      const r = await this.loadArticle(title, o);
      if (!r.ok) return r;
      const a = r.value;
      const s = id === 0 ? { id: 0, level: 1, heading: a.title, anchor: "", number: null, parent: 0, html: a.lead } : a.sections.find((x) => x.id === id);
      if (!s) return { ok: false, reason: "missing", message: `“${a.title}” has no section ${id}` };
      return { ...r, value: { ...s, title: a.title, revisionId: a.revisionId, attribution: this.attribution(a.title, a.revisionId, MODIFIED) } };
    } catch (e) {
      return unavailable("bad-response", String(e));
    }
  }
}

const MODIFIED = "Adapted: references, navigation boxes, infoboxes, edit links and images removed.";

let shared: WikiClient | null = null;
/** The server's client, configured from EX_DATA, EX_WIKI_LANG and EX_WIKI_CONTACT. */
export function wiki(): WikiClient {
  if (!shared) {
    shared = new WikiClient({ lang: process.env.EX_WIKI_LANG, contact: process.env.EX_WIKI_CONTACT });
    if (process.env.EX_WIKI_CONTACT && !shared.contact) {
      console.warn("EX_WIKI_CONTACT is not an email address, an http(s) URL or User:Name; sending the generic User-Agent.");
    }
    process.once("exit", () => shared?.flush());
  }
  return shared;
}

// ---- helpers ----

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(Number.isFinite(n) ? n : lo)));

/** Page properties from action=parse: an object in formatversion 2, a list of { name, "*" } before it. */
function pageProperties(props: unknown): Set<string> {
  if (Array.isArray(props)) return new Set(props.map((p) => String(p?.name)));
  if (props && typeof props === "object") return new Set(Object.keys(props));
  return new Set();
}

function absolute(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  if (url.startsWith("//")) return `https:${url}`;
  return /^https:\/\//.test(url) ? url : null;
}

/** Split titles into requests of at most 50, keeping each URL a sensible length. */
export function batches(titles: string[], size = TITLES_PER_REQUEST, maxChars = 6000): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const t of titles) {
    const len = encodeURIComponent(t).length + 3;
    if (cur.length && (cur.length >= size || chars + len > maxChars)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(t);
    chars += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Follow normalized → converted → redirects to the page each asked title ended at. */
function mapQuery(asked: string[], json: any): Map<string, LookupValue> | null {
  const q = json?.query;
  if (!q) return null;
  const step = (list: any[] | undefined) => new Map<string, any>((list ?? []).map((x) => [String(x.from), x]));
  const normalized = step(q.normalized);
  const converted = step(q.converted);
  const redirects = step(q.redirects);
  const interwiki = new Set<string>((q.interwiki ?? []).map((x: any) => String(x.title)));
  const pages = new Map<string, any>((q.pages ?? []).map((pg: any) => [String(pg.title), pg]));
  const out = new Map<string, LookupValue>();
  for (const t of asked) {
    let cur = t;
    if (interwiki.has(cur)) {
      out.set(t, { status: "invalid", reason: "interwiki" });
      continue;
    }
    cur = normalized.get(cur)?.to ?? cur;
    if (interwiki.has(cur)) {
      out.set(t, { status: "invalid", reason: "interwiki" });
      continue;
    }
    cur = converted.get(cur)?.to ?? cur;
    const red = redirects.get(cur);
    if (red) cur = red.to;
    const pg = pages.get(cur);
    if (!pg) continue;
    if (pg.invalid) out.set(t, { status: "invalid", reason: String(pg.invalidreason ?? "invalid") });
    else if (pg.missing || pg.ns !== 0) out.set(t, pg.missing ? { status: "missing" } : { status: "invalid", reason: "not an article" });
    else
      out.set(t, {
        status: "found",
        title: String(pg.title),
        pageId: Number(pg.pageid),
        redirect: Boolean(red),
        ...(red?.tofragment ? { fragment: String(red.tofragment) } : {}),
        disambiguation: pg.pageprops?.disambiguation !== undefined,
        description: pg.description ?? null,
      });
  }
  return out;
}
