/**
 * Forks in the panes view: a modified open (Shift+Enter, Shift-, Ctrl- or middle-click) opens its
 * pane beside what is to the right instead of replacing it, and the space right of the pane
 * divides into rows, one per fork. Same build, mock model, mock Wikipedia and shared library as
 * the other specs; the documents are hoisted to (z) as in panes.spec.ts.
 */
import { expect, test, type Page } from "@playwright/test";
import { focusedTitle, jump, keys, seedLinks, selected, settle, state } from "./helpers";

/** The tree of panes by title, the picked child starred: [title, [children]] or a leaf's title. */
const tree = (page: Page) =>
  state(page, (s) => {
    const name = (p: any) => (p.kind === "node" ? s.snap.nodes[p.id]?.title || s.snap.nodes[p.id]?.anchors[0]?.text : `W:${p.title}${p.sec ? `#${p.sec}` : ""}`);
    const go = (n: any): unknown => (n.kids.length ? [name(n.ref), n.kids.map((k: any, j: number) => (j === n.pick ? ["*", go(k)] : go(k)))] : name(n.ref));
    return go(s.tree);
  });
/** The focused branch, by title. */
const trail = (page: Page) => state(page, (s) => s.trail.map((p: any) => (p.kind === "node" ? s.snap.nodes[p.id]?.title || s.snap.nodes[p.id]?.anchors[0]?.text : `W:${p.title}${p.sec ? `#${p.sec}` : ""}`)));
/** The rows right of the first pane with forks, each as the titles of its panes, left to right. */
const forkRows = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".strip .forks")][0]
      ? [...document.querySelector(".strip .forks")!.children].map((row) =>
          [...row.querySelectorAll(".pane")].map((p) => p.querySelector(".wiki-head h2, .pane-head h2, .top h1")?.textContent?.trim() ?? ""),
        )
      : [],
  );
/** A section's child sections, by title. */
const childTitles = (page: Page, title: string) =>
  page.evaluate((t) => {
    const s = (globalThis as any).__ie;
    const n = (Object.values(s.snap.nodes) as any[]).find((x) => x.title === t);
    return n.children.filter((c: string) => s.snap.nodes[c].kind === "section").map((c: string) => s.snap.nodes[c].title) as string[];
  }, title);

async function open(page: Page) {
  await page.goto("/doc/infinite-expand");
  await page.waitForSelector(".strip > .pane");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator(".strip > .pane")).toHaveCount(2);
  await page.keyboard.press("z");
  await expect(page.locator(".strip > .pane")).toHaveCount(1);
}

/** Tab through the focused text's marked spans until the selection is these words. */
async function tabTo(page: Page, words: string) {
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    if ((await state(page, (s) => s.selectedText())) === words) return;
  }
  throw new Error(`Tab never reached “${words}”`);
}

/** Whether an element's box is inside the strip's visible box. */
const inView = (page: Page, sel: string) =>
  page.evaluate((sel) => {
    const strip = document.querySelector<HTMLElement>(".strip")!.getBoundingClientRect();
    const r = document.querySelector(sel)!.getBoundingClientRect();
    return r.top >= strip.top - 1 && r.bottom <= strip.bottom + 1;
  }, sel);

test.use({ viewport: { width: 1920, height: 1080 } });
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  await seedLinks(request);
});
test.beforeEach(async ({ context }) => {
  await context.route(/wikipedia\.org|wikimedia\.org|stanford\.edu|example\.org/, (r) => r.abort());
});
test.afterEach(({ page }) => settle(page));

test("Shift+Enter on a section row opens a fork beside the pane to the right; Enter still replaces, and focuses a fork already open", async ({ page }) => {
  await open(page);
  await keys(page, "l l l"); // Expansion by depth showing; the focus on its first row
  // Nothing to the right yet: a fork is a plain open, and a plain trail is drawn as before.
  await keys(page, "Shift+Enter");
  expect(await tree(page)).toEqual(["Infinispand", [["*", ["Expansion by depth", [["*", "Levels of a node"]]]]]]);
  await expect(page.locator(".strip:not(.forked) > .pane")).toHaveCount(3);
  await expect(page.locator(".forks")).toHaveCount(0);
  await keys(page, "j Shift+Enter");
  expect(await forkRows(page)).toEqual([["Levels of a node"], ["Pre-generated depth"]]);
  expect(await trail(page)).toEqual(["Infinispand", "Expansion by depth", "Pre-generated depth"]);
  // The rows divide the height; both start in the column next to the pane they came from.
  const [a, b, parent] = await Promise.all([
    page.locator(".forks > .fork").nth(0).locator(".pane").boundingBox(),
    page.locator(".forks > .fork").nth(1).locator(".pane").boundingBox(),
    page.locator('.pane[data-pane-index="1"]').boundingBox(),
  ]);
  expect(a!.x).toBeCloseTo(b!.x, 0);
  expect(b!.y).toBeGreaterThanOrEqual(a!.y + a!.height - 1);
  expect(a!.x).toBeGreaterThan(parent!.x);
  expect(a!.height).toBeGreaterThan(300);
  // The pane they came from marks both, the focused one as before and the other lightly.
  await expect(page.locator('.pane[data-pane-index="1"] .node.showing > .row')).toHaveText([/Pre-generated depth/]);
  await expect(page.locator('.pane[data-pane-index="1"] .node.forked > .row')).toHaveText([/Levels of a node/]);
  // A plain Enter replaces only the focused fork.
  await keys(page, "j Enter");
  expect(await forkRows(page)).toEqual([["Levels of a node"], ["Generation on demand"]]);
  // Enter (or Shift+Enter) on the row of a fork already open focuses that fork: no second copy.
  await keys(page, "k k Enter");
  expect(await forkRows(page)).toEqual([["Levels of a node"], ["Generation on demand"]]);
  expect(await trail(page)).toEqual(["Infinispand", "Expansion by depth", "Levels of a node"]);
  await keys(page, "j j Shift+Enter");
  expect(await forkRows(page)).toEqual([["Levels of a node"], ["Generation on demand"]]);
  expect(await trail(page)).toEqual(["Infinispand", "Expansion by depth", "Generation on demand"]);
});

test("Shift-, Ctrl- and middle-click fork from section rows; a click in another fork makes it the focused one", async ({ page }) => {
  await open(page);
  const kids = await childTitles(page, "Borrowed from Gwern");
  expect(kids.length).toBeGreaterThanOrEqual(3);
  const row = (t: string) => page.locator(".pane .row", { hasText: t }).first();
  await row("Borrowed from Gwern").click();
  await row(kids[0]).click({ modifiers: ["Shift"] }); // nothing right of it yet: a plain open
  expect(await trail(page)).toEqual(["Infinispand", "Borrowed from Gwern", kids[0]]);
  await row(kids[1]).click({ modifiers: ["Control"] });
  expect(await tree(page)).toEqual(["Infinispand", [["*", ["Borrowed from Gwern", [kids[0], ["*", kids[1]]]]]]]);
  await row(kids[2]).click({ button: "middle" });
  expect(await tree(page)).toEqual(["Infinispand", [["*", ["Borrowed from Gwern", [kids[0], kids[1], ["*", kids[2]]]]]]]);
  // A Shift-click selected no text on the way.
  expect(await page.evaluate(() => window.getSelection()?.isCollapsed ?? true)).toBe(true);
  // A click anywhere in the first fork's pane focuses that fork.
  await page.locator(".forks > .fork").nth(0).locator(".pane-head").click();
  expect(await trail(page)).toEqual(["Infinispand", "Borrowed from Gwern", kids[0]]);
  expect(await focusedTitle(page)).toBe(kids[0]);
  await expect(page.locator(".forks > .fork.on")).toHaveCount(1);
  expect(await page.locator(".forks > .fork").nth(0).getAttribute("class")).toContain("on");
  // A plain click on a row replaces the focused fork, and a Shift-click on the focused row whose pane shows does not close it.
  await row("Display forms").click({ modifiers: ["Shift"] }); // the first pane forks too: a stack right of it
  await expect(page.locator(".strip > .forks > .fork")).toHaveCount(2);
  await expect(page.locator(".strip > .forks > .fork").nth(0).locator(".forks > .fork")).toHaveCount(3);
  await row("Display forms").click({ modifiers: ["Shift"] });
  await expect(page.locator(".strip > .forks > .fork")).toHaveCount(2);
  await row("Editing and regeneration").click();
  expect(await trail(page)).toEqual(["Infinispand", "Editing and regeneration"]);
  await expect(page.locator(".strip > .forks > .fork").nth(1).locator(".pane-head h2")).toHaveText("Editing and regeneration");
});

test("from a Wikipedia link, a node link and a link inside an article: forks, each marked where it was opened", async ({ page }) => {
  await page.goto("/doc/fixed-points");
  await page.waitForSelector(".strip > .pane");
  await page.evaluate(() => document.fonts.ready);
  await jump(page, "Recursion without names");
  await tabTo(page, "fixed-point combinator");
  await keys(page, "Enter");
  await expect(page.locator(".wiki-pane .wiki-head h2")).toHaveText("Fixed-point combinator");
  await keys(page, "h"); // back to the words
  expect(await selected(page)).toBe("fixed-point combinator");
  await tabTo(page, "Y combinator");
  await keys(page, "Shift+Enter");
  expect(await forkRows(page)).toEqual([["Fixed-point combinator"], ["How Y works"]]);
  // In the text it came from, both links are marked, the focused fork's more strongly.
  const from = page.locator('.pane[data-pane-index="2"]');
  await expect(from.locator(".lnk.forked.picked")).toHaveText("Y combinator");
  await expect(from.locator(".lnk.forked:not(.picked)")).toHaveText("fixed-point combinator");
  // [ goes up to the article's row; its sections open as rows, as before.
  await keys(page, "[");
  expect(await trail(page)).toEqual(["Library", "Fixed points", "Recursion without names", "W:Fixed-point combinator"]);
  expect(await state(page, (s) => s.aux)).toMatchObject({ kind: "wiki", host: "p3", row: { t: "head" } });
  await expect(from.locator(".lnk.forked.picked")).toHaveText("fixed-point combinator");
  await expect(page.locator(".wiki-pane .wrow").first()).toBeVisible();
  await keys(page, "j j l");
  expect((await trail(page)).at(-1)).toBe("W:Fixed-point combinator#2");
  // A Shift-click on a link in the article's text forks beside that section.
  const art = page.locator(".forks > .fork").nth(0).locator(".wiki-pane").first();
  await art.locator('.wiki-text a[data-wiki="Haskell Curry"]').click({ modifiers: ["Shift"] });
  const article = ["W:Fixed-point combinator", ["W:Fixed-point combinator#2", ["*", "W:Haskell Curry"]]];
  const recursion = ["Recursion without names", [["*", article], "How Y works"]];
  expect(await tree(page)).toEqual(["Library", [["*", ["Fixed points", [["*", recursion]]]]]]);
  await expect(art.locator(".wrow.forked > .row .title")).toHaveText("Y combinator");
  await expect(art.locator('.wiki-text a.forked.picked[data-wiki="Haskell Curry"]')).toHaveCount(1);
  // And Shift+Enter on a link selected by Tab in the article's text: a third fork of the article.
  await keys(page, "h");
  for (let i = 0; i < 6 && (await state(page, (s) => s.aux?.host)) !== "p3"; i++) await keys(page, "h");
  await keys(page, "k k k");
  await tabTo(page, "lambda calculus");
  await keys(page, "Shift+Enter");
  await expect(page.locator(".wiki-pane .wiki-head h2", { hasText: "Lambda calculus" })).toHaveCount(1);
  expect(await trail(page)).toEqual(["Library", "Fixed points", "Recursion without names", "W:Fixed-point combinator", "W:Lambda calculus"]);
  const stack = page.locator(".forks > .fork").nth(0).locator(".forks > .fork");
  await expect(stack).toHaveCount(3);
});

test("three forks of one pane, one forked again: [ and ] move between them, q closes a fork, and the last but one leaves a plain trail", async ({ page }) => {
  await open(page);
  await keys(page, "l l l Shift+Enter j Shift+Enter j Shift+Enter");
  await keys(page, "l Shift+Enter j Shift+Enter"); // into Generation on demand, and fork from it too
  expect(await tree(page)).toEqual([
    "Infinispand",
    [["*", ["Expansion by depth", ["Levels of a node", "Pre-generated depth", ["*", ["Generation on demand", ["Deepening a leaf", ["*", "Expanding a selection"]]]]]]]],
  ]);
  await expect(page.locator(".strip > .forks > .fork")).toHaveCount(3);
  await expect(page.locator(".strip > .forks > .fork").nth(2).locator(".forks > .fork")).toHaveCount(2);
  await keys(page, "]");
  await expect(page.locator(".status .message")).toContainText("No fork below");
  // Up, row by row, in the order they are drawn: the nearest fork first.
  await keys(page, "[");
  expect((await trail(page)).at(-1)).toBe("Deepening a leaf");
  expect(await focusedTitle(page)).toBe("Deepening a leaf");
  await keys(page, "[");
  expect(await trail(page)).toEqual(["Infinispand", "Expansion by depth", "Pre-generated depth"]);
  expect(await focusedTitle(page)).toBe("Pre-generated depth");
  await keys(page, "[");
  expect(await trail(page)).toEqual(["Infinispand", "Expansion by depth", "Levels of a node"]);
  await keys(page, "[");
  await expect(page.locator(".status .message")).toContainText("No fork above");
  // Down again; back in a fork, the focus is where it was left.
  await keys(page, "] ]");
  expect(await trail(page)).toEqual(["Infinispand", "Expansion by depth", "Generation on demand", "Deepening a leaf"]);
  expect(await focusedTitle(page)).toBe("Deepening a leaf");
  // q at the end of a fork closes that fork; the other stays, as a plain trail.
  await keys(page, "q");
  expect(await tree(page)).toEqual([
    "Infinispand",
    [["*", ["Expansion by depth", ["Levels of a node", "Pre-generated depth", ["*", ["Generation on demand", [["*", "Expanding a selection"]]]]]]]],
  ]);
  // In a fork with panes right of the one being read, q closes those, as it always has.
  await keys(page, "h");
  expect(await focusedTitle(page)).toBe("Generation on demand");
  await keys(page, "q");
  expect(await trail(page)).toEqual(["Infinispand", "Expansion by depth", "Generation on demand"]);
  // With nothing right of it, the whole fork.
  await keys(page, "q");
  expect(await tree(page)).toEqual(["Infinispand", [["*", ["Expansion by depth", ["Levels of a node", ["*", "Pre-generated depth"]]]]]]);
  await keys(page, "[ q");
  expect(await tree(page)).toEqual(["Infinispand", [["*", ["Expansion by depth", [["*", "Pre-generated depth"]]]]]]);
  await expect(page.locator(".forks")).toHaveCount(0);
  await expect(page.locator(".strip:not(.forked) > .pane")).toHaveCount(3);
  await keys(page, "]");
  await expect(page.locator(".status .message")).toContainText("No forks open");
});

test("many forks: the rows scroll down with the focused one in view; a reload brings the tree back", async ({ page }) => {
  await open(page);
  await keys(page, "j Shift+Enter");
  for (let i = 0; i < 5; i++) await keys(page, "j Shift+Enter");
  await expect(page.locator(".strip > .forks > .fork")).toHaveCount(6);
  const strip = page.locator(".strip");
  expect(await strip.evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);
  // Each row is a third of the strip's height; the last, focused, is in view, and the first pane stays at the top.
  const h = await strip.evaluate((el) => el.clientHeight);
  const rowH = (await page.locator(".forks > .fork").nth(2).boundingBox())!.height;
  expect(Math.abs(rowH - Math.floor(h / 3))).toBeLessThanOrEqual(2);
  await expect.poll(() => inView(page, ".forks > .fork.on")).toBe(true);
  await expect.poll(() => strip.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  const first = await page.locator(".strip > .pane").first().boundingBox();
  const sbox = (await strip.boundingBox())!;
  expect(Math.abs(first!.y - sbox.y)).toBeLessThanOrEqual(1);
  // Up to the first fork: the strip scrolls back.
  await keys(page, "[ [ [ [ [");
  await expect.poll(() => inView(page, ".forks > .fork.on")).toBe(true);
  await expect.poll(() => strip.evaluate((el) => el.scrollTop)).toBeLessThan(5);
  const before = await tree(page);
  const was = await trail(page);
  await page.reload();
  await page.waitForSelector(".strip > .pane");
  expect(await tree(page)).toEqual(before);
  expect(await trail(page)).toEqual(was);
  await expect(page.locator(".strip > .forks > .fork")).toHaveCount(6);
});

test("a fork whose node is deleted closes, and the others stay", async ({ page, request }) => {
  // A section of its own to delete, written as another writer would.
  const tree0 = await (await request.get("/api/tree")).json();
  const depth = Object.values(tree0.nodes as Record<string, { id: string; title: string }>).find((n) => n.title === "Expansion by depth")!.id;
  const made = await request.post("/api/ops", { data: { author: "another", message: "Add a section", ops: [{ op: "create", parent: depth, title: "A section to delete", body: "Soon gone." }] } });
  expect(made.ok()).toBe(true);
  await open(page);
  await keys(page, "l l l Shift+Enter");
  const kids = await childTitles(page, "Expansion by depth");
  for (let i = 1; i < kids.indexOf("A section to delete"); i++) await keys(page, "j");
  await keys(page, "j Shift+Enter");
  expect(await forkRows(page)).toEqual([["Levels of a node"], ["A section to delete"]]);
  await keys(page, "[");
  const id = await state(page, (s) => (Object.values(s.snap.nodes) as any[]).find((n) => n.title === "A section to delete").id);
  const res = await request.post("/api/ops", { data: { author: "another", message: "Delete it", ops: [{ op: "delete", id }] } });
  expect(res.ok()).toBe(true);
  // The fork that was not focused goes; the focused one stays, now a plain trail.
  await expect.poll(() => page.locator(".forks").count()).toBe(0);
  expect(await trail(page)).toEqual(["Infinispand", "Expansion by depth", "Levels of a node"]);
});

test("a window too short for rows shows only the focused branch, and says which fork it is and how to switch", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 480 });
  await open(page);
  await keys(page, "l l l Shift+Enter j Shift+Enter");
  await expect(page.locator(".forks")).toHaveCount(0);
  await expect(page.locator(".strip > .pane")).toHaveCount(3);
  await expect(page.locator(".fork-note")).toContainText("fork 2 of 2");
  await keys(page, "[");
  await expect(page.locator(".fork-note")).toContainText("fork 1 of 2");
  expect((await trail(page)).at(-1)).toBe("Levels of a node");
  // With room again, the rows come back.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect(page.locator(".strip > .forks > .fork")).toHaveCount(2);
  await expect(page.locator(".fork-note")).toHaveCount(0);
});

test("in the column a modified open is a plain open, and the status line says why once", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/doc/fixed-points");
  await page.waitForFunction(() => (globalThis as any).__ie?.ready);
  await jump(page, "Recursion without names");
  await keys(page, "Shift+Enter");
  await expect(page.locator(".status .message")).toContainText("panes view");
  await keys(page, "Shift+Enter Shift+Enter");
  expect(await state(page, (s) => s.log.filter((l: any) => l.text.includes("panes view")).length)).toBe(1);
  await keys(page, "[");
  await expect(page.locator(".status .message")).toContainText("panes view");
});
