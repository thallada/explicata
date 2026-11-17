/**
 * Link discovery, keyboard only: links made automatically after an edit (and undone with u),
 * suggestions shown in the text and taken or declined with y and n, review mode, the [[ completer,
 * bare [[marks]] resolved on save, model-written text with its marks taken out and checked, the
 * Related list, /linkhere and /linkall with progress and a cancel, the /autolink modes, and latency. Against the
 * mock model, the mock Wikipedia (Octopus, Cephalopod, Fred Hoyle, Hoyle state, Carbon-12, Lambda
 * calculus, …) and the hashed-words embedder (IE_EMBED=fake).
 */
import { expect, test, type Page } from "@playwright/test";
import { addTop, autoLayout, command, idle, jump, keys, selected, settle, state, visit, writeReport } from "./helpers";

const body = (page: Page) => state(page, (s) => s.snap.nodes[s.focus.node].body as string);
/** The links on the focused node: quote → target title (or node id). */
const linksHere = (page: Page) =>
  state(page, (s) => {
    const snap = s.snap;
    const out: Record<string, string> = {};
    for (const c of snap.nodes[s.focus.node].children) {
      const n = snap.nodes[c];
      if (n.kind === "note" && n.ref) out[n.anchors[0].text] = n.ref.kind === "wiki" ? n.ref.title : n.ref.kind === "node" ? `node:${snap.nodes[n.ref.id]?.title}` : n.ref.url;
    }
    return out;
  });
const suggestions = (page: Page) => state(page, (s) => s.links.forNode(s.focus.node, s.snap).map((x: any) => x.quote) as string[]);

async function column(page: Page, path = "/") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await visit(page, path);
  await page.waitForFunction(() => (globalThis as any).__ie?.ready);
  await page.evaluate(() => document.fonts.ready);
}

/** A new top-level section with this text, typed from the keyboard; the focus is on it afterwards. */
const newDoc = addTop;

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ context }) => {
  await context.route(/wikipedia\.org|wikimedia\.org/, (r) => r.abort());
});

test.afterEach(async ({ page }) => {
  if (await state(page, (s) => !!s?.ready).catch(() => false)) await command(page, "/autolink suggest");
  await settle(page);
});

test("with /autolink on, the sure links are made at once after an edit, as their own commit, and u removes them", async ({ page }) => {
  await column(page);
  // With a model, review is the default (e2e/reviewer.spec.ts); on links the scanner's sure ones unreviewed.
  expect(await state(page, (s) => s.settings.autolink)).toBe("review");
  await command(page, "/autolink on");
  await newDoc(page, "Autolink one", "The cephalopod met Fred Hoyle, who taught it the lambda calculus.");
  await idle(page);
  await expect(page.locator("article .lnk")).toHaveCount(3);
  expect(await linksHere(page)).toEqual({ cephalopod: "Cephalopod", "Fred Hoyle": "Fred Hoyle", "lambda calculus": "Lambda calculus" });
  await expect(page.locator(".status .message")).toContainText("Linked");
  const top = await state(page, (s) => s.commits()[0]);
  expect(top).toMatchObject({ by: "linker", tag: "autolink" });
  await keys(page, "u");
  await expect(page.locator("article .lnk")).toHaveCount(0);
  // Only the links went: the text typed is still there.
  expect(await body(page)).toContain("Fred Hoyle");
});

test("suggestions are drawn in the text; Tab reaches them, y links one, n declines one for good; S lists the rest", async ({ page }) => {
  await column(page);
  await command(page, "/autolink suggest");
  await newDoc(page, "Suggested links", "The cephalopod met Fred Hoyle.\n\nHe spoke of the Hoyle state of carbon-12 and of the lambda calculus.");
  await idle(page);
  await expect(page.locator("article .sugg")).toHaveCount(5);
  await expect(page.locator("article .lnk")).toHaveCount(0);
  // Tab lands on the first; its card shows the proposed article with its summary.
  await keys(page, "Tab");
  expect(await selected(page)).toBe("cephalopod");
  await expect(page.locator(".suggestion")).toContainText("Cephalopod");
  await expect(page.locator(".suggestion")).toContainText("Class of mollusks");
  await keys(page, "y");
  expect(await linksHere(page)).toEqual({ cephalopod: "Cephalopod" });
  await keys(page, "Escape Escape Tab Tab");
  expect(await selected(page)).toBe("Fred Hoyle");
  await keys(page, "n");
  expect(await state(page, (s) => s.snap.nodes[s.focus.node].nolink)).toEqual(["fred hoyle"]);
  await expect(page.locator("article .sugg")).toHaveCount(3);
  // An edit elsewhere in the node does not bring the declined one back.
  await keys(page, "Escape Escape c End");
  await page.keyboard.type(" Indeed.");
  await keys(page, "Escape");
  await idle(page);
  expect(await suggestions(page)).not.toContain("Fred Hoyle");
  // The list: the link made, and the three waiting (the declined one is behind the rejected filter);
  // the first waiting is selected in the text. s skips, n declines, Y links all the waiting shown.
  await keys(page, "S");
  const panel = page.locator("[data-links-panel]");
  await expect(panel.locator(".lrow")).toHaveCount(4);
  await expect(panel.locator(".lfilter[data-filter=rejected]")).toHaveClass(/off/);
  await expect(panel.locator(".lfilter[data-filter=rejected] .n")).toHaveText("1");
  expect(await selected(page)).toBe("Hoyle state");
  await keys(page, "s");
  expect(await selected(page)).toBe("carbon-12");
  await keys(page, "n");
  expect(await selected(page)).toBe("lambda calculus");
  await keys(page, "Y");
  expect(await linksHere(page)).toEqual({ cephalopod: "Cephalopod", "Hoyle state": "Hoyle state", "lambda calculus": "Lambda calculus" });
  expect(await suggestions(page)).toEqual([]);
  await expect(panel.locator(".lfilter[data-filter=linked] .n")).toHaveText("3");
  await keys(page, "Escape");
  expect(await state(page, (s) => s.mode)).toBe("normal");
});

test("typing [[ in the editor completes from library titles first, then Wikipedia; the choice is linked on save", async ({ page }) => {
  await column(page);
  await newDoc(page, "Completer", "A start.");
  await idle(page);
  await keys(page, "c End");
  await page.keyboard.type(" See [[Recursion with");
  const completer = page.locator("[data-completer]");
  await expect(completer.locator(".choice").first()).toContainText("Recursion without names");
  await expect(completer.locator(".group").first()).toHaveText("Library");
  await keys(page, "Enter");
  await page.keyboard.type(" and the [[octo");
  await expect(completer.locator(".group", { hasText: "Wikipedia" })).toBeVisible();
  const choices = await completer.locator(".choice .t").allTextContents();
  const at = choices.indexOf("Octopus");
  expect(at).toBeGreaterThanOrEqual(0);
  for (let i = 0; i < at; i++) await keys(page, "ArrowDown");
  await keys(page, "Enter");
  await expect(completer).toHaveCount(0);
  await keys(page, "Escape");
  expect(await body(page)).toBe("A start. See Recursion without names and the octopus");
  expect(await linksHere(page)).toEqual({ "Recursion without names": "node:Recursion without names", octopus: "Octopus" });
});

test("a bare [[term]] is looked up when the edit is saved: found, it is linked; not found, the writer is told", async ({ page }) => {
  await column(page);
  await newDoc(page, "Bare marks", "The [[Hoyle state]] and [[a thing nobody wrote about]].");
  await idle(page);
  expect(await body(page)).toBe("The Hoyle state and a thing nobody wrote about.");
  expect(await linksHere(page)).toEqual({ "Hoyle state": "Hoyle state" });
  await expect(page.locator(".status .message")).toContainText("Found nothing to link for “a thing nobody wrote about”");
});

test("text a model writes arrives without its marks, and the ones that check out are links", async ({ page }) => {
  await column(page);
  await command(page, "/autolink on");
  await newDoc(page, "Model marks", "A leaf about sea creatures and recursion.");
  await idle(page);
  // e on a node with text and no sections asks the model for sections; the mock marks a few phrases.
  await keys(page, "e");
  await idle(page);
  const kids = await state(page, (s) => s.snap.nodes[s.focus.node].children.filter((c: string) => s.snap.nodes[c].kind === "section").map((c: string) => s.snap.nodes[c]));
  expect(kids).toHaveLength(2);
  for (const k of kids) expect(k.body).not.toContain("[[");
  expect(kids[0].body).toBe("Mock body one. It elaborates the first half, as a cephalopod would.");
  expect(kids[1].body).toContain("with no such article anywhere.");
  const links = await state(page, (s) =>
    s.snap.nodes[s.focus.node].children.flatMap((c: string) => s.snap.nodes[c].children.map((x: string) => s.snap.nodes[x]).filter((x: any) => x.ref).map((x: any) => `${x.anchors[0].text}→${x.ref.kind === "wiki" ? x.ref.title : "node"}`)),
  );
  expect(links).toContain("cephalopod→Cephalopod");
  // The phrase with no article is simply left as text.
  expect(links.some((l: string) => l.startsWith("no such article"))).toBe(false);
  // The second section's mark named a library node from the nearby list, by its handle.
  expect(links.some((l: string) => l.endsWith("→node"))).toBe(true);
  // Nothing on the page ever showed a bracket.
  await expect(page.locator("article")).not.toContainText("[[");
});

test("the Related list sits under a node; a number links the selected words to that row's section", async ({ page }) => {
  await column(page);
  await newDoc(page, "Related here", "Fixed points of functions: a function maps a point to itself, and iterating finds the fixed point.");
  await idle(page);
  await expect(page.locator(".related-list li").first()).toBeVisible();
  const first = await page.locator(".related-list li .bl-title").first().textContent();
  // Select a word and press 1: it links to the first related section.
  await keys(page, "i i");
  const word = await selected(page);
  await keys(page, "1");
  expect(await linksHere(page)).toMatchObject({ [word]: `node:${first}` });
  await expect(page.locator("article .lnk.l-node")).toHaveCount(1);
  // On the node itself, a number goes to that section.
  await keys(page, "Escape Escape 2");
  expect(await state(page, (s) => s.snap.nodes[s.focus.node].title)).not.toBe("Related here");
});

test("/linkhere and /linkall look for links in the background, with progress in the status line and a cancel", async ({ page }) => {
  await column(page, "Fixed points");
  await command(page, "/autolink suggest");
  await command(page, "/linkall");
  await page.waitForFunction(() => (globalThis as any).__ie.links.job?.state === "running" && (globalThis as any).__ie.links.job.done > 0);
  await expect(page.locator(".status .job")).toContainText("links ");
  // Navigation does not stop it.
  await jump(page, "Recursion without names");
  await command(page, "/linkcancel");
  await page.waitForFunction(() => (globalThis as any).__ie.links.job?.state === "cancelled");
  const job = await state(page, (s) => s.links.job);
  expect(job.done).toBeLessThan(job.total);
  await expect(page.locator(".status .job")).toHaveCount(0);
  // /linkall scanned the whole library; /linkhere scans the node the reader is on and everything under it.
  const library = job.total;
  const recursion = await state(page, (s) => s.focus.node);
  await command(page, "/linkhere");
  await page.waitForFunction(() => (globalThis as any).__ie.links.job?.state === "done", undefined, { timeout: 30_000 });
  await expect(page.locator(".status .message")).toContainText("Looked for links in Recursion without names");
  const here = await state(page, (s) => s.links.job);
  expect(here).toMatchObject({ scope: "node", node: recursion });
  expect(here.total).toBeLessThan(library);
  // On its top, the whole tree; on the library root, /linkhere is /linkall.
  await keys(page, "Escape");
  await jump(page, "Fixed points");
  await command(page, "/linkhere");
  await page.waitForFunction(() => (globalThis as any).__ie.links.job?.state === "done", undefined, { timeout: 30_000 });
  await expect(page.locator(".status .message")).toContainText("Looked for links in Fixed points");
  const top = await state(page, (s) => s.links.job);
  expect(top.total).toBeGreaterThan(here.total);
  expect(top.total).toBeLessThan(library);
  await page.waitForFunction(() => {
    const s = (globalThis as any).__ie;
    return s.links.under(Object.keys(s.snap.nodes), s.snap).length > 0;
  });
  await keys(page, "S");
  await expect(page.locator("[data-links-panel] .lrow.pending").first()).toBeVisible();
  await keys(page, "Escape");
});

test("/autolink off looks for nothing, suggest only suggests, on links", async ({ page }) => {
  await column(page);
  await command(page, "/autolink off");
  await newDoc(page, "Modes", "The cephalopod.");
  await idle(page);
  await expect(page.locator("article .sugg")).toHaveCount(0);
  await expect(page.locator("article .lnk")).toHaveCount(0);
  await command(page, "/autolink suggest");
  await keys(page, "c End");
  await page.keyboard.type(" And Fred Hoyle.");
  await keys(page, "Escape");
  await idle(page);
  await expect(page.locator("article .sugg")).toHaveCount(2);
  await expect(page.locator("article .lnk")).toHaveCount(0);
  await command(page, "/autolink on");
  await keys(page, "c End");
  await page.keyboard.type(" Again.");
  await keys(page, "Escape");
  await idle(page);
  await expect(page.locator("article .lnk")).toHaveCount(2);
  expect(await state(page, (s) => s.settings.autolink)).toBe("on");
});

test("Tab then Enter on an article that is still loading go to its first link once it arrives", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await autoLayout(page);
  await page.goto("/");
  await page.waitForFunction(() => (globalThis as any).__ie?.ready);
  await newDoc(page, "Slow article link", "About the [[Hoyle state]].");
  await idle(page);
  expect(await linksHere(page)).toEqual({ "Hoyle state": "Hoyle state" });
  // The article takes a while to come (a slow network); the reader does not wait for it.
  await page.route(/\/api\/wiki\/article\?title=Hoyle/, async (r) => {
    await new Promise((done) => setTimeout(done, 1500));
    await r.continue();
  });
  await keys(page, "Tab");
  expect(await selected(page)).toBe("Hoyle state");
  await keys(page, "Enter");
  await expect(page.locator(".strip .pane").last().locator(".wiki-wait")).toBeVisible();
  await keys(page, "Tab Enter");
  await expect(page.locator(".status .message")).toContainText("still loading");
  // When it arrives, the Tab goes to its first link and the Enter opens that.
  await expect(page.locator(".strip .pane").last().locator(".wiki-head h2")).toHaveText("Carbon-12", { timeout: 10_000 });
});

test("keypress → paint stays within a frame while suggestions are on screen and scans run after edits", async ({ page }) => {
  await column(page);
  await command(page, "/autolink suggest");
  await newDoc(page, "Latency", "The cephalopod met Fred Hoyle.\n\nHe spoke of the Hoyle state of carbon-12 and of the lambda calculus.");
  await idle(page);
  await page.evaluate(() => ((globalThis as any).__ie.samples.length = 0));
  const paced = async (seq: string) => {
    for (const k of seq.split(" ")) {
      await page.keyboard.press(k);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    }
  };
  for (let round = 0; round < 4; round++) {
    await paced("Tab Tab Tab Tab Escape Escape i j j Escape");
    // An edit, saved: the scan it starts runs after the save, off the keystroke.
    await paced("c");
    await page.keyboard.type(` More ${round}.`);
    await paced("Escape");
  }
  await idle(page);
  const ms: number[] = (await state(page, (s) => s.samples)).filter((x: any) => x.what !== "first-token").map((x: any) => x.ms).sort((a: number, b: number) => a - b);
  const p95 = ms[Math.floor(ms.length * 0.95)];
  const report = { keystrokes: ms.length, median: ms[ms.length >> 1], p95, max: ms[ms.length - 1] };
  console.log("keypress → paint with suggestions (ms):", JSON.stringify(report));
  writeReport("linking", report);
  expect(ms.length).toBeGreaterThan(40);
  expect(p95).toBeLessThan(50);
});
