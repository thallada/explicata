/**
 * HTTP routes over server/wiki.ts:
 *
 *   GET  /api/wiki/lookup?titles=A|B|C        or POST { titles: string[] }   (≤ 200 titles)
 *   GET  /api/wiki/suggest?q=Brou&limit=8                                     (q ≤ 200 chars)
 *   GET  /api/wiki/search?q=fixed+point&limit=10                              (q ≤ 300 chars)
 *   GET  /api/wiki/summary?title=Octopus[&cached=1]
 *   GET  /api/wiki/article?title=Octopus[&full=1]
 *   GET  /api/wiki/section?title=Octopus&id=3
 *   GET  /api/wiki/senses?title=Set            the articles a disambiguation page lists
 *
 * summary &cached=1 answers from the server's cache only, never waiting on Wikipedia (for model
 * prompts): 404 { ok: false, reason: "uncached" } when it has none. article &full=1 returns every
 * section's html with the section list, so a whole article is one request.
 * Add &bulk=1 for background work: it queues behind interactive requests and sends maxlag.
 * Answers: 200 { ok: true, ... }; 400 bad input; 404 { ok: false, reason: "missing" };
 * 503 { ok: false, reason, retryAfter } when Wikipedia is unreachable or asked us to wait.
 * A request the browser abandons (a superseded keystroke) is dropped from the queue unsent.
 * With IE_WIKI=off the server wires in wikiOff instead: every route answers 503 reason "off".
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, abortOnClose, readJson, sendJson as send } from "./util";
import type { CallOpts, Result, Uncached, WikiClient } from "./wiki";

const MAX_TITLES = 200;
const MAX_TITLE = 255;
const MAX_BODY = 64 * 1024;

const bad = (message: string) => new HttpError(400, message);

function reply<V>(res: ServerResponse, r: Result<V> | Uncached, key: string) {
  if (r.ok) return send(res, 200, { ok: true, cached: r.cached, ...(r.stale ? { stale: true } : {}), [key]: r.value });
  if (r.reason === "missing" || r.reason === "uncached") return send(res, 404, r);
  if (r.reason === "aborted") return; // the browser has gone
  return send(res, 503, r, r.retryAfter ? { "retry-after": String(r.retryAfter) } : {});
}

function text(url: URL, name: string, max: number, required = true): string {
  const v = (url.searchParams.get(name) ?? "").trim();
  if (!v && required) throw bad(`${name} is required`);
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

async function readTitles(req: IncomingMessage, url: URL): Promise<string[]> {
  let titles: unknown;
  if (req.method === "POST") {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw bad("body too large");
      chunks.push(c as Buffer);
    }
    try {
      titles = (JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { titles?: unknown }).titles;
    } catch {
      throw bad("body is not JSON");
    }
  } else {
    titles = text(url, "titles", MAX_TITLES * (MAX_TITLE + 1)).split("|");
  }
  if (!Array.isArray(titles) || !titles.every((t) => typeof t === "string")) throw bad("titles must be a list of strings");
  if (titles.length > MAX_TITLES) throw bad(`at most ${MAX_TITLES} titles`);
  if (titles.some((t) => t.length > MAX_TITLE)) throw bad(`a title is longer than ${MAX_TITLE} characters`);
  return titles;
}

/** Route /api/wiki/*. Returns false for any other path. */
export function wikiRoutes(client: () => WikiClient) {
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith("/api/wiki/")) return false;
    const route = url.pathname.slice("/api/wiki/".length);
    const allowed = route === "lookup" ? ["GET", "POST"] : ["GET"];
    if (!allowed.includes(req.method ?? "GET")) {
      send(res, 405, { ok: false, message: `use ${allowed.join(" or ")}` }, { allow: allowed.join(", ") });
      return true;
    }
    try {
      const w = client();
      const o: CallOpts = { priority: url.searchParams.get("bulk") === "1" ? "bulk" : "interactive", signal: abortOnClose(res) };
      switch (route) {
        case "lookup": {
          const results = await w.lookup(await readTitles(req, url), o);
          send(res, 200, { ok: true, results });
          return true;
        }
        case "suggest":
          reply(res, await w.suggest(text(url, "q", 200), int(url, "limit", 8, 1, 20), o), "suggestions");
          return true;
        case "search":
          reply(res, await w.search(text(url, "q", 300), int(url, "limit", 10, 1, 50), o), "results");
          return true;
        case "summary": {
          const title = text(url, "title", MAX_TITLE);
          reply(res, url.searchParams.get("cached") === "1" ? await w.summary(title, { ...o, cacheOnly: true }) : await w.summary(title, o), "summary");
          return true;
        }
        case "article":
          reply(res, await w.article(text(url, "title", MAX_TITLE), { ...o, sections: url.searchParams.get("full") === "1" }), "article");
          return true;
        case "section":
          reply(res, await w.section(text(url, "title", MAX_TITLE), int(url, "id", 0, 0, 10_000), o), "section");
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

/** IE_WIKI=off: the routes exist, so the UI can tell "turned off" from "unreachable", but none works. */
export async function wikiOff(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/api/wiki/")) return false;
  send(res, 503, { ok: false, reason: "off", message: "Wikipedia is turned off on this server (IE_WIKI=off)." });
  return true;
}
