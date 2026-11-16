/**
 * Annotating Wikipedia articles, keyboard first, against the mock Wikipedia and the mock model:
 * words of an article are selected with the same keys as words of a node, a lens writes a note on
 * them, the note belongs to the article (it shows wherever the article is opened), and it is found
 * again in a later revision, or listed as detached when its words are gone.
 */
import { expect, test, type Page } from "@playwright/test";
import { command, idle, jump, keys, seedLinks, selected, settle, state } from "./helpers";

const panes = (page: Page) => page.locator(".strip .pane");

async function wide(page: Page, path = "/doc/fixed-points") {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(path);
  await page.waitForSelector(".strip .pane");
  await page.evaluate(() => document.fonts.ready);
}
async function column(page: Page, path: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(path);
  await page.waitForFunction(() => (globalThis as any).__ie?.ready);
}
async function tabTo(page: Page, words: string) {
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press("Tab");
    if ((await selected(page)) === words || (await articleSelection(page)) === words) return;
  }
  throw new Error(`Tab never reached “${words}”`);
}
/** The words selected in an article's text. */
const articleSelection = (page: Page) => state(page, (s) => s.selectedText() as string | null);
/** The library's annotations: their words and text. */
const annotations = (page: Page) => state(page, (s) => Object.values(s.snap.nodes).filter((n: any) => n.wanchor).map((n: any) => `${n.wanchor.q} | ${n.body}`));

test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ request }) => {
  await seedLinks(request);
});
test.beforeEach(async ({ context }) => {
  await context.route(/wikipedia\.org|wikimedia\.org/, (r) => r.abort());
});
test.afterEach(({ page }) => settle(page));

test("words of an article are selected with the node keys, and a lens writes a note on them that the library keeps", async ({ page }) => {
  await wide(page);
  const docs = await state(page, (s) => s.menuItems("").length);
  await jump(page, "Recursion without names");
  await tabTo(page, "fixed-point combinator");
  await keys(page, "Enter");
  const art = page.locator(".wiki-pane").last();
  await expect(art.locator(".wiki-head h2")).toHaveText("Fixed-point combinator");
  // i: the first sentence; i again: its first word; j moves by word, Esc widens back.
  // (Pressed while the article is still arriving, i waits for it.)
  await keys(page, "i");
  await expect.poll(() => articleSelection(page)).toMatch(/^In mathematics and computer science, a fixed-point combinator .* of f: a value x with f\(x\) = x\.$/);
  await expect(art.locator(".wiki-text .sel")).not.toHaveCount(0);
  await keys(page, "i");
  expect(await articleSelection(page)).toBe("In");
  await keys(page, "j L");
  expect(await articleSelection(page)).toBe("mathematics and");
  await keys(page, "Escape");
  // A sentence: y asks why, as a margin note set after its paragraph.
  await keys(page, "j");
  const sentence = await articleSelection(page);
  expect(sentence).toMatch(/^In the untyped lambda calculus/);
  await keys(page, "y");
  await idle(page);
  const note = art.locator(".wiki-text .inset");
  await expect(note).toContainText("through the why lens");
  expect(await note.evaluate((el) => getComputedStyle(el).fontFamily)).toContain("Serif");
  // Tab reaches links and the note's words; d on a link's words writes a gloss.
  await keys(page, "Escape");
  await tabTo(page, "Haskell Curry");
  await expect(art.locator("a.wfocus")).toHaveText("Haskell Curry");
  await keys(page, "d");
  await idle(page);
  await expect(art.locator(".wiki-text .gloss")).toContainText("mock gloss of Haskell Curry");
  await expect(art.locator(".wiki-text .anchor.a-gloss")).toHaveText("Haskell Curry");
  expect((await annotations(page)).sort()).toEqual([`Haskell Curry | mock gloss of Haskell Curry`, `${sentence} | Mock note on “${sentence!.slice(0, 47)}…” through the why lens. It is two sentences long.`].sort());
  // The article's node is in the library's Wikipedia container, which is not a document.
  expect(await state(page, (s) => s.menuItems("").length)).toBe(docs);
  expect(await state(page, (s) => s.menuItems("").some((d: any) => d.title === "Wikipedia"))).toBe(false);
  // Keys that only make sense on a node say why not.
  await keys(page, "Escape Escape");
  await keys(page, "c");
  await expect(page.locator(".status .message")).toContainText("cannot be edited");
  await keys(page, "r");
  await expect(page.locator(".status .message")).toContainText("shown as it is");
});

test("an annotation is a note: Enter steps into it, and it is edited, undone, deleted and given to the editor like any other", async ({ page }) => {
  await wide(page);
  await jump(page, "Recursion without names");
  await tabTo(page, "fixed-point combinator");
  await keys(page, "Enter");
  await keys(page, "i");
  await tabTo(page, "Haskell Curry");
  const art = page.locator(".wiki-pane").last();
  // Its words carry the dotted underline; e opens and closes it, as on a node; Enter opens it, and Enter again steps into it.
  await expect(art.locator(".wiki-text .anchor.a-gloss")).toHaveText("Haskell Curry");
  await expect(art.locator(".wiki-text .gloss")).toHaveCount(0);
  await keys(page, "e");
  await expect(art.locator(".wiki-text .gloss")).toHaveCount(1);
  await keys(page, "e");
  await expect(art.locator(".wiki-text .gloss")).toHaveCount(0);
  await keys(page, "Enter Enter");
  const id = await state(page, (s) => s.focus.node);
  expect(await state(page, (s) => !!s.snap.nodes[s.focus.node].wanchor && s.aux === null)).toBe(true);
  await expect(art.locator(".wiki-text .gloss.focused")).toHaveCount(1);
  // c edits it in place.
  await keys(page, "c");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("the logician the Y combinator is named after");
  await keys(page, "Escape");
  await expect(art.locator(".wiki-text .gloss")).toContainText("the logician the Y combinator is named after");
  await keys(page, "u");
  await expect(art.locator(".wiki-text .gloss")).toContainText("mock gloss of Haskell Curry");
  // The editor agent works on it like on any node.
  await command(page, 'rename to "Curry"');
  await idle(page);
  expect(await state(page, (s) => s.snap.nodes[s.focus.node]?.title)).toBe("Curry");
  // h returns to its words; D there deletes it, u brings it back.
  await keys(page, "h");
  expect(await articleSelection(page)).toBe("Haskell Curry");
  await keys(page, "D");
  expect(await page.evaluate((x) => !!(globalThis as any).__ie.snap.nodes[x], id)).toBe(false);
  await expect(art.locator(".wiki-text .gloss")).toHaveCount(0);
  await expect(art.locator(".wiki-text .anchor.a-gloss")).toHaveCount(0);
  await keys(page, "u");
  await expect(art.locator(".wiki-text .anchor.a-gloss")).toHaveText("Haskell Curry");
});

test("an article's annotations show wherever it is opened: from another link, from another article, by its address", async ({ page }) => {
  // Annotate Lambda calculus under the note that links to it (the article in full beneath the note).
  await wide(page);
  await jump(page, "Recursion without names");
  await tabTo(page, "lambda calculus");
  await keys(page, "Enter j");
  const under = panes(page).last().locator(".wiki.embedded");
  await expect(under.locator(".wiki-head h2")).toHaveText("Lambda calculus");
  await keys(page, "i");
  await expect.poll(() => articleSelection(page)).toMatch(/^Lambda calculus \(also written λ-calculus\) is a formal system/);
  await keys(page, "x");
  await idle(page);
  await expect(under.locator(".wiki-text .inset")).toContainText("through the example lens");
  // From another document's link to it.
  await settle(page);
  await wide(page, "/doc/what-a-proof-is");
  await jump(page, "Proofs as programs");
  await tabTo(page, "a function turning proofs");
  await keys(page, "Enter");
  await expect(page.locator(".wiki-pane").last().locator(".wiki-head h2")).toHaveText("Lambda calculus");
  await expect(page.locator(".wiki-pane").last().locator(".wiki-text .inset")).toContainText("through the example lens");
  // From another article's link to it.
  await jump(page, "Recursion without names");
  await tabTo(page, "fixed-point combinator");
  await keys(page, "Enter");
  await tabTo(page, "lambda calculus");
  await keys(page, "Enter");
  await expect(page.locator(".wiki-pane").last().locator(".wiki-head h2")).toHaveText("Lambda calculus");
  await expect(page.locator(".wiki-pane").last().locator(".wiki-text .inset")).toContainText("through the example lens");
  // By its address, as the column's article page.
  await settle(page);
  await column(page, "/w/en/Lambda_calculus");
  await expect(page.locator(".wiki-page .wiki-text .inset")).toContainText("through the example lens");
});

test("in a new revision an annotation is found where its words moved; one whose words are gone is kept as detached", async ({ page }) => {
  await column(page, "/w/en/Octopus");
  const pageEl = page.locator(".wiki-page");
  const openSection = async (title: string) => {
    const focused = () => page.evaluate(() => document.querySelector(".wiki-page .wrow.focused > .row .title")?.textContent ?? "");
    await expect(pageEl.locator(".wrow").first()).toBeVisible();
    for (let i = 0; i < 12 && (await focused()) !== title; i++) await keys(page, "j");
    await keys(page, "l");
  };
  // A note on a sentence of Description, and one on a sentence of Intelligence.
  await openSection("Description");
  await keys(page, "i j");
  expect(await articleSelection(page)).toBe("Its skin contains specialised cells that let it change colour and texture within a fraction of a second.");
  await keys(page, "y");
  await idle(page);
  await keys(page, "Escape Escape");
  await openSection("Intelligence");
  await keys(page, "i j");
  expect(await articleSelection(page)).toBe("In laboratory studies they have solved mazes, unscrewed jar lids and learned by watching other octopuses.");
  await keys(page, "x");
  await idle(page);
  await expect(pageEl.locator(".wiki-text .inset")).toHaveCount(2);
  const rev = await state(page, (s) => (Object.values(s.snap.nodes) as any[]).find((n) => n.wanchor?.q.startsWith("Its skin")).wanchor.rev as number);
  await settle(page);
  // The next revision: the Intelligence paragraph moved into Description and edited around the
  // annotated sentence, and the skin sentence rewritten away.
  await page.route(/\/api\/wiki\/article\?title=Octopus/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const a = body.article;
    a.revisionId += 1;
    const desc = a.sections.find((x: any) => x.heading === "Description");
    const intel = a.sections.find((x: any) => x.heading === "Intelligence");
    desc.html = desc.html.replace(/Its skin contains specialised cells[^.]*\./, "Its skin can change colour in an instant.") + intel.html.replace("Some have been seen carrying coconut shells to use later as shelter.", "Some carry coconut shells about.").replace("widely regarded as", "often called");
    intel.html = "<p>See above.</p>";
    await route.fulfill({ response: res, json: body });
  });
  await page.reload();
  await page.waitForFunction(() => (globalThis as any).__ie?.ready);
  await openSection("Description");
  const desc = pageEl.locator(".wrow.open").first();
  await expect(desc.locator(".wdetached .inset")).toContainText("Its skin contains specialised cells");
  await expect(desc.locator(".wdetached a")).toHaveAttribute("href", new RegExp(`oldid=${rev}$`));
  await expect(desc.locator(".wiki-text .anchor")).toHaveText("In laboratory studies they have solved mazes, unscrewed jar lids and learned by watching other octopuses.");
  await expect(desc.locator(".wiki-text .inset")).toContainText("through the example lens");
  // Nothing was lost or rewritten: both annotations are still in the library as they were.
  expect((await annotations(page)).filter((a) => /^(Its skin|In laboratory)/.test(a))).toHaveLength(2);
});
