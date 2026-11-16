/**
 * The mouse and touch: the selection bar on a click or a drag, the ⋯ menus, the right-click menu
 * (Copy first; Shift+right-click left to the browser), the menu's keys, the top bar, key hints as
 * buttons, the phone's docked bar and sheet, the Lock naming, and that links, Shift-clicks, pane
 * drags and peeks still work with all of it. These tests work in "Tuning and temperament", which no
 * other spec uses, and undo what they write.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { autoLayout, command, idle, keys, settle, state } from "./helpers";

const DOC = "/doc/tuning-and-temperament";
const FIRST = "Two notes sound smooth together when their frequencies stand in a simple ratio such as 2 to 1 or 3 to 2.";

async function open(page: Page, path = DOC) {
  await page.goto(path);
  await page.waitForSelector("article .outline, .strip .pane");
  await page.evaluate(() => document.fonts.ready);
}
const row = (page: Page, title: string) => page.locator(".row", { has: page.locator(`.title:text-is("${title}")`) }).first();
/** The open section's own text (the column). */
const bodyOf = (page: Page, title: string) => page.locator(".node.open", { has: page.locator(`:scope > .row .title:text-is("${title}")`) }).locator(":scope > .content > .body .para").first();
const menu = (page: Page) => page.locator(".menu");
const item = (page: Page, label: string) => page.locator(".menu .mi", { has: page.locator(`.lbl:text-is("${label}")`) });
/** The box of some words in an element's text. */
const wordsBox = (el: Locator, words: string) =>
  el.evaluate((root, w) => {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let text = "";
    const nodes: [Text, number][] = [];
    for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) nodes.push([n, text.length]), (text += n.data);
    const at = text.indexOf(w);
    if (at < 0) throw new Error(`no “${w}”`);
    const pos = (o: number) => {
      const [n, s] = nodes.findLast(([, s]) => s <= o)!;
      return [n, o - s] as const;
    };
    const r = document.createRange();
    r.setStart(...pos(at));
    r.setEnd(...pos(at + w.length));
    const b = r.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }, words);

test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ request }) => {
  // A link on "simple ratio" (to the mock Wikipedia's Octopus), once.
  const s = await (await request.get("/api/tree")).json();
  const doc = s.nodes[s.root].children.find((c: string) => s.nodes[c].slug === "tuning-and-temperament");
  const sec = s.nodes[doc].children.find((c: string) => s.nodes[c].title === "Why some intervals sound smooth");
  if (s.nodes[sec].children.some((c: string) => s.nodes[c].ref)) return;
  const res = await request.post("/api/ops", { data: { author: "mouse", message: "A link for the mouse tests", ops: [{ op: "create", parent: sec, kind: "note", quote: "simple ratio", ref: { kind: "wiki", title: "Octopus", lang: "en" } }] } });
  expect(res.ok()).toBe(true);
});
test.beforeEach(async ({ context }) => {
  await context.route(/wikipedia\.org|wikimedia\.org/, (r) => r.abort());
});
test.afterEach(({ page }) => settle(page));

test("a single click on a sentence selects it and shows the bar by it, each item with its key; an item does what its key does; fast", async ({ page }) => {
  await open(page);
  // A newcomer is told, once, quietly, in the status line.
  await expect(page.locator(".status .firstrun")).toContainText("Click a sentence");
  await row(page, "Why some intervals sound smooth").click();
  await expect(page.locator(".status .firstrun")).toHaveCount(0);
  const para = bodyOf(page, "Why some intervals sound smooth");
  // How long the click takes to paint, as the browser measures it (only events of 16 ms or more are recorded).
  await page.evaluate(() => {
    (window as any).__clicks = [];
    new PerformanceObserver((l) => (window as any).__clicks.push(...l.getEntries().filter((e) => e.name === "click").map((e) => e.duration))).observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit);
  });
  await para.click({ position: { x: 30, y: 10 } });
  const bar = page.locator(".selbar");
  await expect(bar).toBeVisible();
  expect(await state(page, (s) => [s.focus.grain, s.selectedText()])).toEqual(["sentence", FIRST]);
  await expect(bar.locator("button .k")).toHaveText(["e", "d", "y", "x", "c", ":", "w"]);
  await expect(bar.locator("button[data-key]")).toHaveText(["expande", "defined", "whyy", "examplex", "challengec", "ask…:", "link…w"]);
  // Over the words, not on them.
  const b = (await bar.boundingBox())!;
  const sel = (await page.locator(".sel").first().boundingBox())!;
  expect(b.y + b.height).toBeLessThanOrEqual(sel.y + 1);
  // The status line's hints are buttons too.
  await expect(page.locator(".status .message .key")).toHaveCount(7);
  await page.waitForTimeout(100);
  expect(Math.max(0, ...(await page.evaluate(() => (window as any).__clicks as number[])))).toBeLessThan(150);
  // "why" does what y does: a note answering why, on these words; the bar goes.
  await bar.locator('button[data-key="y"]').click();
  await expect(bar).toHaveCount(0);
  await idle(page);
  const lens = await state(page, (s) => {
    const n = s.snap.nodes[s.focus.node];
    return n.children.map((c: string) => s.snap.nodes[c]).find((c: any) => c.kind === "note" && c.anchors[0]?.text === s.selectedText())?.lens;
  });
  expect(lens).toBe("why");
  await keys(page, "u");
  await expect.poll(() => state(page, (s) => s.snap.nodes[s.focus.node].children.filter((c: string) => s.snap.nodes[c].lens === "why").length)).toBe(0);
  // A key hint in the status line presses its key.
  await para.click({ position: { x: 30, y: 10 } });
  await page.locator(".status .message .key", { hasText: "define" }).click();
  await idle(page);
  expect(await state(page, (s) => s.snap.nodes[s.focus.node].children.some((c: string) => s.snap.nodes[c].lens === "define"))).toBe(true);
  await keys(page, "u");
  await idle(page);
});

test("a drag across words shows the bar for those words; a double click, for the word", async ({ page }) => {
  await open(page);
  await row(page, "Why some intervals sound smooth").click();
  const para = bodyOf(page, "Why some intervals sound smooth");
  const w = await wordsBox(para, "their frequencies stand");
  await page.mouse.move(w.x + 1, w.y + w.h / 2);
  await page.mouse.down();
  await page.mouse.move(w.x + w.w / 2, w.y + w.h / 2, { steps: 4 });
  await page.mouse.move(w.x + w.w - 1, w.y + w.h / 2, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".selbar")).toBeVisible();
  expect(await state(page, (s) => [s.focus.grain, s.selectedText()])).toEqual(["word", "their frequencies stand"]);
  // The browser's own selection was taken over: nothing is left selected twice.
  expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
  const d = await wordsBox(para, "smooth");
  await page.mouse.dblclick(d.x + d.w / 2, d.y + d.h / 2);
  await expect(page.locator(".selbar")).toBeVisible();
  expect((await state(page, (s) => s.selectedText()))?.trim()).toBe("smooth");
  // A key moves on: the bar goes.
  await keys(page, "L");
  await expect(page.locator(".selbar")).toHaveCount(0);
});

test("the ⋯ menus: a row's, the page's, a note's, a stale flag's", async ({ page }) => {
  await open(page);
  // A row's ⋯ shows when the row is pointed at; its menu is the section's, and an item does what its key does.
  const r = row(page, "The comma");
  const more = r.locator(".more");
  expect(await more.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
  await r.hover();
  await expect.poll(() => more.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  await more.click();
  await expect(menu(page)).toBeVisible();
  await expect(page.locator(".menu .mh").first()).toHaveText("The comma");
  for (const l of ["Write more", "Edit text", "Rename", "Add a section inside", "Lock", "Delete"]) await expect(item(page, l)).toHaveCount(1);
  await expect(page.locator(".menu .choices", { hasText: "Move" })).toBeVisible();
  await item(page, "Rename").click();
  await expect(menu(page)).toHaveCount(0);
  await expect(page.locator(".title-editor")).toBeFocused();
  await keys(page, "Escape");
  // The page's ⋯, in its byline: the document's items too. Esc closes it and the focus goes back to the ⋯.
  const pageMore = page.locator(".top .byline .more");
  await page.locator(".top").hover();
  await pageMore.click();
  await expect(item(page, "Save a copy")).toHaveCount(1);
  await expect(item(page, "Export as .md")).toHaveCount(1);
  await keys(page, "Escape");
  await expect(menu(page)).toHaveCount(0);
  expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.more)).toBe("page");
  // A note's ⋯: open the note on "all at once", in Overtones.
  await row(page, "Why some intervals sound smooth").click();
  await row(page, "Overtones").click();
  await page.locator(".anchor", { hasText: "all at once" }).first().click();
  const note = page.locator(".sidenote, .inset").filter({ hasText: "Touch a guitar string" }).first();
  await expect(note).toBeVisible();
  await note.hover();
  await note.locator(":scope > .more").click();
  await expect(item(page, "Change its form")).toHaveCount(1);
  await expect(item(page, "Edit text")).toHaveCount(1);
  expect(await state(page, (s) => s.snap.nodes[s.focus.node].kind)).toBe("note");
  await keys(page, "Escape");
  // A stale flag: edit a section's text with reconciling off, and its sections' rows say their parent changed; a click on the flag offers what to do.
  await command(page, "/auto off");
  await row(page, "Why some intervals sound smooth").click({ button: "right" });
  await item(page, "Edit text").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" An added sentence.");
  await keys(page, "Escape");
  const flag = row(page, "Overtones").locator(".flags");
  await expect(flag).toHaveText("parent changed");
  await flag.click();
  await expect(page.locator(".menu .mh").first()).toHaveText("Overtones · its parent changed");
  await item(page, "Accept as it stands").click();
  await expect(row(page, "Overtones").locator(".flags")).toHaveCount(0);
  await command(page, "/auto on");
  // Put it back: the edit and the acceptances, undone.
  for (let i = 0; i < 6 && (await state(page, (s) => s.snap.nodes[s.focus.node].body.includes("An added sentence") || Object.values(s.snap.nodes).some((n: any) => n.body?.includes("An added sentence")))); i++) await keys(page, "u");
  expect(await state(page, (s) => Object.values(s.snap.nodes).some((n: any) => n.body?.includes("An added sentence")))).toBe(false);
});

test("a right-click: the app's menu for what it is on, Copy first where there is text; Shift+right-click is the browser's", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  await page.evaluate(() => window.addEventListener("contextmenu", (e) => ((window as any).__ctx = e.defaultPrevented)));
  await row(page, "Why some intervals sound smooth").click();
  const para = bodyOf(page, "Why some intervals sound smooth");
  await para.click({ position: { x: 30, y: 10 }, button: "right" });
  await expect(menu(page)).toBeVisible();
  expect(await page.evaluate(() => (window as any).__ctx)).toBe(true);
  expect(await state(page, (s) => s.selectedText())).toBe(FIRST);
  await expect(page.locator(".menu .mi").first().locator(".lbl")).toHaveText("Copy");
  await page.locator(".menu .mi").first().click();
  await expect(menu(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(FIRST);
  // The copy key copies the words selected too.
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(FIRST);
  // A row: the section's menu.
  await row(page, "The comma").click({ button: "right" });
  await expect(page.locator(".menu .mh").first()).toHaveText("The comma");
  await expect(item(page, "Rename")).toHaveCount(1);
  expect(await state(page, (s) => s.snap.nodes[s.focus.node].title)).toBe("The comma");
  await keys(page, "Escape");
  // A link: open it, on wikipedia.org, retarget, remove; its words are selected.
  await page.locator(".lnk", { hasText: "simple ratio" }).first().click({ button: "right" });
  for (const l of ["Copy", "Open the link", "Open on wikipedia.org", "Retarget…", "Remove the link"]) await expect(item(page, l)).toHaveCount(1);
  expect(await state(page, (s) => s.selectedText())).toBe("simple ratio");
  await keys(page, "Escape");
  // Shift+right-click: the browser's menu, not ours.
  const p = (await para.boundingBox())!;
  await page.keyboard.down("Shift");
  await page.mouse.click(p.x + 60, p.y + 10, { button: "right" });
  await page.keyboard.up("Shift");
  expect(await page.evaluate(() => (window as any).__ctx)).toBe(false);
  await expect(menu(page)).toHaveCount(0);
  // Text being typed in keeps the browser's menu.
  await keys(page, ":");
  await page.locator(".command input").click({ button: "right" });
  expect(await page.evaluate(() => (window as any).__ctx)).toBe(false);
  await keys(page, "Escape");
});

test("the menu's keys: ↑ ↓ Home End move, Enter runs, Esc closes and gives the focus back; keys do not reach the page; a press outside closes it", async ({ page }) => {
  await open(page);
  await keys(page, "j");
  const before = await state(page, (s) => s.focus.node);
  await page.locator(".docbar .tool[aria-haspopup]").click();
  await expect(menu(page)).toBeFocused();
  await keys(page, "j k");
  expect(await state(page, (s) => s.focus.node)).toBe(before);
  await expect(menu(page)).toBeVisible();
  const focused = () => page.evaluate(() => document.activeElement?.querySelector(".lbl")?.textContent ?? document.activeElement?.textContent);
  await keys(page, "ArrowDown");
  expect(await focused()).toBe("Documents…");
  await keys(page, "ArrowDown");
  expect(await focused()).toBe("Jump to a section…");
  await keys(page, "ArrowUp ArrowUp");
  expect(await focused()).toBe("Keys and help");
  await keys(page, "Home");
  expect(await focused()).toBe("Documents…");
  await keys(page, "End Enter");
  await expect(menu(page)).toHaveCount(0);
  await expect(page.locator(".help")).toBeVisible();
  await keys(page, "Escape");
  // Esc gives the focus back to what opened it.
  const r = row(page, "The comma");
  await r.hover();
  await r.locator(".more").click();
  await expect(menu(page)).toBeFocused();
  await keys(page, "Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(r.locator(".more")).toBeFocused();
  // A press outside closes it.
  await r.locator(".more").click();
  await expect(menu(page)).toBeVisible();
  await page.mouse.click(5, 400);
  await expect(menu(page)).toHaveCount(0);
  // The top bar: undo, and redo once there is something to redo.
  await expect(page.locator(".docbar .tool", { hasText: "redo" })).toHaveCount(0);
  await expect(page.locator(".docbar .tool", { hasText: "undo" })).toBeVisible();
});

test("the top bar stays at the top of the column as the page scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 500 });
  await open(page);
  await keys(page, "o");
  await page.evaluate(() => window.scrollTo(0, 700));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(400);
  const bar = (await page.locator(".docbar").boundingBox())!;
  expect(bar.y).toBeLessThanOrEqual(1);
  await expect(page.locator(".docbar .tool", { hasText: "menu" })).toBeVisible();
  await keys(page, "O");
});

test("Lock: the menu, the badge, the status line and the help say lock; pin is a pane's", async ({ page }) => {
  await open(page);
  await row(page, "The comma").click({ button: "right" });
  await expect(item(page, "Lock")).toHaveAttribute("aria-checked", "false");
  await item(page, "Lock").click();
  const flags = row(page, "The comma").locator(".flags");
  await expect(flags).toHaveText("locked");
  expect(await flags.evaluate((el) => (el as HTMLElement).innerText)).toBe("LOCKED");
  await expect(page.locator(".status .message")).toContainText("Locked: the model will not rewrite this node.");
  await row(page, "The comma").click({ button: "right" });
  await expect(item(page, "Lock")).toHaveAttribute("aria-checked", "true");
  expect(await page.locator(".menu").innerText()).not.toMatch(/\bpin/i);
  await keys(page, "Escape p");
  await expect(flags).toHaveCount(0);
  await expect(page.locator(".status .message")).toContainText("Unlocked");
  await keys(page, "?");
  await expect(page.locator(".help")).toContainText("lock or unlock");
  await expect(page.locator(".help")).not.toContainText("pin or unpin: pinned nodes");
  await keys(page, "Escape");
});

test.describe("panes", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });
  test.beforeEach(({ page }) => autoLayout(page));

  const paneOf = (page: Page, title: string) => page.locator(".strip .pane", { has: page.locator(`:is(.pane-head h2, .top h1):text-is("${title}")`) }).first();
  const trail = (page: Page) => state(page, (s) => s.trail.map((p: any) => (p.kind === "wiki" ? `W:${p.title}` : s.snap.nodes[p.id].title)));

  test("a pane's ⋯: its node's items and the pane's own; pin from it", async ({ page }) => {
    await open(page);
    await keys(page, "z j Enter");
    const p = paneOf(page, "Why some intervals sound smooth");
    await expect(p.locator(".pane-head h2")).toHaveText("Why some intervals sound smooth");
    await p.hover();
    await p.locator(".pane-btn.more").click();
    await expect(page.locator(".menu .mh").first()).toHaveText("Why some intervals sound smooth");
    for (const l of ["Write more", "Rename", "Pin this pane", "Close this pane", "Show as one column"]) await expect(item(page, l)).toHaveCount(1);
    await item(page, "Pin this pane").click();
    await expect(p).toHaveClass(/pinned/);
    await p.locator(".pane-btn.more").click();
    await expect(item(page, "Pin this pane")).toHaveAttribute("aria-checked", "true");
    await item(page, "Pin this pane").click();
    await expect(p).not.toHaveClass(/pinned/);
    // Right-click in the pane's empty foot: the pane's menu.
    const box = (await p.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 40, { button: "right" });
    await expect(item(page, "Close this pane")).toHaveCount(1);
    await keys(page, "Escape");
  });

  test("links, Shift-clicks, dragging and peeking work as before beside the bar and the ⋯", async ({ page }) => {
    await open(page);
    await keys(page, "z j Enter");
    const sec = paneOf(page, "Why some intervals sound smooth");
    // A click on a sentence shows the bar; a click on a link opens its article beside, and shows no bar.
    await sec.locator(".pane-body .para").first().click({ position: { x: 30, y: 10 } });
    await expect(page.locator(".selbar")).toBeVisible();
    await sec.locator(".lnk", { hasText: "simple ratio" }).click();
    await expect(page.locator(".selbar")).toHaveCount(0);
    await expect.poll(() => trail(page)).toEqual(["Tuning and temperament", "Why some intervals sound smooth", "W:Octopus"]);
    // In the article: a click on a sentence selects it and shows the bar, without linking (an article's words are not linked by hand).
    const art = page.locator(".strip .pane.wiki-pane");
    await art.locator(".wiki-text .wpara").first().click({ position: { x: 40, y: 8 } });
    await expect(page.locator(".selbar")).toBeVisible();
    await expect(page.locator(".selbar button .k")).toHaveText(["e", "d", "y", "x", "c", ":"]);
    expect(await state(page, (s) => s.inArticleText)).toBe(true);
    await art.locator(".wiki-text .wpara").first().click({ position: { x: 60, y: 8 }, button: "right" });
    await expect(page.locator(".menu .mi").first().locator(".lbl")).toHaveText("Copy");
    await keys(page, "Escape");
    // A Shift-click on a row opens it in place of the pane there.
    await paneOf(page, "Tuning and temperament").locator(".row", { hasText: "The comma" }).click({ modifiers: ["Shift"] });
    await expect.poll(() => trail(page)).toEqual(["Tuning and temperament", "The comma"]);
    // Five panes in one column: a covered one peeks under the mouse; with room, a pane drags by its grip (the ⋯ beside it does not drag).
    await page.evaluate(() => localStorage.clear());
    await open(page);
    await keys(page, "z j Enter j Enter j Enter j Enter j Enter");
    const col = page.locator(".strip > .col").nth(1);
    await expect.poll(() => col.locator(":scope > .pane").count()).toBe(5);
    await expect(col).toHaveClass(/crowded/);
    const covered = col.locator(":scope > .pane[data-covered]").first();
    await expect(covered).toHaveCount(1);
    await covered.locator(".tabline").hover();
    await expect(covered).toHaveAttribute("data-peek", "");
    await page.mouse.move(5, 500);
    await page.setViewportSize({ width: 1920, height: 2000 });
    await expect.poll(() => col.getAttribute("class")).not.toContain("crowded");
    const order = () => col.locator(":scope > .pane .pane-head h2").allTextContents();
    const was = await order();
    const last = col.locator(":scope > .pane").last();
    await last.hover();
    await last.locator(".pane-btn.more").click();
    await expect(menu(page)).toBeVisible();
    await keys(page, "Escape");
    expect(await order()).toEqual(was);
    const g = (await last.locator(".grip").boundingBox())!;
    const t = (await col.locator(":scope > .pane").first().boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, g.y + 20, { steps: 3 });
    await page.mouse.move(g.x + g.width / 2, t.y + 8, { steps: 6 });
    await page.mouse.up();
    await expect.poll(order).toEqual([was[was.length - 1], ...was.slice(0, -1)]);
    await expect(menu(page)).toHaveCount(0);
    await expect(page.locator(".selbar")).toHaveCount(0);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a tap on a sentence docks the bar at the foot, keys left out; its ⋯ and the top menu are sheets; × puts the bar away", async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    await expect(page.locator(".status .firstrun")).toContainText("Tap a sentence");
    await row(page, "Why some intervals sound smooth").tap();
    const para = bodyOf(page, "Why some intervals sound smooth");
    const tapFirst = async () => {
      await para.scrollIntoViewIfNeeded();
      const p = (await para.boundingBox())!;
      await page.touchscreen.tap(p.x + 30, p.y + 10);
    };
    const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(2);
    await tapFirst();
    const bar = page.locator(".selbar.docked");
    await expect(bar).toBeVisible();
    expect(await state(page, (s) => s.selectedText())).toBe(FIRST);
    const b = (await bar.boundingBox())!;
    const status = (await page.locator(".status").boundingBox())!;
    near(b.width, 390);
    near(b.y + b.height, status.y);
    await expect(bar.locator(".k").first()).toBeHidden();
    // The words are not left under it.
    const sel = (await page.locator(".sel").last().boundingBox())!;
    expect(sel.y + sel.height).toBeLessThanOrEqual(b.y);
    // Its ⋯: a sheet from the foot, full width.
    await bar.locator(".bar-more").tap();
    const sheet = page.locator(".menu.sheet");
    await expect(sheet).toBeVisible();
    const s = (await sheet.boundingBox())!;
    near(s.width, 390);
    near(s.y + s.height, status.y);
    await expect(sheet.locator(".mi").first().locator(".lbl")).toHaveText("Copy");
    // A tap outside puts it away (on the status line, where a tap does nothing else).
    const outside = () => page.touchscreen.tap(150, status.y + status.height / 2);
    await outside();
    await expect(sheet).toHaveCount(0);
    // × puts the bar away and widens back to the node.
    await tapFirst();
    await expect(bar).toBeVisible();
    await bar.locator(".bar-done").tap();
    await expect(bar).toHaveCount(0);
    expect(await state(page, (s) => s.focus.grain)).toBe("node");
    // The focused row's ⋯ is there to tap (no hover on a phone); its menu is a sheet.
    const more = row(page, "Why some intervals sound smooth").locator(".more");
    await expect.poll(() => more.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await more.tap();
    await expect(page.locator(".menu.sheet .mh").first()).toHaveText("Why some intervals sound smooth");
    await outside();
    await expect(page.locator(".menu.sheet")).toHaveCount(0);
    // The top bar's menu, a sheet too.
    await page.locator(".docbar .tool[aria-haspopup]").tap();
    await expect(page.locator(".menu.sheet")).toBeVisible();
    await expect(item(page, "Documents…")).toHaveCount(1);
  });
});
