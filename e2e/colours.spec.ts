/**
 * Fork colours and the lines they run along, in the panes view: every kind of pane's title rule is
 * drawn by the curve into it, in the pane's colour, as one stroke (measured in the pixels, at several
 * device pixel ratios); a pane folded or scrolled past its title shows its tab and the curve lands in
 * the tab's foot, and a curve out of a folded pane leaves from that foot; a pane's colour depends on
 * the forest only; a covered pane peeks out across and down at once, and the wheel scrolls it; the
 * selection bar sits at its pane's level. Same build, mock model and mock Wikipedia as the others.
 */
import { expect, test, type Page } from "@playwright/test";
import { clickOpen, frames, library, pane, pixels, seedLinks, seedWeb, settle, state, still, tid } from "./helpers";


/**
 * Every curve, with where it ends and what it lands in: its stroke's colour (RGB), its pane's
 * colour (RGB of the pane's --hue), whether the pane's own rule is left to the curve, and the rule's
 * and the tab foot's place on screen.
 */
const lines = (page: Page) =>
  page.evaluate(() => {
    const cx = document.createElement("canvas").getContext("2d")!;
    const rgb = (c: string) => {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = "#000";
      cx.fillStyle = c;
      cx.fillRect(0, 0, 1, 1);
      return [...cx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    };
    const svg = document.querySelector<SVGSVGElement>(".curves")!.getBoundingClientRect();
    const box = { left: Math.round(svg.left), top: Math.round(svg.top) };
    return [...document.querySelectorAll<SVGPathElement>(".curves path:not(.foot):not(.frame)")].map((p) => {
      const pe = document.querySelector<HTMLElement>(`.pane[data-tid="${p.dataset.to}"]`)!;
      const a = p.getPointAtLength(0);
      const b = p.getPointAtLength(p.getTotalLength());
      const head = pe.querySelector<HTMLElement>(":scope > .pane-scroll > .pane-body > .pane-head, :scope > .pane-scroll > .pane-body > .top h1, :scope > .pane-scroll > .pane-body > .wiki:not(.embedded) > .wiki-head");
      const hr = head?.getBoundingClientRect();
      const pr = pe.getBoundingClientRect();
      const from = document.querySelector<HTMLElement>(`.pane[data-tid="${p.dataset.from}"]`)!.getBoundingClientRect();
      return {
        from: Number(p.dataset.from),
        to: Number(p.dataset.to),
        cls: p.getAttribute("class") ?? "",
        hue: p.dataset.hue ?? null,
        paneHue: pe.dataset.hue ?? null,
        kind: pe.classList.contains("wiki-pane") ? `${pe.classList.contains("web") ? "web" : "article"}${pe.querySelector(".wiki-head .wsub") ? " section" : ""}` : pe.querySelector(":scope > .pane-scroll > .pane-body > .top") ? "page" : "section",
        stroke: rgb(getComputedStyle(p).stroke),
        colour: rgb(getComputedStyle(pe).getPropertyValue("--hue")),
        ownRule: head ? rgb(getComputedStyle(head).borderBottomColor) : null,
        ownRuleAlpha: head ? getComputedStyle(head).borderBottomColor : null,
        ruled: pe.dataset.ruled ?? "",
        focused: !!head?.closest(".focused"),
        scrolled: pe.hasAttribute("data-scrolled"),
        folded: pe.hasAttribute("data-covered"),
        start: { x: a.x + box.left, y: a.y + box.top },
        end: { x: b.x + box.left, y: b.y + box.top },
        rule: hr && { left: hr.left, right: hr.right, y: hr.bottom - 0.5 },
        foot: { y: pr.top + 29.5, left: pr.left, right: pr.right },
        fromFoot: { y: from.top + 29.5, right: from.right },
      };
    });
  });

test.use({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ request }) => {
  await seedLinks(request);
  await seedWeb(request);
});
test.beforeEach(async ({ context }) => {
  await context.route(/wikipedia\.org|wikimedia\.org|stanford\.edu|example\.org/, (r) => r.abort());
});
test.afterEach(({ page }) => settle(page));

const near = (a: number, b: number, d = 1) => Math.abs(a - b) <= d;
/** Two colours alike, but for rounding (a colour at part strength, un-premultiplied, may differ by a unit or two). */
const alike = (a: number[] | null, b: number[] | null) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) <= 3);

test("every kind of pane's title rule is drawn by the curve into it, in the pane's colour: nodes (a top-level one too), articles and their sections, web pages and their sections", async ({ page }) => {
  await library(page);
  for (const t of ["The tides", "Fixed points"]) await clickOpen(page, "Library", t);
  const seen = new Set<string>();
  const check = async () => {
    for (const l of await lines(page)) {
      if (!l.ruled.includes("head")) continue;
      seen.add(l.kind);
      expect(l.hue, `${l.kind} ${l.to}`).toBe(l.paneHue);
      expect(alike(l.stroke, l.colour), `${l.kind} ${l.to}: ${l.stroke} ${l.colour}`).toBe(true);
      // The curve runs on along the rule to its end, at its height; the pane's own rule is left out.
      expect(near(l.end.y, l.rule!.y), `${l.kind} y`).toBe(true);
      expect(near(l.end.x, l.rule!.right, 1.5), `${l.kind} x ${l.end.x} ${l.rule!.right}`).toBe(true);
      expect(l.ownRuleAlpha).toMatch(/rgba\(.*, 0\)|transparent/);
    }
  };
  await check();
  await clickOpen(page, "Fixed points", "Recursion without names");
  await check();
  await clickOpen(page, "Recursion without names", "fixed-point combinator", ".lnk, .anchor");
  await expect(pane(page, "Fixed-point combinator").locator(".wrow").first()).toBeVisible();
  // The article's head holds the focus now (its rule is then the text's ink): put the focus back in the section.
  await pane(page, "Recursion without names").locator(".pane-head h2").dispatchEvent("click");
  await still(page);
  await check();
  await clickOpen(page, "Fixed-point combinator", "Y combinator", ".wrow .row");
  await expect(page.locator(".wiki-pane .wiki-head .wsub")).toHaveCount(1);
  await still(page);
  await check();
  // A web page, from a link in a section of another tree, and a section of it.
  await clickOpen(page, "Library", "Error-correcting codes");
  await clickOpen(page, "Error-correcting codes", "The problem");
  await clickOpen(page, "The problem", "Repetition");
  await clickOpen(page, "Repetition", "take a majority vote", ".lnk, .anchor");
  await expect(pane(page, "On maps").locator(".wrow").first()).toBeVisible();
  await pane(page, "Repetition").locator(".pane-head h2").dispatchEvent("click");
  await still(page);
  await check();
  await clickOpen(page, "On maps", "II.", ".wrow .row");
  await expect(page.locator(".wiki-pane.web .wiki-head .wsub")).toHaveCount(1);
  await still(page);
  await check();
  expect([...seen].sort(), JSON.stringify((await lines(page)).map((l) => [l.kind, l.ruled, l.cls, l.folded, l.scrolled]))).toEqual(["article", "article section", "section", "web", "web section"]);
  // A top-level node's pane is headed like any other: only the first pane is a page.
  expect(await page.locator(".strip .pane:not(.root) > .pane-scroll > .pane-body > .top").count()).toBe(0);
  // The two forks out of the library are two colours; the top node has none.
  expect(await pane(page, "Library").getAttribute("data-hue")).toBeNull();
  expect(await pane(page, "The tides").getAttribute("data-hue")).not.toBe(await pane(page, "Fixed points").getAttribute("data-hue"));
  expect(await pane(page, "Fixed points").getAttribute("data-hue")).not.toBeNull();
});

test("a pane's colour is a function of the forest: unchanged by focus, a source scrolled out of sight, folding to a tab, or which way its rule is drawn", async ({ page }) => {
  await library(page);
  for (const t of ["Explicata", "Fixed points"]) await clickOpen(page, "Library", t);
  await clickOpen(page, "Explicata", "Expansion by depth");
  await clickOpen(page, "Fixed points", "The idea itself");
  const colourOf = async () => Object.fromEntries((await lines(page)).map((l) => [l.to, { stroke: l.stroke, colour: l.colour, hue: l.paneHue }]));
  const before = await colourOf();
  const same = async (what: string) => {
    for (const l of await lines(page)) {
      if (!before[l.to]) continue;
      expect(l.paneHue, `${what}: ${l.to}`).toBe(before[l.to].hue);
      expect(alike(l.stroke, before[l.to].colour), `${what}: ${l.to} curve`).toBe(true);
      // A rule the pane draws itself (no curve lands in it) is in the same colour.
      if (!l.ruled.includes("head") && l.ownRule && !l.ownRuleAlpha!.startsWith("rgb(241")) expect(alike(l.ownRule, before[l.to].colour), `${what}: ${l.to} own rule ${l.ownRule}`).toBe(true);
    }
  };
  for (const l of await lines(page)) expect(alike(l.stroke, l.colour)).toBe(true);
  // Focus on the other fork.
  await pane(page, "Expansion by depth").locator(".pane-head h2").dispatchEvent("click");
  await still(page);
  await same("focus moved");
  // The source row scrolled out of its pane: the curve is held at the pane's edge, dotted, and the pane draws its own rule.
  const fixed = pane(page, "Fixed points").locator(".pane-scroll");
  await fixed.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await still(page);
  const idea = await tid(page, "The idea itself");
  const lost = (await lines(page)).find((l) => l.to === idea)!;
  expect(lost.cls).toContain("lost");
  expect(lost.ruled).toBe("");
  await same("source scrolled out");
  await fixed.evaluate((el) => (el.scrollTop = 0));
  await still(page);
  await same("source back");
  // Folded to tabs in a short window, and back.
  await page.setViewportSize({ width: 1920, height: 520 });
  await still(page);
  await same("folded");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await still(page);
  await same("unfolded");
});

test("the join of a curve and the rule it runs into is one stroke, on device pixels, at ratios 1, 1.25, 1.5, 2 and zoom 90 and 110 %", async ({ browser }) => {
  for (const dpr of [1, 1.25, 1.5, 2, 0.9, 1.1]) {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 760 }, deviceScaleFactor: dpr, colorScheme: "dark" });
    await ctx.route(/wikipedia\.org|wikimedia\.org|stanford\.edu|example\.org/, (r) => r.abort());
    const page = await ctx.newPage();
    await library(page);
    for (const t of ["The tides", "What a proof is", "The invention of writing", "Fixed points"]) await clickOpen(page, "Library", t);
    await clickOpen(page, "The tides", "The force");
    // The focus to the last top-level pane, so The tides folds to its tab with its source out of sight.
    await pane(page, "Fixed points").locator(".pane-head h2").dispatchEvent("click");
    await still(page);
    const ls = await lines(page);
    const shot = pixels(await page.screenshot());
    const wd = Math.max(1, Math.floor(dpr + 0.01));
    const bg = (x: number, y: number) => shot.px(Math.round(x * dpr), Math.round((y - 8) * dpr));
    /** The device rows the line covers at x, near y: [row, brightness above the ground]. */
    const column = (x: number, y: number) => {
      const g = bg(x, y);
      const out: [number, number][] = [];
      for (let r = Math.floor((y - 3) * dpr); r <= Math.ceil((y + 3) * dpr); r++) {
        const p = shot.px(Math.round(x * dpr), r);
        const d = p.reduce((s, v, i) => s + Math.abs(v - g[i]), 0);
        if (d > 9) out.push([r, Math.round(d / 3)]);
      }
      return out;
    };
    /** The same rows, as bright but for a unit or two of rounding. */
    const sameLine = (a: [number, number][], b: [number, number][]) => a.length === b.length && a.every(([r, v], i) => r === b[i][0] && Math.abs(v - b[i][1]) <= 2);
    const joins = ls.filter((l) => l.ruled.includes("head"));
    expect(joins.length, `dpr ${dpr}`).toBeGreaterThan(0);
    for (const l of joins) {
      const x0 = Math.max(l.rule!.left, l.end.x - 400);
      // Just inside the rule and further along it: the same rows, the same colour, and as many rows as a hairline has.
      const a = column(l.rule!.left + 3, l.rule!.y);
      const b = column((x0 + l.end.x) / 2, l.rule!.y);
      expect(sameLine(a, b), `dpr ${dpr} rule of ${l.to}: ${JSON.stringify([a, b])}`).toBe(true);
      expect(a.length, `dpr ${dpr} rows ${JSON.stringify(a)}`).toBe(wd);
    }
    // Out of a folded pane's tab: its foot and the curve on from it are one line.
    const out = ls.find((l) => near(l.start.y, l.fromFoot.y, 1) && l.start.x >= l.fromFoot.right - 3);
    expect(out, `dpr ${dpr}: a curve out of a tab's foot`).toBeTruthy();
    const f = column(out!.start.x - 6, out!.start.y);
    const c = column(out!.start.x + 2, out!.start.y);
    expect(sameLine(f, c), `dpr ${dpr} foot: ${JSON.stringify([f, c])}`).toBe(true);
    expect(f.length).toBe(wd);
    await ctx.close();
  }
});

test("a pane folded or scrolled past its title shows its tab, and its curve lands in the tab's foot; with its title in sight, in the title's rule", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 760 });
  await library(page);
  for (const t of ["The tides", "What a proof is", "The invention of writing", "Fixed points"]) await clickOpen(page, "Library", t);
  await clickOpen(page, "The tides", "The force");
  await pane(page, "Fixed points").locator(".pane-head h2").dispatchEvent("click");
  await still(page);
  let ls = await lines(page);
  let checked = 0;
  for (const t of ["The tides", "What a proof is", "The invention of writing", "Fixed points"]) {
    const id = await tid(page, t);
    const l = ls.find((x) => x.to === id && x.from !== id);
    // Below the column's foot, a curve stops there, dotted.
    if (!l || l.cls.includes("lost") || l.focused) continue;
    checked++;
    const visible = await pane(page, t).evaluate((p) => {
      const h = p.querySelector<HTMLElement>(".pane-head, .top h1")!.getBoundingClientRect();
      const r = p.getBoundingClientRect();
      const next = (p.nextElementSibling as HTMLElement | null)?.getBoundingClientRect().top ?? Infinity;
      const covered = p.hasAttribute("data-covered") || p.hasAttribute("data-scrolled");
      return h.bottom > r.top + (covered ? 30 : 0) + 4 && h.bottom < Math.min(next, p.parentElement!.getBoundingClientRect().bottom);
    });
    const info = JSON.stringify({ end: l.end, rule: l.rule, foot: l.foot, ruled: l.ruled, folded: l.folded, cls: l.cls, visible });
    if (visible) expect(near(l.end.y, l.rule!.y), `${t} into its title's rule ${info}`).toBe(true);
    else expect(near(l.end.y, l.foot.y), `${t} into its tab's foot ${info}`).toBe(true);
  }
  expect(checked).toBeGreaterThan(1);
  // A curve out of a folded pane leaves from the right end of its tab's foot, solid.
  const force = await tid(page, "The force");
  await expect(pane(page, "The tides")).toHaveAttribute("data-covered", "");
  ls = await lines(page);
  const out = ls.find((l) => l.to === force)!;
  expect(out.cls).not.toContain("lost");
  expect(near(out.start.y, out.fromFoot.y)).toBe(true);
  expect(near(out.start.x, out.fromFoot.right, 1.5)).toBe(true);

  // A plain pane scrolled past its title: its tab at its top, the curve into its foot; back up, into the rule again.
  const sc = pane(page, "The force").locator(".pane-scroll");
  await sc.evaluate((el) => (el.scrollTop = 300));
  await expect(pane(page, "The force")).toHaveAttribute("data-scrolled", "");
  await still(page);
  expect(await pane(page, "The force").locator(".tabline").evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  let l = (await lines(page)).find((x) => x.to === force)!;
  expect(near(l.end.y, l.foot.y), `scrolled: ${l.end.y} ${l.foot.y}`).toBe(true);
  expect(l.ruled).toContain("tab");
  await sc.evaluate((el) => (el.scrollTop = 0));
  await expect(pane(page, "The force")).not.toHaveAttribute("data-scrolled", "");
  await still(page);
  l = (await lines(page)).find((x) => x.to === force)!;
  expect(near(l.end.y, l.rule!.y)).toBe(true);
});

test("a pane covered across and down peeks out whole on both axes; the wheel scrolls it and it stays out; the selection bar of a pane under it is covered", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 760 });
  await library(page);
  for (const t of ["The tides", "What a proof is", "The invention of writing", "Fixed points"]) await clickOpen(page, "Library", t);
  await clickOpen(page, "Fixed points", "Recursion without names");
  await clickOpen(page, "Recursion without names", "fixed-point combinator", ".lnk, .anchor");
  await expect(pane(page, "Fixed-point combinator").locator(".wrow").first()).toBeVisible();
  await still(page);
  // The top-level trees' column is covered to spines, and folded down: hover the spine of a folded pane in it.
  const col = pane(page, "The tides").locator("xpath=..");
  expect(await col.evaluate((c) => c.hasAttribute("data-covered") || !!c.nextElementSibling?.hasAttribute("data-over"))).toBe(true);
  const tides = pane(page, "The tides");
  await expect(tides).toHaveAttribute("data-covered", "");
  const tb = (await tides.boundingBox())!;
  const sp = { x: tb.x + 4, y: tb.y - 45, width: 20 };
  await page.mouse.move(sp.x + sp.width / 2, sp.y + 60);
  await expect(col).toHaveAttribute("data-peek", "");
  await expect(tides).toHaveAttribute("data-peek", "");
  const vp = page.viewportSize()!;
  const r = (await tides.boundingBox())!;
  const c = (await col.boundingBox())!;
  expect(r.width).toBeGreaterThan(600);
  expect(c.width).toBeGreaterThan(600);
  expect(r.y).toBeGreaterThanOrEqual(c.y - 1);
  expect(r.y + r.height).toBeLessThanOrEqual(Math.min(c.y + c.height, vp.height) + 1);
  // What is under the pointer is that pane, whole: the wheel scrolls its text, and it stays out.
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.waitForTimeout(250);
  await expect(tides).toHaveAttribute("data-peek", "");
  const before = await tides.locator(".pane-scroll").evaluate((el) => el.scrollTop);
  await page.mouse.wheel(0, 240);
  await expect.poll(() => tides.locator(".pane-scroll").evaluate((el) => el.scrollTop)).toBeGreaterThan(before);
  await frames(page);
  await expect(tides).toHaveAttribute("data-peek", "");
  await expect(col).toHaveAttribute("data-peek", "");
  // Away: back.
  await page.mouse.move(vp.width - 10, vp.height / 2);
  await expect(col).not.toHaveAttribute("data-peek", "");

  // The selection bar: shown in its pane; a pane peeking over it covers it.
  const rec = pane(page, "Recursion without names");
  // A couple of words at the start of its text, dragged over: the bar sits by them, near the pane's left.
  const para = (await rec.locator(".pane-body .para").first().boundingBox())!;
  await page.mouse.move(para.x + 2, para.y + 10);
  await page.mouse.down();
  await page.mouse.move(para.x + 30, para.y + 10, { steps: 4 });
  await page.mouse.move(para.x + 60, para.y + 10, { steps: 4 });
  await page.mouse.up();
  const bar = page.locator(".selbar");
  await expect(bar).toBeVisible();
  expect(await bar.evaluate((el) => !!el.closest(".pane"))).toBe(true);
  const b = (await bar.boundingBox())!;
  const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".selbar"), at)).toBe(true);
  // Peek the top-level trees' column (to the left, covered): it slides out over the pane with the bar.
  await page.mouse.move(sp.x + sp.width / 2, sp.y + 60);
  await expect(col).toHaveAttribute("data-peek", "");
  const over = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return { bar: !!el?.closest(".selbar"), peeked: !!el?.closest("[data-peek]") };
  }, at);
  const cb = (await col.boundingBox())!;
  expect(at.x).toBeLessThan(cb.x + cb.width);
  expect(over).toEqual({ bar: false, peeked: true });
  expect(await state(page, (s) => s.selectedText())).not.toBeNull();
});
