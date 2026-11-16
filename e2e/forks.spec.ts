/**
 * Forks in the panes view, laid out by column: a modified open (Shift+Enter, Shift-, Ctrl- or
 * middle-click) opens its pane below what is in the next column instead of replacing it; column d
 * holds every pane at depth d and divides its own height among them, folding all but one into tabs
 * when they do not fit. Curves run from where each pane was opened to its title; panes close (q, ×)
 * and pin (P, pin). Same build, mock model, mock Wikipedia and shared library as the other specs;
 * the documents are hoisted to (z) as in panes.spec.ts.
 */
import { expect, test, type Page } from "@playwright/test";
import { focusedTitle, jump, keys, seedLinks, selected, settle, state } from "./helpers";

/** The first tree of panes by title, the picked child starred: [title, [children]] or a leaf's title. */
const tree = (page: Page) =>
  state(page, (s) => {
    const name = (p: any) => (p.kind === "node" ? s.snap.nodes[p.id]?.title || s.snap.nodes[p.id]?.anchors[0]?.text : `W:${p.title}${p.sec ? `#${p.sec}` : ""}`);
    const go = (n: any): unknown => (n.kids.length ? [name(n.ref), n.kids.map((k: any, j: number) => (j === n.pick ? ["*", go(k)] : go(k)))] : name(n.ref));
    return go(s.forest.trees[0]);
  });
/** The focused branch, by title. */
const trail = (page: Page) => state(page, (s) => s.trail.map((p: any) => (p.kind === "node" ? s.snap.nodes[p.id]?.title || s.snap.nodes[p.id]?.anchors[0]?.text : `W:${p.title}${p.sec ? `#${p.sec}` : ""}`)));
/** The columns on screen, left to right, each as its panes' titles top to bottom. */
const columns = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".strip > .col")].map((c) =>
      [...c.querySelectorAll(":scope > .pane")].map((p) => p.querySelector(".wiki-head h2, .pane-head h2, .top h1")?.textContent?.trim() ?? ""),
    ),
  );
/** A pane by its title. */
const pane = (page: Page, title: string) => page.locator(".strip .pane", { has: page.locator(`:is(.wiki-head h2, .pane-head h2, .top h1):text-is("${title}")`) }).first();
/** Each pane's box, by title. */
const boxes = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>(".strip .pane")].map((p) => {
        const r = p.getBoundingClientRect();
        return [p.querySelector(".wiki-head h2, .pane-head h2, .top h1")?.textContent?.trim() ?? "", { x: r.x, y: r.y, w: r.width, h: r.height, tab: p.hasAttribute("data-tab") }];
      }),
    ),
  );
/** A section's child sections, by title. */
const childTitles = (page: Page, title: string) =>
  page.evaluate((t) => {
    const s = (globalThis as any).__ie;
    const n = (Object.values(s.snap.nodes) as any[]).find((x) => x.title === t);
    return n.children.filter((c: string) => s.snap.nodes[c].kind === "section").map((c: string) => s.snap.nodes[c].title) as string[];
  }, title);
/** The curves drawn: from which pane to which (ids in the forest), their classes, and their ends on screen. */
const curves = (page: Page) =>
  page.evaluate(() => {
    const svg = document.querySelector<SVGSVGElement>(".curves")!;
    const box = svg.getBoundingClientRect();
    return [...svg.querySelectorAll("path")].map((p) => {
      const a = p.getPointAtLength(0);
      const b = p.getPointAtLength(p.getTotalLength());
      return { from: Number(p.dataset.from), to: Number(p.dataset.to), cls: p.getAttribute("class") ?? "", a: { x: a.x + box.x, y: a.y + box.y }, b: { x: b.x + box.x, y: b.y + box.y } };
    });
  });
const tid = (page: Page, title: string) => pane(page, title).evaluate((el) => Number((el as HTMLElement).dataset.tid));
const nextFrames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
/** Wait until the strip has stopped scrolling sideways (it scrolls smoothly to follow the focus), and the curves have been drawn after. */
async function still(page: Page) {
  await page.waitForFunction(
    () =>
      new Promise((r) => {
        const el = document.querySelector(".strip")!;
        const x = el.scrollLeft;
        setTimeout(() => r(el.scrollLeft === x), 300);
      }),
  );
  await nextFrames(page);
}

async function open(page: Page) {
  await page.goto("/doc/infinite-expand");
  await page.waitForSelector(".strip .pane");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator(".strip .pane")).toHaveCount(2);
  await page.keyboard.press("z");
  await expect(page.locator(".strip .pane")).toHaveCount(1);
}

/** Tab through the focused text's marked spans until the selection is these words. */
async function tabTo(page: Page, words: string) {
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    if ((await state(page, (s) => s.selectedText())) === words) return;
  }
  throw new Error(`Tab never reached “${words}”`);
}

/** The owner's screenshot: Two kinds of cell, with Eukaryote (opened from its link), Simple cells and Complex cells beside each other in the next column, and Bacteria opened from Eukaryote's text. */
async function cells(page: Page) {
  await page.goto("/doc/the-eukaryotic-cell");
  await page.waitForSelector(".strip .pane");
  await page.evaluate(() => document.fonts.ready);
  await jump(page, "Two kinds of cell");
  await keys(page, "Enter");
  await tabTo(page, "Eukaryotes");
  await keys(page, "Enter");
  await expect(pane(page, "Eukaryote").locator(".wiki-text a[data-wiki]").first()).toBeVisible();
  await pane(page, "Eukaryote").locator('.wiki-text a[data-wiki="Bacteria"]').first().click();
  await expect(pane(page, "Bacteria").locator(".wiki-text").first()).toBeVisible();
  await page.locator(".pane .row", { hasText: "Simple cells" }).first().click({ modifiers: ["Shift"] });
  await page.locator(".pane .row", { hasText: "Complex cells" }).first().click({ modifiers: ["Shift"] });
  await expect.poll(() => columns(page)).toEqual([["Library"], ["The one merger"], ["Two kinds of cell"], ["Eukaryote", "Simple cells", "Complex cells"], ["Bacteria"]]);
  await still(page);
}

test.use({ viewport: { width: 1920, height: 1080 } });
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  await seedLinks(request);
});
test.beforeEach(async ({ context }) => {
  await context.route(/wikipedia\.org|wikimedia\.org|stanford\.edu|example\.org/, (r) => r.abort());
});
test.afterEach(({ page }) => settle(page));

test("Shift+Enter on a section row opens a fork below in the next column; Enter still replaces, and focuses a fork already open", async ({ page }) => {
  await open(page);
  await keys(page, "l l l"); // Expansion by depth showing; the focus on its first row
  // Nothing to the right yet: a fork is a plain open, and a plain trail is one pane per column.
  await keys(page, "Shift+Enter");
  expect(await tree(page)).toEqual(["Infinispand", [["*", ["Expansion by depth", [["*", "Levels of a node"]]]]]]);
  expect(await columns(page)).toEqual([["Infinispand"], ["Expansion by depth"], ["Levels of a node"]]);
  await keys(page, "j Shift+Enter");
  expect(await columns(page)).toEqual([["Infinispand"], ["Expansion by depth"], ["Levels of a node", "Pre-generated depth"]]);
  expect(await trail(page)).toEqual(["Infinispand", "Expansion by depth", "Pre-generated depth"]);
  // They share the column's height, one above the other, beside the pane they came from.
  const b = await boxes(page);
  const [a, c, parent] = [b["Levels of a node"], b["Pre-generated depth"], b["Expansion by depth"]];
  expect(a.x).toBeCloseTo(c.x, 0);
  expect(c.y).toBeCloseTo(a.y + a.h, 0);
  expect(a.x).toBeGreaterThan(parent.x);
  const strip = await page.locator(".strip").evaluate((el) => el.clientHeight);
  expect(Math.abs(a.h + c.h - strip)).toBeLessThan(2);
  // The pane they came from marks both, the focused one as before and the other lightly.
  await expect(pane(page, "Expansion by depth").locator(".node.showing > .row")).toHaveText([/Pre-generated depth/]);
  await expect(pane(page, "Expansion by depth").locator(".node.forked > .row")).toHaveText([/Levels of a node/]);
  // A plain Enter replaces only the focused fork.
  await keys(page, "j Enter");
  expect(await columns(page)).toEqual([["Infinispand"], ["Expansion by depth"], ["Levels of a node", "Generation on demand"]]);
  // Enter (or Shift+Enter) on the row of a fork already open focuses that fork: no second copy.
  await keys(page, "k k Enter");
  expect(await columns(page)).toEqual([["Infinispand"], ["Expansion by depth"], ["Levels of a node", "Generation on demand"]]);
  expect(await trail(page)).toEqual(["Infinispand", "Expansion by depth", "Levels of a node"]);
  await keys(page, "j j Shift+Enter");
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
  // A click on the first fork's heading focuses that fork, and makes that pane the active one.
  await pane(page, kids[0]).locator(".pane-head").click();
  expect(await trail(page)).toEqual(["Infinispand", "Borrowed from Gwern", kids[0]]);
  expect(await focusedTitle(page)).toBe(kids[0]);
  await expect(page.locator(".pane.active .pane-head h2")).toHaveText(kids[0]);
  // The first pane forks too: its forks share the next column, and the panes opened from each the one after.
  await row("Display forms").click({ modifiers: ["Shift"] });
  expect(await columns(page)).toEqual([["Infinispand"], ["Borrowed from Gwern", "Display forms"], kids.slice(0, 3)]);
  await row("Display forms").click({ modifiers: ["Shift"] });
  expect((await columns(page))[1]).toEqual(["Borrowed from Gwern", "Display forms"]);
  await row("Editing and regeneration").click();
  expect(await trail(page)).toEqual(["Infinispand", "Editing and regeneration"]);
  expect((await columns(page))[1]).toEqual(["Borrowed from Gwern", "Editing and regeneration"]);
});

test("the owner's screenshot: the lone pane in the next column fills its height; the shared column gives short panes what they need", async ({ page }) => {
  await cells(page);
  const b = await boxes(page);
  const strip = await page.locator(".strip").evaluate((el) => el.clientHeight);
  // Bacteria, alone in its column, is as tall as the strip.
  expect(Math.abs(b["Bacteria"].h - strip)).toBeLessThan(1);
  expect(b["Bacteria"].y).toBeCloseTo(b["Eukaryote"].y, 0);
  // The three forks share their column's height, top to bottom, with nothing left over.
  const col = ["Eukaryote", "Simple cells", "Complex cells"].map((t) => b[t]);
  expect(Math.abs(col.reduce((h, x) => h + x.h, 0) - strip)).toBeLessThan(2);
  for (let i = 1; i < 3; i++) expect(col[i].y).toBeCloseTo(col[i - 1].y + col[i - 1].h, 0);
  for (const t of ["Eukaryote", "Simple cells", "Complex cells"]) expect(await pane(page, t).getAttribute("data-tab")).toBeNull();
});

test("every pane has the same hairline on its right and bottom, shared with its neighbours: none missing, none doubled", async ({ page }) => {
  await cells(page);
  const edges = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".strip .pane")].map((p) => {
      const cs = getComputedStyle(p);
      const last = p === p.parentElement!.lastElementChild;
      return { title: p.querySelector("h1, h2")?.textContent, right: cs.borderRightWidth, bottom: cs.borderBottomWidth, top: cs.borderTopWidth, left: cs.borderLeftWidth, rightColor: cs.borderRightColor, bottomColor: cs.borderBottomColor, last, flush: document.querySelector(".strip")!.hasAttribute("data-flush") };
    }),
  );
  const color = edges[0].rightColor;
  for (const e of edges) {
    expect(e.right, `${e.title} right`).toBe("1px");
    expect(e.bottom, `${e.title} bottom`).toBe("1px");
    expect(e.rightColor).toBe(color);
    // Between panes there is one line: the upper or left pane's, never both.
    expect(e.top).toBe("0px");
    expect(e.left).toBe("0px");
    // The last pane of a column meets the status line, which draws that line, unless a scrollbar runs between them.
    if (!e.last || !e.flush) expect(e.bottomColor).toBe(color);
  }
  // In the shared column each pane's box ends where the next begins: the line between them is the upper one's bottom edge.
  const b = await boxes(page);
  expect(b["Simple cells"].y).toBeCloseTo(b["Eukaryote"].y + b["Eukaryote"].h, 0);
  // An article's tinted ground meets the plain one at the same line.
  const tint = await pane(page, "Eukaryote").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(tint).not.toBe(await pane(page, "Simple cells").evaluate((el) => getComputedStyle(el).backgroundColor));
  expect(await pane(page, "Eukaryote").evaluate((el) => getComputedStyle(el).borderBottomColor)).toBe(color);
});

test("a curve per open edge, from where each pane was opened to its title; it follows a pane's scroll and the strip's, and the focused branch's is drawn differently", async ({ page }) => {
  await cells(page);
  // Library and The one merger are covered to spines, so the curves into and out of them are not drawn.
  const ids: Record<string, number> = {};
  for (const t of ["Two kinds of cell", "Eukaryote", "Simple cells", "Complex cells", "Bacteria"]) ids[t] = await tid(page, t);
  let cs = await curves(page);
  const edge = (from: string, to: string) => cs.filter((c) => c.from === ids[from] && c.to === ids[to]);
  for (const [f, t] of [["Two kinds of cell", "Eukaryote"], ["Two kinds of cell", "Simple cells"], ["Two kinds of cell", "Complex cells"], ["Eukaryote", "Bacteria"]]) expect(edge(f, t), `${f} → ${t}`).toHaveLength(1);
  expect(cs.filter((c) => c.to === ids["Two kinds of cell"])).toHaveLength(0);
  // Ends: near the link words, the row, and the child's title.
  const near = async (sel: string, p: { x: number; y: number }, slack = 16) => {
    const r = (await page.locator(sel).first().boundingBox())!;
    expect(p.x).toBeGreaterThan(r.x - slack);
    expect(p.x).toBeLessThan(r.x + r.width + slack);
    expect(p.y).toBeGreaterThan(r.y - slack);
    expect(p.y).toBeLessThan(r.y + r.height + slack);
  };
  const kinds = pane(page, "Two kinds of cell");
  const nearIn = async (loc: ReturnType<Page["locator"]>, p: { x: number; y: number }, slack = 16) => {
    const r = (await loc.first().boundingBox())!;
    expect(p.x).toBeGreaterThan(r.x - slack);
    expect(p.x).toBeLessThan(r.x + r.width + slack);
    expect(p.y).toBeGreaterThan(r.y - slack);
    expect(p.y).toBeLessThan(r.y + r.height + slack);
  };
  await nearIn(kinds.locator(".lnk", { hasText: "Eukaryotes" }), edge("Two kinds of cell", "Eukaryote")[0].a);
  await nearIn(kinds.locator(".node.forked > .row", { hasText: "Simple cells" }), edge("Two kinds of cell", "Simple cells")[0].a);
  const title = (t: string) => pane(page, t).locator(".wiki-head h2, .pane-head h2").first();
  for (const t of ["Eukaryote", "Simple cells", "Complex cells"]) {
    const end = edge("Two kinds of cell", t)[0].b;
    const r = (await title(t).boundingBox())!;
    expect(end.x).toBeLessThanOrEqual(r.x + 2);
    expect(end.x, t).toBeGreaterThan(r.x - 30);
    expect(end.y).toBeGreaterThan(r.y - 4);
    expect(end.y).toBeLessThan(r.y + r.height + 4);
  }
  await near('.wiki-pane .wiki-text a[data-wiki="Bacteria"]', edge("Eukaryote", "Bacteria")[0].a);
  // The focused branch (Two kinds of cell → Complex cells) in its own ink; the others not.
  expect(edge("Two kinds of cell", "Complex cells")[0].cls).toContain("on");
  expect(edge("Two kinds of cell", "Simple cells")[0].cls).not.toContain("on");
  expect(await page.locator(".curves path.on").first().evaluate((el) => getComputedStyle(el).stroke)).not.toBe(await page.locator(".curves path:not(.on)").first().evaluate((el) => getComputedStyle(el).stroke));
  // Scroll Eukaryote's text: the curve out of it moves with its link.
  const before = edge("Eukaryote", "Bacteria")[0].a;
  await pane(page, "Eukaryote").locator(".pane-scroll").evaluate((el) => (el.scrollTop = 40));
  await nextFrames(page);
  cs = await curves(page);
  expect(Math.abs(edge("Eukaryote", "Bacteria")[0].a.y - (before.y - 40))).toBeLessThan(3);
  // Scrolled out of its pane, the source is held at the pane's edge and the curve is dotted.
  await pane(page, "Eukaryote").locator(".pane-scroll").evaluate((el) => (el.scrollTop = 400));
  await nextFrames(page);
  cs = await curves(page);
  expect(edge("Eukaryote", "Bacteria")[0].cls).toContain("lost");
  const top = (await pane(page, "Eukaryote").locator(".pane-scroll").boundingBox())!.y;
  expect(Math.abs(edge("Eukaryote", "Bacteria")[0].a.y - top)).toBeLessThan(6);
  // Scroll the strip: the curves move with the panes.
  const was = edge("Two kinds of cell", "Simple cells")[0].b;
  await page.locator(".strip").evaluate((el) => (el.scrollLeft += el.scrollLeft >= 200 ? -200 : 200));
  await still(page);
  cs = await curves(page);
  const now = edge("Two kinds of cell", "Simple cells")[0].b;
  const r = (await title("Simple cells").boundingBox())!;
  expect(Math.abs(now.x - was.x)).toBeGreaterThan(20);
  expect(now.x).toBeGreaterThan(r.x - 30);
  expect(now.x).toBeLessThanOrEqual(r.x + 2);
  // And they can be turned off, and on again.
  await page.keyboard.press(":");
  await page.keyboard.type("/curves off");
  await page.keyboard.press("Enter");
  await expect(page.locator(".curves path")).toHaveCount(0);
  await page.keyboard.press(":");
  await page.keyboard.type("/curves on");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await curves(page)).length).toBeGreaterThan(3);
});

test("exactly one pane is active, under a heavy rule; the rest of the focused branch under a hairline", async ({ page }) => {
  await cells(page);
  const marks = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".strip .pane")].map((p) => ({
        title: p.querySelector("h1, h2")?.textContent?.trim(),
        active: p.classList.contains("active"),
        rule: getComputedStyle(p, "::after").height,
      })),
    );
  let m = await marks();
  expect(m.filter((x) => x.active).map((x) => x.title)).toEqual([await state(page, (s) => s.snap.nodes[s.trail[s.paneAt].id].title)]);
  expect(m.find((x) => x.active)!.rule).toBe("3px");
  expect(m.filter((x) => x.rule === "3px")).toHaveLength(1);
  // The other panes on the focused branch: a hairline; off it, nothing.
  expect(m.find((x) => x.title === "Complex cells")!.rule).toBe("1px");
  expect(m.find((x) => x.title === "Simple cells")!.rule).toBe("0px");
  // Into an article: it is the active pane now, and still the only one.
  await pane(page, "Bacteria").locator(".wiki-head").click();
  m = await marks();
  expect(m.filter((x) => x.active).map((x) => x.title)).toEqual(["Bacteria"]);
  expect(m.filter((x) => x.rule === "3px").map((x) => x.title)).toEqual(["Bacteria"]);
});

/** Five sections of the first pane, opened side by side: five panes in column 1. */
async function five(page: Page) {
  await open(page);
  await keys(page, "j Shift+Enter j Shift+Enter j Shift+Enter j Shift+Enter j Shift+Enter");
  const kids = (await childTitles(page, "Infinispand")).slice(0, 5);
  expect((await columns(page))[1]).toEqual(kids);
  return kids;
}

test("a column with more panes than fit folds all but the focused one into tabs; moving the focus there, or a click on a tab, opens it", async ({ page }) => {
  const kids = await five(page);
  const strip = await page.locator(".strip").evaluate((el) => el.clientHeight);
  let b = await boxes(page);
  // The focused fork (the last) takes the height less a tab's for each of the others; the others are tabs, in order, above it.
  expect(kids.slice(0, 4).every((t) => b[t].tab)).toBe(true);
  expect(b[kids[4]].tab).toBe(false);
  expect(Math.abs(b[kids[4]].h - (strip - 4 * 30))).toBeLessThan(2);
  for (let i = 1; i < 5; i++) expect(b[kids[i]].y).toBeCloseTo(b[kids[i - 1]].y + b[kids[i - 1]].h, 0);
  await expect(pane(page, kids[0]).locator(".tabline .tabtitle")).toHaveText(kids[0]);
  await expect(pane(page, kids[0]).locator(".tabline")).toBeVisible();
  await expect(pane(page, kids[0]).locator(".pane-ctl .pane-btn.close")).toBeVisible();
  // l steps into the focused fork's pane; [ moves up the column: that tab opens, the one left folds.
  await keys(page, "l");
  await expect(page.locator(".pane.active .pane-head h2")).toHaveText(kids[4]);
  const where = await focusedTitle(page);
  await keys(page, "[");
  expect(await trail(page)).toEqual(["Infinispand", kids[3]]);
  await expect(page.locator(".pane.active .pane-head h2")).toHaveText(kids[3]);
  b = await boxes(page);
  expect(b[kids[3]].tab).toBe(false);
  expect(b[kids[4]].tab).toBe(true);
  // ] comes back down, to where the focus was.
  await keys(page, "]");
  await expect(page.locator(".pane.active .pane-head h2")).toHaveText(kids[4]);
  expect(await focusedTitle(page)).toBe(where);
  await keys(page, "]");
  await expect(page.locator(".status .message")).toContainText("No pane below");
  // A click on a tab opens that pane and makes it the active one.
  await pane(page, kids[1]).locator(".tabline").click();
  await expect(page.locator(".pane.active .pane-head h2")).toHaveText(kids[1]);
  b = await boxes(page);
  expect(b[kids[1]].tab).toBe(false);
  expect(b[kids[4]].tab).toBe(true);
});

test("a pinned pane does not fold in its column, outlives a closed parent as an orphan in its column, and is not covered to a spine", async ({ page }) => {
  const kids = await five(page);
  // Pin the second fork, by its button: it opens beside the focused one and stays open as the focus moves up and down the column.
  await pane(page, kids[1]).locator(".pane-ctl .pane-btn.pin").click();
  await expect(pane(page, kids[1])).toHaveClass(/pinned/);
  let b = await boxes(page);
  expect(b[kids[1]].tab).toBe(false);
  expect(b[kids[1]].h).toBeGreaterThan(200);
  await keys(page, "l [ [");
  await expect(page.locator(".pane.active .pane-head h2")).toHaveText(kids[2]);
  b = await boxes(page);
  expect(b[kids[1]].tab).toBe(false);
  expect(b[kids[4]].tab).toBe(true);
  // The pin is kept across a reload.
  await page.reload();
  await page.waitForSelector(".strip .pane");
  await expect(pane(page, kids[1])).toHaveClass(/pinned/);
  // Pin a pane opened from the first fork, then close that fork with its ×: the pinned pane stays where it was, an orphan, with no curve into it.
  await pane(page, kids[0]).locator(".tabline").click();
  const grand = (await childTitles(page, kids[0]))[0];
  await keys(page, "l l l P");
  await expect(page.locator(".pane.active .pane-head h2")).toHaveText(grand);
  await expect(page.locator(".pane.active")).toHaveClass(/pinned/);
  const orphan = await tid(page, grand);
  await pane(page, kids[0]).locator(".pane-ctl .pane-btn.close").click();
  expect((await columns(page))[1]).not.toContain(kids[0]);
  expect((await columns(page))[2]).toEqual([grand]);
  await expect(pane(page, grand).locator(".orphan-note")).toBeVisible();
  expect(await state(page, (s) => s.forest.trees.length)).toBe(2);
  await nextFrames(page);
  expect((await curves(page)).filter((c) => c.to === orphan)).toHaveLength(0);
  // Its own × closes it.
  await pane(page, grand).locator(".pane-ctl .pane-btn.close").click();
  expect(await columns(page)).toHaveLength(2);
});

test("a pinned column is not covered to a spine as the strip scrolls; later columns slide past it", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await open(page);
  await keys(page, "l l l j j l l l");
  await expect.poll(async () => (await columns(page)).length).toBe(4);
  const covered = () => page.evaluate(() => [...document.querySelectorAll(".strip > .col")].map((c) => c.hasAttribute("data-covered")));
  // Unpinned, column 1 is covered once the strip has scrolled to the last.
  await page.locator(".strip").evaluate((el) => (el.scrollLeft = el.scrollWidth));
  await expect.poll(async () => (await covered())[1]).toBe(true);
  await pane(page, "Expansion by depth").locator(".spine-title").click();
  await keys(page, "P");
  await expect(pane(page, "Expansion by depth")).toHaveClass(/pinned/);
  await page.locator(".strip").evaluate((el) => (el.scrollLeft = el.scrollWidth));
  await still(page);
  expect((await covered())[1]).toBe(false);
  const col1 = (await pane(page, "Expansion by depth").boundingBox())!;
  const col2x = await page.evaluate(() => document.querySelectorAll(".strip > .col")[2].getBoundingClientRect().x);
  expect(col1.x).toBeGreaterThanOrEqual(0);
  expect(col2x).toBeGreaterThanOrEqual(col1.x + col1.width - 1);
  // The last column can still be scrolled fully into view.
  const last = (await pane(page, "Deepening a leaf").boundingBox())!;
  expect(last.x + last.width).toBeLessThanOrEqual(1600 + 1);
  await keys(page, "P");
  await expect(pane(page, "Expansion by depth")).not.toHaveClass(/pinned/);
});

test("× and q close the pane they are on, whatever it shows, with what was opened from it; pinned panes under it stay", async ({ page }) => {
  // A node: × on a fork that is not focused closes it alone.
  await cells(page);
  await pane(page, "Simple cells").locator(".pane-ctl .pane-btn.close").click();
  expect((await columns(page))[3]).toEqual(["Eukaryote", "Complex cells"]);
  // An article opened from an article: q closes it only, and the focus goes back to its link.
  await pane(page, "Bacteria").locator(".wiki-head").click();
  await keys(page, "q");
  expect(await columns(page)).toEqual([["Library"], ["The one merger"], ["Two kinds of cell"], ["Eukaryote", "Complex cells"]]);
  await expect(page.locator(".pane.active .wiki-head h2")).toHaveText("Eukaryote");
  // Pinned panes under a closed pane stay: open Bacteria again, pin it, close Eukaryote.
  await pane(page, "Eukaryote").locator('.wiki-text a[data-wiki="Bacteria"]').first().click();
  await keys(page, "P");
  await pane(page, "Eukaryote").locator(".pane-ctl .pane-btn.close").click();
  expect(await columns(page)).toEqual([["Library"], ["The one merger"], ["Two kinds of cell"], ["Complex cells"], ["Bacteria"]]);
  await expect(pane(page, "Bacteria").locator(".orphan-note")).toBeVisible();
  // Its own × closes the orphan.
  await pane(page, "Bacteria").locator(".pane-ctl .pane-btn.close").click();
  expect(await columns(page)).toEqual([["Library"], ["The one merger"], ["Two kinds of cell"], ["Complex cells"]]);
  // A note that also links, opened as a pane of its own: q closes it, back to its words.
  await page.goto("/doc/octopus-minds");
  await page.waitForSelector(".strip .pane");
  await jump(page, "The common ancestor");
  await keys(page, "l");
  await page.locator(".pane .anchor", { hasText: "The camera-like eye" }).click();
  await expect(page.locator(".pane.note-pane")).toHaveCount(1);
  await expect(page.locator(".pane.active")).toHaveClass(/note-pane/);
  await keys(page, "q");
  await expect(page.locator(".pane.note-pane")).toHaveCount(0);
  expect(await selected(page)).toBe("The camera-like eye");
});

test("q on an article opened from an article in a fork closes that article only (the owner's bug)", async ({ page }) => {
  await page.goto("/doc/fixed-points");
  await page.waitForSelector(".strip .pane");
  await page.evaluate(() => document.fonts.ready);
  await jump(page, "Recursion without names");
  // A fork beside it from the document's pane: Recursion without names starts a fork.
  await keys(page, "k Enter j Shift+Enter");
  expect((await trail(page)).at(-1)).toBe("Recursion without names");
  await tabTo(page, "fixed-point combinator");
  await keys(page, "Enter");
  await expect(page.locator(".wiki-pane .wiki-head h2", { hasText: "Fixed-point combinator" })).toHaveCount(1);
  await page.locator('.wiki-pane .wiki-text a[data-wiki="Haskell Curry"]').first().click();
  expect(await trail(page)).toEqual(["Library", "Fixed points", "Recursion without names", "W:Fixed-point combinator", "W:Haskell Curry"]);
  await keys(page, "q");
  expect(await trail(page)).toEqual(["Library", "Fixed points", "Recursion without names", "W:Fixed-point combinator"]);
  await keys(page, "q");
  expect(await trail(page)).toEqual(["Library", "Fixed points", "Recursion without names"]);
  expect(await selected(page)).toBe("fixed-point combinator");
});

test("from a Wikipedia link, a node link and a link inside an article: forks, each marked where it was opened", async ({ page }) => {
  await page.goto("/doc/fixed-points");
  await page.waitForSelector(".strip .pane");
  await page.evaluate(() => document.fonts.ready);
  await jump(page, "Recursion without names");
  await tabTo(page, "fixed-point combinator");
  await keys(page, "Enter");
  await expect(page.locator(".wiki-pane .wiki-head h2")).toHaveText("Fixed-point combinator");
  await keys(page, "h"); // back to the words
  expect(await selected(page)).toBe("fixed-point combinator");
  await tabTo(page, "Y combinator");
  await keys(page, "Shift+Enter");
  expect((await columns(page))[3]).toEqual(["Fixed-point combinator", "How Y works"]);
  // In the text it came from, both links are marked, the focused fork's more strongly.
  const from = page.locator('.pane[data-pane-index="2"]');
  await expect(from.locator(".lnk.forked.picked")).toHaveText("Y combinator");
  await expect(from.locator(".lnk.forked:not(.picked)")).toHaveText("fixed-point combinator");
  // Into How Y works, then [ goes up the column to the article; its sections open as rows, as before.
  await pane(page, "How Y works").locator(".pane-head").click();
  await keys(page, "[");
  expect(await trail(page)).toEqual(["Library", "Fixed points", "Recursion without names", "W:Fixed-point combinator"]);
  expect(await state(page, (s) => s.aux)).toMatchObject({ kind: "wiki", host: "p3", row: { t: "head" } });
  await expect(from.locator(".lnk.forked.picked")).toHaveText("fixed-point combinator");
  await keys(page, "j j l");
  expect((await trail(page)).at(-1)).toBe("W:Fixed-point combinator#2");
  // A Shift-click on a link in the article's text forks beside that section.
  const art = pane(page, "Fixed-point combinator");
  await art.locator('.wiki-text a[data-wiki="Haskell Curry"]').click({ modifiers: ["Shift"] });
  const article = ["W:Fixed-point combinator", ["W:Fixed-point combinator#2", ["*", "W:Haskell Curry"]]];
  const recursion = ["Recursion without names", [["*", article], "How Y works"]];
  expect(await tree(page)).toEqual(["Library", [["*", ["Fixed points", [["*", recursion]]]]]]);
  await expect(art.locator(".wrow.forked > .row .title")).toHaveText("Y combinator");
  await expect(art.locator('.wiki-text a.forked.picked[data-wiki="Haskell Curry"]')).toHaveCount(1);
  expect((await columns(page))[4]).toHaveLength(2);
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
  expect((await columns(page))[2]).toEqual(["Levels of a node", "A section to delete"]);
  await page.locator(".pane .row", { hasText: "Levels of a node" }).first().click();
  const id = await state(page, (s) => (Object.values(s.snap.nodes) as any[]).find((n) => n.title === "A section to delete").id);
  const res = await request.post("/api/ops", { data: { author: "another", message: "Delete it", ops: [{ op: "delete", id }] } });
  expect(res.ok()).toBe(true);
  await expect.poll(async () => (await columns(page))[2]).toEqual(["Levels of a node"]);
  expect(await trail(page)).toEqual(["Infinispand", "Expansion by depth", "Levels of a node"]);
});

test("a window too short to share a column folds it at once: the focused pane open, the others tabs", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 480 });
  await open(page);
  await keys(page, "l l l Shift+Enter j Shift+Enter");
  let b = await boxes(page);
  expect(b["Levels of a node"].tab).toBe(true);
  expect(b["Pre-generated depth"].tab).toBe(false);
  // With room again, they share the column.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect.poll(async () => (await boxes(page))["Levels of a node"].tab).toBe(false);
  b = await boxes(page);
  expect(b["Pre-generated depth"].tab).toBe(false);
});

test("many forks: a reload brings the forest back", async ({ page }) => {
  await open(page);
  await keys(page, "j Shift+Enter");
  for (let i = 0; i < 5; i++) await keys(page, "j Shift+Enter");
  expect((await columns(page))[1]).toHaveLength(6);
  const before = await tree(page);
  const was = await trail(page);
  await page.reload();
  await page.waitForSelector(".strip .pane");
  expect(await tree(page)).toEqual(before);
  expect(await trail(page)).toEqual(was);
  expect((await columns(page))[1]).toHaveLength(6);
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
