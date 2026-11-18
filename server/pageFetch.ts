/**
 * Reading one web page, or one image, for server/page.ts: politely, and within bounds. See
 * docs/pages.md for why each rule is here.
 *
 *   - http and https only, default ports, no credentials, and only addresses `publicUrl`
 *     (server/subscription.ts) calls public: checked for the address asked and for every redirect
 *     hop (redirects are followed by hand, at most 5).
 *   - 15 s for the whole read; the decoded body is capped while it streams in (5 MB for a page);
 *     only the content types the caller accepts.
 *   - The User-Agent says what this is and nothing about who runs it, and is never browser-like.
 *     A refusal is final: nothing is retried with anything changed.
 *   - robots.txt is honoured: read once a day per host and judged by its body, whatever the status.
 *   - Requests to one host start at least a second apart, and one URL is read once however many
 *     callers ask for it at the same time. A host that answers 429 or 503 is left alone for its
 *     Retry-After (else 10 s). A caller may cap how many reads run at once (`maxActive`).
 *   - server/wiki.ts reads Wikipedia's images with one of these too, under its own User-Agent and
 *     without robots.txt (Wikimedia's own policies govern upload.wikimedia.org: docs/wikipedia.md §1).
 *
 * Only addresses a person opened come here; nothing follows the links in a page. `fetch` is
 * injected, so the tests and the mock (server/pageMock.ts) never touch the network. Nothing here
 * throws into a caller: failures come back as { ok: false, reason }.
 */

import { publicUrl } from "./subscription";

export const PAGE_USER_AGENT = "Explicata/0.1 (personal reading tool)";
/** The product token robots.txt groups are matched against. */
const ROBOTS_TOKEN = "explicata";

const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const SPACING_MS = 1000;
const ROBOTS_TTL_MS = 24 * 3600 * 1000;
/** Google reads the first 500 KiB of a robots.txt; so do we. */
const ROBOTS_MAX_BYTES = 500 * 1024;
const MAX_URL = 2000;
/** After a 429 or 503 without Retry-After, a host is left alone this long; never longer than MAX_HOLD_MS. */
const HOLD_MS = 10_000;
const MAX_HOLD_MS = 5 * 60_000;

/** A host asked us to wait longer than a read may take. */
class Held extends Error {
  constructor(readonly seconds: number) {
    super("held");
  }
}

export const PAGE_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];
export const PAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export type FetchFailReason = "robots" | "refused" | "type" | "too-large" | "offline" | "error";
export interface FetchFail {
  ok: false;
  reason: FetchFailReason;
  message: string;
  /** The HTTP status, when the site answered. */
  status?: number;
  /** The site's headers, when it answered (a refusal is told apart by them). */
  headers?: Headers;
  /** Where the read had got to: the last address asked. */
  url: string;
}
export interface Fetched {
  ok: true;
  /** The address the body came from, after redirects. */
  url: string;
  status: number;
  headers: Headers;
  /** The media type, lower case, without parameters. */
  type: string;
  /** The charset parameter of content-type, if any. */
  charset?: string;
  body: Uint8Array;
}
export type FetchOutcome = Fetched | FetchFail;

export interface GetOpts {
  /** Media types accepted: exact ("text/html") or a family ("image/*"). */
  types: string[];
  maxBytes: number;
  signal?: AbortSignal;
}

export interface FetcherOptions {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Least time between the starts of two requests to one host (default 1 s; the mock uses 0). */
  spacingMs?: number;
  timeoutMs?: number;
  /** The User-Agent (default PAGE_USER_AGENT; Wikipedia's images are asked for with server/wiki.ts's). */
  userAgent?: string;
  /** Read robots.txt before a host's first request (default true; false for a host whose own policy governs it). */
  robots?: boolean;
  /** At most this many reads at once, all hosts together (default no limit). */
  maxActive?: number;
}

/**
 * Why this address will not be read, or null if it may be. The same test is applied to every
 * redirect hop. Phrased for a reader.
 */
export function guardUrl(u: string): string | null {
  if (u.length > MAX_URL) return `The address is longer than ${MAX_URL} characters.`;
  let x: URL;
  try {
    x = new URL(u);
  } catch {
    return "That is not a web address.";
  }
  if (x.protocol !== "http:" && x.protocol !== "https:") return "Only http and https pages are read.";
  if (x.username || x.password) return "Addresses with a user name or password are not read.";
  if (!publicUrl(u)) return "Only pages on the public internet are read; this address is on this machine or a private network.";
  if (x.port) return "Only addresses on the usual ports (80 and 443) are read.";
  return null;
}

function withoutHash(u: string): string {
  const x = new URL(u);
  x.hash = "";
  return x.href;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    if (signal?.aborted) return done();
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true });
  });

/** A media type matches "text/html" exactly, or "image/*" by family. */
const accepts = (types: string[], type: string) => types.some((t) => (t.endsWith("/*") ? type.startsWith(t.slice(0, -1)) : t === type));

const fail = (reason: FetchFailReason, message: string, url: string, extra: { status?: number; headers?: Headers } = {}): FetchFail => ({
  ok: false,
  reason,
  message,
  url,
  ...extra,
});

/** The content-type header split into its media type and charset. */
function contentType(header: string | null): { type: string; charset?: string } {
  const [type, ...params] = (header ?? "").split(";");
  const charset = params.map((p) => /^\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(p)?.[1]).find(Boolean);
  return { type: type.trim().toLowerCase(), ...(charset ? { charset: charset.toLowerCase() } : {}) };
}

export class PageFetcher {
  private fetch: typeof fetch;
  private now: () => number;
  private sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private spacingMs: number;
  private timeoutMs: number;
  /** The earliest time the next request to each host may start. */
  private nextStart = new Map<string, number>();
  /** Until when a host that asked us to slow down is left alone. */
  private heldUntil = new Map<string, number>();
  private inFlight = new Map<string, Promise<FetchOutcome>>();
  private robots = new Map<string, { rules: RobotsRules | null; until: number }>();
  private robotsFlight = new Map<string, Promise<RobotsRules | null>>();
  private userAgent: string;
  private robotsOn: boolean;
  private maxActive: number;
  private active = 0;
  private waiting: (() => void)[] = [];
  /** Requests sent so far, robots.txt included. */
  requests = 0;

  constructor(o: FetcherOptions = {}) {
    this.fetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? defaultSleep;
    this.spacingMs = o.spacingMs ?? SPACING_MS;
    this.timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
    this.userAgent = o.userAgent ?? PAGE_USER_AGENT;
    this.robotsOn = o.robots !== false;
    this.maxActive = o.maxActive ?? Infinity;
  }

  /**
   * Read `url`, following redirects, if robots.txt allows. Callers asking for the same URL at the
   * same time share one read; a caller that aborts stops waiting, and the read goes on for the
   * others (and for the cache: the next open is then immediate).
   */
  get(asked: string, o: GetOpts): Promise<FetchOutcome> {
    const refused = guardUrl(asked);
    if (refused) return Promise.resolve(fail("refused", refused, asked));
    // A fragment is never sent: the page is the same with or without it.
    const url = withoutHash(asked);
    const key = `${o.types.join(",")} ${url}`;
    let p = this.inFlight.get(key);
    if (!p) {
      p = this.limited(() => this.read(url, o)).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, p);
    }
    return o.signal ? raceAbort(p, o.signal, url) : p;
  }

  /** Run a read when fewer than `maxActive` are running. */
  private async limited<T>(run: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxActive) await new Promise<void>((go) => this.waiting.push(go));
    this.active++;
    try {
      return await run();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private async read(start: string, o: GetOpts): Promise<FetchOutcome> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let url = start;
    try {
      for (let hop = 0; ; hop++) {
        const allowed = await this.allowed(url, timeout);
        if (!allowed) return fail("robots", `${new URL(url).host} asks programs like this one not to read this page (robots.txt).`, url);
        const res = await this.request(url, o.types, timeout);
        if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
          void res.body?.cancel().catch(() => {});
          if (hop >= MAX_REDIRECTS) return fail("refused", `The page redirected more than ${MAX_REDIRECTS} times.`, url, { status: res.status });
          let next: string;
          try {
            next = new URL(res.headers.get("location")!, url).href;
          } catch {
            return fail("error", "The page redirected to something that is not an address.", url, { status: res.status });
          }
          const refused = guardUrl(next);
          if (refused) return fail("refused", `The page redirected to an address that is not read. ${refused}`, next, { status: res.status });
          url = withoutHash(next);
          continue;
        }
        if (res.status < 200 || res.status >= 300) {
          void res.body?.cancel().catch(() => {});
          // Asked to slow down: nothing more goes to that host until it said, or for HOLD_MS.
          if (res.status === 429 || res.status === 503) this.hold(new URL(url).host, res.headers.get("retry-after"));
          return fail(res.status === 429 || res.status >= 500 ? "error" : "refused", `The site answered ${res.status}.`, url, { status: res.status, headers: res.headers });
        }
        const ct = contentType(res.headers.get("content-type"));
        // No content-type at all: the body decides, as a browser would for a page.
        const type = ct.type || "";
        if (type && !accepts(o.types, type)) {
          void res.body?.cancel().catch(() => {});
          return fail("type", typeMessage(type), url, { status: res.status, headers: res.headers });
        }
        const declared = Number(res.headers.get("content-length"));
        if (declared > o.maxBytes && !res.headers.get("content-encoding")) {
          void res.body?.cancel().catch(() => {});
          return fail("too-large", tooLarge(o.maxBytes), url, { status: res.status, headers: res.headers });
        }
        const body = await readCapped(res, o.maxBytes);
        if (!body) return fail("too-large", tooLarge(o.maxBytes), url, { status: res.status, headers: res.headers });
        if (!type) {
          const head = new TextDecoder().decode(body.subarray(0, 512)).trimStart().toLowerCase();
          const sniffed = head.startsWith("<!doctype html") || head.startsWith("<html") ? "text/html" : "";
          if (!sniffed || !accepts(o.types, sniffed)) return fail("type", "The site did not say what kind of file this is.", url, { status: res.status, headers: res.headers });
          return { ok: true, url, status: res.status, headers: res.headers, type: sniffed, body };
        }
        return { ok: true, url, status: res.status, headers: res.headers, type, ...(ct.charset ? { charset: ct.charset } : {}), body };
      }
    } catch (e) {
      if (e instanceof Held) return fail("error", `${hostOf(url)} asked for fewer requests; it is asked again in ${e.seconds} s.`, url, { status: 429 });
      if (timeout.aborted) return fail("offline", `${hostOf(url)} did not answer within ${Math.round(this.timeoutMs / 1000)} s.`, url);
      return fail("offline", `${hostOf(url)} could not be reached: ${(e as Error).message ?? e}`, url);
    }
  }

  /** One request, after waiting for the host's turn. Redirects are not followed. */
  private async request(url: string, types: string[], signal: AbortSignal): Promise<Response> {
    await this.turn(new URL(url).host, signal);
    signal.throwIfAborted();
    this.requests++;
    return this.fetch(url, {
      redirect: "manual",
      credentials: "omit",
      signal,
      headers: { "user-agent": this.userAgent, accept: types.join(", "), "accept-encoding": "gzip, br" },
    });
  }

  /** Wait until a request to `host` may start, and book the next turn after it. A wait longer than the read may take fails at once. */
  private async turn(host: string, signal: AbortSignal) {
    const now = this.now();
    const held = this.heldUntil.get(host) ?? 0;
    if (held - now >= this.timeoutMs) throw new Held(Math.ceil((held - now) / 1000));
    const at = Math.max(now, held, this.nextStart.get(host) ?? 0);
    this.nextStart.set(host, at + this.spacingMs);
    if (at > now) await this.sleep(at - now, signal);
    // Asked to slow down while this one waited its turn.
    const since = (this.heldUntil.get(host) ?? 0) - this.now();
    if (since >= this.timeoutMs) throw new Held(Math.ceil(since / 1000));
  }

  /** No request to `host` before Retry-After (seconds or a date), else HOLD_MS, at most MAX_HOLD_MS. */
  private hold(host: string, retryAfter: string | null) {
    const now = this.now();
    let ms = HOLD_MS;
    if (retryAfter && /^\d+$/.test(retryAfter.trim())) ms = Number(retryAfter.trim()) * 1000;
    else if (retryAfter && !Number.isNaN(Date.parse(retryAfter))) ms = Date.parse(retryAfter) - now;
    this.heldUntil.set(host, now + Math.min(MAX_HOLD_MS, Math.max(ms, 0)));
  }

  /** Whether robots.txt lets this program read `url`. A robots.txt that cannot be read allows. */
  private async allowed(url: string, signal: AbortSignal): Promise<boolean> {
    if (!this.robotsOn) return true;
    const x = new URL(url);
    const rules = await this.robotsFor(x.origin, signal);
    return !rules || robotsAllows(rules, x.pathname + x.search);
  }

  private robotsFor(origin: string, signal: AbortSignal): Promise<RobotsRules | null> {
    const have = this.robots.get(origin);
    if (have && have.until > this.now()) return Promise.resolve(have.rules);
    let p = this.robotsFlight.get(origin);
    if (!p) {
      p = this.readRobots(origin, signal).finally(() => this.robotsFlight.delete(origin));
      this.robotsFlight.set(origin, p);
    }
    return p;
  }

  /** robots.txt, judged by its body whatever the status (a 418 saying `Disallow: /` disallows). */
  private async readRobots(origin: string, signal: AbortSignal): Promise<RobotsRules | null> {
    let url = `${origin}/robots.txt`;
    let rules: RobotsRules | null = null;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const res = await this.request(url, ["text/plain", "*/*"], signal);
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
          void res.body?.cancel().catch(() => {});
          const next = new URL(location, url).href;
          if (guardUrl(next)) break;
          url = withoutHash(next);
          continue;
        }
        const body = await readCapped(res, ROBOTS_MAX_BYTES, true);
        rules = parseRobots(new TextDecoder().decode(body ?? new Uint8Array()));
        break;
      }
    } catch {
      // Unreachable or too slow: as if there were none, and asked again next time. The page read
      // that follows will say why.
      return null;
    }
    this.robots.set(origin, { rules, until: this.now() + ROBOTS_TTL_MS });
    return rules;
  }
}

function raceAbort(p: Promise<FetchOutcome>, signal: AbortSignal, url: string): Promise<FetchOutcome> {
  if (signal.aborted) return Promise.resolve(fail("error", "aborted", url));
  return new Promise((resolve) => {
    const onAbort = () => resolve(fail("error", "aborted", url));
    signal.addEventListener("abort", onAbort, { once: true });
    void p.then((r) => (signal.removeEventListener("abort", onAbort), resolve(r)));
  });
}

/**
 * The body, decoded (fetch undoes gzip and br), or null once it passes `max` bytes: the read is
 * then cancelled. With `truncate` the first `max` bytes are returned instead of null.
 */
async function readCapped(res: Response, max: number, truncate = false): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      void reader.cancel().catch(() => {});
      if (!truncate) return null;
      chunks.push(value.subarray(0, value.length - (size - max)));
      size = max;
      break;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) (out.set(c, at), (at += c.length));
  return out;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "The site";
  }
};

const tooLarge = (max: number) => `The page is larger than ${Math.round(max / (1024 * 1024))} MB.`;

function typeMessage(type: string): string {
  if (type === "application/pdf") return "This is a PDF, which is not read here.";
  if (type.startsWith("image/")) return "This is an image, not a page.";
  if (type.startsWith("video/") || type.startsWith("audio/")) return "This is a recording, not a page.";
  return `This is not a page (${type}).`;
}

// ---- robots.txt (RFC 9309) ----

interface RobotsRule {
  allow: boolean;
  path: string;
}
/** The groups that name this program, else the `*` groups; null when the file has no rules at all. */
export interface RobotsRules {
  mine: RobotsRule[] | null;
  any: RobotsRule[] | null;
}

/**
 * The rules of a robots.txt that concern us. Lines that are not `field: value` are ignored, so an
 * HTML error page parses as no rules. Consecutive user-agent lines share the rules after them.
 */
export function parseRobots(text: string): RobotsRules | null {
  let mine: RobotsRule[] | null = null;
  let any: RobotsRule[] | null = null;
  let agents: string[] = [];
  let inRules = false;
  let seen = false;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      if (inRules) agents = [];
      inRules = false;
      agents.push(value.toLowerCase());
      continue;
    }
    if (field !== "allow" && field !== "disallow") continue;
    inRules = true;
    if (!agents.length) continue;
    seen = true;
    const forMe = agents.some((a) => a.split("/")[0].trim() === ROBOTS_TOKEN);
    const forAny = agents.includes("*");
    // A group with an empty Disallow exists (and so outranks `*`) but holds no rule.
    if (forMe) mine ??= [];
    if (forAny) any ??= [];
    if (!value) continue;
    const rule = { allow: field === "allow", path: value };
    if (forMe) mine!.push(rule);
    if (forAny) any!.push(rule);
  }
  return seen ? { mine, any } : null;
}

/** Whether `path` (with its query) may be read: the longest matching rule wins, Allow on a tie. */
export function robotsAllows(rules: RobotsRules, path: string): boolean {
  const list = rules.mine ?? rules.any;
  if (!list) return true;
  let best: RobotsRule | null = null;
  for (const r of list) {
    if (!robotsMatch(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

function robotsMatch(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  try {
    const rx = new RegExp(`^${re}${anchored ? "$" : ""}`);
    return rx.test(path) || rx.test(safeDecode(path));
  } catch {
    return false;
  }
}

function safeDecode(s: string) {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}
