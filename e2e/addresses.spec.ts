/**
 * A bare address typed into a node's text becomes a titled link once the edit is finished
 * (src/core/bareLinks.ts, Store.typedAddresses), against the mock web (EX_PAGES=mock) and the mock
 * model: linked as typed, then the page's title in place of the address; u brings the address back,
 * still linked, and it is not converted again; a page that cannot be read leaves the address linked
 * as typed and the status line says why; a Wikipedia address becomes a link to the article; a
 * section whose whole text is an address becomes a section that is only the link; several in one
 * edit all convert, at most five pages read; a page with no headings is arranged in the background,
 * so opening it later is immediate. The browser's own requests elsewhere are refused.
 */
import { expect, test, type Page } from "@playwright/test";
import { WEB, addTop, keys, pageCalls, settle, state, visit } from "./helpers";

const status = (page: Page) => page.locator(".status .message");
const body = (page: Page) => state(page, (s) => s.snap.nodes[s.focus.node].body as string);
/** The links on the focused node's text: their words and targets. */
const linksHere = (page: Page) =>
  state(page, (s) =>
    s.snap.nodes[s.focus.node].children
      .map((c: string) => s.snap.nodes[c])
      .filter((n: any) => n.kind === "note" && n.ref)
      .map((n: any) => ({ words: n.anchors[0]?.text, ref: n.ref })),
  );

test.beforeEach(async ({ context }) => {
  await context.route((u) => /(^|\.)(wikipedia\.org|wikimedia\.org|example\.(org|com|net))$/.test(u.hostname), (r) => r.abort());
});

test.afterEach(({ page }) => settle(page));

test("an address typed into the text is linked, then titled from its page; u brings the address back, linked, and it is not converted again", async ({ page }) => {
  await addTop(page, "Reading the trace", `Start with ${WEB.tracing}, then the rest.`);
  await expect.poll(() => body(page)).toBe("Start with Following one request through the stack, then the rest.");
  expect(await linksHere(page)).toEqual([{ words: "Following one request through the stack", ref: { kind: "url", url: WEB.tracing, title: "Following one request through the stack" } }]);
  await expect(status(page)).toContainText("Linked as “Following one request through the stack”, the page's title. u brings the address back.");
  // Two commits of their own, after the edit: the link as typed, then the title (newest first).
  const history: string[] = await state(page, (s) => s.commits().slice(0, 8).map((c: any) => c.message));
  const titled = history.findIndex((m) => /^Title the link “https:\/\/tracing\.example\.org.*”: “Following one request through the stack”$/.test(m));
  const linked = history.findIndex((m) => /^Link “https:\/\/tracing\.example\.org.*” to Following one request|^Link “https:\/\/tracing\.example\.org/.test(m));
  expect(titled).toBeGreaterThanOrEqual(0);
  expect(linked).toBeGreaterThan(titled);

  await keys(page, "u");
  await expect.poll(() => body(page)).toBe(`Start with ${WEB.tracing}, then the rest.`);
  expect(await linksHere(page)).toEqual([{ words: WEB.tracing, ref: { kind: "url", url: WEB.tracing } }]);
  // Edited again, the address is not new: it stays as it is.
  await keys(page, "c End");
  await page.keyboard.type(" More.");
  await page.keyboard.press("Escape");
  await expect.poll(() => body(page)).toBe(`Start with ${WEB.tracing}, then the rest. More.`);
  await page.waitForTimeout(300);
  expect(await body(page)).toBe(`Start with ${WEB.tracing}, then the rest. More.`);
  expect(await linksHere(page)).toEqual([{ words: WEB.tracing, ref: { kind: "url", url: WEB.tracing } }]);
});

test("a page that cannot be read leaves its address as typed, linked, and the status line says why", async ({ page }) => {
  await addTop(page, "Tides asked", `The answer is at ${WEB.robots}.`);
  await expect(status(page)).toContainText(`No title for ${WEB.robots}: qa.example.com asks programs like this one not to read this page (robots.txt).`);
  await expect(status(page)).toContainText("The address stays as typed, linked.");
  expect(await body(page)).toBe(`The answer is at ${WEB.robots}.`);
  expect(await linksHere(page)).toEqual([{ words: WEB.robots, ref: { kind: "url", url: WEB.robots } }]);
});

test("a Wikipedia article's address becomes a link to the article, titled with its title", async ({ page }) => {
  await addTop(page, "Eight arms", "Read https://en.wikipedia.org/wiki/Octopus first. Not `https://code.example.org/x` though.");
  await expect.poll(() => body(page)).toBe("Read Octopus first. Not `https://code.example.org/x` though.");
  expect(await linksHere(page)).toEqual([{ words: "Octopus", ref: { kind: "wiki", title: "Octopus", lang: "en" } }]);
});

test("several addresses in one edit all convert, at most five pages read; one with no headings is arranged in the background, so opening it is immediate", async ({ page }) => {
  const calls = pageCalls();
  const urls = [WEB.essay, WEB.letters, WEB.rules, WEB.phare, WEB.figures, WEB.videos];
  await addTop(page, "Six addresses", urls.join(" and "));
  await expect.poll(() => body(page)).not.toContain(WEB.figures);
  await expect.poll(() => body(page)).not.toMatch(new RegExp(urls.slice(0, 5).map((u) => u.replace(/[.?/]/g, "\\$&")).join("|")));
  const titles = await Promise.all(urls.slice(0, 5).map((u) => titleOf(page, u)));
  expect(titles.slice(0, 3)).toEqual(["A Hundred Small Maps", "On maps", "Twelve rules for a small team – Notes on Software"]);
  expect(await body(page)).toBe([...titles, WEB.videos].join(" and "));
  expect((await linksHere(page)).map((l: any) => l.ref.url)).toEqual(urls);
  expect(await state(page, (s) => s.log.map((l: any) => l.text))).toContain("Linked 6 addresses; reading the page titles… 1 more is linked as typed, without reading its page (at most 5 are read from one edit).");
  // The essay has no headings: the server arranged it by itself, with no pane open on it.
  await expect.poll(pageCalls).toBe(calls + 1);
  const opened = await (await page.request.get(`/api/page/article?url=${encodeURIComponent(WEB.essay)}`)).json();
  expect(opened).toMatchObject({ cached: true, article: { outline: "model" } });
});

test("a section whose whole text is an address becomes a section that is only the link, named after its page", async ({ page }) => {
  const root = (await (await page.request.get("/api/tree")).json()).root as string;
  const made = await page.request.post("/api/ops", { data: { author: "tester", message: "Add a holder", ops: [{ op: "create", parent: root, title: "Address holder", body: "" }, { op: "create", parent: "$0", title: "", body: "" }] } });
  expect(made.ok()).toBe(true);
  const tree = await (await page.request.get("/api/tree")).json();
  const holder = Object.values(tree.nodes as Record<string, { title: string; children: string[] }>).find((n) => n.title === "Address holder")!;
  const id = holder.children[0];
  await visit(page, `/n/${encodeURIComponent(id)}`);
  await page.waitForFunction(() => (globalThis as any).__ie?.ready);
  await page.evaluate((i) => (globalThis as any).__ie.setFocus({ node: i, grain: "node" }), id);
  await keys(page, "c");
  await page.keyboard.type(WEB.letters);
  await page.keyboard.press("Escape");
  await expect.poll(() => state(page, (s) => s.snap.nodes[s.focus.node].title)).toBe("On maps");
  const n = await state(page, (s) => s.snap.nodes[s.focus.node]);
  expect(n.id).toBe(id);
  expect(n.body).toBe("");
  expect(n.ref).toEqual({ kind: "url", url: WEB.letters, title: "On maps" });
  expect(await state(page, (s) => s.linkOnly(s.focus.node))).toBe(true);
});

/** A page's title as the server keeps it. */
async function titleOf(page: Page, url: string): Promise<string> {
  return (await (await page.request.get(`/api/page/summary?url=${encodeURIComponent(url)}&cached=1`)).json()).summary.title;
}
