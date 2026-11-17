/**
 * Links and Wikipedia, keyboard only, against the mock Wikipedia (IE_WIKI=mock, server/wikiMock.ts)
 * and the shared library with links written into it over the op API (e2e/helpers.ts). Nothing here
 * touches the network: requests to wikipedia.org are refused, so a test that opens one only sees
 * the address it would have gone to.
 */
import { expect, test, type Page } from "@playwright/test";
import { autoLayout, command, focusedTitle, jump, keys, seedLinks, selected, settle, state, visit, writeReport, type Sample } from "./helpers";

/** The panes' titles, left to right: a node's title, or W:article for a Wikipedia pane. */
const trail = (page: Page) =>
  state(page, (s) => s.trail.map((p: any) => (p.kind === "node" ? s.snap.nodes[p.id].title || s.snap.nodes[p.id].anchors[0]?.text : `W:${p.title}${p.sec ? `#${p.sec}` : ""}`)));
const panes = (page: Page) => page.locator(".strip .pane");

/** Tab through the focused section's marked spans until the selection is these words. */
async function tabTo(page: Page, words: string) {
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    if ((await selected(page)) === words) return;
  }
  throw new Error(`Tab never reached “${words}”`);
}

async function column(page: Page, path = "Fixed points") {
  await page.setViewportSize({ width: 1440, height: 900 });
  // After wide(), this page's layout follows the window, and 1440 px is wide enough for panes.
  if (page.url().startsWith("http")) await page.evaluate(() => localStorage.setItem("ie:settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("ie:settings") ?? "{}"), view: "column" })));
  await visit(page, path);
  await page.waitForFunction(() => (globalThis as any).__ie?.ready);
  await page.evaluate(() => document.fonts.ready);
}
async function wide(page: Page, path = "Fixed points") {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await autoLayout(page);
  await visit(page, path);
  await page.waitForSelector(".strip .pane");
  await page.evaluate(() => document.fonts.ready);
}
/** Open a section in panes and select the first marked span in its text. */
async function inPane(page: Page, title: string, words: string) {
  await jump(page, title);
  await tabTo(page, words);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  await seedLinks(request);
});

test.beforeEach(async ({ context }) => {
  // The mock answers /api/wiki; wikipedia.org itself is never reached from a test.
  await context.route(/wikipedia\.org|wikimedia\.org|evil\.example|stanford\.edu|example\.org/, (r) => r.abort());
});

test.afterEach(({ page }) => settle(page));

test("each kind of link has its mark; a note that also links keeps its dotted underline", async ({ page }) => {
  await column(page);
  await jump(page, "Recursion without names");
  await keys(page, "Enter");
  const sec = page.locator(".node.open", { hasText: "Recursion without names" }).first();
  // Wikipedia: solid underline and a W after the words.
  const wiki = sec.locator(".lnk.l-wiki", { hasText: "fixed-point combinator" });
  await expect(wiki).toBeVisible();
  expect(await wiki.evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain("underline");
  await expect(sec.locator(".lmark.l-wiki").first()).toHaveText("W");
  // Another note in the library: §, with its top in its tooltip.
  await expect(sec.locator(".lnk.l-node", { hasText: "Y combinator" })).toBeVisible();
  const nodeMark = sec.locator(".lmark.l-node").first();
  await expect(nodeMark).toHaveText("§");
  expect(await nodeMark.getAttribute("title")).toContain("in Fixed points");
  // The web: ↗.
  await expect(sec.locator(".lnk.l-url", { hasText: "self-reference" })).toBeVisible();
  await expect(sec.locator(".lmark.l-url")).toHaveText("↗");
  // Both: "lambda calculus" is a gloss (dotted) that also links to an article (W).
  const both = sec.locator(".anchor", { hasText: "lambda calculus" });
  await expect(both).toBeVisible();
  expect(await both.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("gradient");
  expect(await both.evaluate((el) => el.nextElementSibling?.className)).toContain("lmark l-wiki");
  // The marks are not text: the body offsets are unchanged and the mark cannot be selected.
  expect(await sec.locator(".lmark").first().evaluate((el) => getComputedStyle(el).userSelect)).toBe("none");
});

test("hovering a link shows its preview and leaving or a key takes it away; focusing it by keyboard shows it too", async ({ page }) => {
  await column(page);
  await jump(page, "Recursion without names");
  await keys(page, "Enter");
  const link = page.locator(".lnk.l-wiki", { hasText: "fixed-point combinator" });
  await link.hover();
  const popup = page.locator(".popup:not(.focus-popup)");
  await expect(popup).toContainText("Higher-order function Y for which Y f = f (Y f)");
  await expect(popup.locator(".wattr")).toContainText("CC BY-SA 4.0");
  await page.mouse.move(5, 5);
  await expect(popup).toHaveCount(0);
  // It does not come back on its own, and a key press ends a pending one.
  await link.hover();
  await expect(popup).toHaveCount(1);
  await page.keyboard.press("Shift");
  await expect(popup).toHaveCount(0);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(700);
  await expect(page.locator(".popup")).toHaveCount(0);
  // The node link's preview names its top and shows its first lines.
  await page.locator(".lnk.l-node", { hasText: "Y combinator" }).hover();
  await expect(popup).toContainText("Fixed points");
  await expect(popup).toContainText("How Y works");
  await page.mouse.move(5, 5);
  await expect(popup).toHaveCount(0);
  // By keyboard: while the selection is a link's words, its card shows beside them, and goes with the focus.
  await keys(page, "i");
  await tabTo(page, "fixed-point combinator");
  const fp = page.locator(".focus-popup");
  await expect(fp).toBeVisible();
  await expect(fp).toContainText("Fixed-point combinator");
  await tabTo(page, "self-reference");
  await expect(fp).toContainText("plato.stanford.edu");
  await keys(page, "Escape");
  await expect(fp).toHaveCount(0);
});

test("panes: Tab and Enter open an article in the next pane; its sections open as rows; a link in it opens a further pane; moving left keeps the trail", async ({ page }) => {
  await wide(page);
  await inPane(page, "Recursion without names", "fixed-point combinator");
  await keys(page, "Enter");
  const art = page.locator(".wiki-pane").last();
  await expect(art.locator(".wiki-head h2")).toHaveText("Fixed-point combinator");
  await expect(art.locator(".wiki-brand")).toContainText("Wikipedia");
  await expect(art.locator(".wattr")).toContainText("CC BY-SA 4.0");
  await expect(art.locator(".wattr")).toContainText("Adapted");
  // Its sections are rows, numbered; the lead is its text, with the sanitiser's leftovers gone.
  await expect(art.locator(".wrow > .row .title")).toHaveText(["Introduction", "Y combinator", "Other fixed-point combinators", "Typed fixed-point combinators"]);
  expect(await art.locator(".wiki-text sup, .wiki-text table.infobox, .wiki-text script").count()).toBe(0);
  expect(await trail(page)).toEqual(["Library", "Fixed points", "Recursion without names", "W:Fixed-point combinator"]);
  // j j l: the second section opens as the next pane; l again steps into it.
  await expect(art.locator(".wrow").first()).toBeVisible();
  await keys(page, "j j l");
  await expect(panes(page)).toHaveCount(5);
  const sec = panes(page).last();
  await expect(sec.locator(".wiki-head h2")).toContainText("Y combinator");
  await expect(sec.locator(".wrow .title")).toHaveText(["Verification"]);
  await expect(sec.locator(".wattr")).toBeVisible();
  await keys(page, "l");
  expect(await state(page, (s) => s.aux)).toMatchObject({ kind: "wiki", host: "p4", row: { t: "head" } });
  // Tab selects the section's link to Lambda calculus, as words of a node; Enter opens it as a further pane.
  await keys(page, "Tab");
  await expect(sec.locator("a.wfocus")).toHaveText("lambda calculus");
  expect(await state(page, (s) => s.selectedText())).toBe("lambda calculus");
  await keys(page, "Enter");
  await expect(panes(page)).toHaveCount(6);
  await expect(panes(page).last().locator(".wiki-head h2")).toHaveText("Lambda calculus");
  // Back left, step by step, to the words the trail started from; nothing to the right closes.
  await keys(page, "h");
  expect(await state(page, (s) => s.paneAt)).toBe(4);
  // From the link it was opened from: Esc widens the selection to its sentence, then to the text's
  // head; h goes up to the section's row in the pane before, its head, the words.
  await keys(page, "Escape Escape h h h");
  expect(await selected(page)).toBe("fixed-point combinator");
  expect(await trail(page)).toEqual(["Library", "Fixed points", "Recursion without names", "W:Fixed-point combinator", "W:Fixed-point combinator#2", "W:Lambda calculus"]);
  await expect(panes(page)).toHaveCount(6);
  // Opening something else from an earlier pane opens it beside what is to its right.
  await tabTo(page, "lambda calculus");
  await keys(page, "Enter");
  expect((await trail(page)).slice(3)).toEqual(["lambda calculus"]);
  // W opens the focused article on wikipedia.org in a new tab (refused here, so only its address is seen).
  await keys(page, "h");
  await tabTo(page, "fixed-point combinator");
  await keys(page, "Enter");
  const [req] = await Promise.all([page.context().waitForEvent("request", (r) => r.url().includes("wikipedia.org")), page.keyboard.press("W")]);
  expect(req.url()).toBe("https://en.wikipedia.org/wiki/Fixed-point_combinator");
  for (const p of page.context().pages()) if (p !== page) await p.close();
  // Spines of covered article panes carry the W and the tint.
  await page.locator('.pane.active .wiki-text a[data-wiki="Lambda calculus"]').first().click();
  await expect(page.locator(".pane.active .wiki-head h2")).toHaveText("Lambda calculus");
  await page.locator('.pane.active .wiki-text a[data-wiki="Alonzo Church"]').first().click();
  await expect(page.locator(".pane.active .wiki-head h2")).toHaveText("Alonzo Church");
  await page.locator('.pane.active .wiki-text a[data-wiki="Lambda calculus"]').first().click();
  await expect(page.locator(".pane.active .wiki-head h2")).toHaveText("Lambda calculus");
  const spine = page.locator(".col[data-covered] .wiki-pane .spine").first();
  await expect(spine.locator(".wmark")).toHaveText("W");
  expect(await spine.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(await page.locator(".pane.root .spine").evaluate((el) => getComputedStyle(el).backgroundColor));
});

test("a note that also links opens as one pane: its text above, the article in full beneath", async ({ page }) => {
  await wide(page, "Where the elements come from");
  await inPane(page, "The triple-alpha process", "an excited state at almost exactly the energy");
  await keys(page, "Enter");
  const pane = panes(page).last();
  await expect(pane).toHaveClass(/note-pane/);
  await expect(pane.locator(".body").first()).toContainText("It is called the Hoyle state");
  const block = pane.locator(".wiki.embedded");
  await expect(block).not.toHaveClass(/folded/);
  await expect(block.locator(".wiki-head h2")).toHaveText("Hoyle state");
  await expect(block.locator(".wiki-text").first()).toContainText("excited, spin-0 resonant state");
  await expect(block.locator(".wattr")).toBeVisible();
  await expect(block.locator(".wrow .title")).toHaveText(["Prediction", "Structure"]);
  expect(await block.locator(".wiki-text a[data-wiki]").evaluateAll((as) => as.map((a) => a.getAttribute("data-wiki")))).toEqual(["Carbon-12", "Fred Hoyle", "Triple-alpha process"]);
  // j reaches the article under the note, then its sections; l opens one as the next pane.
  await keys(page, "j");
  expect(await state(page, (s) => s.aux?.host?.startsWith("n"))).toBe(true);
  await keys(page, "j l");
  await expect(panes(page).last().locator(".wiki-head h2")).toContainText("Prediction");
  await keys(page, "h h h");
  expect(await state(page, (s) => s.aux)).toBeNull();
});

/** The page a note with a target opens as: the note's text first, as the library's, then the article. */
async function expectCommentary(page: Page, note: string, article: string, lead: string) {
  const host = page.locator(".pane.note-pane, article:has(> header h1.note-title)").last();
  await expect(host.locator(".body").first()).toContainText(note);
  const block = host.locator(".wiki.embedded");
  await expect(block).not.toHaveClass(/folded/);
  await expect(block.locator(".wiki-head h2")).toHaveText(article);
  await expect(block.locator(".wiki-text").first()).toContainText(lead);
  // The note's text comes before the article's.
  const [n, a] = await Promise.all([host.locator(".body").first().boundingBox(), block.boundingBox()]);
  expect(n!.y).toBeLessThan(a!.y);
}

test("a note that also links, clicked or entered, opens its article with the note on top, in panes and in the column", async ({ page }) => {
  const words = "an excited state at almost exactly the energy";
  const note = "It is called the Hoyle state";
  // Panes, by click.
  await wide(page, "Where the elements come from");
  await jump(page, "The triple-alpha process");
  await keys(page, "l");
  await panes(page).last().locator(".anchor", { hasText: words }).click();
  await expect(panes(page).last()).toHaveClass(/note-pane/);
  await expectCommentary(page, note, "Hoyle state", "excited, spin-0 resonant state");
  // The column, by keyboard: Enter on the words opens the note as a page; h returns to the words.
  await column(page, "Where the elements come from");
  await jump(page, "The triple-alpha process");
  await keys(page, "Enter i");
  await tabTo(page, words);
  await keys(page, "Enter");
  await expectCommentary(page, note, "Hoyle state", "excited, spin-0 resonant state");
  // Its sections open in place, as on the article page.
  for (let i = 0; i < 6 && !(await page.locator(".wrow.focused").count()); i++) await keys(page, "j");
  await keys(page, "l");
  await expect(page.locator(".wrow.open .wiki-text")).toContainText("Hoyle reasoned");
  await keys(page, "h h h");
  expect(await selected(page)).toBe(words);
  await expect(page.locator(".wiki.embedded")).toHaveCount(0);
  // The column, by click.
  await page.locator(".anchor", { hasText: words }).click();
  await expectCommentary(page, note, "Hoyle state", "excited, spin-0 resonant state");
  await page.goBack();
  await expect(page.locator(".wiki.embedded")).toHaveCount(0);
});

test("a note and a link on the same words open as that one page: the note on top, the linked article beneath", async ({ page }) => {
  const words = "The camera-like eye";
  const note = "The octopus eye has a lens";
  await wide(page, "Octopus minds");
  await inPane(page, "The common ancestor", words);
  await keys(page, "Enter");
  await expectCommentary(page, note, "Cephalopod", "molluscan class Cephalopoda");
  await column(page, "Octopus minds");
  await jump(page, "The common ancestor");
  await keys(page, "l");
  await page.locator(".anchor", { hasText: words }).click();
  await expectCommentary(page, note, "Cephalopod", "molluscan class Cephalopoda");
  await keys(page, "h");
  expect(await selected(page)).toBe(words);
});

test("a link to a node in another tree opens it, and Back returns; in panes it opens next and h returns", async ({ page }) => {
  await column(page, "What a proof is");
  await jump(page, "Proofs as programs");
  await keys(page, "Enter i");
  await tabTo(page, "Several of the leading systems");
  await keys(page, "Enter");
  const preview = page.locator(".lpreview.l-node");
  await expect(preview).toContainText("Fixed points");
  await expect(preview).toContainText("Recursion without names");
  await keys(page, "Enter");
  await expect.poll(() => focusedTitle(page)).toBe("Recursion without names");
  const recursion = await state(page, (s) => s.focus.node);
  await expect(page).toHaveURL(new RegExp(`/n/${encodeURIComponent(recursion)}$`));
  await page.goBack();
  await expect.poll(() => focusedTitle(page)).toBe("Proofs as programs");
  // Panes: the node opens in the next pane, marked with the titles above it; h comes back to the words.
  await wide(page, "What a proof is");
  await inPane(page, "Proofs as programs", "Several of the leading systems");
  await keys(page, "Enter");
  const last = panes(page).last();
  await expect(last).toHaveClass(/jumped/);
  await expect(last.locator(".pane-from")).toHaveText("Library › Fixed points");
  await expect(last.locator(".pane-head h2")).toHaveText("Recursion without names");
  await keys(page, "h");
  expect(await selected(page)).toBe("Several of the leading systems");
  // The library, What a proof is, Proof assistants, Proofs as programs, and the node opened beside it
  // (following the link out of the hoisted tree in the column un-hoisted the page to the library).
  await expect(panes(page)).toHaveCount(5);
});

test("Linked from and Mentioned in list what links here, reachable by j and Enter", async ({ page }) => {
  await wide(page);
  await jump(page, "Recursion without names");
  await keys(page, "l");
  const pane = panes(page).last();
  const back = pane.locator(".backlinks");
  await expect(back.locator("h3")).toHaveText("Linked from");
  await expect(back.locator("li .bl-title")).toHaveText(["Proofs as programs"]);
  await expect(back.locator("li .bl-doc")).toHaveText(["What a proof is"]);
  // A section nothing links to has no list at all.
  await expect(page.locator(`.pane[data-pane="${await state(page, (s) => s.focus.node)}"] .backlinks`)).toHaveCount(1);
  await keys(page, "l j j");
  await expect(back.locator("li.focused")).toHaveCount(1);
  await keys(page, "Enter");
  expect(await selected(page)).toBe("Several of the leading systems");
  // Lambda calculus is linked from two top-level trees: its pane lists both, and either leads back.
  await inPane(page, "Recursion without names", "lambda calculus");
  await keys(page, "Enter j l");
  const art = page.locator(".wiki-pane").last();
  await keys(page, "L");
  const lc = page.locator(".wiki-pane").last();
  await expect(lc.locator(".backlinks h3")).toHaveText("Mentioned in");
  await expect(lc.locator(".backlinks .bl-doc")).toHaveText(["Fixed points", "What a proof is"]);
  for (let i = 0; i < 8 && !(await lc.locator(".backlinks li.focused").count()); i++) await keys(page, "j");
  await keys(page, "j");
  await expect(lc.locator(".backlinks li.focused .bl-doc")).toHaveText("What a proof is");
  await keys(page, "Enter");
  expect(await selected(page)).toBe("a function turning proofs");
  void art;
});

test("linking by hand: the picker links to the library, to Wikipedia and to an address; it retargets; /unlink and D remove", async ({ page }) => {
  await column(page, "The tides");
  await jump(page, "The tides");
  const doc = await state(page, (s) => s.focus.node);
  const linkCount = () => page.evaluate((d) => {
    const s = (globalThis as any).__ie.snap;
    return s.nodes[d].children.map((c: string) => s.nodes[c]).filter((n: any) => n.ref).map((n: any) => `${n.anchors[0].text}|${n.ref.kind}|${n.ref.title ?? n.ref.url ?? n.ref.path?.join("/")}`);
  }, doc);
  // A word in the page's text: i i selects it; w opens the picker filled with it.
  await keys(page, "i i");
  const word = await selected(page);
  await keys(page, "w");
  const picker = page.locator(".picker");
  await expect(picker.locator("input")).toHaveValue(word);
  // Library: a top-level node by title.
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Octopus minds");
  await expect(picker.locator(".choice.selected .t")).toHaveText("Octopus minds");
  await keys(page, "Enter");
  await expect(picker).toHaveCount(0);
  expect(await linkCount()).toEqual([`${word}|node|Octopus minds`]); // its path: the titles from the library root
  await expect(page.locator(".lnk.l-node", { hasText: word })).toBeVisible();
  // The same picker on that link retargets it, here to Wikipedia: suggestions arrive under their own head.
  await keys(page, "w");
  await expect(picker.locator(".picker-head")).toContainText("Retarget");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("octo");
  await expect(picker.locator(".group", { hasText: "Wikipedia" })).toBeVisible();
  const octopus = picker.locator(".choice", { hasText: "Octopus" }).filter({ hasText: "molluscs" });
  await expect(octopus).toBeVisible();
  while (!(await octopus.evaluate((el) => el.classList.contains("selected")))) await keys(page, "ArrowDown");
  await keys(page, "Enter");
  expect(await linkCount()).toEqual([`${word}|wiki|Octopus`]);
  await expect(page.locator(".lnk.l-wiki", { hasText: word })).toBeVisible();
  // An address: pasted, it is offered as an external link.
  await keys(page, "l");
  const second = await selected(page);
  await keys(page, "w");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("https://example.org/tides");
  await expect(picker.locator(".choice.selected")).toContainText("example.org");
  await keys(page, "Enter");
  expect(await linkCount()).toEqual([`${word}|wiki|Octopus`, `${second}|url|https://example.org/tides`]);
  // /link with a target in the text form, on the node itself: the node is about something.
  await keys(page, "Escape Escape");
  await command(page, "/link w:Tide");
  expect(await state(page, (s) => s.snap.nodes[s.focus.node].ref)).toEqual({ kind: "wiki", title: "Tide", lang: "en" });
  await command(page, "/unlink");
  expect(await state(page, (s) => s.snap.nodes[s.focus.node].ref)).toBeUndefined();
  // /unlink on a link's words removes the link; D on a link removes it too.
  await keys(page, "i");
  await tabTo(page, second);
  await command(page, "/unlink");
  expect(await linkCount()).toEqual([`${word}|wiki|Octopus`]);
  await tabTo(page, word);
  await keys(page, "D");
  expect(await linkCount()).toEqual([]);
  await keys(page, "u");
  expect(await linkCount()).toEqual([`${word}|wiki|Octopus`]);
  await keys(page, "Escape");
});

test("a disambiguation page lists its senses as rows; a missing article, an unreachable Wikipedia and a slow one say so plainly", async ({ page }) => {
  await wide(page, "The tides");
  await jump(page, "The tides");
  await keys(page, "i i");
  await command(page, "/link w:Mercury");
  await keys(page, "Enter");
  const art = page.locator(".wiki-pane.active");
  await expect(art.locator(".senses h3")).toContainText("may refer to");
  await expect(art.locator(".sense .title")).toHaveText(["Mercury (planet)", "Mercury (element)", "Mercury (mythology)", "Freddie Mercury"]);
  await keys(page, "j l");
  await expect(page.locator(".wiki-pane.active").locator(".wiki-head h2")).toHaveText("Mercury (planet)");
  await expect(page.locator(".wiki-pane.active").locator(".wattr")).toBeVisible();
  for (const [title, says] of [["No such article zzz", "No article"], ["Offline example", "could not be reached"]]) {
    await keys(page, "h h h");
    await command(page, `/link w:${title}`);
    await keys(page, "Enter");
    await expect(page.locator(".wiki-pane.active").locator(".wiki-problem")).toContainText(says);
  }
  // Refused or slow, Wikipedia gets a plain message, and the reader is told once (only once) how to make it fast.
  await keys(page, "h h h");
  await command(page, "/link w:Rate limited example");
  await keys(page, "Enter");
  await expect(page.locator(".wiki-pane.active").locator(".wiki-problem")).toContainText("fewer requests");
  await expect(page.locator(".status .message")).toContainText("IE_WIKI_CONTACT");
  expect(await page.evaluate(() => localStorage.getItem("ie:wiki-hint"))).toBe("true");
  await keys(page, "h h h");
  await command(page, "/link w:Slow article");
  await keys(page, "Enter");
  await expect(page.locator(".wiki-pane.active").locator(".wiki-wait")).toContainText("Loading");
  await expect(page.locator(".wiki-pane.active").locator(".wiki-head h2")).toHaveText("Slow article", { timeout: 10_000 });
  await expect(page.locator(".status .message")).not.toContainText("IE_WIKI_CONTACT");
  await keys(page, "h h h");
  await command(page, "/unlink");
});

test("column: Enter on a link shows a preview, Enter again opens the article as a page; its sections open in place; h and Back return", async ({ page }) => {
  await column(page);
  await jump(page, "Recursion without names");
  await keys(page, "Enter i");
  await tabTo(page, "fixed-point combinator");
  await keys(page, "Enter");
  const preview = page.locator(".lpreview.l-wiki");
  await expect(preview).toContainText("Higher-order function Y");
  await expect(preview.locator(".wattr")).toBeVisible();
  await keys(page, "Enter");
  const pageEl = page.locator(".wiki-page");
  await expect(pageEl.locator(".wiki-head h2")).toHaveText("Fixed-point combinator");
  await expect(pageEl.locator(".wattr").last()).toContainText("CC BY-SA 4.0");
  await expect(page).toHaveURL(/\/w\/en\/Fixed-point_combinator$/);
  await expect(pageEl.locator(".wrow").first()).toBeVisible();
  await keys(page, "j j l");
  await expect(pageEl.locator(".wrow.open > .row .title")).toHaveText("Y combinator");
  await expect(pageEl.locator(".wrow.open .wiki-text")).toContainText("defined in the");
  await keys(page, "l");
  await expect(pageEl.locator(".wrow.focused > .row .title")).toHaveText("Verification");
  // A link in the open section opens a further article on the page; h goes back one.
  await keys(page, "h Tab Enter");
  await expect(pageEl.locator(".wiki-head h2")).toHaveText("Lambda calculus");
  await keys(page, "h");
  await expect(pageEl.locator(".wiki-head h2")).toHaveText("Fixed-point combinator");
  // Back on the link's words: Esc widens to the sentence, then to the section's row; h to the head, then out.
  await keys(page, "Escape Escape h h");
  await expect(page.locator(".wiki-page")).toHaveCount(0);
  expect(await selected(page)).toBe("fixed-point combinator");
  // Back works too.
  await keys(page, "Enter");
  await expect(page.locator(".wiki-page")).toHaveCount(1);
  await page.goBack();
  await expect(page.locator(".wiki-page")).toHaveCount(0);
  await expect.poll(() => focusedTitle(page)).toBe("Recursion without names");
  // A section's own target is a row under its text: j reaches it, Enter follows it.
  await command(page, "/link w:Recursion (computer science)");
  await keys(page, "Escape");
  for (let i = 0; i < 6 && !(await page.locator(".target-row.focused").count()); i++) await keys(page, "j");
  await expect(page.locator(".target-row.focused")).toContainText("Recursion (computer science)");
  await keys(page, "Enter");
  await expect(page.locator(".wiki-page .wiki-head h2")).toHaveText("Recursion (computer science)");
  await keys(page, "h");
  await command(page, "/unlink");
});

test("a hostile article cannot run script or load anything from elsewhere, in a pane or on the column's page", async ({ page }) => {
  const outside: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.hostname !== "localhost" && u.protocol !== "data:" && u.protocol !== "blob:") outside.push(r.url());
  });
  let dialogs = 0;
  page.on("dialog", (d) => (dialogs++, d.dismiss()));
  for (const view of [wide, column]) {
    await view(page, "The tides");
    await jump(page, "The tides");
    await keys(page, "i i");
    await command(page, "/link w:Hostile article");
    await keys(page, "Enter");
    if (view === column) await keys(page, "Enter");
    const art = page.locator(view === column ? ".wiki-page" : ".wiki-pane").last();
    await expect(art.locator(".wiki-head h2")).toHaveText("Hostile article");
    // Open its section too (once the article, not just its title, is there).
    await expect(art.locator(".wrow").first()).toBeVisible();
    await keys(page, "j l");
    await page.waitForTimeout(300);
    const text = page.locator(".wiki-text");
    expect(await text.locator("script, iframe, object, embed, img, svg, style, link, form, video, base, meta").count()).toBe(0);
    expect(await text.evaluateAll((els) => els.flatMap((e) => [...e.querySelectorAll("*")]).flatMap((e) => [...e.attributes].map((a) => a.name)).filter((n) => /^on|^style$|^src|^srcset$|^background$/.test(n)))).toEqual([]);
    expect(await text.evaluateAll((els) => els.flatMap((e) => [...e.querySelectorAll("a[href]")]).map((a) => a.getAttribute("href")!).filter((h) => !/^https:\/\//.test(h)))).toEqual([]);
    for (const a of await text.locator("a[target]").all()) expect(await a.getAttribute("rel")).toContain("noopener");
    // The heading with markup in it is shown as text.
    if (view === wide) await expect(page.locator(".wiki-pane").last().locator(".wiki-head")).toContainText("<img");
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
    await keys(page, "h h h h");
    if (view === column) await keys(page, "Escape");
    await command(page, "/unlink");
  }
  expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
  expect(dialogs).toBe(0);
  expect(outside).toEqual([]);
});

test("keypress → paint stays within one frame budget through links and articles, in panes and in the column", async ({ page }) => {
  const paced = async (seq: string) => {
    for (const k of seq.split(" ")) {
      await page.keyboard.press(k);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    }
  };
  const report: Record<string, unknown> = {};
  for (const view of ["panes", "column"] as const) {
    if (view === "panes") await wide(page);
    else await column(page);
    const seq = view === "panes" ? "l i Tab Tab Enter j j l l Tab h h h h Tab Enter j h h Escape Escape" : "Enter i Tab Tab Enter Enter j j l l h h h h Escape Escape";
    const measure = async (passes: number) => {
      await page.evaluate(() => ((globalThis as any).__ie.samples.length = 0));
      for (let pass = 0; pass < passes; pass++) {
        await paced(seq);
        await page.waitForTimeout(50);
      }
      const samples: Sample[] = await state(page, (s) => s.samples);
      const ms = samples.filter((x) => x.what !== "first-token").map((x) => x.ms).sort((a, b) => a - b);
      const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))];
      return { keystrokes: ms.length, median: pct(0.5), p95: pct(0.95), max: ms[ms.length - 1], over20: samples.filter((x) => x.what !== "first-token" && x.ms > 20).map((x) => `${x.what}:${Math.round(x.ms)}`) };
    };
    await jump(page, "Recursion without names");
    // The first time through, each article is fetched, cleaned and laid out for the first time;
    // after that, what is timed is moving through what is already there.
    const cold = await measure(1);
    const warm = await measure(3);
    report[view] = { cold, warm };
    // One frame for nearly every key; a rare second frame (a preview appearing, the column's
    // article page giving way to the node's page) is allowed, as the other latency tests allow it.
    expect(warm.keystrokes).toBeGreaterThan(30);
    expect(warm.median).toBeLessThan(17.5);
    expect(warm.p95).toBeLessThan(34);
    expect(cold.max).toBeLessThan(100);
  }
  console.log("links keypress → paint (ms):", JSON.stringify(report));
  writeReport("links", report);
});
