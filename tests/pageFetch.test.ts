/** server/pageFetch.ts with fetch injected: address guard, redirects, caps, content types, robots.txt, spacing, single flight. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decodeBody } from "../server/page";
import { PAGE_MAX_BYTES, PAGE_TYPES, PAGE_USER_AGENT, PageFetcher, guardUrl, parseRobots, robotsAllows } from "../server/pageFetch";

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;
const PAGE = `<!doctype html><title>t</title><p>hello</p>`;
const html = (body = PAGE, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const notFound = () => new Response("no", { status: 404, headers: { "content-type": "text/plain" } });

let clock = 0;
let slept: number[];
function fetcher(handler: Handler, extra: Partial<ConstructorParameters<typeof PageFetcher>[0]> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = new PageFetcher({
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return handler(new URL(String(input)), init);
    }) as typeof fetch,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    ...extra,
  });
  return { f, calls, pages: () => calls.filter((c) => !c.url.endsWith("/robots.txt")) };
}
const get = (f: PageFetcher, url: string) => f.get(url, { types: PAGE_TYPES, maxBytes: PAGE_MAX_BYTES });

beforeEach(() => {
  clock = Date.parse("2026-11-17T12:00:00Z");
  slept = [];
});

describe("the address guard", () => {
  it("refuses this machine, private networks, credentials, other schemes and ports, without a request", async () => {
    const { f, calls } = fetcher(() => html());
    for (const u of [
      "http://127.0.0.1/",
      "http://localhost/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://2130706433/",
      "http://0x7f.1/",
      "http://[::ffff:127.0.0.1]/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://printer.local/",
      "https://user:pass@example.org/",
      "file:///etc/passwd",
      "ftp://example.org/x",
      "https://example.org:8443/",
      "not a url",
      `https://example.org/${"x".repeat(2000)}`,
    ]) {
      expect(guardUrl(u), u).not.toBeNull();
      expect(await get(f, u), u).toMatchObject({ ok: false, reason: "refused" });
    }
    expect(calls).toEqual([]);
    expect(guardUrl("https://example.org/a?b=c")).toBeNull();
    expect(guardUrl("http://example.org:80/")).toBeNull();
  });

  it("checks every redirect hop, and stops after 5", async () => {
    const { f } = fetcher((url) => {
      if (url.pathname === "/robots.txt") return notFound();
      if (url.pathname === "/to-local") return new Response(null, { status: 302, headers: { location: "http://localhost:8080/" } });
      if (url.pathname === "/to-metadata") return new Response(null, { status: 301, headers: { location: "http://169.254.169.254/" } });
      const n = /^\/hop\/(\d+)$/.exec(url.pathname);
      if (n) return new Response(null, { status: 302, headers: { location: `/hop/${Number(n[1]) + 1}` } });
      return html();
    });
    expect(await get(f, "https://example.org/to-local")).toMatchObject({ ok: false, reason: "refused", url: "http://localhost:8080/" });
    expect(await get(f, "https://example.org/to-metadata")).toMatchObject({ ok: false, reason: "refused" });
    // /hop/1 → … → /hop/6 is five redirects, then /hop/6 redirects a sixth time.
    expect(await get(f, "https://example.org/hop/1")).toMatchObject({ ok: false, reason: "refused", message: "The page redirected more than 5 times." });
    const five = fetcher((url) => {
      if (url.pathname === "/robots.txt") return notFound();
      const n = Number(/^\/hop\/(\d+)$/.exec(url.pathname)?.[1]);
      return n < 6 ? new Response(null, { status: 302, headers: { location: `/hop/${n + 1}` } }) : html();
    });
    expect(await get(five.f, "https://example.org/hop/1")).toMatchObject({ ok: true, url: "https://example.org/hop/6" });
  });

  it("sends its own User-Agent, no credentials, and follows redirects by hand", async () => {
    const { f, pages } = fetcher((url) => (url.pathname === "/robots.txt" ? notFound() : html()));
    expect(await get(f, "https://example.org/a")).toMatchObject({ ok: true, type: "text/html", charset: "utf-8" });
    const init = pages()[0].init!;
    expect(init.redirect).toBe("manual");
    expect(init.credentials).toBe("omit");
    expect((init.headers as Record<string, string>)["user-agent"]).toBe(PAGE_USER_AGENT);
    expect(PAGE_USER_AGENT).toBe("Explicata/0.1 (personal reading tool)");
  });
});

describe("answers", () => {
  it("refuses other content types, non-2xx answers, and bodies past the cap while they stream", async () => {
    let pulled = 0;
    const { f } = fetcher((url) => {
      if (url.pathname === "/robots.txt") return notFound();
      if (url.pathname === "/pdf") return new Response("%PDF", { headers: { "content-type": "application/pdf" } });
      if (url.pathname === "/forbidden") return html("no", 403);
      if (url.pathname === "/busy") return html("busy", 503);
      if (url.pathname === "/declared") return html("x", 200, { "content-length": String(PAGE_MAX_BYTES + 1) });
      if (url.pathname === "/stream") {
        const chunk = new Uint8Array(64 * 1024).fill(0x61);
        const body = new ReadableStream<Uint8Array>({
          pull(c) {
            pulled++;
            if (pulled > 200) c.close();
            else c.enqueue(chunk);
          },
        });
        return new Response(body, { headers: { "content-type": "text/html" } });
      }
      // Bytes, not a string: a string body would be given text/plain.
      if (url.pathname === "/bare") return new Response(new TextEncoder().encode("<!DOCTYPE html><p>no type</p>"));
      if (url.pathname === "/bare-binary") return new Response(new TextEncoder().encode("GIF89a"));
      return html();
    });
    expect(await get(f, "https://example.org/pdf")).toMatchObject({ ok: false, reason: "type" });
    expect(await get(f, "https://example.org/forbidden")).toMatchObject({ ok: false, reason: "refused", status: 403 });
    expect(await get(f, "https://example.org/busy")).toMatchObject({ ok: false, reason: "error", status: 503 });
    expect(await get(f, "https://example.org/declared")).toMatchObject({ ok: false, reason: "too-large" });
    expect(await get(f, "https://example.org/stream")).toMatchObject({ ok: false, reason: "too-large" });
    // 5 MB in 64 KB chunks is 80 chunks: reading stopped there, not at the 200 on offer.
    expect(pulled).toBeLessThan(90);
    expect(await get(f, "https://example.org/bare")).toMatchObject({ ok: true, type: "text/html" });
    expect(await get(f, "https://example.org/bare-binary")).toMatchObject({ ok: false, reason: "type" });
  });

  it("reports a network failure as offline, and a hung site as offline after the timeout", async () => {
    const { f } = fetcher(() => {
      throw new TypeError("fetch failed");
    });
    expect(await get(f, "https://example.org/")).toMatchObject({ ok: false, reason: "offline" });
    const hung = new PageFetcher({
      timeoutMs: 50,
      fetch: ((_: unknown, init?: RequestInit) =>
        new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch,
    });
    expect(await get(hung, "https://example.org/")).toMatchObject({ ok: false, reason: "offline", message: expect.stringMatching(/^example\.org did not answer within/) });
  });

  it("decodes by the header's charset, else a <meta> one, else UTF-8", () => {
    const latin = Buffer.from(`<meta charset="iso-8859-1"><p>café</p>`, "latin1");
    expect(decodeBody(latin)).toContain("café");
    expect(decodeBody(latin, "windows-1252")).toContain("café");
    expect(decodeBody(Buffer.from("<p>café</p>"))).toContain("café");
    expect(decodeBody(Buffer.from("<p>café</p>"), "no-such-charset")).toContain("café");
  });
});

describe("robots.txt", () => {
  it("parses groups: this program's own outranks *, longest match wins, Allow on a tie, * and $", () => {
    const r = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: Explicata\nUser-agent: OtherBot\nDisallow: /private/\nAllow: /private/open\nDisallow: /*.pdf$\n")!;
    expect(robotsAllows(r, "/public")).toBe(true);
    expect(robotsAllows(r, "/private/x")).toBe(false);
    expect(robotsAllows(r, "/private/open/y")).toBe(true);
    expect(robotsAllows(r, "/files/a.pdf")).toBe(false);
    expect(robotsAllows(r, "/files/a.pdf?x")).toBe(true);
    const any = parseRobots("User-agent: *\nDisallow: /search\nAllow: /search/about\n# comment\n")!;
    expect(robotsAllows(any, "/search?q=x")).toBe(false);
    expect(robotsAllows(any, "/search/about")).toBe(true);
    expect(robotsAllows(parseRobots("User-agent: explicata/0.1\nDisallow:\n\nUser-agent: *\nDisallow: /\n")!, "/x")).toBe(true);
    expect(parseRobots("<html><body>Not found</body></html>")).toBeNull();
    expect(parseRobots("")).toBeNull();
  });

  it("judges by the body whatever the status: a 418 with Disallow: / disallows; unreadable files allow", async () => {
    const files: Record<string, () => Response> = {
      "teapot.example.org": () => new Response("User-agent: *\nDisallow: /\n", { status: 418 }),
      "missing.example.org": () => notFound(),
      "broken.example.org": () => new Response("<h1>Service unavailable</h1>", { status: 503 }),
      "down.example.org": () => {
        throw new TypeError("fetch failed");
      },
      "mine.example.org": () => new Response("User-agent: Explicata\nDisallow: /notes/\n"),
    };
    const { f, pages } = fetcher((url) => (url.pathname === "/robots.txt" ? files[url.host]() : html()));
    expect(await get(f, "https://teapot.example.org/page")).toMatchObject({ ok: false, reason: "robots" });
    expect(await get(f, "https://missing.example.org/page")).toMatchObject({ ok: true });
    expect(await get(f, "https://broken.example.org/page")).toMatchObject({ ok: true });
    expect(await get(f, "https://mine.example.org/notes/1")).toMatchObject({ ok: false, reason: "robots" });
    expect(await get(f, "https://mine.example.org/essays/1")).toMatchObject({ ok: true });
    expect(pages().map((c) => c.url)).toEqual(["https://missing.example.org/page", "https://broken.example.org/page", "https://mine.example.org/essays/1"]);
    const down = fetcher((url) => (url.host === "down.example.org" && url.pathname === "/robots.txt" ? files["down.example.org"]() : html()));
    expect(await get(down.f, "https://down.example.org/page")).toMatchObject({ ok: true });
  });

  it("reads robots.txt once per host a day, and checks the host a redirect goes to", async () => {
    const { f, calls } = fetcher((url) => {
      if (url.pathname === "/robots.txt") return url.host === "b.example.org" ? new Response("User-agent: *\nDisallow: /\n") : notFound();
      if (url.host === "a.example.org" && url.pathname === "/away") return new Response(null, { status: 302, headers: { location: "https://b.example.org/x" } });
      return html();
    });
    await get(f, "https://a.example.org/1");
    await get(f, "https://a.example.org/2");
    expect(calls.filter((c) => c.url === "https://a.example.org/robots.txt")).toHaveLength(1);
    expect(await get(f, "https://a.example.org/away")).toMatchObject({ ok: false, reason: "robots", url: "https://b.example.org/x" });
    clock += 25 * 3600 * 1000;
    await get(f, "https://a.example.org/3");
    expect(calls.filter((c) => c.url === "https://a.example.org/robots.txt")).toHaveLength(2);
  });
});

describe("politeness", () => {
  it("starts requests to one host a second apart, other hosts at once", async () => {
    const { f } = fetcher((url) => (url.pathname === "/robots.txt" ? notFound() : html()));
    await get(f, "https://a.example.org/1"); // robots.txt at 0, the page at 1000
    await get(f, "https://a.example.org/2");
    await get(f, "https://b.example.org/1");
    expect(slept).toEqual([1000, 1000, 1000]);
  });

  it("reads one URL once for callers asking at the same time; a caller that aborts stops waiting alone", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { f, pages } = fetcher(async (url) => {
      if (url.pathname === "/robots.txt") return notFound();
      await gate;
      return html();
    });
    const ac = new AbortController();
    const a = f.get("https://example.org/p", { types: PAGE_TYPES, maxBytes: PAGE_MAX_BYTES, signal: ac.signal });
    const b = get(f, "https://example.org/p");
    ac.abort();
    expect(await a).toMatchObject({ ok: false, message: "aborted" });
    release();
    expect(await b).toMatchObject({ ok: true });
    expect(pages()).toHaveLength(1);
  });
});

describe("with the real fetch", () => {
  // A local server stands in for a public host: the injected fetch sends example.org's requests to
  // it, so the guard is still applied to the address asked, and fetch itself undoes the gzip.
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/robots.txt") return res.writeHead(404).end();
      if (req.url === "/bomb") {
        res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
        return res.end(gzipSync(Buffer.alloc(PAGE_MAX_BYTES + 1024 * 1024, 0x61)));
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.from(PAGE)));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("caps the decoded size of a gzipped body, not its compressed size", async () => {
    const f = new PageFetcher({ spacingMs: 0, fetch: ((input: string, init?: RequestInit) => fetch(String(input).replace("https://gz.example.org", base), init)) as typeof fetch });
    const small = await get(f, "https://gz.example.org/page");
    expect(small).toMatchObject({ ok: true });
    expect(small.ok && new TextDecoder().decode(small.body)).toBe(PAGE);
    expect(await get(f, "https://gz.example.org/bomb")).toMatchObject({ ok: false, reason: "too-large" });
  });
});
