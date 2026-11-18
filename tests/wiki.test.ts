/** server/wiki.ts with fetch mocked: batching, redirects, disambiguation, caching, backoff, sanitising. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WikiClient, batches, parseRetryAfter, prepareTitle, userAgent, validContact } from "../server/wiki";
import { sanitizeWikiHtml, splitArticle } from "../server/wikiHtml";

// A tiny fake Wikipedia: pages, redirects, disambiguation pages.
const PAGES: Record<string, { id: number; description?: string; disambiguation?: boolean }> = {
  Octopus: { id: 22780, description: "Soft-bodied eight-limbed order of molluscs" },
  Cephalopod: { id: 42726, description: "Class of mollusks" },
  "Fixed point": { id: 11245, description: "Topics referred to by the same term", disambiguation: true },
  "Set (mathematics)": { id: 26691, description: "Collection of distinct objects" },
};
const REDIRECTS: Record<string, string> = { Cephalopods: "Cephalopod" };
for (let i = 0; i < 120; i++) PAGES[`Page ${i}`] = { id: 1000 + i };

function queryAnswer(titles: string[]) {
  const normalized: { from: string; to: string }[] = [];
  const redirects: { from: string; to: string }[] = [];
  const pages: unknown[] = [];
  for (const t of titles) {
    let cur = t;
    const n = t.charAt(0).toUpperCase() + t.slice(1);
    if (n !== t) normalized.push({ from: t, to: (cur = n) });
    if (REDIRECTS[cur]) redirects.push({ from: cur, to: (cur = REDIRECTS[cur]) });
    const p = PAGES[cur];
    pages.push(
      p
        ? { pageid: p.id, ns: 0, title: cur, description: p.description, pageprops: { ...(p.disambiguation ? { disambiguation: "" } : {}), wikibase_item: "Q1" } }
        : { ns: 0, title: cur, missing: true },
    );
  }
  return { batchcomplete: true, query: { normalized, redirects, pages } };
}

type Handler = (url: URL) => Response | Promise<Response>;
function mockFetch(handler: Handler) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(url);
  }) as typeof fetch;
  return { f, calls };
}
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

const defaultHandler: Handler = (url) => {
  const titles = url.searchParams.get("titles");
  if (url.pathname === "/w/api.php" && url.searchParams.get("action") === "query" && titles) return json(queryAnswer(titles.split("|")));
  return json({}, 404);
};

let dir: string;
let clock: number;
let slept: number[];
function client(handler: Handler = defaultHandler, extra: Partial<ConstructorParameters<typeof WikiClient>[0]> = {}) {
  const m = mockFetch(handler);
  const w = new WikiClient({
    dataDir: dir,
    fetch: m.f,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    ...extra,
  });
  return { w, calls: m.calls };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ie-wiki-"));
  clock = Date.parse("2026-11-14T12:00:00Z");
  slept = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("lookup", () => {
  it("batches at 50 titles and deduplicates after normalisation", async () => {
    const { w, calls } = client();
    const inputs = Array.from({ length: 120 }, (_, i) => `Page ${i}`);
    const res = await w.lookup([...inputs, "page 0", "Page_1", "  Page   2 "]);
    expect(calls.length).toBe(3); // 50 + 50 + 20
    expect(calls.map((c) => c.url.searchParams.get("titles")!.split("|").length)).toEqual([50, 50, 20]);
    expect(res).toHaveLength(123);
    expect(res.every((r) => r.status === "found")).toBe(true);
    expect(res[120]).toMatchObject({ input: "page 0", status: "found", title: "Page 0" });
  });

  it("resolves redirects, flags disambiguation pages, reports missing and invalid", async () => {
    const { w } = client();
    const [ceph, fixed, octo, none, bad] = await w.lookup(["cephalopods", "fixed point", "octopus", "No such thing", "a|b"]);
    expect(ceph).toMatchObject({ status: "found", title: "Cephalopod", redirect: true, disambiguation: false, description: "Class of mollusks" });
    expect(fixed).toMatchObject({ status: "found", title: "Fixed point", disambiguation: true });
    expect(octo).toMatchObject({ status: "found", title: "Octopus", redirect: false, pageId: 22780, url: "https://en.wikipedia.org/wiki/Octopus" });
    expect(none).toMatchObject({ status: "missing" });
    expect(bad).toMatchObject({ status: "invalid" });
  });

  it("caches positives and negatives: a repeat scan sends no requests, even after a restart", async () => {
    const a = client();
    await a.w.lookup(["Octopus", "No such thing", "Cephalopods"]);
    expect(a.calls.length).toBe(1);
    const again = await a.w.lookup(["Octopus", "No such thing", "Cephalopods"]);
    expect(a.calls.length).toBe(1);
    expect(again.every((r) => r.cached)).toBe(true);
    a.w.flush();
    const b = client(); // new process, same data dir
    const third = await b.w.lookup(["octopus", "No such thing"]);
    expect(b.calls.length).toBe(0);
    expect(third.map((r) => r.status)).toEqual(["found", "missing"]);
  });

  it("negatives expire sooner than positives", async () => {
    const { w, calls } = client();
    await w.lookup(["Octopus", "No such thing"]);
    clock += 4 * 24 * 3600 * 1000; // past the 3-day negative lifetime, inside the 30-day positive one
    await w.lookup(["Octopus", "No such thing"]);
    expect(calls.length).toBe(2);
    expect(calls[1].url.searchParams.get("titles")).toBe("No such thing");
  });

  it("returns unavailable items instead of throwing when offline, and serves stale entries", async () => {
    const { w } = client(() => {
      throw new TypeError("fetch failed");
    });
    const res = await w.lookup(["Octopus"]);
    expect(res[0]).toMatchObject({ status: "unavailable", reason: "offline" });
    // Offline is remembered for a while: no new attempt, still no throw.
    expect((await w.summary("Octopus")).ok).toBe(false);
  });

  it("holds offline for offlineHoldMs: 30 s by default, not at all with 0", async () => {
    let down = true;
    const handler: Handler = (url) => {
      if (down) throw new TypeError("fetch failed");
      return defaultHandler(url);
    };
    const held = client(handler);
    expect((await held.w.lookup(["Octopus"]))[0]).toMatchObject({ status: "unavailable", reason: "offline" });
    down = false;
    expect((await held.w.lookup(["Octopus"]))[0]).toMatchObject({ status: "unavailable", reason: "offline" });
    expect(held.calls.length).toBe(1);
    clock += 30_000;
    expect((await held.w.lookup(["Octopus"]))[0]).toMatchObject({ status: "found" });

    down = true;
    const free = client(handler, { offlineHoldMs: 0, persist: false });
    expect((await free.w.lookup(["Octopus"]))[0]).toMatchObject({ reason: "offline" });
    down = false;
    expect((await free.w.lookup(["Octopus"]))[0]).toMatchObject({ status: "found" });
  });
});

describe("queue", () => {
  it("backs off on 429 with Retry-After, then succeeds", async () => {
    let n = 0;
    const { w, calls } = client((url) => {
      if (n++ === 0) return json({ error: "too many" }, 429, { "retry-after": "3" });
      return defaultHandler(url);
    }, { spacingMs: 100 });
    const [r] = await w.lookup(["Octopus"]);
    expect(r.status).toBe("found");
    expect(calls.length).toBe(2);
    expect(slept).toContain(3000);
  });

  it("gives up at once when Retry-After is longer than an interactive caller should wait", async () => {
    const { w, calls } = client(() => json({}, 429, { "retry-after": "2712" }));
    const r = await w.suggest("Brou");
    expect(r).toMatchObject({ ok: false, reason: "rate-limited", retryAfter: 2712 });
    // The pause holds for everyone: the next call does not touch the network.
    const r2 = await w.suggest("Brouw");
    expect(r2).toMatchObject({ ok: false, reason: "rate-limited" });
    expect(calls.length).toBe(1);
  });

  it("treats a maxlag error as a pause and sends maxlag only for bulk work", async () => {
    let n = 0;
    const { w, calls } = client((url) => {
      if (url.searchParams.get("maxlag") && n++ === 0) return json({ error: { code: "maxlag", info: "Waiting" } }, 200, { "retry-after": "5" });
      return defaultHandler(url);
    }, { spacingMs: 100 });
    await w.lookup(["Octopus"], { priority: "interactive" });
    expect(calls[0].url.searchParams.get("maxlag")).toBeNull();
    const [r] = await w.lookup(["Cephalopod"], { priority: "bulk" });
    expect(r.status).toBe("found");
    expect(calls[1].url.searchParams.get("maxlag")).toBe("5");
    expect(slept).toContain(5000);
  });

  it("serves a person first, then background jobs, then scans after edits, unless a scan has waited too long", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const { w, calls } = client(async (url) => {
      if (first) (first = false), await gate;
      return defaultHandler(url);
    });
    const order: string[] = [];
    const ask = (t: string, priority: "interactive" | "bulk" | "scan") => w.lookup([t], { priority }).then(() => order.push(t));
    // The first request holds the queue; the rest line up behind it in their lanes.
    const all = [ask("Page 0", "scan"), ask("Page 1", "scan"), ask("Page 2", "bulk"), ask("Page 3", "interactive")];
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all(all);
    expect(order).toEqual(["Page 0", "Page 3", "Page 2", "Page 1"]);
    expect(calls.map((c) => c.url.searchParams.get("maxlag"))).toEqual(["5", null, "5", "5"]);

    // A scan that has waited past SCAN_STARVE_MS goes before a bulk job.
    let hold: () => void = () => {};
    const gate2 = new Promise<void>((r) => (hold = r));
    let firstAgain = true;
    const b = client(async (url) => {
      if (firstAgain) (firstAgain = false), await gate2;
      return defaultHandler(url);
    });
    const seen: string[] = [];
    const go = (t: string, priority: "bulk" | "scan") => b.w.lookup([t], { priority }).then(() => seen.push(t));
    const rest = [go("Page 10", "bulk"), go("Page 11", "scan")];
    await new Promise((r) => setTimeout(r, 5));
    const more = go("Page 12", "bulk");
    clock += 31_000;
    hold();
    await Promise.all([...rest, more]);
    expect(seen).toEqual(["Page 10", "Page 11", "Page 12"]);
  });

  it("spaces requests and sends the generic User-Agent", async () => {
    const { w, calls } = client(defaultHandler, { spacingMs: 1000 });
    await w.lookup(["Page 1"]);
    await w.lookup(["Page 2"]);
    expect(slept).toEqual([1000]);
    expect(calls[0].headers["user-agent"]).toBe("Explicata/0.1 (personal knowledge tool)");
  });

  it("drops a queued request whose caller aborted, without sending it", async () => {
    const { w, calls } = client(defaultHandler, { spacingMs: 1000 });
    const first = w.lookup(["Page 1"]);
    const ac = new AbortController();
    const second = w.suggest("Brou", 8, { signal: ac.signal });
    ac.abort();
    await first;
    expect(await second).toMatchObject({ ok: false, reason: "aborted" });
    expect(calls.length).toBe(1);
  });
});

describe("user agent and contact", () => {
  it("accepts only machine-recognisable contacts", () => {
    expect(validContact("me@example.org")).toBe("me@example.org");
    expect(validContact("User:Someone")).toBe("User:Someone");
    expect(validContact("https://example.org/me")).toBe("https://example.org/me");
    expect(validContact("Jane Doe")).toBeNull();
    expect(validContact("a@b.c; rm")).toBeNull();
    expect(userAgent("me@example.org")).toBe("Explicata/0.1 (me@example.org)");
  });
});

describe("helpers", () => {
  it("parses Retry-After as seconds or a date", () => {
    const now = Date.parse("2026-11-14T12:00:00Z");
    expect(parseRetryAfter("7", now)).toBe(7000);
    expect(parseRetryAfter("Sat, 14 Nov 2026 12:00:10 GMT", now)).toBe(10_000);
    expect(parseRetryAfter(null, now)).toBeNull();
  });
  it("prepares titles like MediaWiki", () => {
    expect(prepareTitle("octopus_minds")).toEqual({ title: "Octopus minds" });
    expect(prepareTitle("[x]")).toEqual({ invalid: "illegal character" });
    expect(batches(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
  });
});

describe("sanitiser", () => {
  const o = "en";
  it("strips scripts, styles, event handlers and javascript: links", () => {
    const out = sanitizeWikiHtml(
      `<p onclick="alert(1)" style="color:red" class="x">Hi <script>alert(1)</script><style>p{}</style><img src=x onerror=alert(1)>` +
        `<a href="javascript:alert(1)">bad</a> <a href="https://example.org/" onmouseover="x()">ext</a></p>`,
      o,
    );
    expect(out).not.toMatch(/script|style|onclick|onerror|onmouseover|javascript|alert/i);
    expect(out).toBe(`<p>Hi bad <a href="https://example.org/" rel="noopener noreferrer nofollow" target="_blank">ext</a></p>`);
  });

  it("rewrites internal links to data-wiki and unwraps red links and other namespaces", () => {
    const out = sanitizeWikiHtml(
      `<p><a href="/wiki/Fixed_point_(mathematics)" title="Fixed point (mathematics)">fixed points</a>, ` +
        `<a href="/wiki/Convergence_proof_techniques#contraction_mapping">tool</a>, ` +
        `<a href="/w/index.php?title=Nope&amp;action=edit&amp;redlink=1" class="new">red</a>, ` +
        `<a href="/wiki/Help:IPA/English">ipa</a>, <a href="/wiki/Star_Wars:_Episode_IV">sw</a></p>`,
      o,
    );
    expect(out).toContain(`<a href="https://en.wikipedia.org/wiki/Fixed_point_(mathematics)" data-wiki="Fixed point (mathematics)">fixed points</a>`);
    expect(out).toContain(`data-wiki="Convergence proof techniques" data-wiki-fragment="contraction mapping">tool</a>`);
    expect(out).toContain(", red, ipa, ");
    expect(out).toContain(`data-wiki="Star Wars: Episode IV"`);
  });

  it("drops reference markers, navboxes, infoboxes, hidden text and layout tables; keeps wikitables", () => {
    const out = sanitizeWikiHtml(
      `<div class="shortdescription" style="display:none">Short</div>` +
        `<table class="infobox"><tr><td>box</td></tr></table>` +
        `<p>Text<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup> more.</p>` +
        `<div role="navigation" class="navbox">nav</div><span class="mw-editsection">[edit]</span>` +
        `<table class="wikitable"><tbody><tr><th colspan="2" style="x">H</th></tr><tr><td>a</td><td>b</td></tr></tbody></table>`,
      o,
    );
    expect(out).toBe(`<p>Text more.</p><table><tbody><tr><th colspan="2">H</th></tr><tr><td>a</td><td>b</td></tr></tbody></table>`);
  });

  it("keeps MathML and escapes text", () => {
    const out = sanitizeWikiHtml(`<p>Let <math display="inline" onclick="x"><mi>x</mi><mo>&lt;</mo></math> &amp; y</p>`, o);
    expect(out).toBe(`<p>Let <math display="inline"><mi>x</mi><mo>&lt;</mo></math> &amp; y</p>`);
  });

  it("keeps a thumbnail as a figure: its 2x rendition through the app's image route, its caption, its File page to credit it", () => {
    const html = `<figure typeof="mw:File/Thumb"><a href="/wiki/File:X.jpg" class="mw-file-description" onclick="x"><img alt="An x" src="//upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/250px-X.jpg" width="250" height="200" onload="x" srcset="//upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/375px-X.jpg 1.5x, //upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/500px-X.jpg 2x"></a><figcaption>Cap with <a href="/wiki/Octopus">a link</a></figcaption></figure><p>t</p>`;
    expect(sanitizeWikiHtml(html, o)).toBe(
      `<figure><img src="/api/wiki/media?u=https%3A%2F%2Fupload.wikimedia.org%2Fwikipedia%2Fcommons%2Fthumb%2Fa%2Fab%2FX.jpg%2F500px-X.jpg" alt="An x" width="500" height="400" loading="lazy" decoding="async" data-full="https://en.wikipedia.org/wiki/File:X.jpg"><figcaption>Cap with <a href="https://en.wikipedia.org/wiki/Octopus" data-wiki="Octopus">a link</a></figcaption></figure><p>t</p>`,
    );
    // Old-style thumbnails, on another language's wiki: the File page on that wiki, caption from thumbcaption.
    const old = `<div class="thumb tright"><div class="thumbinner"><a href="/wiki/Fichier:Y.png" class="image"><img src="//upload.wikimedia.org/y.png" width="220" height="100" class="thumbimage"></a><div class="thumbcaption"><div class="magnify"><a href="/wiki/Fichier:Y.png" class="internal"><img src="//upload.wikimedia.org/magnify.png" width="15" height="11"></a></div>Une légende</div></div></div>`;
    expect(sanitizeWikiHtml(old, "fr")).toBe(`<figure><img src="/api/wiki/media?u=https%3A%2F%2Fupload.wikimedia.org%2Fy.png" alt="" width="220" height="100" loading="lazy" decoding="async" data-full="https://fr.wikipedia.org/wiki/Fichier:Y.png"><figcaption>Une légende</figcaption></figure>`);
  });

  it("drops icons and flags, pictures in a sentence, pictures from elsewhere or with no File page, and anything in a dropped box", () => {
    const file = (name: string, img: string, cls = "") => `<figure typeof="mw:File/Thumb" class="${cls}"><a href="/wiki/File:${name}" class="mw-file-description">${img}</a><figcaption>${name}</figcaption></figure>`;
    for (const html of [
      file("Flag.svg", `<img src="//upload.wikimedia.org/flag.png" width="23" height="15">`),
      file("Tall.svg", `<img src="//upload.wikimedia.org/tall.png" width="300" height="40">`),
      file("Icon.svg", `<img src="//upload.wikimedia.org/icon.png" width="80" height="80" class="mw-file-element noviewer">`),
      `<span class="flagicon">${file("Flag2.svg", `<img src="//upload.wikimedia.org/flag2.png" width="60" height="60">`)}</span>`,
      file("Evil.png", `<img src="https://evil.example/x.png" width="250" height="200">`),
      file("Data.png", `<img src="data:image/png;base64,AAAA" width="250" height="200">`),
      `<figure><a href="https://evil.example/" class="mw-file-description"><img src="//upload.wikimedia.org/z.png" width="250" height="200"></a></figure>`,
      `<figure><img src="//upload.wikimedia.org/z.png" width="250" height="200"></figure>`,
      `<div role="navigation" class="navbox">${file("Nav.png", `<img src="//upload.wikimedia.org/nav.png" width="250" height="200">`)}</div>`,
      `<table class="infobox ib-box"><tr><td class="infobox-image">${file("Box.png", `<img src="//upload.wikimedia.org/box.png" width="250" height="200">`)}</td></tr></table>`,
      `<div class="ambox">${file("Warn.png", `<img src="//upload.wikimedia.org/warn.png" width="250" height="200">`)}</div>`,
      `<figure typeof="mw:File/Thumb"><a href="/wiki/File:Sound.ogg" class="mw-file-description"><audio src="//upload.wikimedia.org/s.ogg" controls></audio></a><figcaption>A sound</figcaption></figure>`,
    ]) {
      expect(sanitizeWikiHtml(html + "<p>t</p>", o), html).toBe("<p>t</p>");
    }
    // A picture inline in a sentence goes; the sentence stays one paragraph.
    expect(sanitizeWikiHtml(`<p>A <span typeof="mw:File"><a href="/wiki/File:Big.png" class="mw-file-description"><img src="//upload.wikimedia.org/big.png" width="300" height="200"></a></span> picture.</p>`, o)).toBe("<p>A  picture.</p>");
  });

  it("makes a gallery one figure per picture, its caption a paragraph; and a multiple-image block one figure each", () => {
    const box = (n: string, cap: string) => `<li class="gallerybox"><div class="thumb"><span typeof="mw:File"><a href="/wiki/File:${n}" class="mw-file-description"><img src="//upload.wikimedia.org/thumb/${n}/120px-${n}" width="120" height="90" srcset="//upload.wikimedia.org/thumb/${n}/240px-${n} 2x"></a></span></div><div class="gallerytext">${cap}</div></li>`;
    const out = sanitizeWikiHtml(`<ul class="gallery mw-gallery-traditional"><li class="gallerycaption">Two</li>${box("A.jpg", "First")}${box("B.jpg", "Second")}</ul>`, o);
    expect(out).toMatch(/^<p>Two<\/p>\n<figure><img src="\/api\/wiki\/media\?u=[^"]*240px-A\.jpg" alt="" width="240" height="180" [^>]*data-full="https:\/\/en\.wikipedia\.org\/wiki\/File:A\.jpg"><figcaption>First<\/figcaption><\/figure>\n<figure>.*B\.jpg.*<figcaption>Second<\/figcaption><\/figure>$/s);
    const single = (n: string, cap: string) => `<div class="tsingle"><div class="thumbimage"><span typeof="mw:File"><a href="/wiki/File:${n}" class="mw-file-description"><img src="//upload.wikimedia.org/${n}" width="150" height="100"></a></span></div><div class="thumbcaption">${cap}</div></div>`;
    const multi = sanitizeWikiHtml(`<div class="thumb tmulti tright"><div class="thumbinner multiimageinner"><div class="trow">${single("L.jpg", "Left")}${single("R.jpg", "Right")}</div><div class="trow"><div class="thumbcaption">Both together</div></div></div></div>`, o);
    expect(multi.match(/<figure>/g)).toHaveLength(2);
    expect(multi).toContain("<figcaption>Left</figcaption>");
    expect(multi).toContain("<figcaption>Right</figcaption>");
    expect(multi).toMatch(/<p>Both together<\/p>$/);
  });

  it("makes a video the click-to-play facade: a WebM of 360–720 lines from upload.wikimedia.org, its still through the image route, its File page", () => {
    const html = `<figure typeof="mw:File/Thumb"><span><video poster="//upload.wikimedia.org/thumb/V.webm/220px--V.webm.jpg" controls="" preload="none" autoplay width="220" height="124" data-mwtitle="V.webm" resource="/wiki/File:V.webm"><source src="//upload.wikimedia.org/V.webm" type="video/webm" data-width="1920" data-height="1080"><source src="//upload.wikimedia.org/transcoded/V.webm/V.webm.480p.vp9.webm" type="video/webm; codecs=&quot;vp9, opus&quot;" data-width="854" data-height="480"><source src="https://evil.example/v.webm" type="video/webm" data-width="640" data-height="360"></video></span><figcaption>A clip</figcaption></figure>`;
    expect(sanitizeWikiHtml(html, o)).toBe(
      `<figure class="video" data-video="https://upload.wikimedia.org/transcoded/V.webm/V.webm.480p.vp9.webm" data-width="854" data-height="480" data-file="https://en.wikipedia.org/wiki/File:V.webm"><img src="/api/wiki/media?u=https%3A%2F%2Fupload.wikimedia.org%2Fthumb%2FV.webm%2F220px--V.webm.jpg" alt="" width="854" height="480" loading="lazy" decoding="async"><figcaption>A clip</figcaption></figure>`,
    );
    // No File page: no credit, not kept. No source on upload.wikimedia.org: not kept.
    expect(sanitizeWikiHtml(html.replace(` data-mwtitle="V.webm" resource="/wiki/File:V.webm"`, ""), o)).toBe("");
    expect(sanitizeWikiHtml(`<figure><video resource="/wiki/File:E.webm" src="https://evil.example/e.webm"></video></figure>`, o)).toBe("");
  });

  it("lifts the infobox's picture to the top of the lead, its caption with it; the infobox itself stays out", () => {
    const page =
      `<div class="mw-parser-output"><div class="hatnote">See also</div><table class="infobox biota"><tbody><tr><th>Heron</th></tr>` +
      `<tr><td colspan="2" class="infobox-image"><span typeof="mw:File/Frameless"><a href="/wiki/File:H.jpg" class="mw-file-description"><img src="//upload.wikimedia.org/thumb/H.jpg/250px-H.jpg" width="250" height="200" srcset="//upload.wikimedia.org/thumb/H.jpg/500px-H.jpg 2x"></a></span><div class="infobox-caption">An adult</div></td></tr>` +
      `<tr><th>Range</th><td><span class="flagicon"><img src="//upload.wikimedia.org/f.png" width="23" height="15"></span> Europe</td></tr></tbody></table><p>Lead.</p>` +
      `<div class="mw-heading mw-heading2"><h2 id="A">A</h2></div><p>Alpha</p></div>`;
    const { lead, sections, media } = splitArticle(page, "en");
    expect(lead).toBe(`<figure><img src="/api/wiki/media?u=https%3A%2F%2Fupload.wikimedia.org%2Fthumb%2FH.jpg%2F500px-H.jpg" alt="" width="500" height="400" loading="lazy" decoding="async" data-full="https://en.wikipedia.org/wiki/File:H.jpg"><figcaption>An adult</figcaption></figure>\n<p>Lead.</p>`);
    expect(sections[0].html).toBe("<p>Alpha</p>");
    expect(media).toEqual(["https://upload.wikimedia.org/thumb/H.jpg/500px-H.jpg"]);
    // An infobox without an image cell: the cell of its first picture worth keeping.
    const plain = splitArticle(`<table class="infobox"><tr><td><img src="//upload.wikimedia.org/i.png" width="20" height="20"></td></tr><tr><td><a href="/wiki/File:P.png" class="mw-file-description"><img src="//upload.wikimedia.org/p.png" width="200" height="150"></a></td></tr></table><p>Lead.</p>`, "en");
    expect(plain.lead).toMatch(/^<figure><img src="\/api\/wiki\/media\?u=https%3A%2F%2Fupload\.wikimedia\.org%2Fp\.png"[^>]*data-full="https:\/\/en\.wikipedia\.org\/wiki\/File:P\.png"><\/figure>\n<p>Lead\.<\/p>$/);
  });

  it("splits an article at its headings into a section tree", () => {
    const page =
      `<div class="mw-content-ltr mw-parser-output"><p>Lead.</p>` +
      `<div class="mw-heading mw-heading2"><h2 id="Proof">Proof</h2></div><p>P.</p>` +
      `<div class="mw-heading mw-heading3"><h3 id="Step_one">Step one</h3></div><p>S1.</p>` +
      `<div class="mw-heading mw-heading2"><h2 id="See_also">See also</h2></div><ul><li><a href="/wiki/Octopus">Octopus</a></li></ul></div>`;
    const { lead, sections } = splitArticle(page, "en");
    expect(lead).toBe("<p>Lead.</p>");
    expect(sections.map(({ id, level, heading, anchor, parent }) => ({ id, level, heading, anchor, parent }))).toEqual([
      { id: 1, level: 2, heading: "Proof", anchor: "Proof", parent: 0 },
      { id: 2, level: 3, heading: "Step one", anchor: "Step_one", parent: 1 },
      { id: 3, level: 2, heading: "See also", anchor: "See_also", parent: 0 },
    ]);
    expect(sections[1].html).toBe("<p>S1.</p>");
  });
});

describe("article", () => {
  const page =
    `<div class="mw-parser-output"><p>Lead <a href="/wiki/Octopus">octopus</a>.</p>` +
    `<div class="mw-heading mw-heading2"><h2 id="A">A</h2></div><p>Alpha<script>x</script></p>` +
    `<div class="mw-heading mw-heading2"><h2 id="B">B</h2></div><p>Beta</p></div>`;
  const handler: Handler = (url) => {
    if (url.searchParams.get("action") === "parse") {
      if (url.searchParams.get("page") === "Nope") return json({ error: { code: "missingtitle", info: "missing" } });
      return json({
        parse: {
          title: "Thing",
          pageid: 5,
          revid: 777,
          text: page,
          tocdata: { sections: [{ number: "1", index: "1" }, { number: "2", index: "2" }] },
        },
      });
    }
    return defaultHandler(url);
  };

  it("fetches the page once, then serves every section from the cache", async () => {
    const { w, calls } = client(handler);
    const a = await w.article("thing");
    expect(a.ok && a.value).toMatchObject({ title: "Thing", revisionId: 777, lead: `<p>Lead <a href="https://en.wikipedia.org/wiki/Octopus" data-wiki="Octopus">octopus</a>.</p>` });
    expect(a.ok && a.value.sections.map((s) => [s.id, s.heading, s.number])).toEqual([
      [1, "A", "1"],
      [2, "B", "2"],
    ]);
    expect(a.ok && a.value.attribution.text).toContain("CC BY-SA 4.0");
    expect(a.ok && a.value.attribution.revisionUrl).toBe("https://en.wikipedia.org/w/index.php?title=Thing&oldid=777");
    const full = await w.article("thing", { sections: true });
    expect(full.ok && full.value.sections[0].html).toBe("<p>Alpha</p>");
    expect(calls.length).toBe(1);
    expect(calls[0].url.searchParams.get("prop")).toBe("text|tocdata|revid|displaytitle|properties");
  });

  it("reports a missing page as missing, not unavailable", async () => {
    const { w } = client(handler);
    expect(await w.article("Nope")).toMatchObject({ ok: false, reason: "missing" });
  });

  it("returns every section's html with sections: true, from the same request", async () => {
    const { w, calls } = client(handler);
    const short = await w.article("thing");
    expect(short.ok && short.value.sections[0]).not.toHaveProperty("html");
    const full = await w.article("thing", { sections: true });
    expect(full.ok && full.value.sections.map((s) => [s.heading, s.html])).toEqual([
      ["A", "<p>Alpha</p>"],
      ["B", "<p>Beta</p>"],
    ]);
    expect(full.ok && full.value.disambiguation).toBe(false);
    expect(calls.length).toBe(1);
  });

  it("reads the disambiguation flag from parse properties, in either format", async () => {
    for (const properties of [{ disambiguation: "", wikibase_item: "Q1" }, [{ name: "disambiguation", "*": "" }]]) {
      const { w } = client((url) => json({ parse: { title: "Set", pageid: 1, revid: 2, text: "<p>Set may refer to:</p>", properties } }));
      expect(await w.article("Set")).toMatchObject({ ok: true, value: { disambiguation: true } });
    }
    const { w } = client((url) => json({ parse: { title: "Plain", pageid: 1, revid: 2, text: "<p>x</p>", properties: { wikibase_item: "Q1" } } }));
    expect(await w.article("Plain")).toMatchObject({ ok: true, value: { disambiguation: false } });
  });

  it("reads an article cached before the flag existed as not a disambiguation page", async () => {
    const articles = join(dir, "wiki-cache", "en", "articles");
    mkdirSync(articles, { recursive: true });
    const old = { title: "Old", pageId: 9, revisionId: 10, lead: "<p>Old.</p>", sections: [], sanitiser: 2 };
    writeFileSync(join(articles, createHash("sha1").update("Old|0").digest("hex") + ".json"), JSON.stringify({ v: old, exp: clock + 1000 }));
    const { w, calls } = client(handler);
    expect(await w.article("Old")).toMatchObject({ ok: true, cached: true, value: { title: "Old", disambiguation: false } });
    expect(calls.length).toBe(0);
  });
});

describe("an article cached by an older sanitiser", () => {
  const handler: Handler = (url) =>
    url.searchParams.get("action") === "parse"
      ? json({ parse: { title: "Pictured", pageid: 9, revid: 11, text: `<figure><a href="/wiki/File:P.jpg" class="mw-file-description"><img src="//upload.wikimedia.org/p.jpg" width="250" height="200"></a><figcaption>A picture</figcaption></figure><p>Now with pictures.</p>` } })
      : defaultHandler(url);
  const cacheOld = () => {
    const articles = join(dir, "wiki-cache", "en", "articles");
    mkdirSync(articles, { recursive: true });
    // Written before pictures were kept: no sanitiser version, no media.
    const old = { title: "Pictured", pageId: 9, revisionId: 10, lead: "<p>Before pictures.</p>", sections: [] };
    writeFileSync(join(articles, createHash("sha1").update("Pictured|0").digest("hex") + ".json"), JSON.stringify({ v: old, exp: clock + 3 * 24 * 3600 * 1000 }));
  };

  it("is read again, though still in date, so its pictures appear at once; then served from the cache", async () => {
    cacheOld();
    const { w, calls } = client(handler);
    const a = await w.article("Pictured");
    expect(a).toMatchObject({ ok: true, cached: false, value: { revisionId: 11 } });
    expect(a.ok && a.value.lead).toMatch(/^<figure><img src="\/api\/wiki\/media\?u=https%3A%2F%2Fupload\.wikimedia\.org%2Fp\.jpg"/);
    expect(calls.length).toBe(1);
    // A new client (a restarted server) reads it from the disk, as the current sanitiser made it.
    const again = client(() => {
      throw new Error("no request expected");
    });
    expect(await again.w.article("Pictured")).toMatchObject({ ok: true, cached: true, value: { revisionId: 11 } });
    expect(again.calls.length).toBe(0);
  });

  it("is still served, marked stale, while Wikipedia cannot be reached", async () => {
    cacheOld();
    const { w } = client(() => {
      throw new TypeError("fetch failed");
    });
    expect(await w.article("Pictured")).toMatchObject({ ok: true, cached: true, stale: true, value: { lead: "<p>Before pictures.</p>" } });
  });
});

describe("pictures", () => {
  const still = "https://upload.wikimedia.org/p.jpg";
  const handler: Handler = (url) => {
    if (url.hostname === "upload.wikimedia.org") return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
    if (url.searchParams.get("action") === "parse")
      return json({ parse: { title: "Pictured", pageid: 9, revid: 11, text: `<figure><a href="/wiki/File:P.jpg" class="mw-file-description"><img src="//upload.wikimedia.org/p.jpg" width="250" height="200"></a></figure><p>t</p>` } });
    return defaultHandler(url);
  };

  it("are read only once an article served here shows them, only from upload.wikimedia.org, with the client's User-Agent", async () => {
    const { w, calls } = client(handler, { contact: "someone@example.org", mediaSpacingMs: 0 });
    expect(await w.media(still)).toMatchObject({ ok: false, status: 404 });
    expect(calls.length).toBe(0);
    await w.article("Pictured");
    expect(await w.media(still)).toMatchObject({ ok: true, type: "image/png" });
    const req = calls[calls.length - 1];
    expect(req.url.href).toBe(still);
    expect(new Headers(req.headers).get("user-agent")).toBe("Explicata/0.1 (someone@example.org)");
    // Never robots.txt, never another host, never plain http, even when named in an article.
    expect(calls.some((c) => c.url.pathname === "/robots.txt")).toBe(false);
    expect(await w.media("https://evil.example/p.jpg")).toMatchObject({ ok: false, status: 404 });
    expect(await w.media("http://upload.wikimedia.org/p.jpg")).toMatchObject({ ok: false, status: 404 });
  });

  it("are asked for at most two at a time, spaced apart, and not at all for a while after a 429", async () => {
    let active = 0;
    let most = 0;
    let n = 0;
    let told = false;
    let afterTold = 0;
    const starts: number[] = [];
    const urls = Array.from({ length: 6 }, (_, i) => `https://upload.wikimedia.org/p${i}.jpg`);
    const text = urls.map((u, i) => `<figure><a href="/wiki/File:P${i}.jpg" class="mw-file-description"><img src="${u.slice(6)}" width="250" height="200"></a></figure>`).join("") + "<p>t</p>";
    const { w } = client(async (url) => {
      if (url.searchParams.get("action") === "parse") return json({ parse: { title: "Many", pageid: 9, revid: 11, text } });
      if (url.hostname !== "upload.wikimedia.org") return defaultHandler(url);
      starts.push(clock);
      if (told) afterTold++;
      active++;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (++n === 2) {
        told = true;
        return new Response("slow down", { status: 429, headers: { "retry-after": "60" } });
      }
      return new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } });
    });
    await w.article("Many");
    const got = await Promise.all(urls.map((u) => w.media(u)));
    expect(most).toBeLessThanOrEqual(2);
    // Anonymous: each waits its turn, a second after the one before.
    expect(slept.filter((ms) => ms >= 1000).length).toBeGreaterThanOrEqual(starts.length - 1);
    // Once told to wait 60 s (longer than a read may wait), nothing more is asked (but one already on its way): the rest are refused without a request.
    expect(afterTold).toBeLessThanOrEqual(1);
    expect(got.filter((r) => !r.ok && /asked for fewer requests/.test((r as { message: string }).message)).length).toBeGreaterThanOrEqual(3);
  });
});

describe("summary from the cache only", () => {
  const summaryJson = { type: "standard", title: "Octopus", titles: { normalized: "Octopus" }, pageid: 22780, extract: "An octopus.", revision: "1" };
  it("answers uncached without a request, then the cached summary, fresh or expired", async () => {
    const { w, calls } = client((url) => (url.pathname.includes("/page/summary/") ? json(summaryJson) : defaultHandler(url)));
    expect(await w.summary("Octopus", { cacheOnly: true })).toMatchObject({ ok: false, reason: "uncached" });
    expect(calls.length).toBe(0);
    await w.summary("Octopus");
    expect(calls.length).toBe(1);
    const hit = await w.summary("octopus", { cacheOnly: true });
    expect(hit).toMatchObject({ ok: true, cached: true, value: { title: "Octopus", extract: "An octopus." } });
    expect(hit).not.toHaveProperty("stale");
    clock += 15 * 24 * 3600 * 1000; // past the 14-day lifetime
    expect(await w.summary("Octopus", { cacheOnly: true })).toMatchObject({ ok: true, stale: true });
    expect(calls.length).toBe(1);
  });
});
