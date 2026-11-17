/**
 * The panes view, on a wide window: the path to the focus as a strip of panes side by side.
 * Same production build, mock model and shared library as the other specs. The first pane is the
 * library; most tests here are about the panes themselves, so they hoist to the first document
 * (z) and start from it, as the first pane.
 */
import { expect, test, type Page } from "@playwright/test";
import { autoLayout, command, focusedTitle, idle, jump, keys, settle, state, writeReport, type Sample } from "./helpers";

/** Each pane's title and box, left to right. */
const panes = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".strip .pane")].map((p) => {
      const r = p.getBoundingClientRect();
      return { title: p.querySelector(".pane-head h2, .top h1")?.textContent ?? "", left: r.left, right: r.right, width: r.width, covered: !!p.closest(".col")?.hasAttribute("data-covered") };
    }),
  );
const paneTitles = async (page: Page) => (await panes(page)).map((p) => p.title);
const nodeId = (page: Page, title: string) => page.evaluate((t) => (Object.values((globalThis as any).__ie.snap.nodes) as any[]).find((n) => n.title === t).id as string, title);

async function open(page: Page) {
  await page.goto("/doc/infinispand");
  await page.waitForSelector(".strip .pane");
  await page.evaluate(() => document.fonts.ready);
  // The library pane and the document's; hoisting makes the document the first.
  await expect(page.locator(".strip .pane")).toHaveCount(2);
  await page.keyboard.press("z");
  await expect(page.locator(".strip .pane")).toHaveCount(1);
}

test.use({ viewport: { width: 1920, height: 1080 } });
test.describe.configure({ mode: "serial" });

test.beforeEach(({ page }) => autoLayout(page));
test.afterEach(({ page }) => settle(page));

test("the library is the first pane, and a document opens in the next; reload and Back keep the place", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".strip .pane");
  expect(await paneTitles(page)).toEqual(["Library"]);
  await expect(page.locator(".pane.root .rows > .node")).toHaveCount(await state(page, (s) => s.snap.nodes[s.snap.root].children.filter((c: string) => !s.snap.nodes[c].articles).length));
  await keys(page, "j l"); // the first document's row, then open it
  expect(await paneTitles(page)).toEqual(["Library", "Infinispand"]);
  await expect(page.locator(".pane.doc .abstract.seed.folded")).toBeVisible();
  await keys(page, "j l"); // the next document: its pane opens beside the first one's, below it in the same column
  expect(await paneTitles(page)).toEqual(["Library", "Infinispand", "A mind made of text"]);
  await keys(page, "l l"); // into its first section, and open that
  const third = await paneTitles(page);
  expect(third).toHaveLength(4);
  await expect(page).toHaveURL(/\/doc\/a-mind-made-of-text\/\d+%40\d+$/);
  await page.reload();
  await page.waitForSelector(".strip .pane");
  expect(await paneTitles(page)).toEqual(third);
  // Opening a document from the menu is a new page in the address bar's history; Back returns.
  await page.keyboard.press("m");
  await page.keyboard.type("tides");
  await page.keyboard.press("Enter");
  // From the menu a document opens in place of the one open, not beside it.
  expect(await paneTitles(page)).toEqual(["Library", "Infinispand", "The tides"]);
  await expect(page).toHaveURL(/\/doc\/the-tides$/);
  await page.goBack();
  await expect.poll(() => paneTitles(page)).toEqual(third);
  await page.goForward();
  await expect.poll(() => paneTitles(page)).toEqual(["Library", "Infinispand", "The tides"]);
});

test("auto shows panes at 1920 px and on a laptop's 1366, one column on a phone or a narrow window; v and /view switch", async ({ page }) => {
  await open(page);
  await expect(page.locator(".app.view-panes .strip .pane")).toHaveCount(1);
  await expect(page.locator(".strip .pane.root h1")).toHaveText("Infinispand");
  await page.setViewportSize({ width: 1366, height: 768 });
  await expect(page.locator(".app.view-panes .strip .pane")).toHaveCount(1);
  for (const [width, height] of [[820, 900], [390, 800]]) {
    await page.setViewportSize({ width, height });
    await expect(page.locator(".strip"), `${width}`).toHaveCount(0);
    await expect(page.locator("article > .outline > .node").first()).toBeVisible();
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect(page.locator(".strip .pane")).toHaveCount(1);
  await keys(page, "v");
  await expect(page.locator(".strip")).toHaveCount(0);
  await expect(page.locator(".status .message")).toContainText("one column");
  await keys(page, "v");
  await expect(page.locator(".strip .pane")).toHaveCount(1);
  await expect(page.locator(".status .message")).toContainText("panes");
  await command(page, "/view column");
  await expect(page.locator(".strip")).toHaveCount(0);
  expect(await state(page, (s) => s.settings.view)).toBe("column");
  await command(page, "/view auto");
  await expect(page.locator(".strip .pane")).toHaveCount(1);
  // The setting is remembered.
  await page.reload();
  await page.waitForSelector(".strip .pane");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("ie:settings")!).view)).toBe("auto");
});

test("opening three levels deep gives four panes left to right; h moves back left keeping them; q closes", async ({ page }) => {
  await open(page);
  // l: first child · l: open it · l: its first child · j j · l open · l first child · l open
  await keys(page, "l l l j j l l l");
  await expect(page.locator(".strip .pane")).toHaveCount(4);
  const ps = await panes(page);
  expect(ps.map((p) => p.title)).toEqual(["Infinispand", "Expansion by depth", "Generation on demand", "Deepening a leaf"]);
  for (let i = 1; i < ps.length; i++) expect(ps[i].left).toBeGreaterThan(ps[i - 1].left);
  // In each parent's list, the child whose pane is showing is marked.
  await expect(page.locator(".pane .node.showing > .row")).toHaveText(["Expansion by depth", "Generation on demand", "Deepening a leaf"].map((t) => new RegExp(t)));
  // Moving back left closes nothing: the trail stays as it was.
  await keys(page, "h");
  await expect(page.locator(".strip .pane")).toHaveCount(4);
  expect(await focusedTitle(page)).toBe("Generation on demand");
  await keys(page, "h");
  expect(await focusedTitle(page)).toBe("Expansion by depth");
  expect(await paneTitles(page)).toEqual(["Infinispand", "Expansion by depth", "Generation on demand", "Deepening a leaf"]);
  // And forward again along the same trail.
  await keys(page, "l");
  expect(await focusedTitle(page)).toBe("Levels of a node");
  await expect(page.locator(".strip .pane")).toHaveCount(4);
  // q closes the active pane (the one holding the focus, under the heavy rule) and every pane opened from it; the focus goes back to the row it was opened from.
  await keys(page, "j j l");
  expect(await focusedTitle(page)).toBe("Deepening a leaf");
  await expect(page.locator(".pane.active .pane-head h2")).toHaveText("Generation on demand");
  await keys(page, "q");
  expect(await paneTitles(page)).toEqual(["Infinispand", "Expansion by depth"]);
  expect(await focusedTitle(page)).toBe("Generation on demand");
  await keys(page, "q");
  expect(await paneTitles(page)).toEqual(["Infinispand"]);
  expect(await focusedTitle(page)).toBe("Expansion by depth");
  // The first pane stays.
  await keys(page, "q");
  expect(await paneTitles(page)).toEqual(["Infinispand"]);
  await expect(page.locator(".status .message")).toContainText("first pane stays");
});

test("j and k move among siblings, and the strip follows", async ({ page }) => {
  await open(page);
  await keys(page, "j"); // from the top: its first child
  expect(await focusedTitle(page)).toBe("Expansion by depth");
  await jump(page, "Levels of a node");
  await expect(page.locator(".strip .pane")).toHaveCount(2);
  await keys(page, "j");
  expect(await focusedTitle(page)).toBe("Pre-generated depth");
  await keys(page, "l"); // open it: its pane appears
  expect(await paneTitles(page)).toEqual(["Infinispand", "Expansion by depth", "Pre-generated depth"]);
  await keys(page, "j"); // a closed sibling: the open one's pane stays until something else is opened
  expect(await focusedTitle(page)).toBe("Generation on demand");
  expect(await paneTitles(page)).toEqual(["Infinispand", "Expansion by depth", "Pre-generated depth"]);
  await keys(page, "k");
  expect(await paneTitles(page)).toEqual(["Infinispand", "Expansion by depth", "Pre-generated depth"]);
  await keys(page, "k k k k"); // stops at the first sibling, never wanders into other panes
  expect(await focusedTitle(page)).toBe("Levels of a node");
  await keys(page, "j j j j j j");
  expect(await focusedTitle(page)).toBe("Deeper, not longer");
  // A click on a row does what l does: focus it and show its pane, beside the one already open there.
  await page.locator(".pane .row", { hasText: "Generation on demand" }).click();
  expect(await paneTitles(page)).toEqual(["Infinispand", "Expansion by depth", "Pre-generated depth", "Generation on demand"]);
  expect(await focusedTitle(page)).toBe("Generation on demand");
});

test("a pre-generated note opened in a pane is set inside the pane", async ({ page }) => {
  await open(page);
  await jump(page, "Expansion by depth");
  await keys(page, "l Tab Enter");
  const pane = page.locator(".strip .pane").nth(1);
  const note = pane.locator(".sidenote").first();
  await expect(note).toBeVisible();
  const [n, p, body] = await Promise.all([note.boundingBox(), pane.boundingBox(), pane.locator(".pane-head").boundingBox()]);
  expect(n!.x).toBeGreaterThanOrEqual(body!.x); // in the pane's column, not a margin
  expect(n!.x + n!.width).toBeLessThanOrEqual(body!.x + body!.width + 1);
  expect(n!.x + n!.width).toBeLessThanOrEqual(p!.x + p!.width);
  expect(await pane.locator(".pane-scroll").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  // And by mouse: a click on the marked span closes it again.
  await pane.locator(".anchor.on").first().click();
  await expect(pane.locator(".sidenote")).toHaveCount(0);
});

test("in panes everything is reachable with the mouse: rows, headings, marked spans, a dragged selection", async ({ page }) => {
  await open(page);
  await page.locator(".pane .row", { hasText: "Borrowed from Gwern" }).click();
  expect(await paneTitles(page)).toEqual(["Infinispand", "Borrowed from Gwern"]);
  await page.locator(".pane .row", { hasText: "Semantic zoom" }).click();
  expect(await paneTitles(page)).toEqual(["Infinispand", "Borrowed from Gwern", "Semantic zoom"]);
  // A marked span opens its note, and closes it again.
  const anchor = page.locator(".pane .anchor", { hasText: "StretchText" });
  await anchor.click();
  await expect(page.locator(".pane .anchor.on")).toHaveCount(1);
  await anchor.click();
  await expect(page.locator(".pane .anchor.on")).toHaveCount(0);
  // A pane's heading focuses its node, leaving the trail as it is; a click on the focused row whose pane is showing keeps it; its x closes it.
  await page.locator(".pane-head", { hasText: "Borrowed from Gwern" }).click();
  expect(await focusedTitle(page)).toBe("Borrowed from Gwern");
  expect(await paneTitles(page)).toEqual(["Infinispand", "Borrowed from Gwern", "Semantic zoom"]);
  await page.locator(".pane .row", { hasText: "Borrowed from Gwern" }).click();
  expect(await paneTitles(page)).toEqual(["Infinispand", "Borrowed from Gwern", "Semantic zoom"]);
  await page.locator('.pane[data-pane-index="1"] .pane-ctl .pane-btn.close').click();
  expect(await paneTitles(page)).toEqual(["Infinispand"]);
  await page.locator(".pane .row", { hasText: "Borrowed from Gwern" }).click();
  await page.locator(".pane .row", { hasText: "Typography" }).click();
  // Dragging across a pane's text makes that range the focus.
  const para = page.locator(".strip .pane").last().locator(".para").first();
  const box = (await para.boundingBox())!;
  await page.mouse.move(box.x + 6, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 12, { steps: 6 });
  await page.mouse.up();
  const focus = await state(page, (s) => ({ title: s.snap.nodes[s.focus.node].title, grain: s.focus.grain, text: s.snap.nodes[s.focus.node].body.slice(s.focus.range[0], s.focus.range[1]) }));
  expect(focus.title).toBe("Typography");
  expect(focus.grain).toBe("word");
  expect(focus.text.length).toBeGreaterThan(3);
  await page.keyboard.press("Escape");
});

test("past the viewport, earlier panes become spines; a click on one brings it back", async ({ page }) => {
  await open(page);
  await keys(page, "l l l j j l l l");
  await expect(page.locator(".strip .pane")).toHaveCount(4);
  // The focused pane, and its parent with the marked row, end up fully in view.
  await expect.poll(async () => {
    const ps = await panes(page);
    return ps[3].left >= 0 && ps[3].right <= 1920 + 1 && ps[2].left >= 0 && ps[2].right <= ps[3].left + 1;
  }).toBe(true);
  const strip = page.locator(".strip");
  expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // The root has slid under the rest and shows as a spine, its title set vertically.
  const spine = page.locator('.col[data-covered] .spine').first();
  await expect(spine).toHaveText("Infinispand");
  await expect.poll(() => spine.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  expect(await spine.locator(".spine-title").evaluate((el) => getComputedStyle(el).writingMode)).toBe("vertical-rl");
  const box = (await spine.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.width).toBeLessThan(60);
  await spine.click();
  expect(await focusedTitle(page)).toBe("Infinispand");
  // The trail stays; the strip slides back to show the first pane whole.
  await expect(page.locator(".strip .pane")).toHaveCount(4);
  await expect.poll(async () => (await panes(page))[0].left).toBe(0);
  await expect(page.locator(".col[data-covered]")).toHaveCount(0);
});

test("generation in a pane: a note on a sentence streams in; a leaf gets sections as rows", async ({ page }) => {
  await open(page);
  await jump(page, "Why it ends");
  await keys(page, "l i j e");
  const last = page.locator(".strip .pane").last();
  await expect(last.locator(".pane-head h2")).toHaveText("Why it ends");
  await expect(last.locator(".sidenote.pending")).toBeVisible();
  await idle(page);
  await expect(last.locator(".sidenote")).toContainText("Mock note on");
  await keys(page, "Escape Escape");
  await jump(page, "Downward: rendered children");
  await keys(page, "e e");
  await idle(page);
  const pane = page.locator(`.pane[data-pane="${await nodeId(page, "Downward: rendered children")}"]`);
  await expect(pane.locator(".rows .row")).toHaveText([/First part of Downward: rendered children/, /Second part of Downward: rendered children/]);
  await keys(page, "l l"); // into the new section, and open it: a pane of its own, at the end of the focused branch
  await expect.poll(async () => (await state(page, (s) => s.snap.nodes[s.trail[s.trail.length - 1].id]?.title))).toBe("First part of Downward: rendered children");
  expect(await paneTitles(page)).toContain("First part of Downward: rendered children");
});

test("editing in a pane: c, type, Esc", async ({ page }) => {
  await open(page);
  await jump(page, "Pinned nodes");
  await keys(page, "c");
  const editor = page.locator(".pane .editor");
  await expect(editor).toBeFocused();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Rewritten in a pane.");
  await page.keyboard.press("Escape");
  await expect(page.locator(".strip .pane").last().locator(".body").first()).toHaveText("Rewritten in a pane.");
  expect(await state(page, (s) => s.snap.nodes[s.focus.node].body)).toBe("Rewritten in a pane.");
  // r renames at the head of the pane.
  await keys(page, "r");
  await expect(page.locator(".pane-head .title-editor")).toBeFocused();
  await page.keyboard.press("Escape");
  await idle(page);
});

test("keypress → paint stays within the 50 ms budget in panes", async ({ page }) => {
  await open(page);
  // One keystroke per frame, as in the column test.
  const paced = async (seq: string) => {
    for (const k of seq.split(" ")) {
      await page.keyboard.press(k);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    }
  };
  // Walk down and across: open each top-level section, then three of its children in turn,
  // read a sentence of the last, close back up and move to the next section.
  for (let pass = 0; pass < 2; pass++) {
    await paced("O");
    for (let i = 0; i < 10; i++) await paced(`${i === 0 ? "l" : "j"} l l l j l j l i j Escape h h`);
  }
  // Open notes in a pane from the keyboard.
  await jump(page, "Levels of a node");
  await paced("Tab Enter Tab Enter Tab Enter Escape Escape");
  await jump(page, "Expansion by depth");
  await paced("l Tab Enter Tab Enter Escape Escape");
  const samples: Sample[] = await state(page, (s) => s.samples);
  const ms = samples.filter((x) => x.what !== "first-token").map((x) => x.ms).sort((a, b) => a - b);
  const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))];
  const report = { view: "panes", keystrokes: ms.length, median: pct(0.5), p95: pct(0.95), max: ms[ms.length - 1] };
  const slow = samples.filter((x) => x.what !== "first-token" && x.ms > 30).map((x) => `${x.what}:${Math.round(x.ms)}`);
  console.log("panes keypress → paint (ms):", JSON.stringify(report), "over 30ms:", slow.join(" "));
  writeReport("paint-panes", report);
  expect(ms.length).toBeGreaterThan(150);
  expect(report.p95).toBeLessThan(50);
});

test("only the strip scrolls sideways, and nothing hides behind the status line", async ({ page }) => {
  await open(page);
  await keys(page, "l l l j j l l l");
  await expect(page.locator(".strip .pane")).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.evaluate(() => (window.scrollX, document.scrollingElement!.scrollLeft))).toBe(0);
  expect(await page.locator(".strip").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  const status = (await page.locator(".status").boundingBox())!;
  const strip = (await page.locator(".strip").boundingBox())!;
  expect(strip.y + strip.height).toBeLessThanOrEqual(status.y + 0.5);
  // The longest pane (the root's list) scrolls its last row clear of the status line.
  await keys(page, "O k");
  const root = page.locator(".pane.root .pane-scroll");
  await root.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const lastRow = (await page.locator(".pane.root .rows > .node").last().boundingBox())!;
  expect(lastRow.y + lastRow.height).toBeLessThanOrEqual(status.y);
  // The history panel takes its width from the strip rather than covering it.
  await keys(page, "g");
  const panel = (await page.locator(".panel").boundingBox())!;
  const narrowed = (await page.locator(".strip").boundingBox())!;
  expect(narrowed.x + narrowed.width).toBeLessThanOrEqual(panel.x + 1);
  await keys(page, "Escape");
});
