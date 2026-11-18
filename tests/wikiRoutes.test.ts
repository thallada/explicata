/** server/wikiRoutes.ts over a real HTTP server on a random port, with Wikipedia mocked. */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WikiClient } from "../server/wiki";
import { TINY_PNG } from "../server/pageMock";
import { mockWikiFetch } from "../server/wikiMock";
import { wikiOff, wikiRoutes } from "../server/wikiRoutes";

type Handle = ReturnType<typeof wikiRoutes>;
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

let server: Server;
let base: string;
let dir: string;
let online = true;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ie-wikiroutes-"));
  const client = new WikiClient({
    dataDir: dir,
    spacingMs: 0,
    fetch: (async (input: string | URL | Request) => {
      if (!online) throw new TypeError("fetch failed");
      const url = new URL(String(input));
      if (url.pathname.endsWith("/search/title")) {
        return Response.json({ pages: [{ id: 1, title: "Brouwer fixed-point theorem", description: "Theorem in topology", thumbnail: null }] });
      }
      if (url.pathname.includes("/page/summary/")) return Response.json({ title: "Not found." }, { status: 404 });
      const titles = url.searchParams.get("titles")?.split("|") ?? [];
      return Response.json({ query: { pages: titles.map((t) => ({ ns: 0, title: t, missing: true })) } });
    }) as typeof fetch,
  });
  ({ server, base } = await serve(wikiRoutes(() => client)));
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("/api/wiki", () => {
  it("leaves other paths alone", async () => {
    expect((await fetch(`${base}/api/docs`)).status).toBe(418);
  });

  it("validates input", async () => {
    expect((await fetch(`${base}/api/wiki/suggest`)).status).toBe(400);
    expect((await fetch(`${base}/api/wiki/suggest?q=a&limit=999`)).status).toBe(400);
    expect((await fetch(`${base}/api/wiki/suggest?q=${"x".repeat(201)}`)).status).toBe(400);
    expect((await fetch(`${base}/api/wiki/summary?title=${"x".repeat(256)}`)).status).toBe(400);
    expect((await fetch(`${base}/api/wiki/summary`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/wiki/nothing`)).status).toBe(404);
  });

  it("serves suggestions, 404 for missing pages, 503 when offline", async () => {
    const s = await (await fetch(`${base}/api/wiki/suggest?q=Brou`)).json();
    expect(s).toMatchObject({ ok: true, suggestions: [{ title: "Brouwer fixed-point theorem" }] });
    expect((await fetch(`${base}/api/wiki/summary?title=Nothing%20here`)).status).toBe(404);
    online = false;
    const r = await fetch(`${base}/api/wiki/suggest?q=fixed`);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ ok: false, reason: "offline" });
    online = true;
  });
});

describe("/api/wiki over the mock provider", () => {
  let mock: { base: string; server: Server };
  let off: { base: string; server: Server };
  beforeAll(async () => {
    const client = new WikiClient({ fetch: mockWikiFetch, spacingMs: 0, mediaSpacingMs: 0, persist: false, offlineHoldMs: 0 });
    mock = await serve(wikiRoutes(() => client));
    off = await serve(wikiOff);
  });
  afterAll(() => {
    mock.server.close();
    off.server.close();
  });
  const get = async (base: string, path: string) => {
    const r = await fetch(base + path);
    return { status: r.status, body: await r.json() };
  };

  it("returns a whole article with full=1, and only the section list without it", async () => {
    const full = await get(mock.base, "/api/wiki/article?title=Octopus&full=1");
    expect(full.status).toBe(200);
    expect(full.body).toMatchObject({ ok: true, cached: false, article: { title: "Octopus", disambiguation: false } });
    expect(full.body.article.sections.map((s: { heading: string }) => s.heading)).toEqual([
      "Etymology and pluralisation",
      "Description",
      "Size",
      "Nervous system and senses",
      "Intelligence",
    ]);
    expect(full.body.article.sections.every((s: { html?: string }) => typeof s.html === "string" && s.html.startsWith("<p>"))).toBe(true);
    const short = await get(mock.base, "/api/wiki/article?title=Octopus");
    expect(short.body.cached).toBe(true);
    expect(short.body.article.sections[0]).not.toHaveProperty("html");
    const dab = await get(mock.base, "/api/wiki/article?title=Mercury&full=1");
    expect(dab.body.article.disambiguation).toBe(true);
  });

  it("answers cached=1 summaries from the cache only: 404 uncached, then 200", async () => {
    const miss = await get(mock.base, "/api/wiki/summary?title=Cephalopod&cached=1");
    expect(miss).toEqual({ status: 404, body: { ok: false, reason: "uncached", message: "No summary of “Cephalopod” is cached" } });
    expect((await get(mock.base, "/api/wiki/summary?title=Cephalopod")).status).toBe(200);
    const hit = await get(mock.base, "/api/wiki/summary?title=Cephalopod&cached=1");
    expect(hit).toMatchObject({ status: 200, body: { ok: true, cached: true, summary: { title: "Cephalopod", description: "Class of mollusks" } } });
  });

  it("passes the misbehaving titles through as 503s", async () => {
    expect(await get(mock.base, "/api/wiki/summary?title=Offline%20example")).toMatchObject({ status: 503, body: { ok: false, reason: "offline" } });
    expect(await get(mock.base, "/api/wiki/summary?title=Rate%20limited%20example")).toMatchObject({ status: 503, body: { ok: false, reason: "rate-limited" } });
    expect(await get(mock.base, "/api/wiki/article?title=No%20such%20page&full=1")).toMatchObject({ status: 404, body: { ok: false, reason: "missing" } });
  });

  it("media: serves a picture an article served here shows, from upload.wikimedia.org only, to this app's own pages only", async () => {
    const still = "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Grey_heron_at_the_weir.jpg/500px-Grey_heron_at_the_weir.jpg";
    const media = (u: string, headers: Record<string, string> = {}) => fetch(`${mock.base}/api/wiki/media?u=${encodeURIComponent(u)}`, { headers });
    // Not yet shown in any article served.
    expect((await media(still)).status).toBe(404);
    const art = await get(mock.base, "/api/wiki/article?title=Grey%20heron&full=1");
    expect(art.body.article.lead).toContain(`/api/wiki/media?u=${encodeURIComponent(still)}`);
    const r = await media(still);
    expect(r.status).toBe(200);
    expect(Object.fromEntries(r.headers)).toMatchObject({ "content-type": "image/png", "cache-control": "private, max-age=604800", "content-security-policy": "sandbox", "x-content-type-options": "nosniff" });
    expect(Buffer.compare(Buffer.from(await r.arrayBuffer()), Buffer.from(TINY_PNG))).toBe(0);
    // The video's still is shown too; the video file itself is never fetched by the server.
    expect((await media("https://upload.wikimedia.org/wikipedia/commons/thumb/b/b2/Heron_takes_off.webm/220px--Heron_takes_off.webm.jpg")).status).toBe(200);
    expect((await media("https://upload.wikimedia.org/wikipedia/commons/transcoded/b/b2/Heron_takes_off.webm/Heron_takes_off.webm.480p.vp9.webm")).status).toBe(404);
    // A flag icon (dropped), another rendition, another host, plain http: never served.
    expect((await media("https://upload.wikimedia.org/wikipedia/commons/thumb/f/f0/Flag_of_Europe.svg/23px-Flag_of_Europe.svg.png")).status).toBe(404);
    expect((await media(still.replace("500px", "250px"))).status).toBe(404);
    expect((await media("https://evil.example/x.png")).status).toBe(404);
    expect((await media(still.replace("https:", "http:"))).status).toBe(404);
    expect((await media("javascript:alert(1)")).status).toBe(400);
    // Another site's page may not use it as a proxy.
    expect((await media(still, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await media(still, { "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  it("answers every route with 503 off when turned off, and leaves other paths alone", async () => {
    for (const path of ["/api/wiki/summary?title=Octopus", "/api/wiki/suggest?q=Oct", "/api/wiki/anything", "/api/wiki/media?u=https%3A%2F%2Fupload.wikimedia.org%2Fx.png"]) {
      expect(await get(off.base, path)).toEqual({
        status: 503,
        body: { ok: false, reason: "off", message: "Wikipedia is turned off on this server (EX_WIKI=off)." },
      });
    }
    expect((await fetch(`${off.base}/api/state`)).status).toBe(418);
  });
});
