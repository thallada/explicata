/**
 * A scripted run of the app using only the keyboard, against the production build and the
 * deterministic mock model. Assertions read state from the page; every action is a keystroke.
 * Latencies are measured in the page (keydown timestamp → the frame after the render).
 */
import { expect, test, type Page } from "@playwright/test";
import { command, focusedTitle, idle, jump, keys, openPage, paced, settle, state, type Sample, writeReport } from "./helpers";

const titlesUnder = (page: Page, title: string) =>
  page.evaluate((t) => {
    const s = (globalThis as any).__ie;
    const n = Object.values(s.snap.nodes).find((x: any) => x.title === t) as any;
    return n.children.map((c: string) => s.snap.nodes[c]).filter((c: any) => c.kind === "section").map((c: any) => c.title) as string[];
  }, title);

/** The first tree, opened in the column (hoisted, with the library one step out). */
async function open(page: Page) {
  await openPage(page, "Infinispand");
  await page.evaluate(() => document.fonts.ready);
}

test.describe.configure({ mode: "serial" });

// The tests share one server-side library. Let each test's work reach it before the page closes.
test.afterEach(({ page }) => settle(page));

test("opens on an outline of ten titles with the prompt folded above it", async ({ page }) => {
  await open(page);
  await expect(page.locator("article > .outline > .node")).toHaveCount(10);
  await expect(page.locator(".node.open")).toHaveCount(0);
  await expect(page.locator(".abstract.seed.folded")).toBeVisible();
  await expect(page.locator("h1")).toHaveText("Infinispand");
  await page.keyboard.press("Enter");
  await expect(page.locator(".abstract.seed.folded")).toHaveCount(0);
  await expect(page.locator(".abstract.seed")).toContainText("I think maybe we want something like CDRTs under the hood");
});

test("pre-generated expansions paint within the 50 ms budget", async ({ page }) => {
  await open(page);
  // One keystroke per frame (about 60 a second, well past any typist). Sent faster than that,
  // keys queue behind each other and the measurement becomes the length of the queue.
  // Walk the whole pre-generated outline: open every section, top to bottom, then every note in a few.
  for (let i = 0; i < 70; i++) await paced(page, "j l");
  const opened = await page.locator(".node.open").count();
  expect(opened).toBeGreaterThan(40);
  // Close and reopen subtrees, and step through grains.
  await paced(page, "O j l h l i j j i l l Escape Escape");
  // Open notes in every form from the keyboard.
  await jump(page, "Levels of a node");
  await paced(page, "Tab Enter Tab Enter Tab Enter Escape Escape");
  await jump(page, "Expansion by depth");
  await paced(page, "Tab Enter Tab Enter");
  await expect(page.locator(".gloss").first()).toBeVisible();
  await expect(page.locator(".inset").first()).toBeVisible();
  await expect(page.locator(".sidenote").first()).toBeVisible();

  const samples: Sample[] = await state(page, (s) => s.samples);
  const ms = samples.filter((x) => x.what !== "first-token").map((x) => x.ms).sort((a, b) => a - b);
  const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))];
  const report = { keystrokes: ms.length, median: pct(0.5), p95: pct(0.95), max: ms[ms.length - 1] };
  const slow = samples.filter((x) => x.what !== "first-token" && x.ms > 30).map((x) => `${x.what}:${Math.round(x.ms)}`);
  console.log("keypress → paint (ms):", JSON.stringify(report), "over 30ms:", slow.join(" "));
  writeReport("paint", report);
  expect(ms.length).toBeGreaterThan(150);
  expect(report.p95).toBeLessThan(50);
});

test("a margin note sits beside its line and does not overlap its neighbours", async ({ page }) => {
  await open(page);
  await jump(page, "Expansion by depth");
  await keys(page, "l Tab Enter");
  const note = page.locator(".sidenote").first();
  const anchor = page.locator(".anchor.on").first();
  const [n, a, col] = await Promise.all([note.boundingBox(), anchor.boundingBox(), page.locator("article").boundingBox()]);
  expect(n!.x).toBeGreaterThan(col!.x + col!.width); // in the margin, not the column
  expect(Math.abs(n!.y - a!.y)).toBeLessThan(40); // level with the words it is about
});

test("past the pre-generated text, a selection is expanded by the model, in a form that follows its size", async ({ page }) => {
  await open(page);
  await jump(page, "Gloss");
  // Sentence grain → a margin note, streamed.
  await keys(page, "l i j e");
  await expect(page.locator(".sidenote.pending")).toBeVisible();
  await idle(page);
  await expect(page.locator(".sidenote")).toContainText("Mock note on");
  // Word grain → an inline gloss.
  await keys(page, "i l l d");
  await idle(page);
  await expect(page.locator(".gloss").last()).toContainText("mock gloss of");
  // Several sentences → an inset passage, with the reader's own question as the lens.
  await jump(page, "Levels of a node");
  await keys(page, "l i J J");
  await command(page, "how does this fail?");
  await idle(page);
  await expect(page.locator(".inset").last()).toContainText("through the how does this fail? lens");

  const notes = await state(page, (s) =>
    Object.values(s.snap.nodes).filter((c: any) => c.kind === "note" && !c.wanchor && /^[Mm]ock/.test(c.body)).map((c: any) => c.form).sort(),
  );
  expect(notes).toEqual(["gloss", "note", "passage"]);

  const samples: Sample[] = await state(page, (s) => s.samples);
  const first = samples.filter((x) => x.what === "first-token").map((x) => x.ms);
  console.log("request → first token painted (ms, mock model):", JSON.stringify(first.map(Math.round)));
  writeReport("first-token", { mock: true, samples: first });
  expect(first.length).toBe(3);
  expect(Math.max(...first)).toBeLessThan(1000);
});

test("a note is a node: it can be entered and expanded again", async ({ page }) => {
  await open(page);
  await jump(page, "Gloss");
  await keys(page, "l Tab Enter Enter"); // open the pre-generated gloss, then step into it
  expect(await state(page, (s) => s.snap.nodes[s.focus.node].kind)).toBe("note");
  await keys(page, "i i e"); // a word inside the note
  await idle(page);
  const depth = await state(page, (s) => Object.values(s.snap.nodes).filter((n: any) => n.kind === "note" && s.snap.nodes[n.parent].kind === "note" && /mock/.test(n.body)).length);
  expect(depth).toBe(1);
});

test("a leaf with no children gets subsections on request", async ({ page }) => {
  await open(page);
  await jump(page, "Sidenote");
  expect(await titlesUnder(page, "Sidenote")).toEqual([]);
  await keys(page, "e e"); // open, then go deeper
  await idle(page);
  expect(await titlesUnder(page, "Sidenote")).toEqual(["First part of Sidenote", "Second part of Sidenote"]);
  await expect(page.locator(".node.open", { hasText: "First part of Sidenote" }).first()).toBeVisible();
});

test("editing a node pins it, and the model reconciles its parent and its open children", async ({ page }) => {
  await open(page);
  await jump(page, "Passage");
  await keys(page, "l c");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("A human rewrote this section entirely.");
  await page.keyboard.press("Escape");
  await idle(page);
  const after = await state(page, (s) => {
    const by = (t: string): any => Object.values(s.snap.nodes).find((x: any) => x.title === t);
    return { passage: by("Passage"), parent: by("Display forms").body, log: s.log.map((l: any) => l.text) };
  });
  expect(after.passage).toMatchObject({ body: "A human rewrote this section entirely.", pinned: true, by: "human" });
  // The mock resolver says one level up needs rewriting; the level above that is kept.
  expect(after.parent).toMatch(/^Re-summarised from: Gloss; Sidenote; Passage/);
  expect(after.log.some((l: string) => /1 level up/.test(l))).toBe(true);
  await expect(page.locator(".flags.attn")).toHaveCount(0);
});

test("add, rename, move, delete and undo, without leaving the keyboard", async ({ page }) => {
  await open(page);
  await jump(page, "Keyboard and focus");
  const before = await titlesUnder(page, "Keyboard and focus");
  await keys(page, "l a");
  await page.keyboard.type("Chords");
  await page.keyboard.press("Enter");
  await idle(page);
  expect(await titlesUnder(page, "Keyboard and focus")).toEqual([...before, "Chords"]);
  expect(await focusedTitle(page)).toBe("Chords");
  await keys(page, "K K");
  await idle(page);
  expect((await titlesUnder(page, "Keyboard and focus")).indexOf("Chords")).toBe(before.length - 2);
  await keys(page, "r");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Key chords");
  await page.keyboard.press("Enter");
  await idle(page);
  expect(await titlesUnder(page, "Keyboard and focus")).toContain("Key chords");
  await keys(page, "D");
  await idle(page);
  expect(await titlesUnder(page, "Keyboard and focus")).not.toContain("Key chords");
  // Every one of those steps, and every reconciliation they triggered, is a named, hashed commit.
  const log = await state(page, (s) => s.commits().slice(0, 12).map((c: any) => [c.message, !!c.hash]));
  expect(log.filter(([m]: [string]) => m === "(undo/redo)")).toEqual([]);
  expect(log.every(([, hashed]: [string, boolean]) => hashed)).toBe(true);
  expect(log.map(([m]: [string]) => m)).toContain("Delete “Key chords”");
  await keys(page, "u");
  expect(await titlesUnder(page, "Keyboard and focus")).toContain("Key chords");
});

test("the editor agent edits through the same ops and its work is merged back", async ({ page }) => {
  await open(page);
  await jump(page, "The tree underneath");
  await command(page, 'add "Garbage collection"');
  await idle(page);
  expect(await titlesUnder(page, "The tree underneath")).toContain("Garbage collection");
  const commit = await state(page, (s) => s.commits().find((c: any) => c.message.startsWith("Agent: add")));
  expect(commit).toMatchObject({ by: "agent", actor: "llm" });
  // u takes the agent's work back.
  await keys(page, "u");
  expect(await titlesUnder(page, "The tree underneath")).not.toContain("Garbage collection");
});

test("history: every commit verifies, any commit can be viewed, and a revert is a new commit", async ({ page }) => {
  await open(page);
  await keys(page, "g v");
  await expect(page.locator(".verdict")).toContainText(/Verified: all \d+ hashed commits reproduce byte-for-byte/);
  const total = await state(page, (s) => s.commits().length);
  expect(total).toBeGreaterThan(11);
  // Walk down to the oldest commits (the library's creation, then the first tree's) and look
  // at the tree as it was when only three sections had been written.
  for (let i = 0; i < total + 5; i++) await page.keyboard.press("j");
  await keys(page, "k k k k Enter");
  await expect(page.locator(".banner")).toContainText("Read-only");
  await expect(page.locator("article > .outline > .node")).toHaveCount(3);
  // Writing is refused while viewing the past.
  await keys(page, "a");
  await expect(page.locator(".status .message")).toContainText("read-only");
  await expect(page.locator(".title-editor")).toHaveCount(0);
  // Revert to it: the node the reader is on (the tree's top) goes back, the rest of the library stays, and the revert is itself
  // a commit that can be undone.
  const others = await state(page, (s) => s.doc.snap().nodes[s.doc.snap().root].children.filter((c: string) => c !== s.activeNode).map((c: string) => s.doc.shape(undefined, c)).join());
  expect(others).not.toBe("");
  await keys(page, "r");
  await expect(page.locator(".banner")).toHaveCount(0);
  await expect(page.locator("article > .outline > .node")).toHaveCount(3);
  expect(await state(page, (s) => s.commits()[0].tag)).toBe("revert");
  expect(await state(page, (s) => s.doc.snap().nodes[s.doc.snap().root].children.filter((c: string) => c !== s.activeNode).map((c: string) => s.doc.shape(undefined, c)).join())).toBe(others);
  await keys(page, "v");
  await expect(page.locator(".verdict")).toContainText("Verified");
  await keys(page, "Escape u");
  await expect(page.locator("article > .outline > .node")).toHaveCount(10);
});

test("branches merge; a conflict in meaning is found, resolved by the model, and can be overruled", async ({ page }) => {
  await open(page);
  const edit = async (text: string) => {
    await jump(page, "Deeper, not longer");
    await keys(page, "l c");
    await page.keyboard.press("Control+a");
    await page.keyboard.type(text);
    await page.keyboard.press("Escape");
    await idle(page);
  };
  await command(page, "/auto off"); // keep the cascade out of this test
  await command(page, "/branch alt");
  await edit("On alt: deeper text is always shorter.");
  await command(page, "/switch main");
  await edit("On main: deeper text is never shorter.");
  await command(page, "/auto on");
  await command(page, "/merge alt");
  await idle(page);
  const conflicts = await state(page, (s) => s.doc.conflicts());
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]).toMatchObject({ type: "edit-edit", status: "resolved", resolvedBy: "resolver" });
  expect([conflicts[0].a, conflicts[0].b].sort()).toEqual(["On alt: deeper text is always shorter.", "On main: deeper text is never shorter."]);
  // Review it in the panel and overrule the model: take side B instead.
  await keys(page, "g");
  for (let i = 0; i < 40; i++) await page.keyboard.press("k");
  await expect(page.locator(".conflict.selected")).toContainText("resolved by resolver");
  await keys(page, "x");
  expect((await state(page, (s) => s.doc.conflicts()))[0].status).toBe("open");
  await keys(page, "2");
  const settled = (await state(page, (s) => s.doc.conflicts()))[0];
  expect(settled).toMatchObject({ status: "resolved", resolvedBy: "tester", resolved: settled.b });
  await keys(page, "v");
  await expect(page.locator(".verdict")).toContainText("Verified");
});

test("two people editing at once converge, and the library survives a reload", async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await open(a);
  await open(b);
  await jump(a, "A shared working memory");
  await keys(a, "l a");
  await a.keyboard.type("Written by A");
  await a.keyboard.press("Enter");
  await jump(b, "How we know it works");
  await keys(b, "l a");
  await b.keyboard.type("Written by B");
  await b.keyboard.press("Enter");
  await expect.poll(() => titlesUnder(a, "How we know it works")).toContain("Written by B");
  await expect.poll(() => titlesUnder(b, "A shared working memory")).toContain("Written by A");
  await idle(a);
  await idle(b);
  await expect.poll(async () => (await state(a, (s) => s.doc.stateHash())) === (await state(b, (s) => s.doc.stateHash()))).toBe(true);
  await a.reload();
  await a.waitForSelector("article");
  expect(await titlesUnder(a, "How we know it works")).toContain("Written by B");
  // The view is remembered too: the section A opened is still open.
  await expect(a.locator(".node.open", { hasText: "A shared working memory" }).first()).toBeVisible();
});
