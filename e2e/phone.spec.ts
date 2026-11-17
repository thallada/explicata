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
  for (const m of await sheet.locator(".mi, .choices button").all()) {
    const b = (await m.boundingBox())!;
    expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(40);
  }
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


// ---- the second round: what the owner found on a real phone ----

/** A press of a finger, by real touch events: down at a point, held, moved through points (each a frame apart), and lifted. */
async function press(page: Page, from: { x: number; y: number }, opts: { hold?: number; to?: { x: number; y: number }[]; steps?: number; wait?: number } = {}) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  if (opts.hold) await page.waitForTimeout(opts.hold);
  let at = from;
  for (const to of opts.to ?? []) {
    const n = opts.steps ?? 10;
    for (let k = 1; k <= n; k++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: at.x + ((to.x - at.x) * k) / n, y: at.y + ((to.y - at.y) * k) / n }] });
      await page.waitForTimeout(16);
    }
    at = to;
  }
  if (opts.wait) await page.waitForTimeout(opts.wait);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** A tap of a finger at a point, by real touch events (the browser then sends its compatibility mouse events, as a phone's does). */
const touchTap = (page: Page, x: number, y: number) => press(page, { x, y }, { hold: 40 });

/** Open these top-level sections from the library, each in a pane of its own down the second page; the last opened is the active one. */
async function stackFromLibrary(page: Page, titles: string[]) {
  for (const t of titles) {
    await page.locator(".trail-step", { hasText: "Library" }).tap();
    await at(page, "Library", 0);
    await row(page, t).tap();
    await at(page, t, 1);
  }
}

/** The active pane's page, measured: its height, and how much of each pane in it shows (down to what covers it), top to bottom. */
const shown = (page: Page) =>
  page.evaluate(() => {
    const p = document.querySelector<HTMLElement>(".strip .pane.active")!;
    const col = p.parentElement!;
    const c = col.getBoundingClientRect();
    const ps = [...col.querySelectorAll<HTMLElement>(":scope > .pane")];
    const vis = ps.map((q, i) => {
      const r = q.getBoundingClientRect();
      const next = col.classList.contains("crowded") ? (ps[i + 1]?.getBoundingClientRect().top ?? Infinity) : Infinity;
      return Math.round(Math.max(0, Math.min(r.bottom, c.bottom, next) - Math.max(r.top, c.top)));
    });
    return { h: Math.round(c.height), vis, active: ps.indexOf(p), crowded: col.classList.contains("crowded"), titles: ps.map((q) => q.querySelector(".tabtitle")!.textContent) };
  });

for (const [width, height] of [
  [390, 844],
  [360, 640],
] as const)
  test(`at ${width}×${height}, the pane gone to in a shared page has the page's height; the others fold to their tabs (two panes and three)`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await start(page);
    await stackFromLibrary(page, ["Fixed points", "Octopus minds"]);
    let s = await shown(page);
    expect(s.vis).toHaveLength(2);
    // Two panes, each too long for half the page: the one gone to has all but the other's tab.
    expect(s.crowded).toBe(true);
    expect(s.vis[s.active]).toBeGreaterThanOrEqual(s.h - 44 - 2);
    expect(s.vis[1 - s.active]).toBeLessThanOrEqual(46);
    await shot(page, `20-two-panes-${width}`);
    // A tap on the other's tab: it has the height now.
    const other = page.locator(".strip .pane.active").locator("xpath=..").locator(":scope > .pane:not(.active) > .tabline");
    await other.first().tap();
    await expect.poll(async () => (await shown(page)).active).toBe(1 - s.active);
    s = await shown(page);
    expect(s.vis[s.active]).toBeGreaterThanOrEqual(s.h - 44 - 2);
    expect(s.vis[1 - s.active]).toBeLessThanOrEqual(46);
    await stackFromLibrary(page, ["Where the elements come from"]);
    s = await shown(page);
    expect(s.vis).toHaveLength(3);
    expect(s.vis[s.active]).toBeGreaterThanOrEqual(s.h - 2 * 44 - 2);
    for (const [i, v] of s.vis.entries()) if (i !== s.active) expect(v).toBeLessThanOrEqual(46);
    await shot(page, `21-three-panes-${width}`);
    // Swiped back and forth, the page comes back the same: the active pane whole.
    await swipe(page, 260);
    await at(page, "Library", 0);
    await swipe(page, -260);
    await expect.poll(async () => (await shown(page)).vis[(await shown(page)).active]).toBeGreaterThanOrEqual(s.h - 2 * 44 - 2);
  });

test("on a wide screen a column still shares its height among panes that fit (the panes view is unchanged)", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await seedLinks(page.request);
  await autoLayout(page);
  await page.goto("/");
  await page.waitForFunction(() => (globalThis as any).__ie?.ready);
  await expect(page.locator(".panes:not([data-layout])")).toHaveCount(1);
  for (const t of ["Fixed points", "Octopus minds"]) await page.locator(".pane.root .rows .row", { hasText: t }).first().click();
  const col = page.locator(".strip > .col").nth(1);
  await expect(col.locator(":scope > .pane")).toHaveCount(2);
  await expect(col).not.toHaveClass(/crowded/);
});

test("the trail says how many panes each page holds: a dot each, the step's own filled; past four, their number; at 360 with a deep trail and long titles", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await start(page);
  await stackFromLibrary(page, ["Octopus minds", "Fixed points", "Where the elements come from"]);
  const step = page.locator(".trail-step.here");
  await expect(step).toHaveAttribute("data-col-panes", "3");
  await expect(step.locator(".trail-stack i")).toHaveCount(3);
  const place = (await shown(page)).active;
  const dots = await step.locator(".trail-stack i").evaluateAll((is) => is.map((i) => i.classList.contains("on")));
  expect(dots.indexOf(true)).toBe(place);
  expect(dots.filter(Boolean)).toHaveLength(1);
  // The filled dot is the step's colour.
  const fill = await rgb(page, await step.locator(".trail-stack i.on").evaluate((el) => getComputedStyle(el).backgroundColor));
  const hue = await rgb(page, await step.evaluate((el) => getComputedStyle(el).getPropertyValue("--hue")));
  expect(fill).toBe(hue);
  // A page of one pane says nothing.
  await expect(page.locator(".trail-step", { hasText: "Library" }).locator(".trail-stack, .trail-count")).toHaveCount(0);
  await expect(step).toHaveAttribute("aria-label", /of 3 panes on its page/);
  await stackFromLibrary(page, ["What a proof is", "The one merger"]);
  await expect(page.locator(".trail-step.here")).toHaveAttribute("data-col-panes", "5");
  await expect(page.locator(".trail-step.here .trail-count")).toHaveText("5");
  await shot(page, "22-trail-counts-360");
  // A deep trail with long titles: two panes on the third page, then deeper. The step on screen stays in view, each step a finger wide.
  const titles = page.locator(".pane.active .rows .row .title");
  const firstRows = (await titles.allTextContents()).slice(0, 2);
  await titles.first().tap();
  await expect.poll(() => active(page)).toBe(firstRows[0]);
  await page.locator(".trail-step").nth(1).tap();
  await row(page, firstRows[1]).tap();
  await expect.poll(() => active(page)).toBe(firstRows[1]);
  await expect(page.locator(".trail-step.here")).toHaveAttribute("data-col-panes", "2");
  for (let d = 0; d < 2; d++) {
    if (!(await titles.count())) break;
    const t = (await titles.first().textContent())!;
    await titles.first().tap();
    await expect.poll(() => active(page)).toBe(t);
  }
  const here = (await page.locator(".trail-step.here").boundingBox())!;
  const trail = (await page.locator(".trail-steps").boundingBox())!;
  expect(here.x).toBeGreaterThanOrEqual(trail.x - 1);
  expect(here.x + here.width).toBeLessThanOrEqual(trail.x + trail.width + 1);
  for (const b of await page.locator(".trail-step").all()) expect(Math.round((await b.boundingBox())!.height)).toBeGreaterThanOrEqual(40);
  await page.waitForTimeout(400);
  await shot(page, "23-trail-deep-360");
  await page.locator(".trail-steps").evaluate((el) => (el.scrollLeft = 0));
  await shot(page, "23b-trail-deep-360-start");
});

/** How long the strip takes to come to rest on a page after `go`: from the tap's click to its first scroll, and from its first scroll event to its last change. */
async function glideTime(page: Page, go: () => Promise<void>): Promise<{ ms: number; lag: number; frames: number }> {
  await page.evaluate(() => {
    const s = document.querySelector<HTMLElement>(".strip")!;
    const w = window as any;
    w.__glide = { click: 0, first: 0, last: 0, frames: 0, x: s.scrollLeft };
    document.addEventListener("click", () => (w.__glide.click ||= performance.now()), { capture: true, once: true });
    s.addEventListener("scroll", () => {
      const g = w.__glide;
      const now = performance.now();
      if (!g.first) g.first = now;
      if (Math.abs(s.scrollLeft - g.x) > 0.01) (g.last = now), g.frames++, (g.x = s.scrollLeft);
    });
  });
  await go();
  await expect.poll(() => snapped(page)).toBe(true);
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    const g = (window as any).__glide;
    return { ms: Math.round(g.last - g.first), lag: Math.round(g.first - g.click), frames: g.frames };
  });
}

test("a tap pages over fast: the strip glides in about 140 ms, easing out (the browser's smooth scroll took 300), at once with reduced motion; a swipe still snaps", async ({ page }) => {
  await start(page);
  const t1 = await glideTime(page, () => row(page, "Fixed points").tap());
  await at(page, "Fixed points", 1);
  const t2 = await glideTime(page, () => page.locator(".trail-step", { hasText: "Library" }).tap());
  await at(page, "Library", 0);
  console.log(`glide: forward ${t1.ms} ms in ${t1.frames} frames (${t1.lag} ms after the click), back ${t2.ms} ms in ${t2.frames} frames`);
  for (const t of [t1, t2]) {
    expect(t.ms).toBeLessThanOrEqual(180);
    expect(t.frames).toBeGreaterThanOrEqual(3);
    expect(t.lag).toBeLessThan(100);
  }
  // Snapping is the browser's again once it lands.
  await expect(page.locator(".strip[data-gliding]")).toHaveCount(0);
  expect(await page.locator(".strip").evaluate((el) => getComputedStyle(el).scrollSnapType)).toContain("mandatory");
  // A finger mid-glide takes the strip from it; where it comes to rest decides.
  await row(page, "Fixed points").tap();
  await swipe(page, 200);
  await expect.poll(() => snapped(page)).toBe(true);
  await expect.poll(async () => (await pageIndex(page)) === (await state(page, (s) => s.paneAt))).toBe(true);
  await page.locator(".trail-step", { hasText: "Library" }).tap();
  await at(page, "Library", 0);
  // Reduced motion: at once.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const t3 = await glideTime(page, () => row(page, "Fixed points").tap());
  await at(page, "Fixed points", 1);
  expect(t3.frames).toBeLessThanOrEqual(1);
});

test("the map draws the forest as a tree: a line from each parent's mark down and across into each child's, in the child's colour; an orphan has none into it; a tall forest scrolls", async ({ page }) => {
  await start(page);
  await row(page, "Fixed points").tap();
  await row(page, "Recursion without names").tap();
  await at(page, "Recursion without names", 2);
  await page.locator(".pane.active > .pane-ctl > .pin").tap();
  await stackFromLibrary(page, ["Octopus minds"]);
  await page.locator(".trail-map").tap();
  const map = page.locator(".pane-map");
  await expect(map.locator(".map-t")).toHaveText(["Library", "Fixed points", "Recursion without names", "Octopus minds"]);
  /** Every row's lines, measured: kind, where (x, top, bottom), its colour and width, and the row's own mark. */
  const measure = () =>
    map.locator(".map-row").evaluateAll((rows) =>
      rows.map((r) => {
        const rr = r.getBoundingClientRect();
        return {
          tid: Number((r as HTMLElement).dataset.map),
          hue: (r as HTMLElement).dataset.hue,
          top: rr.top,
          bottom: rr.bottom,
          rails: [...r.querySelectorAll<HTMLElement>(".rail")].map((x) => {
            const b = x.getBoundingClientRect();
            const cs = getComputedStyle(x);
            return { kind: x.dataset.rail!, to: Number(x.dataset.to), hue: x.dataset.hue, x: b.left, right: b.right, top: b.top, bottom: b.bottom, mid: rr.top + rr.height / 2, w: parseFloat(cs.borderLeftWidth) || parseFloat(cs.borderBottomWidth), color: cs.borderLeftColor !== "rgba(0, 0, 0, 0)" && parseFloat(cs.borderLeftWidth) ? cs.borderLeftColor : cs.borderBottomColor };
          }),
        };
      }),
    );
  const rows = await measure();
  const byTid = new Map(rows.map((r) => [r.tid, r]));
  const parentOf = await state(page, (s) => Object.fromEntries(s.panesPlaced.map((x: any) => [x.node.id, x.parent?.id ?? null])));
  for (const r of rows) {
    const elbow = r.rails.find((x) => x.kind === "elbow");
    const p = parentOf[r.tid];
    if (p === null) {
      expect(elbow, "a root has no line into it").toBeUndefined();
      continue;
    }
    // Into a child, in its colour: the elbow drops from the parent's line, at the parent's line's x, to the row's middle.
    expect(elbow!.hue).toBe(r.hue);
    const pr = byTid.get(p)!;
    const down = pr.rails.find((x) => x.kind === "down")!;
    expect(Math.abs(elbow!.x - down.x)).toBeLessThan(0.5);
    expect(Math.abs(elbow!.bottom - elbow!.mid)).toBeLessThan(1.5);
    // Unbroken from the parent's mark to the child's: every row between has the line at that x.
    for (const q of rows.filter((q) => q.top >= pr.bottom - 0.5 && q.bottom <= r.top + 0.5)) expect(q.rails.some((x) => (x.kind === "pass" || x.kind === "on") && Math.abs(x.x - down.x) < 0.5), `line through ${q.tid}`).toBe(true);
    // On device pixels: whole CSS pixels, so a 1 or 2 px border lands on whole device pixels at any scale.
    expect(elbow!.x).toBe(Math.round(elbow!.x));
  }
  // The colours are the panes' own: the line into Octopus minds is its pane's colour, at full strength along the focused branch.
  const oct = rows.find((r) => r.rails.some((x) => x.kind === "elbow") && r.tid === (rows[rows.length - 1].tid))!;
  const ocol = oct.rails.find((x) => x.kind === "elbow")!;
  expect(ocol.w).toBe(2);
  expect(await rgb(page, ocol.color)).toBe(await rgb(page, await page.locator(".trail-step.here").evaluate((el) => getComputedStyle(el).getPropertyValue("--hue"))));
  await shot(page, "24-map-tree");
  // An orphan: Fixed points closed, its pinned child stays, with no line into it.
  await map.locator(".map-row", { hasText: "Fixed points" }).locator(".map-btn.close").tap();
  await expect(map.locator(".map-t")).toHaveText(["Library", "Octopus minds", "Recursion without names"]);
  const orphan = map.locator(".map-row", { hasText: "Recursion without names" });
  await expect(orphan.locator(".rail[data-rail=elbow]")).toHaveCount(0);
  await expect(orphan.locator(".rail[data-rail=dash]")).toHaveCount(1);
  await shot(page, "25-map-orphan-tree");
  await page.keyboard.press("Escape");
  // A deep and wide forest: every top-level section, and three levels under the first.
  await state(page, (s) => {
    const sec = (id: string) => s.snap.nodes[id].children.filter((c: string) => s.snap.nodes[c].kind === "section");
    for (const c of sec(s.snap.root)) {
      s.land(0);
      s.openPane(0, { kind: "node", id: c });
    }
    s.land(0);
    let id = sec(s.snap.root)[0];
    s.openPane(0, { kind: "node", id });
    for (let d = 1; d <= 3 && sec(id).length; d++) {
      for (const k of sec(id).slice(0, 3)) {
        s.land(d);
        s.openPane(d, { kind: "node", id: k });
      }
      id = sec(id)[0];
      s.land(d);
      s.openPane(d, { kind: "node", id });
    }
  });
  await page.locator(".trail-map").tap();
  await expect.poll(() => map.locator(".map-row").count()).toBeGreaterThan(14);
  const tall = await map.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(tall.sh).toBeGreaterThan(tall.ch);
  const deep = await measure();
  for (const r of deep) for (const x of r.rails.filter((x) => x.kind === "elbow")) expect(x.right).toBeGreaterThan(x.x + 4);
  await shot(page, "26-map-forest");
  // A finger scrolls the sheet.
  await map.evaluate((el) => (el.scrollTop = 0));
  const m = (await map.boundingBox())!;
  await swipe(page, 0, -200, { x: 200, y: m.y + m.height - 40 });
  await expect.poll(() => map.evaluate((el) => el.scrollTop)).toBeGreaterThan(50);
  await shot(page, "26b-map-forest-scrolled");
});

test("a press held on a pane's tab or the band above its title picks it up to move it down its page; a swipe or a tap there does what it did; Move up and down in its ⋯", async ({ page }) => {
  await start(page);
  await stackFromLibrary(page, ["Fixed points", "Octopus minds", "Where the elements come from"]);
  const order = async () => (await shown(page)).titles;
  const before = await order();
  expect(before).toHaveLength(3);
  const col = page.locator(".strip > .col").nth(1);
  // The first pane's tab, held, then carried to the page's foot.
  const tab = col.locator(":scope > .pane").first().locator(":scope > .tabline");
  await expect(tab).toBeVisible();
  const t = (await tab.boundingBox())!;
  const c = (await col.boundingBox())!;
  const from = { x: t.x + 60, y: t.y + t.height / 2 };
  // Mid-carry: the pane lifted, its tab under the finger, a line where it will go; the page does not turn or scroll.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  await page.waitForTimeout(500);
  await expect(col.locator(":scope > .pane[data-lifted]")).toHaveCount(1);
  for (let k = 1; k <= 12; k++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + k, y: from.y + ((c.y + c.height - 20 - from.y) * k) / 12 }] });
    await page.waitForTimeout(16);
  }
  await expect(page.locator(".drag-ghost")).toBeVisible();
  await expect(page.locator(".drop-line")).toBeVisible();
  const g = (await page.locator(".drag-ghost").boundingBox())!;
  // Just above the finger, not under it.
  expect(g.y + g.height).toBeLessThanOrEqual(c.y + c.height - 20);
  expect(g.y + g.height).toBeGreaterThan(c.y + c.height - 20 - 60);
  expect(await pageIndex(page)).toBe(1);
  await shot(page, "28-carrying");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await expect.poll(order).toEqual([before[1], before[2], before[0]]);
  await expect(page.locator(".drag-ghost, .drop-line, .pane[data-lifted]")).toHaveCount(0);
  expect(await pageIndex(page)).toBe(1);
  await shot(page, "29-dropped");
  // The active pane, by the band above its title, carried to the top.
  const band = page.locator(".strip .pane.active > .grip");
  await expect(band).toBeVisible();
  const b = (await band.boundingBox())!;
  expect(Math.round(b.height)).toBeGreaterThanOrEqual(44);
  const activeTitle = (await shown(page)).titles[(await shown(page)).active];
  await press(page, { x: b.x + 40, y: b.y + b.height / 2 }, { hold: 500, to: [{ x: b.x + 40, y: c.y + 10 }] });
  await expect.poll(async () => (await order())[0]).toBe(activeTitle);
  // A press held too briefly, then moved, is a swipe: the page turns, nothing moves.
  const now = await order();
  const t2 = (await col.locator(":scope > .pane[data-tab]:not(.active) > .tabline").first().boundingBox())!;
  await press(page, { x: t2.x + 300, y: t2.y + 22 }, { to: [{ x: t2.x + 40, y: t2.y + 22 }] });
  await expect.poll(() => pageIndex(page)).toBe(1);
  expect(await order()).toEqual(now);
  await swipe(page, 260, 0, { x: 80, y: t2.y + 22 });
  await at(page, "Library", 0);
  await swipe(page, -260);
  await expect.poll(() => pageIndex(page)).toBe(1);
  // A tap on a tab still goes to that pane.
  const tab3 = col.locator(":scope > .pane[data-tab]:not(.active) > .tabline").first();
  const name = await tab3.locator(".tabtitle").textContent();
  await tab3.tap();
  await expect.poll(() => active(page)).toBe(name);
  // A second finger puts a held pane back where it was.
  const keep = await order();
  const t4 = (await col.locator(":scope > .pane[data-tab]:not(.active) > .tabline").first().boundingBox())!;
  const cdp2 = await page.context().newCDPSession(page);
  await cdp2.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: t4.x + 60, y: t4.y + 22 }] });
  await page.waitForTimeout(500);
  await cdp2.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: t4.x + 60, y: c.y + c.height - 30 }] });
  await cdp2.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: t4.x + 60, y: c.y + c.height - 30 }, { x: 200, y: 300 }] });
  await expect(page.locator(".drag-ghost")).toHaveCount(0);
  await cdp2.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp2.detach();
  expect(await order()).toEqual(keep);
  // The ⋯: Move this pane up / down, a finger's size, and greyed where it cannot go.
  await page.locator(".pane.active > .pane-ctl > .more").tap();
  const sheet = page.locator(".menu.sheet");
  const up = sheet.locator(".mi", { hasText: "Move this pane up" });
  const down = sheet.locator(".mi", { hasText: "Move this pane down" });
  await expect(up).toHaveCount(1);
  await expect(down).toHaveCount(1);
  for (const m of [up, down]) expect(Math.round((await m.boundingBox())!.height)).toBeGreaterThanOrEqual(40);
  await down.scrollIntoViewIfNeeded();
  await shot(page, "30-pane-menu-move");
  const me = (await shown(page)).active;
  const was = await order();
  if (me > 0) {
    await up.tap();
    await expect.poll(async () => (await shown(page)).active).toBe(me - 1);
  } else {
    await down.tap();
    await expect.poll(async () => (await shown(page)).active).toBe(me + 1);
  }
  expect((await order()).sort()).toEqual(was.sort());
  // At the top, up is greyed.
  for (let i = 0; i < 3; i++) await page.keyboard.press("Alt+Shift+k");
  await expect.poll(async () => (await shown(page)).active).toBe(0);
  await page.locator(".pane.active > .pane-ctl > .more").tap();
  await expect(sheet.locator(".mi", { hasText: "Move this pane up" })).toHaveAttribute("aria-disabled", "true");
});

test("a held pane near a crowded page's foot scrolls the page under it", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await start(page);
  await stackFromLibrary(page, ["Fixed points", "Octopus minds", "Where the elements come from", "What a proof is", "The one merger"]);
  const col = page.locator(".strip > .col").nth(1);
  await page.locator(".trail-step").nth(1).tap();
  // The first pane's tab, at the top, carried to the foot and held there.
  await col.evaluate((el) => (el.scrollTop = 0));
  await page.keyboard.press("Alt+Shift+k");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Alt+k");
  const s0 = await col.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
  test.skip(s0.max < 20, "the page has nothing to scroll");
  const tab = col.locator(":scope > .pane:not(.active) > .tabline").last();
  const t = (await tab.boundingBox())!;
  const c = (await col.boundingBox())!;
  const before = await col.evaluate((el) => el.scrollTop);
  const toward = t.y > c.y + c.height / 2 ? c.y + 6 : c.y + c.height - 6;
  await press(page, { x: t.x + 60, y: t.y + 22 }, { hold: 500, to: [{ x: t.x + 60, y: toward }], wait: 600 });
  expect(Math.abs((await col.evaluate((el) => el.scrollTop)) - before)).toBeGreaterThan(10);
});

for (const width of [390, 360])
  test(`at ${width}: the selection bar is one row, a finger high; its actions scroll sideways and its ⋯ and × stay at its end; above an on-screen keyboard too`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await start(page);
    await row(page, "Fixed points").tap();
    await row(page, "Recursion without names").tap();
    await at(page, "Recursion without names", 2);
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
    const b = (await bar.boundingBox())!;
    expect(b.height).toBeLessThanOrEqual(48);
    expect(Math.round(b.width)).toBe(width);
    const status = (await page.locator(".status").boundingBox())!;
    expect(Math.abs(b.y + b.height - status.y)).toBeLessThan(2);
    for (const x of await bar.locator("button").all()) {
      const r = (await x.boundingBox())!;
      expect(Math.round(r.height)).toBeGreaterThanOrEqual(44);
      expect(Math.round(r.width)).toBeGreaterThanOrEqual(44);
    }
    // ⋯ and × at the end, whole on screen, the × last.
    const more = (await bar.locator(".bar-more").boundingBox())!;
    const done = (await bar.locator(".bar-done").boundingBox())!;
    expect(Math.round(done.x + done.width)).toBe(width);
    expect(Math.round(more.x + more.width)).toBe(Math.round(done.x));
    // The actions overflow, fade at the end, and a finger scrolls them to link….
    const acts = bar.locator(".bar-acts");
    await expect(acts).toHaveAttribute("data-after", "");
    await shot(page, `31-selbar-${width}`);
    const a = (await acts.boundingBox())!;
    await swipe(page, -200, 0, { x: a.x + a.width - 20, y: a.y + a.height / 2 });
    await expect(acts).toHaveAttribute("data-before", "");
    const link = (await bar.locator("button[data-key=w]").boundingBox())!;
    expect(link.x + link.width).toBeLessThanOrEqual(more.x + 1);
    // Scrolling the bar turned no page and kept the selection.
    expect(await pageIndex(page)).toBe(2);
    expect(await state(page, (s) => s.selectedText())).toBeTruthy();
    await shot(page, `32-selbar-${width}-scrolled`);
    // An on-screen keyboard raises it with the status line.
    await page.evaluate(() => document.documentElement.style.setProperty("--kb", "260px"));
    const b2 = (await bar.boundingBox())!;
    const s2 = (await page.locator(".status").boundingBox())!;
    expect(Math.abs(b2.y + b2.height - s2.y)).toBeLessThan(2);
    expect(Math.round(800 - (s2.y + s2.height))).toBe(260);
    await page.evaluate(() => document.documentElement.style.removeProperty("--kb"));
    // Its × puts it away (an action would write into the library the tests share).
    await bar.locator(".bar-done").tap();
    await expect(bar).toHaveCount(0);
  });

test("a tap on a link only opens it: no hover card from the tap's mouse events, and none left over a page that changes; a long press still shows the card", async ({ page }) => {
  await start(page);
  await row(page, "Fixed points").tap();
  await row(page, "Recursion without names").tap();
  await at(page, "Recursion without names", 2);
  for (const words of ["fixed-point combinator", "Y combinator"]) {
    await page.evaluate(() => {
      const w = window as any;
      w.__events = [];
      for (const t of ["pointerover", "pointerdown", "pointerup", "mouseover", "mousemove", "mousedown", "mouseup", "click"]) document.addEventListener(t, (e) => w.__events.push(`${t}${(e as PointerEvent).pointerType ? `:${(e as PointerEvent).pointerType}` : ""}`), true);
    });
    const link = page.locator(".pane.active .lnk", { hasText: words }).first();
    const l = (await link.boundingBox())!;
    const x = l.x + 12;
    const y = l.y + l.height / 2;
    await touchTap(page, x, y);
    // A phone's browser may send its compatibility mouse events late, after the tap: so does this test.
    await page.evaluate(([x, y]) => {
      const t = document.elementFromPoint(x, y) ?? document.body;
      for (const type of ["mouseover", "mousemove"]) t.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
    }, [x, y]);
    const want = words === "fixed-point combinator" ? "Fixed-point combinator" : "How Y works";
    await at(page, want, 3);
    const events: string[] = await page.evaluate(() => (window as any).__events);
    // The browser did send mouse events after the tap, as a phone's does.
    expect(events).toContain("mouseover");
    await page.waitForTimeout(900);
    await expect(page.locator(".popup")).toHaveCount(0);
    if (words === "fixed-point combinator") await shot(page, "27-link-tapped");
    await swipe(page, 260);
    await at(page, "Recursion without names", 2);
    await page.waitForTimeout(600);
    await expect(page.locator(".popup")).toHaveCount(0);
  }
  // A card showing (a mouse resting on a link, on a touch screen with a mouse too) goes when the page changes.
  await state(page, (s) => {
    const id = Object.values(s.snap.nodes).find((n: any) => n.kind === "note" && n.ref && n.anchors?.[0]?.text === "Y combinator") as any;
    s.popup = { note: id.id, x: 100, top: 400, bottom: 420 };
    s.emit();
  });
  await expect(page.locator(".popup")).toHaveCount(1);
  await page.locator(".trail-step", { hasText: "Library" }).tap();
  await at(page, "Library", 0);
  await expect(page.locator(".popup")).toHaveCount(0);
  // The long press still shows the card, above the menu, and only there.
  await page.locator(".trail-step", { hasText: "Recursion without names" }).tap();
  await at(page, "Recursion without names", 2);
  const link = page.locator(".pane.active .lnk", { hasText: "fixed-point combinator" }).first();
  const l = (await link.boundingBox())!;
  await link.dispatchEvent("contextmenu", { clientX: l.x + 10, clientY: l.y + 5, bubbles: true, cancelable: true });
  await expect(page.locator(".menu.sheet .menu-card .lcard")).toBeVisible();
  await expect(page.locator(".popup")).toHaveCount(0);
});
