/** server/wikiMock.ts through the real WikiClient: shapes, fixtures, misbehaving titles, and that sanitising beats the hostile page. */
import { parseFragment, type DefaultTreeAdapterTypes as T } from "parse5";
import { describe, expect, it } from "vitest";
import { WikiClient } from "../server/wiki";
import { makeMockWikiFetch, mockWikiFetch } from "../server/wikiMock";

const client = (f: typeof fetch = mockWikiFetch) => new WikiClient({ fetch: f, spacingMs: 0, persist: false, offlineHoldMs: 0 });
const links = (html: string) => [...html.matchAll(/data-wiki="([^"]+)"/g)].map((m) => m[1]);

describe("mock Wikipedia", () => {
  it("serves Fixed-point combinator with its section tree, lead links and no junk", async () => {
    const r = await client().article("Fixed-point combinator", { sections: true });
    if (!r.ok) throw new Error(r.message);
    const a = r.value;
    expect(a.disambiguation).toBe(false);
    expect(links(a.lead)).toEqual(["Lambda calculus", "Haskell Curry", "Recursion (computer science)"]);
    expect(a.sections.map((s) => [s.heading, s.level, s.number, s.parent])).toEqual([
      ["Introduction", 2, "1", 0],
      ["Y combinator", 2, "2", 0],
      ["Verification", 3, "2.1", 2],
      ["Other fixed-point combinators", 2, "3", 0],
      ["Strict fixed-point combinator", 3, "3.1", 4],
      ["Typed fixed-point combinators", 2, "4", 0],
    ]);
    expect(links(a.sections[1].html)).toEqual(["Lambda calculus"]);
    const all = a.lead + a.sections.map((s) => s.html).join("");
    expect(all).not.toMatch(/reference|infobox|navbox|hatnote|cite_note|\[1\]|Related articles|A source\.|style|display:none/);
    expect(all).toContain("<math");
  });

  it("every link in every lead resolves to a fixture", async () => {
    const w = client();
    const titles = ["Fixed-point combinator", "Lambda calculus", "Octopus", "Hoyle state", "Alonzo Church", "Haskell Curry", "Recursion (computer science)", "Cephalopod", "Carbon-12", "Fred Hoyle", "Triple-alpha process"];
    const targets = new Set<string>();
    for (const t of titles) {
      const r = await w.article(t);
      if (!r.ok) throw new Error(`${t}: ${r.message}`);
      for (const l of links(r.value.lead)) targets.add(l);
    }
    const found = await w.lookup([...targets]);
    expect(found.filter((x) => x.status !== "found")).toEqual([]);
  });

  it("follows the redirect, flags the disambiguation page and lists its senses", async () => {
    const w = client();
    const [red, dab] = await w.lookup(["fixed point combinator", "Mercury"]);
    expect(red).toMatchObject({ status: "found", title: "Fixed-point combinator", redirect: true });
    expect(dab).toMatchObject({ status: "found", disambiguation: true });
    expect(await w.summary("Fixed point combinator")).toMatchObject({ ok: true, value: { title: "Fixed-point combinator" } });
    expect(await w.summary("Mercury")).toMatchObject({ ok: true, value: { disambiguation: true } });
    expect(await w.article("Mercury")).toMatchObject({ ok: true, value: { disambiguation: true } });
    const s = await w.senses("Mercury");
    expect(s.ok && s.value.map((x) => x.title)).toEqual(["Mercury (planet)", "Mercury (element)", "Mercury (mythology)", "Freddie Mercury"]);
    expect(s.ok && s.value.every((x) => x.description)).toBe(true);
  });

  it("answers missing titles as missing everywhere", async () => {
    const w = client();
    expect(await w.summary("No such page")).toMatchObject({ ok: false, reason: "missing" });
    expect(await w.article("No such page")).toMatchObject({ ok: false, reason: "missing" });
    expect((await w.lookup(["No such page"]))[0]).toMatchObject({ status: "missing" });
  });

  it("suggests case-insensitively by title or word prefix, and searches with marked excerpts", async () => {
    const w = client();
    const s = await w.suggest("LAMB");
    expect(s.ok && s.value.map((x) => x.title)).toEqual(["Lambda calculus"]);
    const word = await w.suggest("calc");
    expect(word.ok && word.value.map((x) => x.title)).toEqual(["Lambda calculus"]);
    const merc = await w.suggest("mercury");
    expect(merc.ok && merc.value[0].title).toBe("Mercury");
    expect(merc.ok && merc.value.map((x) => x.title)).toContain("Freddie Mercury");
    const q = await w.search("nervous system");
    expect(q.ok && q.value.map((x) => x.title)).toEqual(["Octopus", "Cephalopod"]);
    expect(q.ok && q.value[0].snippetHtml).toMatch(/<mark>nervous<\/mark> <mark>system<\/mark>/);
  });

  it("misbehaves on purpose for the offline and rate-limited titles, without poisoning later calls", async () => {
    const w = client();
    expect(await w.summary("Offline example")).toMatchObject({ ok: false, reason: "offline" });
    expect(await w.summary("Octopus")).toMatchObject({ ok: true });
    expect(await w.article("Rate limited example")).toMatchObject({ ok: false, reason: "rate-limited" });
    expect(await w.suggest("Offline example")).toMatchObject({ ok: false, reason: "offline" });
    expect(await w.suggest("Offline")).toMatchObject({ ok: true });
  });

  it("is slow for the slow article", async () => {
    const w = client(makeMockWikiFetch(60));
    const t = performance.now();
    expect(await w.summary("Slow article")).toMatchObject({ ok: true });
    expect(performance.now() - t).toBeGreaterThanOrEqual(55);
  });

  it("leaves nothing executable or remote in the hostile article", async () => {
    {
      const r = await client().article("Hostile article", { sections: true });
      if (!r.ok) throw new Error(r.message);
      const html = r.value.lead + r.value.sections.map((s) => s.html).join("");
      const allowedAttrs = new Set(["href", "data-wiki", "data-wiki-fragment", "data-wiki-anchor", "rel", "target", "colspan", "rowspan", "start", "display", "width", "height", "stretchy"]);
      const seen: string[] = [];
      const walk = (nodes: T.ChildNode[]) => {
        for (const n of nodes) {
          if (!("tagName" in n)) continue;
          seen.push(n.tagName);
          for (const a of n.attrs) {
            expect(allowedAttrs.has(a.name), `${n.tagName} ${a.name}`).toBe(true);
            if (a.name === "href") expect(a.value).toMatch(/^https:\/\//);
            if (a.name === "href" && !a.value.startsWith("https://en.wikipedia.org/")) {
              expect(n.attrs.find((x) => x.name === "target")?.value).toBe("_blank");
              expect(n.attrs.find((x) => x.name === "rel")?.value).toContain("noopener");
            }
          }
          walk(n.childNodes);
        }
      };
      walk(parseFragment(html).childNodes);
      for (const bad of ["script", "style", "link", "meta", "base", "iframe", "svg", "form", "input", "button", "object", "embed", "video", "audio", "source", "picture", "img", "template", "noscript", "div", "span"]) {
        expect(seen, bad).not.toContain(bad);
      }
      expect(html).not.toMatch(/on\w+=|srcset|evil\.example\/(?!page|protocol-relative)/i);
      expect(links(html)).toContain("Octopus");
      expect(html).toContain("&lt;script&gt;"); // escaped text stays text
    }
    // Headings are plain text, never HTML: the UI must escape them.
    const a = await client().article("Hostile article");
    expect(a.ok && a.value.sections[0].heading).toBe(`Attacks <img src=x onerror="window.__pwned=9">`);
  });
});
