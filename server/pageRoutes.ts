/**
 * HTTP routes over server/page.ts:
 *
 *   GET  /api/page/article?url=https://…            the page as a lead and sections
 *   GET  /api/page/summary?url=https://…[&cached=1]  title, site, author, date, first sentence
 *   GET  /api/page/media?u=https://…                an image a page read here shows
 *   POST /api/page/reload   { url }                 read the page again (the reader's Reload)
 *   POST /api/page/arrange  { url[, auto: true] }   summarise it with a model, and arrange a page
 *                                                    divided by length into sections (pageArrange.ts)
 *
 * summary &cached=1 answers from the snapshot cache only, never reading the page: 404
 * { ok: false, reason: "uncached" } when it has none. media serves only addresses that appear in
 * a kept snapshot (it is not an open proxy): its pictures, and the stills of its videos (a
 * poster, a YouTube thumbnail); image types only, with headers that keep the browser from
 * treating the answer as anything but an image.
 * Answers: 200 { ok: true, cached, article | summary }; 400 bad input; 403 a cross-site request;
 * 404 uncached; 422 a WebUnusable for a page that cannot be shown (robots, refused, type, empty,
 * too-large); 503 a WebUnusable when the site could not be reached or failed (offline, error).
 * A request the browser abandons is not answered; the read goes on, so the next open is immediate.
 * With EX_PAGES=off the server wires in pageOff instead: every route answers 503 reason "off".
 *
 * reload answers 200 { ok: true, article } with the new copy, or with the last copy and
 * `stale: <why>` when the page no longer answers; a page never shown before that still cannot be
 * shown is a 422 or 503 WebUnusable, as for article. arrange never reads the page: it works on the
 * kept copy. 200 { ok: true, article, called, arranged: "sections" | "summary", note? }; refused
 * with { ok: false, reason, message }: 404 uncached (not read here yet), 409 old (a copy read before
 * arranging existed), 422 too-long, 429 budget or plan, 502 failed (the call failed), 503 no-model
 * or off (EX_PAGES_ARRANGE=off).
 *
 * Arranging by itself: article, reload and summary (not &cached=1) start it for a page divided by
 * length that a model has not arranged (Arranger.auto), and article and reload send where it stands
 * in the page's `auto`: { state: "running" } or { state: "skipped", reason, message }. While it runs
 * the browser asks arrange with `auto: true`, which only waits for the call under way (or answers
 * with what it came to: 409 idle when nothing is under way) and never starts one.
 *
 * Every route refuses a request another site's page makes (Sec-Fetch-Site, else Origin, against
 * the request's own Host). Requests with neither header (curl, the tests) are allowed. The two
 * that act (reload reads a site, arrange spends model budget) are POST only; the others GET only.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MediaResult, PageClient, PageResult, WebArticle, WebUnusable } from "./page";
import type { ArrangeRefusal, Arranger } from "./pageArrange";
import { HttpError, abortOnClose, readJson, sendJson as send } from "./util";
import type { Uncached } from "./wiki";

const MAX_URL = 2000;

const bad = (message: string) => new HttpError(400, message);

/** Why this request is refused as cross-site, or null if it may go on. */
export function crossSite(req: IncomingMessage): string | null {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return `a ${site} request`;
  const origin = req.headers.origin;
  if (origin === undefined) return null;
  try {
    return new URL(origin).host === req.headers.host ? null : `a request from ${origin}`;
  } catch {
    return `a request from origin ${origin}`;
  }
}

export function address(url: URL, name: string): string {
  return checked(url.searchParams.get(name), name);
}

function checked(given: unknown, name: string): string {
  const v = (typeof given === "string" ? given : "").trim();
  if (!v) throw bad(`${name} is required`);
  if (v.length > MAX_URL) throw bad(`${name} is longer than ${MAX_URL} characters`);
  let x: URL;
  try {
    x = new URL(v);
  } catch {
    throw bad(`${name} is not an address`);
  }
  if (x.protocol !== "http:" && x.protocol !== "https:") throw bad(`${name} must be an http or https address`);
  return v;
}

const LASTING = new Set(["robots", "refused", "type", "empty", "too-large"]);

/**
 * An image as the media routes send it (this one, and /api/wiki/media): with headers that keep
 * the browser from treating it as anything but an image, cached a week by this browser only.
 */
export function sendMedia(res: ServerResponse, r: MediaResult | { ok: false; reason: "aborted" }) {
  if (r.ok) {
    res.writeHead(200, {
      "content-type": r.type,
      "content-length": String(r.body.length),
      "cache-control": "private, max-age=604800",
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
    });
    res.end(r.body);
  } else if (!("reason" in r)) send(res, r.status, { ok: false, message: r.message });
}

/** The routes that act, and are POST only; the rest are GET only. */
const POSTS = new Set(["reload", "arrange"]);

const REFUSED: Record<ArrangeRefusal, number> = { uncached: 404, old: 409, idle: 409, "too-long": 422, budget: 429, plan: 429, failed: 502, "no-model": 503, off: 503, manual: 503 };

function reply<V>(res: ServerResponse, r: PageResult<V> | Uncached | { ok: false; reason: "aborted" }, key: string) {
  if (r.ok) return send(res, 200, { ok: true, cached: r.cached, [key]: r.value });
  if (r.reason === "aborted") return; // the browser has gone
  if (r.reason === "uncached") return send(res, 404, r);
  return send(res, LASTING.has(r.reason) ? 422 : 503, r);
}

/** Route /api/page/*. Returns false for any other path. Without an arranger, arrange answers 503 off. */
export function pageRoutes(client: () => PageClient, arranger?: () => Arranger) {
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith("/api/page/")) return false;
    const route = url.pathname.slice("/api/page/".length);
    const refused = crossSite(req);
    if (refused) {
      send(res, 403, { ok: false, message: `Refused ${refused}: these routes answer this app's own pages only.` });
      return true;
    }
    const method = POSTS.has(route) ? "POST" : "GET";
    if ((req.method ?? "GET") !== method) {
      send(res, 405, { ok: false, message: `use ${method}` }, { allow: method });
      return true;
    }
    // A page read or opened: arranged by itself if it is divided by length (never throws, never waits).
    const auto = (u: string) => arranger?.().auto(u);
    const withAuto = <R extends { ok: true; value: WebArticle }>(u: string, r: R): R => {
      const a = auto(u);
      return a ? { ...r, value: { ...r.value, auto: a } } : r;
    };
    try {
      const p = client();
      const signal = abortOnClose(res);
      switch (route) {
        case "reload": {
          const body = await readJson<{ url?: unknown }>(req, 16 * 1024);
          const u = checked(body.url, "url");
          const r = await p.reload(u, { signal });
          if (r.ok) send(res, 200, { ok: true, cached: false, article: withAuto(u, r).value, ...(r.stale ? { stale: r.stale } : {}) });
          else reply(res, r, "article");
          return true;
        }
        case "arrange": {
          const body = await readJson<{ url?: unknown; auto?: unknown }>(req, 16 * 1024);
          const u = checked(body.url, "url");
          if (!arranger) {
            send(res, 503, { ok: false, reason: "off", message: "Arranging pages with a model is not available on this server." });
            return true;
          }
          // Not abandoned when the browser goes: the call is made once, and its result kept for the next ask.
          const r = await arranger().arrange(u, { join: body.auto === true });
          if (r.ok) send(res, 200, r);
          else send(res, REFUSED[r.reason], r);
          return true;
        }
        case "article": {
          const u = address(url, "url");
          const r = await p.article(u, { signal });
          reply(res, r.ok ? withAuto(u, r) : r, "article");
          return true;
        }
        case "summary": {
          const u = address(url, "url");
          const cacheOnly = url.searchParams.get("cached") === "1";
          const r = await p.summary(u, { signal, cacheOnly });
          // Read for a link's title (not a card's look at the cache): arranged by itself as when opened.
          if (r.ok && !cacheOnly) auto(u);
          reply(res, r, "summary");
          return true;
        }
        case "media":
          sendMedia(res, await p.media(address(url, "u"), { signal }));
          return true;
        default:
          send(res, 404, { ok: false, message: `no route /api/page/${route}` });
          return true;
      }
    } catch (e) {
      if (e instanceof HttpError) send(res, e.status, { ok: false, message: e.message });
      else send(res, 500, { ok: false, message: (e as Error).message ?? String(e) });
      return true;
    }
  };
}

/** EX_PAGES=off: the routes exist, so the UI can tell "turned off" from "unreachable", but none works. */
export async function pageOff(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/api/page/")) return false;
  const off: WebUnusable = {
    ok: false,
    reason: "off",
    message: "Reading web pages is turned off on this server (EX_PAGES=off).",
    url: url.searchParams.get("url") ?? url.searchParams.get("u") ?? "",
  };
  send(res, 503, off);
  return true;
}
