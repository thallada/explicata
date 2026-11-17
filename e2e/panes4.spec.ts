/**
 * The panes view, round four: curves over the panes' edges and under the selection bar and menus;
 * a pane peeking out leaves every other curve clear of its place, and nothing stale behind; a
 * pane's title and its tab never show together; a peeking pane and the active one have clear edges;
 * a menu's button closes it; a link's underline and its curve are one stroke at every pixel ratio.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { autoLayout, curveFaults, pixels, seedLinks, settle } from "./helpers";

const pane = (page: Page, title: string | RegExp) =>
  typeof title === "string" ? page.locator(".strip .pane", { has: page.locator(`:is(.wiki-head h2, .pane-head h2, .top h1):text-is("${title}")`) }).first() : page.locator(".strip .pane", { has: page.locator(`:is(.wiki-head h2, .pane-head h2, .top h1)`, { hasText: title }) }).first();
const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
async function still(page: Page) {
  await page.waitForFunction(
    () =>
      new Promise((r) => {
        const at = () => [document.querySelector(".strip")!, ...document.querySelectorAll(".strip > .col, .strip .pane-scroll")].map((el) => `${el.scrollLeft},${el.scrollTop}`).join();
        const x = at();
        setTimeout(() => r(at() === x), 250);
      }),
  );
  await frames(page);
}
async function open(page: Page, inPane: string | RegExp, text: string | RegExp, sel = ".row") {
  // A row by its exact title (the shared library has documents whose titles start the same).
  const it = sel === ".row" && typeof text === "string" ? pane(page, inPane).locator(".row", { has: page.locator(`.title:text-is("${text}")`) }) : pane(page, inPane).locator(sel, { hasText: text });
  await it.first().dispatchEvent("click");
  await still(page);
}
/** Open the nth row of a pane's own outline; returns its title. */
async function openNth(page: Page, inPane: string, n: number): Promise<string> {
  const row = pane(page, inPane).locator(":scope > .pane-scroll > .pane-body > .outline > li > .row").nth(n);
  const title = (await row.locator(".title").first().textContent())!.trim();
  await row.dispatchEvent("click");
  await still(page);
  return title;
}
async function library(page: Page) {
  await autoLayout(page);
  await page.goto("/");
  await page.waitForSelector(".strip .pane");
  await page.evaluate(() => document.fonts.ready);
}
/** The owner's kind of forest: several columns, crowded. */
async function forest(page: Page) {
  await library(page);
  await open(page, "Library", "Octopus minds");
  await open(page, "Octopus minds", "A separate experiment");
  await open(page, "A separate experiment", "The common ancestor");
  await open(page, "Library", "Infinispand");
  await open(page, /Infinispand/, "Expansion by depth");
  await open(page, "Expansion by depth", "Levels of a node");
  await open(page, "Expansion by depth", "Generation on demand");
  await open(page, "Library", "The tides");
  // (By their places, not their titles: other tests rename sections of the shared library.)
  const sec = await openNth(page, "The tides", 1);
  await openNth(page, sec, 0);
  await openNth(page, sec, 1);
  await pane(page, "Generation on demand").locator(".pane-head h2").dispatchEvent("click");
  await still(page);
}
const noFaults = async (page: Page, when: string) => {
  await still(page);
  expect(await curveFaults(page), when).toEqual([]);
};

test.use({ viewport: { width: 2000, height: 1000 }, colorScheme: "dark" });
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ request }) => {
  await seedLinks(request);
});
test.beforeEach(async ({ context }) => {
  await context.route(/wikipedia\.org|wikimedia\.org|stanford\.edu|example\.org/, (r) => r.abort());
});
test.afterEach(({ page }) => settle(page));

test("peeking in a busy forest: every other curve leaves the peeking pane's place clear, its own stay over it, and nothing is stale after", async ({ page }) => {
  await forest(page);
  await noFaults(page, "at rest");
  // Every pane that is cut off in a crowded column, in turn.
  const cut = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".strip > .col.crowded > .pane")].flatMap((p) => {
      const c = p.parentElement!.getBoundingClientRect();
      const r = p.getBoundingClientRect();
      const next = (p.nextElementSibling as HTMLElement | null)?.getBoundingClientRect().top ?? Infinity;
      const top = Math.max(r.top, c.top);
      const bottom = Math.min(r.bottom, next, c.bottom);
      return bottom - top < Math.min(r.height, c.height) - 4 && bottom - top > 8 ? [{ x: Math.max(r.left, c.left) + 160, y: top + Math.min(12, (bottom - top) / 2), tid: p.dataset.tid }] : [];
    }),
  );
  expect(cut.length).toBeGreaterThan(1);
  for (const c of cut) {
    await page.mouse.move(c.x, c.y);
    await expect(page.locator(`.pane[data-tid="${c.tid}"]`)).toHaveAttribute("data-peek", "");
    await noFaults(page, `peeking ${c.tid}`);
    // The peeking pane is edged on every side.
    const edge = await page.locator(`.pane[data-tid="${c.tid}"]`).evaluate((el) => ({ style: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth, offset: getComputedStyle(el).outlineOffset }));
    expect(edge).toEqual({ style: "solid", width: "1px", offset: "-1px" });
    await page.mouse.move(1995, 995);
    await expect(page.locator(`.pane[data-tid="${c.tid}"]`)).not.toHaveAttribute("data-peek", "");
    await noFaults(page, `after ${c.tid}`);
  }
});

test("a pane's title and its tab never show together, and the curve lands in whichever shows, as a crowded column scrolls through its panes", async ({ page }) => {
  await forest(page);
  const col = page.locator(".strip > .col.crowded").first();
  const max = await col.evaluate((c) => c.scrollHeight - c.clientHeight);
  for (let y = 0; y <= max; y += Math.max(20, Math.round(max / 12))) {
    await col.evaluate((c, y) => (c.scrollTop = y), y);
    await frames(page);
    const both = await col.evaluate((c) => {
      const cb = c.getBoundingClientRect();
      const ps = [...c.querySelectorAll<HTMLElement>(":scope > .pane")];
      return ps.flatMap((p, i) => {
        const tab = getComputedStyle(p.querySelector(".tabline")!).opacity === "1";
        const head = p.querySelector<HTMLElement>(":scope > .pane-scroll > .pane-body > .pane-head, :scope > .pane-scroll > .pane-body > .top h1, :scope > .pane-scroll > .pane-body > .wiki:not(.embedded) > .wiki-head");
        const rule = head?.getBoundingClientRect();
        const r = p.getBoundingClientRect();
        const next = ps[i + 1]?.getBoundingClientRect().top ?? Infinity;
        // The rule shows: below the tab's place, above what covers the pane, inside the column.
        const shows = !!rule && rule.bottom > Math.max(r.top, cb.top) + 30 && rule.bottom <= Math.min(next, cb.bottom);
        return tab && shows ? [p.querySelector("h1, h2")?.textContent?.trim()] : [];
      });
    });
    expect(both, `scrolled to ${y}`).toEqual([]);
    expect(await curveFaults(page), `scrolled to ${y}`).toEqual([]);
  }
});

test("the selection bar is over the curves and under a pane peeking over it; curves are over the panes' edges", async ({ page }) => {
  await forest(page);
  const para = (await pane(page, "Generation on demand").locator(".pane-body .para").first().boundingBox())!;
  await page.mouse.click(para.x + 30, para.y + 10);
  await expect(page.locator(".selbar")).toBeVisible();
  await noFaults(page, "with the bar (its place clear of the curves)");
  const z = await page.evaluate(() => ({ curves: Number(getComputedStyle(document.querySelector(".curves")!).zIndex), peek: 6 }));
  expect(z.curves).toBeGreaterThan(z.peek);
  // The active pane: the heavy rule on top, its other edges in the strong ink (drawn with the curves, along its left, foot and right).
  const frame = await page.locator(".pane.active").evaluate((el) => {
    const r = el.getBoundingClientRect();
    const f = document.querySelector<SVGPathElement>(".curves path.frame");
    if (!f) return null;
    const a = f.getPointAtLength(0);
    const b = f.getPointAtLength(f.getTotalLength());
    return { rule: getComputedStyle(el, "::after").height, left: Math.abs(a.x - r.left) < 1.5, right: Math.abs(b.x - r.right) < 1.5, stroke: getComputedStyle(f).stroke !== getComputedStyle(el).borderRightColor };
  });
  expect(frame).toEqual({ rule: "3px", left: true, right: true, stroke: true });
});

test("a menu's button closes the menu it opened: the top bar's, and a pane's ⋯", async ({ page }) => {
  await forest(page);
  const menu = page.locator(".menu");
  const top = page.locator(".docbar .tool", { hasText: "menu" });
  await top.click();
  await expect(menu).toBeVisible();
  await top.click();
  await expect(menu).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(menu).toHaveCount(0);
  await top.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  const more = page.locator(".pane.active .pane-ctl .pane-btn.more");
  await more.click();
  await expect(menu).toBeVisible();
  await more.click();
  await expect(menu).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(menu).toHaveCount(0);
});

/** Two kinds of cell → its link Eukaryotes (serif, in a node's text) → the article → its link Bacteria (sans, in an article). */
async function linked(browser: Browser, dpr: number) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1000 }, deviceScaleFactor: dpr, colorScheme: "dark" });
  await ctx.route(/wikipedia\.org|wikimedia\.org|stanford\.edu|example\.org/, (r) => r.abort());
  const page = await ctx.newPage();
  await autoLayout(page);
  await page.goto("/doc/the-one-merger");
  await page.waitForSelector(".strip .pane");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => (globalThis as any).__ie?.ready);
  await open(page, "The one merger", "Two kinds of cell");
  await expect(pane(page, "Two kinds of cell")).toBeVisible();
  await open(page, "Two kinds of cell", "Eukaryotes", ".lnk");
  await expect(pane(page, "Eukaryote").locator('.wiki-text a[data-wiki="Bacteria"]').first()).toBeVisible();
  await pane(page, "Eukaryote").locator('.wiki-text a[data-wiki="Bacteria"]').first().dispatchEvent("click");
  await still(page);
  // The article the active pane, so it and the pane before it are both in view.
  await pane(page, "Eukaryote").locator(".wiki-head h2").dispatchEvent("click");
  await still(page);
  await page.waitForTimeout(400);
  await still(page);
  return { ctx, page };
}

test("a link's underline is drawn as the start of its curve: one stroke on device pixels, in a node's text and an article's, at ratios 1, 1.25, 1.5, 2 and zoom 90 and 110 %", async ({ browser }) => {
  for (const dpr of [1, 1.25, 1.5, 2, 0.9, 1.1]) {
    const { ctx, page } = await linked(browser, dpr);
    const links = await page.evaluate(() => {
      const svg = document.querySelector(".curves")!.getBoundingClientRect();
      const box = { left: Math.round(svg.left), top: Math.round(svg.top) };
      const cx = document.createElement("canvas").getContext("2d")!;
      const rgb = (c: string) => {
        cx.clearRect(0, 0, 1, 1);
        cx.fillStyle = c;
        cx.fillRect(0, 0, 1, 1);
        return [...cx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      };
      return [...document.querySelectorAll<HTMLElement>("[data-curved]")].map((el) => {
        const rects = [...el.getClientRects()].filter((r) => r.width > 0);
        const kind = el.matches(".wiki-text a") ? "article" : "node";
        const pane = el.closest<HTMLElement>(".pane")!.dataset.tid;
        const path = [...document.querySelectorAll<SVGPathElement>(`.curves path[data-from="${pane}"]`)].find((p) => {
          const a = p.getPointAtLength(0);
          return rects.some((r) => Math.abs(a.x + box.left - r.left) < 1.5);
        });
        const d = path?.getAttribute("d") ?? "";
        const a = path?.getPointAtLength(0);
        // The underline's run: from the link's left, along to its right, then the step on.
        const m = d.match(/^M([\d.]+) ([\d.]+)H([\d.]+)C/);
        return {
          kind,
          decoration: getComputedStyle(el).textDecorationColor,
          rects: rects.map((r) => ({ left: r.left, right: r.right, bottom: r.bottom })),
          start: a && { x: a.x + box.left, y: a.y + box.top },
          run: m && { x0: +m[1] + box.left, y: +m[2] + box.top, x1: +m[3] + box.left },
          colour: path && getComputedStyle(path).stroke,
          rgb: path ? rgb(getComputedStyle(path).stroke) : null,
          alpha: path ? Number(getComputedStyle(path).stroke.match(/\/ ([\d.]+)\)/)?.[1] ?? 1) : 1,
        };
      });
    });
    expect(links.map((l) => l.kind).sort(), `dpr ${dpr}`).toEqual(["article", "node"]);
    const raw = await page.screenshot();
    if (process.env.UL_DEBUG) (await import("node:fs")).writeFileSync(`test-results/ul-${dpr}.png`, raw), console.log(JSON.stringify(links));
    const shot = pixels(raw);
    const wd = Math.max(1, Math.floor(dpr + 0.01));
    for (const l of links) {
      // The browser's own underline is left out; the curve's begins at the link's left and ends at its right, on its last line.
      expect(l.decoration, `dpr ${dpr} ${l.kind}`).toBe("rgba(0, 0, 0, 0)");
      const last = l.rects[l.rects.length - 1];
      expect(l.run, `dpr ${dpr} ${l.kind}`).not.toBeNull();
      expect(Math.abs(l.run!.x0 - last.left), `dpr ${dpr} ${l.kind} left`).toBeLessThan(1);
      expect(Math.abs(l.run!.x1 - last.right), `dpr ${dpr} ${l.kind} right`).toBeLessThan(1);
      expect(l.run!.y).toBeGreaterThan(last.bottom - 8);
      expect(l.run!.y).toBeLessThan(last.bottom + 2);
      // On device pixels: the line's middle sits half a hairline off a device row, as the curves' do.
      const off = l.run!.y * dpr - wd / 2;
      expect(Math.abs(off - Math.round(off)), `dpr ${dpr} ${l.kind} snapped`).toBeLessThan(0.02);
      // In the pixels: on the line's row, under the link where no letter reaches, the curve's colour (at its strength) shows.
      const yDev = Math.floor(l.run!.y * dpr);
      const dist = (a: number[], b: number[]) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);
      let checked = 0;
      for (let x = Math.round(last.left * dpr) + 2; x < Math.round(last.right * dpr) - 2 && checked < 6; x += 1) {
        const bg = shot.px(x, yDev + Math.round(4 * dpr));
        const want = l.rgb!.map((v, i) => l.alpha * v + (1 - l.alpha) * bg[i]);
        if (dist(shot.px(x, yDev), want) >= 60) continue;
        // One hairline: as many device rows in its colour as the curves have, no softer edge.
        const rows = [];
        for (let r = yDev - Math.round(2 * dpr); r <= yDev + Math.round(2 * dpr); r++) if (dist(shot.px(x, r), want) < 90) rows.push(r);
        expect(rows.length, `dpr ${dpr} ${l.kind} at ${x}: rows ${rows}`).toBe(wd);
        checked++;
      }
      expect(checked, `dpr ${dpr} ${l.kind}: the line in the curve's colour`).toBeGreaterThan(2);
    }
    expect(await curveFaults(page), `dpr ${dpr}`).toEqual([]);
    await ctx.close();
  }
});
