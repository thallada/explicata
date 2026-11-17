/**
 * The pages layout (src/ui/pages.ts, Pages.tsx): the panes on a phone, one column at a time. Driven
 * as a phone is: a 390×844 touch screen at device scale 3, taps, and swipes made of real touch
 * events (through the DevTools protocol, so the browser's own scrolling, snapping and momentum
 * are what is tested). Also 360×640, a tablet held upright (768), and turning to landscape, which
 * at 900 px or more shows the panes side by side, the same panes. With PHONE_SHOTS set to a
 * directory, each state is saved there, light and dark.
 */
import { expect, test, type Page } from "@playwright/test";
import { autoLayout, seedLinks, settle, state } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

const SHOTS = process.env.PHONE_SHOTS;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await frames(page);
    await page.screenshot({ path: `${SHOTS}/${name}-${colorScheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function start(page: Page) {
  await seedLinks(page.request);
  await autoLayout(page);
  await page.goto("/");
  await page.waitForFunction(() => (globalThis as any).__ie?.ready);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator(".panes[data-layout=pages]")).toHaveCount(1);
}

/** The page the strip rests on. */
const pageIndex = (page: Page) =>
  page.evaluate(() => {
    const s = document.querySelector<HTMLElement>(".strip")!;
    return Math.round(s.scrollLeft / s.clientWidth);
  });
/** Whether the strip rests exactly on a page. */
const snapped = (page: Page) =>
  page.evaluate(() => {
    const s = document.querySelector<HTMLElement>(".strip")!;
    return Math.abs(s.scrollLeft - Math.round(s.scrollLeft / s.clientWidth) * s.clientWidth) < 1.5;
  });
/** What the active pane shows. */
const active = (page: Page) =>
  state(page, (s) => {
    const n = s.branchNodes[s.paneAt];
    return n.ref.kind === "node" ? s.snap.nodes[n.ref.id].title : n.ref.title;
  });
const activeTid = (page: Page) => state(page, (s) => s.branchNodes[s.paneAt].id as number);
/** Where the reader is, once the strip has come to rest: the active pane, and the page on screen. */
async function at(page: Page, title: string, index: number) {
  await expect.poll(() => active(page)).toBe(title);
  await expect.poll(() => pageIndex(page)).toBe(index);
  await expect.poll(() => snapped(page)).toBe(true);
}
const row = (page: Page, title: string) => page.locator(".pane.active .rows .row", { hasText: title }).first();
const steps = (page: Page) => page.locator(".trail .trail-step .trail-t").allTextContents();

/** A swipe of a finger across the screen, by real touch events. */
async function swipe(page: Page, dx: number, dy = 0, from = { x: dx > 0 ? 80 : 310, y: 520 }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  const n = 12;
  for (let k = 1; k <= n; k++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + (dx * k) / n, y: from.y + (dy * k) / n }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** A colour as RGB, whatever notation the browser gives it in. */
const rgb = (page: Page, css: string) =>
  page.evaluate((c) => {
    const cx = document.createElement("canvas").getContext("2d")!;
    cx.fillStyle = "#000";
    cx.fillStyle = c;
    cx.fillRect(0, 0, 1, 1);
    return [...cx.getImageData(0, 0, 1, 1).data.slice(0, 3)].join(",");
  }, css);
const firstColour = (s: string) => /(oklch|oklab|rgba?|color)\([^)]*\)/.exec(s)?.[0] ?? s;

test.afterEach(async ({ page }) => settle(page));

test("a tap on a row pages forward to its pane; a swipe goes back and forth; Back goes back a pane and Forward forward", async ({ page }) => {
  await start(page);
  await expect(page.locator(".strip > .col")).toHaveCount(1);
  expect(await steps(page)).toEqual(["Library"]);
  await shot(page, "01-library");
  const entries = await page.evaluate(() => history.length);
  await row(page, "Fixed points").tap();
  await at(page, "Fixed points", 1);
  expect(await steps(page)).toEqual(["Library", "Fixed points"]);
  await expect(page.locator(".trail-step.here")).toHaveText("Fixed points");
  await shot(page, "02-opened");
  await row(page, "Recursion without names").tap();
  await at(page, "Recursion without names", 2);
  expect(await steps(page)).toEqual(["Library", "Fixed points", "Recursion without names"]);
  // One entry in the browser's history per pane gone to.
  expect(await page.evaluate(() => history.length)).toBe(entries + 2);
  await shot(page, "03-deeper");
  // A swipe to the right: back to the pane it was opened from, which is the browser's Back too.
  await swipe(page, 260);
  await at(page, "Fixed points", 1);
  expect(await page.evaluate(() => history.state?.i)).toBe(1);
  // The panes stay; the trail runs on past the one on screen.
  expect(await steps(page)).toEqual(["Library", "Fixed points", "Recursion without names"]);
  await expect(page.locator(".trail-step.ahead")).toHaveText("Recursion without names");
  await shot(page, "04-swiped-back");
  await swipe(page, -260);
  await at(page, "Recursion without names", 2);
  expect(await page.evaluate(() => history.length)).toBe(entries + 2);
  // A swipe down a pane scrolls its text, and turns no page.
  const scroll = page.locator(".pane.active .pane-scroll");
  await swipe(page, 0, -300, { x: 200, y: 600 });
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  expect(await pageIndex(page)).toBe(2);
  // The browser's Back and Forward (its button, or the edge swipe).
  await page.goBack();
  await at(page, "Fixed points", 1);
  await page.goBack();
  await at(page, "Library", 0);
  await page.goForward();
  await at(page, "Fixed points", 1);
  // The trail: a tap on a step goes there.
  await page.locator(".trail-step", { hasText: "Recursion without names" }).tap();
  await at(page, "Recursion without names", 2);
  // A reload keeps the panes, the page and Back.
  await page.reload();
  await page.waitForFunction(() => (globalThis as any).__ie?.ready);
  await at(page, "Recursion without names", 2);
  await page.goBack();
  await at(page, "Fixed points", 1);
});

test("panes opened from one pane stack down one page, each in its colour, the colour of what opened it", async ({ page }) => {
  await start(page);
  for (const t of ["Fixed points", "Octopus minds", "Where the elements come from"]) {
    await page.locator(".trail-step", { hasText: "Library" }).tap();
    await at(page, "Library", 0);
    await row(page, t).tap();
    await at(page, t, 1);
  }
  const col = page.locator(".strip > .col").nth(1);
  await expect(col.locator(":scope > .pane")).toHaveCount(3);
  await expect(page.locator(".strip > .col")).toHaveCount(2);
  // Too many for the page: they stack as on a wide screen, those not looked at folded to tabs a finger high.
  await expect(col).toHaveClass(/crowded/);
  const tabs = col.locator(":scope > .pane[data-tab] > .tabline");
  await expect.poll(() => tabs.count()).toBeGreaterThan(0);
  for (const b of await tabs.all()) expect(Math.round((await b.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
  await shot(page, "05-stacked");
  // Each a colour of its own (each opened from the library); its row in the library has it, and so does its step in the trail.
  const hues = await col.locator(":scope > .pane").evaluateAll((ps) => ps.map((p) => (p as HTMLElement).dataset.hue));
  expect(new Set(hues).size).toBe(3);
  await page.locator(".trail-step", { hasText: "Library" }).tap();
  await at(page, "Library", 0);
  const marks = await page.locator(".pane.root .rows .node[data-src-hue]").evaluateAll((ns) => ns.map((n) => [(n.querySelector(".title") as HTMLElement).textContent, (n as HTMLElement).dataset.srcHue]));
  expect(marks).toHaveLength(3);
  for (const [title, hue] of marks) {
    const p = page.locator(".strip .pane", { has: page.locator(`.pane-head h2:text-is("${title}")`) });
    expect(await p.getAttribute("data-hue"), title!).toBe(hue);
  }
  await shot(page, "06-library-marked");
  // A tab, tapped, is that pane.
  await page.locator(".trail-step", { hasText: "Where the elements come from" }).tap();
  await at(page, "Where the elements come from", 1);
  const tab = col.locator(":scope > .pane[data-tab] > .tabline").first();
  const tabbed = await tab.locator(".tabtitle").textContent();
  await tab.tap();
  await at(page, tabbed!, 1);
  // A link followed: the article's pane, its title's rule and its step in the trail in the colour of the link's underline.
  await page.locator(".trail-step", { hasText: "Library" }).tap();
  await row(page, "Fixed points").tap();
  await at(page, "Fixed points", 1);
  await row(page, "Recursion without names").tap();
  await at(page, "Recursion without names", 2);
  const link = page.locator(".strip .pane", { has: page.locator('.pane-head h2:text-is("Recursion without names")') }).locator(".lnk", { hasText: "fixed-point combinator" }).first();
  await link.tap();
  await at(page, "Fixed-point combinator", 3);
  const wiki = page.locator(".strip .pane.active");
  await expect(wiki).toHaveClass(/wiki-pane/);
  await expect(wiki.locator(".wiki-head h2")).toBeVisible();
  const hue = await wiki.getAttribute("data-hue");
  await expect(link).toHaveAttribute("data-src-hue", hue!);
  await expect(link).toHaveAttribute("data-src-on", "");
  const under = await rgb(page, await link.evaluate((el) => getComputedStyle(el).textDecorationColor));
  const rule = await rgb(page, await wiki.locator(".wiki-head").evaluate((el) => getComputedStyle(el).borderBottomColor));
  expect(under).toBe(rule);
  expect(under).not.toBe("0,0,0");
  await expect(page.locator(".trail-step.here")).toHaveAttribute("data-hue", hue!);
  // A section's row carries its pane's colour the same way.
  const showing = page.locator(".strip > .col").nth(1).locator(".pane.on-branch .node[data-src-on] > .row").first();
  const bar = await rgb(page, firstColour(await showing.evaluate((el) => getComputedStyle(el).boxShadow)));
  const head = await rgb(page, await page.locator(".strip > .col").nth(2).locator(".pane.on-branch .pane-head").evaluate((el) => getComputedStyle(el).borderBottomColor));
  expect(bar).toBe(head);
  await shot(page, "07-article");
  await swipe(page, 260);
  await at(page, "Recursion without names", 2);
  await shot(page, "08-link-coloured");
});

test("pin and close from a pane's buttons, its ⋯, and the map of every open pane", async ({ page }) => {
  await start(page);
  await row(page, "Fixed points").tap();
  await at(page, "Fixed points", 1);
  await row(page, "Recursion without names").tap();
  await at(page, "Recursion without names", 2);
  // Its buttons show without a hover, a finger's size.
  const ctl = page.locator(".pane.active > .pane-ctl > .pane-btn");
  await expect(ctl).toHaveCount(3);
  for (const b of await ctl.all()) {
    await expect(b).toBeVisible();
    const r = (await b.boundingBox())!;
    expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(40);
  }
  await page.locator(".pane.active > .pane-ctl > .pin").tap();
  await expect.poll(() => state(page, (s) => !!s.branchNodes[s.paneAt].pinned)).toBe(true);
  // Its ⋯: the pane's menu, a sheet.
  await page.locator(".pane.active > .pane-ctl > .more").tap();
  const sheet = page.locator(".menu.sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".mi", { hasText: "Unpin this pane" }).or(sheet.locator(".mi", { hasText: "Pin this pane" }))).toHaveCount(1);
  for (const m of await sheet.locator(".mi").all()) expect((await m.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  await shot(page, "09-pane-menu");
  // A tap outside puts it away (on the status line, where a tap does nothing else).
  const status = (await page.locator(".status").boundingBox())!;
  await page.touchscreen.tap(200, status.y + status.height / 2);
  await expect(sheet).toHaveCount(0);
  // The map: every pane, indented by where it opened from, the active one marked.
  await page.locator(".trail-map").tap();
  const map = page.locator(".pane-map");
  await expect(map).toBeVisible();
  await expect(map.locator(".map-t")).toHaveText(["Library", "Fixed points", "Recursion without names"]);
  await expect(map.locator(".map-row.here .map-t")).toHaveText("Recursion without names");
  const pads = await map.locator(".map-row").evaluateAll((rs) => rs.map((r) => parseFloat(getComputedStyle(r).paddingLeft)));
  expect(pads[1]).toBeGreaterThan(pads[0]);
  expect(pads[2]).toBeGreaterThan(pads[1]);
  await expect(map.locator(".map-row.pinned .map-t")).toHaveText("Recursion without names");
  for (const b of await map.locator(".map-go, .map-btn").all()) expect(Math.round((await b.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
  await shot(page, "10-map");
  // A tap on a pane goes to it, and puts the map away.
  await map.locator(".map-go", { hasText: "Library" }).tap();
  await expect(map).toHaveCount(0);
  await at(page, "Library", 0);
  // Closing Fixed points from the map: the pinned pane stays, its source closed.
  await page.locator(".trail-map").tap();
  await map.locator(".map-row", { hasText: "Fixed points" }).locator(".map-btn.close").tap();
  await expect(map.locator(".map-t")).toHaveText(["Library", "Recursion without names"]);
  await expect(map.locator(".map-sub")).toHaveText("its source closed");
  await shot(page, "11-map-orphan");
  await page.keyboard.press("Escape");
  await expect(map).toHaveCount(0);
  // A pane's own ×: it closes, and the page goes back to where it was opened from.
  await row(page, "Octopus minds").tap();
  await at(page, "Octopus minds", 1);
  await page.locator(".pane.active > .pane-ctl > .close").tap();
  await expect(page.locator(".strip .pane-head h2", { hasText: "Octopus minds" })).toHaveCount(0);
  await at(page, "Library", 0);
  // The first pane has no ×.
  await expect(page.locator(".pane.root > .pane-ctl > .close")).toBeHidden();
});

test("a tap on a sentence: the selection bar at the foot, a finger's size; a long press on a link shows what it opens", async ({ page }) => {
  await start(page);
  await row(page, "Fixed points").tap();
  await row(page, "Recursion without names").tap();
  await at(page, "Recursion without names", 2);
  // Words with no note or link on them.
  const spot = await page.evaluate(() => {
    const body = document.querySelector(".pane.active .pane-body > .body")!;
    const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      const i = t.textContent!.indexOf("cannot call itself");
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(t, i + 3);
      r.setEnd(t, i + 5);
      const b = r.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
    return null;
  });
  await page.touchscreen.tap(spot!.x, spot!.y);
  const bar = page.locator(".selbar.docked");
  await expect(bar).toBeVisible();
  expect(await state(page, (s) => s.selectedText())).toBeTruthy();
  const b = (await bar.boundingBox())!;
  const status = (await page.locator(".status").boundingBox())!;
  expect(Math.abs(b.y + b.height - status.y)).toBeLessThan(2);
  expect(Math.round(b.width)).toBe(390);
  for (const x of await bar.locator("button").all()) expect(Math.round((await x.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
  const sel = (await page.locator(".pane.active .sel").last().boundingBox())!;
  expect(sel.y + sel.height).toBeLessThanOrEqual(b.y);
  await shot(page, "12-selection");
  await bar.locator(".bar-done").tap();
  await expect(bar).toHaveCount(0);
  // A long press (the browser's contextmenu) on a link: its card above its menu; Open goes there.
  const link = page.locator(".pane.active .lnk", { hasText: "fixed-point combinator" }).first();
  const l = (await link.boundingBox())!;
  await link.dispatchEvent("contextmenu", { clientX: l.x + 10, clientY: l.y + 5, bubbles: true, cancelable: true });
  const sheet = page.locator(".menu.sheet");
  await expect(sheet.locator(".menu-card .lcard")).toBeVisible();
  await expect(sheet.locator(".menu-card")).toContainText("Fixed-point combinator");
  await shot(page, "13-link-card");
  await sheet.locator(".mi", { hasText: "Open the link" }).tap();
  await at(page, "Fixed-point combinator", 3);
});

test("the libraries panel, the top menu, and the other layouts are a tap away; a hardware keyboard still works", async ({ page }) => {
  await start(page);
  await row(page, "Fixed points").tap();
  await at(page, "Fixed points", 1);
  // The top bar's tools, a finger high.
  for (const t of await page.locator(".docbar .tool").all()) expect(Math.round((await t.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
  await page.locator(".docbar .lib-name").tap();
  const panel = page.locator(".panel.left.libraries");
  await expect(panel).toBeVisible();
  const r = (await panel.boundingBox())!;
  expect([r.x, Math.round(r.width)]).toEqual([0, 390]);
  for (const x of await panel.locator(".lib-row, .key").all()) {
    const b = (await x.boundingBox())!;
    expect(Math.round(Math.min(b.width, b.height))).toBeGreaterThanOrEqual(40);
  }
  await shot(page, "14-libraries");
  await page.locator(".docbar .lib-name").tap();
  await expect(panel).toHaveCount(0);
  // The menu: a sheet, with the layouts. One column, then back to the pages, the same panes.
  const menu = () => page.locator(".docbar .tool[aria-haspopup=menu]").tap();
  await menu();
  await expect(page.locator(".menu.sheet")).toBeVisible();
  await shot(page, "15-top-menu");
  await page.locator(".menu.sheet .choices button", { hasText: "column" }).tap();
  await expect(page.locator(".strip")).toHaveCount(0);
  await expect(page.locator(".trail")).toHaveCount(0);
  await expect(page.locator("article > .outline > .node").first()).toBeVisible();
  await shot(page, "16-column");
  await menu();
  await page.locator(".menu.sheet .choices button", { hasText: "auto" }).tap();
  await at(page, "Fixed points", 1);
  // /view panes: side by side even here; /view auto: pages again.
  await page.keyboard.press(":");
  await page.keyboard.type("/view panes");
  await page.keyboard.press("Enter");
  await expect(page.locator(".panes:not([data-layout])")).toHaveCount(1);
  await page.keyboard.press(":");
  await page.keyboard.type("/view auto");
  await page.keyboard.press("Enter");
  await at(page, "Fixed points", 1);
  // Keys: Alt+h to where the pane was opened from, Alt+l back; l on a row opens it and goes there.
  await page.keyboard.press("Alt+h");
  await at(page, "Library", 0);
  await page.keyboard.press("Alt+l");
  await at(page, "Fixed points", 1);
  await page.keyboard.press("j");
  const first = (await page.locator(".pane.active .rows .row .title").first().textContent())!;
  await page.keyboard.press("l");
  await at(page, first, 2);
  await page.keyboard.press("h");
  await at(page, "Fixed points", 1);
});

test("turned to landscape at 900 px or more the panes stand side by side, the same panes and the same active one; turned back, pages again", async ({ page }) => {
  await start(page);
  await row(page, "Fixed points").tap();
  await row(page, "Recursion without names").tap();
  await at(page, "Recursion without names", 2);
  await page.locator(".trail-step", { hasText: "Library" }).tap();
  await row(page, "Octopus minds").tap();
  await at(page, "Octopus minds", 1);
  await page.locator(".trail-step", { hasText: "Library" }).tap();
  await row(page, "Fixed points").tap();
  await row(page, "Recursion without names").tap();
  await at(page, "Recursion without names", 2);
  const tids = () => page.locator(".strip .pane").evaluateAll((ps) => ps.map((p) => Number((p as HTMLElement).dataset.tid)).sort((a, b) => a - b));
  const before = await tids();
  const was = await activeTid(page);
  expect(before).toHaveLength(4);
  await page.setViewportSize({ width: 1000, height: 600 });
  await expect(page.locator(".panes:not([data-layout])")).toHaveCount(1);
  await expect(page.locator(".trail")).toHaveCount(0);
  expect(await tids()).toEqual(before);
  expect(await activeTid(page)).toBe(was);
  // Columns a pane wide, stacked as on a laptop, the earlier ones under the later as spines.
  await expect(page.locator(".pane.active .pane-head h2")).toHaveText("Recursion without names");
  const widths = await page.locator(".strip > .col").evaluateAll((cs) => cs.map((c) => Math.round(c.getBoundingClientRect().width)));
  for (const w of widths) expect(w).toBeLessThan(1000);
  await expect(page.locator(".strip > .col[data-covered]")).not.toHaveCount(0);
  await shot(page, "17-landscape");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".panes[data-layout=pages]")).toHaveCount(1);
  await at(page, "Recursion without names", 2);
  expect(await tids()).toEqual(before);
  expect(await page.locator(".curves path").count()).toBe(0);
  // Back still goes back a pane.
  await page.goBack();
  await at(page, "Fixed points", 1);
});

for (const [width, height] of [
  [390, 844],
  [360, 640],
  [768, 1024],
] as const)
  test(`at ${width}×${height}: nothing scrolls sideways, and what a finger presses is at least 40 px each way`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await start(page);
    await row(page, "Fixed points").tap();
    await at(page, "Fixed points", 1);
    await row(page, "Recursion without names").tap();
    await at(page, "Recursion without names", 2);
    const wide = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
    expect(await wide()).toBe(true);
    // Each page is the screen's width.
    const cols = await page.locator(".strip > .col").evaluateAll((cs) => cs.map((c) => Math.round(c.getBoundingClientRect().width)));
    for (const w of cols) expect(w).toBe(width);
    const small = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>(".trail-step, .trail-map, .docbar .tool, .pane.active > .pane-ctl > .pane-btn, .pane.active .rows .row")) {
        const r = el.getBoundingClientRect();
        if (!r.width || getComputedStyle(el).display === "none") continue;
        if (r.width < 40 || r.height < 40) out.push(`${el.className} ${el.textContent?.slice(0, 20)} ${r.width}×${r.height}`);
      }
      return out;
    });
    expect(small).toEqual([]);
    await shot(page, `18-size-${width}`);
    await page.locator(".trail-map").tap();
    expect(await wide()).toBe(true);
    await shot(page, `19-size-${width}-map`);
  });
