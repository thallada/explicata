/**
 * HTTP routes over server/wiki.ts:
 *
 *   GET  /api/wiki/suggest?q=Brou&limit=8      (q ≤ 200 chars)
 *   GET  /api/wiki/summary?title=Octopus[&cached=1]
 *   GET  /api/wiki/article?title=Octopus[&full=1]
 *   GET  /api/wiki/senses?title=Set            the articles a disambiguation page lists
 *
 * summary &cached=1 answers from the server's cache only, never waiting on Wikipedia (for model
 * prompts): 404 { ok: false, reason: "uncached" } when it has none. article &full=1 returns every
 * section's html with the section list, so a whole article is one request.
 * Add &bulk=1 for background work: it queues behind interactive requests and sends maxlag.
 * Answers: 200 { ok: true, ... }; 400 bad input; 404 { ok: false, reason: "missing" };
 * 503 { ok: false, reason, retryAfter } when Wikipedia is unreachable or asked us to wait.
 * A request the browser abandons (a superseded keystroke) is dropped from the queue unsent.
 * With EX_WIKI=off the server wires in wikiOff instead: every route answers 503 reason "off".
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, abortOnClose, sendJson as send } from "./util";
import type { CallOpts, Result, Uncached, WikiClient } from "./wiki";

const MAX_TITLE = 255;

const bad = (message: string) => new HttpError(400, message);

function reply<V>(res: ServerResponse, r: Result<V> | Uncached, key: string) {
  if (r.ok) return send(res, 200, { ok: true, cached: r.cached, ...(r.stale ? { stale: true } : {}), [key]: r.value });
  if (r.reason === "missing" || r.reason === "uncached") return send(res, 404, r);
  if (r.reason === "aborted") return; // the browser has gone
  return send(res, 503, r, r.retryAfter ? { "retry-after": String(r.retryAfter) } : {});
}

function text(url: URL, name: string, max: number): string {
  const v = (url.searchParams.get(name) ?? "").trim();
  if (!v) throw bad(`${name} is required`);
  if (v.length > max) throw bad(`${name} is longer than ${max} characters`);
  return v;
}

function int(url: URL, name: string, fallback: number, lo: number, hi: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${name} must be an integer from ${lo} to ${hi}`);
  return n;
}

/** Route /api/wiki/*. Returns false for any other path. */
export function wikiRoutes(client: () => WikiClient) {
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith("/api/wiki/")) return false;
    const route = url.pathname.slice("/api/wiki/".length);
    if ((req.method ?? "GET") !== "GET") {
      send(res, 405, { ok: false, message: "use GET" }, { allow: "GET" });
      return true;
    }
    try {
      const w = client();
      const o: CallOpts = { priority: url.searchParams.get("bulk") === "1" ? "bulk" : "interactive", signal: abortOnClose(res) };
      switch (route) {
        case "suggest":
          reply(res, await w.suggest(text(url, "q", 200), int(url, "limit", 8, 1, 20), o), "suggestions");
          return true;
        case "summary": {
          const title = text(url, "title", MAX_TITLE);
          reply(res, url.searchParams.get("cached") === "1" ? await w.summary(title, { ...o, cacheOnly: true }) : await w.summary(title, o), "summary");
          return true;
        }
        case "article":
          reply(res, await w.article(text(url, "title", MAX_TITLE), { ...o, sections: url.searchParams.get("full") === "1" }), "article");
          return true;
        case "senses":
          reply(res, await w.senses(text(url, "title", MAX_TITLE), o), "senses");
          return true;
        default:
          send(res, 404, { ok: false, message: `no route /api/wiki/${route}` });
          return true;
      }
    } catch (e) {
      if (e instanceof HttpError) send(res, e.status, { ok: false, message: e.message });
      else send(res, 500, { ok: false, message: (e as Error).message ?? String(e) });
      return true;
    }
  };
}

/** EX_WIKI=off: the routes exist, so the UI can tell "turned off" from "unreachable", but none works. */
export async function wikiOff(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/api/wiki/")) return false;
  send(res, 503, { ok: false, reason: "off", message: "Wikipedia is turned off on this server (EX_WIKI=off)." });
  return true;
}
