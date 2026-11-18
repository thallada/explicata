/** server/pageRoutes.ts and server/page.ts's cache over a real HTTP server, with the web mocked by server/pageMock.ts. */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normUrl } from "../src/llm/web";
import { PageClient } from "../server/page";
import { MOCK_PAGES, MOCK_YOUTUBE_ID, TINY_PNG, makeMockPageFetch } from "../server/pageMock";
import { pageOff, pageRoutes } from "../server/pageRoutes";

type Handle = ReturnType<typeof pageRoutes>;
/** A real HTTP server around one handler; 418 for paths it declines. */
async function serve(handle: Handle): Promise<{ base: string; server: Server }> {
  const server = createServer(async (req, res) => {
    if (!(await handle(req, res, new URL(req.url ?? "/", "http://x")))) {
      res.writeHead(418);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** A GET with exactly these headers (fetch would add or refuse some of them). */
function raw(base: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(base + path, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}
const q = (u: string) => encodeURIComponent(u);

let dir: string;
let server: Server;
let base: string;
let client: PageClient;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ie-pageroutes-"));
  client = new PageClient({ dataDir: dir, fetch: makeMockPageFetch(), spacingMs: 0 });
  ({ server, base } = await serve(pageRoutes(() => client)));
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = async (path: string) => {
  const r = await fetch(base + path);
  return { status: r.status, body: await r.json() };
};

describe("/api/page", () => {
  it("leaves other paths alone, validates input, GET only", async () => {
    expect((await fetch(`${base}/api/wiki/summary`)).status).toBe(418);
    expect((await fetch(`${base}/api/page/article`)).status).toBe(400);
    expect((await fetch(`${base}/api/page/article?url=ftp%3A%2F%2Fexample.org%2F`)).status).toBe(400);
    expect((await fetch(`${base}/api/page/article?url=nonsense`)).status).toBe(400);
    expect((await fetch(`${base}/api/page/article?url=${q(`https://example.org/${"x".repeat(2000)}`)}`)).status).toBe(400);
    expect((await fetch(`${base}/api/page/article?url=${q(MOCK_PAGES.tracing)}`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/page/nothing`)).status).toBe(404);
  });

  it("returns a usable page as an article, then from the cache", async () => {
    const first = await get(`/api/page/article?url=${q(MOCK_PAGES.letters)}`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      ok: true,
      cached: false,
      article: {
        url: MOCK_PAGES.letters,
        requested: MOCK_PAGES.letters,
        title: "On maps",
        outline: "pseudo",
        leadFrom: "intro",
        attribution: { site: "Letters from the Coast", author: "Odile Marsh", published: "2024-09-02T08:00:00+00:00", adapted: ["navigation and scripts removed"] },
      },
    });
    expect(first.body.article.sections.map((s: { id: string }) => s.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(first.body.article.hash).toMatch(/^[0-9a-f]{16}$/);
    expect((await get(`/api/page/article?url=${q(MOCK_PAGES.letters)}`)).body.cached).toBe(true);
  });

  it("answers 422 with the reason for a page that cannot be shown, 503 when the site cannot be reached", async () => {
    expect(await get(`/api/page/article?url=${q(MOCK_PAGES.pdf)}`)).toMatchObject({ status: 422, body: { ok: false, reason: "type", url: MOCK_PAGES.pdf } });
    expect(await get(`/api/page/article?url=${q(MOCK_PAGES.robots)}`)).toMatchObject({ status: 422, body: { ok: false, reason: "robots" } });
    expect(await get(`/api/page/article?url=${q("http://localhost:4747/api/state")}`)).toMatchObject({ status: 422, body: { ok: false, reason: "refused" } });
    expect(await get(`/api/page/article?url=${q(MOCK_PAGES.offline)}`)).toMatchObject({ status: 503, body: { ok: false, reason: "offline" } });
  });

  it("answers cached=1 summaries from the cache only: 404 uncached, then 200", async () => {
    const miss = await get(`/api/page/summary?url=${q(MOCK_PAGES.tracing)}&cached=1`);
    expect(miss).toEqual({ status: 404, body: { ok: false, reason: "uncached", message: `Nothing from ${MOCK_PAGES.tracing} is cached` } });
    const live = await get(`/api/page/summary?url=${q(MOCK_PAGES.tracing)}`);
    expect(live).toMatchObject({ status: 200, body: { ok: true, cached: false } });
    const hit = await get(`/api/page/summary?url=${q(MOCK_PAGES.tracing)}&cached=1`);
    expect(hit).toEqual({
      status: 200,
      body: {
        ok: true,
        cached: true,
        summary: {
          url: MOCK_PAGES.tracing,
          requested: MOCK_PAGES.tracing,
          title: "Following one request through the stack",
          site: "tracing.example.org",
          author: "Rosalind Vane",
          published: "2025-03-14T09:30:00Z",
          description: "What happens between a click and an answer, followed one hop at a time.",
          sentence: "The request leaves the browser, crosses three proxies and a queue, and only then reaches the code that answers it.",
        },
      },
    });
    // An unusable page's summary is its reason, from the cache too.
    await get(`/api/page/summary?url=${q(MOCK_PAGES.shell)}`);
    expect(await get(`/api/page/summary?url=${q(MOCK_PAGES.shell)}&cached=1`)).toMatchObject({ status: 422, body: { ok: false, reason: "empty", title: "Someone on App" } });
  });

  it("serves images a cached page shows, and nothing else", async () => {
    const heron = "https://figures.example.org/img/heron.png";
    // Not yet in any snapshot.
    expect((await raw(base, `/api/page/media?u=${q(heron)}`)).status).toBe(404);
    await get(`/api/page/article?url=${q(MOCK_PAGES.figures)}`);
    const img = await raw(base, `/api/page/media?u=${q(heron)}`);
    expect(img.status).toBe(200);
    expect(Buffer.compare(img.body, Buffer.from(TINY_PNG))).toBe(0);
    expect(img.headers).toMatchObject({
      "content-type": "image/png",
      "cache-control": "private, max-age=604800",
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
    });
    // In the snapshot, but not an image.
    expect((await raw(base, `/api/page/media?u=${q("https://figures.example.org/img/ticket.png")}`)).status).toBe(415);
    // Dropped from the page (a tracker), or never on it: not served.
    expect((await raw(base, `/api/page/media?u=${q("https://tracker.example.net/pixel.gif")}`)).status).toBe(404);
    expect((await raw(base, `/api/page/media?u=${q("https://figures.example.org/img/other.png")}`)).status).toBe(404);
    expect((await raw(base, `/api/page/media?u=${q("http://169.254.169.254/latest")}`)).status).toBe(404);
  });

  it("serves a video's still (its poster, YouTube's thumbnail) once a page showing it is read; never the video itself", async () => {
    const poster = "https://videos.example.org/img/weir-still.png";
    const thumb = `https://i.ytimg.com/vi/${MOCK_YOUTUBE_ID}/hqdefault.jpg`;
    expect((await raw(base, `/api/page/media?u=${q(thumb)}`)).status).toBe(404);
    await get(`/api/page/article?url=${q(MOCK_PAGES.videos)}`);
    for (const u of [poster, thumb]) expect((await raw(base, `/api/page/media?u=${q(u)}`)).status, u).toBe(200);
    expect((await raw(base, `/api/page/media?u=${q("https://media.example.org/weir.mp4")}`)).status).toBe(404);
    // A thumbnail for an id the page does not show is not served.
    expect((await raw(base, `/api/page/media?u=${q("https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg")}`)).status).toBe(404);
  });

  it("refuses cross-site requests and allows same-origin ones and clients that send neither header", async () => {
    const path = `/api/page/summary?url=${q(MOCK_PAGES.letters)}&cached=1`;
    const host = new URL(base).host;
    expect((await raw(base, path, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await raw(base, path, { "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await raw(base, path, { origin: "https://evil.example.net" })).status).toBe(403);
    expect((await raw(base, path, { origin: "null" })).status).toBe(403);
    expect((await raw(base, `/api/page/media?u=${q("https://figures.example.org/img/heron.png")}`, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await raw(base, path, { "sec-fetch-site": "same-origin", origin: `http://${host}` })).status).toBe(200);
    expect((await raw(base, path, { "sec-fetch-site": "none" })).status).toBe(200);
    expect((await raw(base, path, { origin: `http://${host}` })).status).toBe(200);
    expect((await raw(base, path)).status).toBe(200);
  });

  it("answers every route with 503 off when turned off, and leaves other paths alone", async () => {
    const off = await serve(pageOff);
    try {
      for (const path of [`/api/page/article?url=${q(MOCK_PAGES.tracing)}`, "/api/page/media?u=x", "/api/page/anything"]) {
        const r = await fetch(off.base + path);
        expect(r.status).toBe(503);
        expect(await r.json()).toMatchObject({ ok: false, reason: "off", message: "Reading web pages is turned off on this server (EX_PAGES=off)." });
      }
      expect((await fetch(`${off.base}/api/state`)).status).toBe(418);
    } finally {
      off.server.close();
    }
  });
});

describe("the snapshot cache", () => {
  let cache: string;
  let clock: number;
  beforeEach(() => {
    cache = mkdtempSync(join(tmpdir(), "ie-pagecache-"));
    clock = Date.parse("2026-11-17T12:00:00Z");
  });
  const counting = (fail = false) => {
    const mock = makeMockPageFetch();
    const calls: string[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input));
      if (fail) throw new TypeError("fetch failed");
      return mock(input, init);
    }) as typeof fetch;
    return { f, calls };
  };
  const make = (f: typeof fetch, extra = {}) => new PageClient({ dataDir: cache, fetch: f, spacingMs: 0, now: () => clock, ...extra });

  it("keeps a snapshot on disk under sha1(normUrl(url)), and serves it after a restart without asking again", async () => {
    const a = make(counting().f);
    const r1 = await a.article(`${MOCK_PAGES.tracing}#comments`);
    expect(r1).toMatchObject({ ok: true, cached: false });
    const file = join(cache, "page-cache", `${createHash("sha1").update(normUrl(MOCK_PAGES.tracing)).digest("hex")}.json`);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("Following one request through the stack");
    a.flush();
    // Months later, offline: still the same snapshot, no timed refetch.
    clock += 200 * 24 * 3600 * 1000;
    const offline = counting(true);
    const r2 = await make(offline.f).article(MOCK_PAGES.tracing);
    expect(r2).toMatchObject({ ok: true, cached: true });
    expect(r2.ok && r1.ok && r2.value.hash === r1.value.hash).toBe(true);
    expect(offline.calls).toEqual([]);
    // Its images are known to the media route after a restart too.
    await make(counting().f).article(MOCK_PAGES.figures);
    const c = make(counting().f);
    expect(await c.media("https://figures.example.org/img/heron.png")).toMatchObject({ ok: true, type: "image/png" });
  });

  it("remembers an unusable page for a day, and a transient failure not at all", async () => {
    const { f, calls } = counting();
    const c = make(f);
    await c.article(MOCK_PAGES.pdf);
    await c.article(MOCK_PAGES.pdf);
    expect(calls.filter((u) => u === MOCK_PAGES.pdf)).toHaveLength(1);
    clock += 25 * 3600 * 1000;
    await c.article(MOCK_PAGES.pdf);
    expect(calls.filter((u) => u === MOCK_PAGES.pdf)).toHaveLength(2);
    await c.article(MOCK_PAGES.offline);
    await c.article(MOCK_PAGES.offline);
    expect(calls.filter((u) => u.startsWith(MOCK_PAGES.offline) && !u.endsWith("robots.txt"))).toHaveLength(2);
  });

  it("keeps at most maxSnapshots, dropping the least recently read", async () => {
    const c = make(counting().f, { maxSnapshots: 2 });
    const file = (u: string) => join(cache, "page-cache", `${createHash("sha1").update(normUrl(u)).digest("hex")}.json`);
    await c.article(MOCK_PAGES.tracing);
    clock += 1000;
    await c.article(MOCK_PAGES.letters);
    clock += 1000;
    await c.article(MOCK_PAGES.tracing); // read again: now the most recent
    clock += 1000;
    await c.article(MOCK_PAGES.rules);
    expect(c.snapshots).toBe(2);
    expect(existsSync(file(MOCK_PAGES.tracing))).toBe(true);
    expect(existsSync(file(MOCK_PAGES.letters))).toBe(false);
    expect(existsSync(file(MOCK_PAGES.rules))).toBe(true);
  });

  it("reads one page once for callers asking at the same time", async () => {
    const { f, calls } = counting();
    const c = make(f);
    const [a, b] = await Promise.all([c.article(MOCK_PAGES.rules), c.summary(MOCK_PAGES.rules)]);
    expect(a.ok && b.ok).toBe(true);
    expect(calls.filter((u) => u === MOCK_PAGES.rules)).toHaveLength(1);
  });
});
