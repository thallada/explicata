/**
 * Notes on a web page's words, against the mock web (EX_PAGES=mock) and the mock model: the same
 * keys, bar and menu as on Wikipedia's text (i selects, the lenses write a note on the words, Tab
 * reaches it, Enter opens it and steps in, h comes back, e folds it, D deletes it), the note filed
 * under the page's node in the library. It follows its words when a model arranges the page into
 * other sections, is listed as detached when a reload finds them gone, and is listed on a page that
 * cannot be shown; a section that is only a link to a page shows the same notes as the page's own
 * pane. Nothing here touches the network: the server's fetch is the mock's, and the browser's
 * requests elsewhere are refused.
 */
import { expect, test, type Page } from "@playwright/test";
import { WEB, command, idle, jump, keys, seedLinks, seedWeb, settle, state, visit, wide } from "./helpers";

/** server/pageMock.ts `changing`: its text changes after its first read, losing CHANGING_LINE. */
const CHANGING = "https://changing.example.org/notes/harbour-log";
const CHANGING_LINE = "The tide table pinned inside the harbour office was last corrected in a year nobody can now remember.";

const status = (page: Page) => page.locator(".status .message");
/** Open a page in the next pane, as following a link to it does. */
const follow = (page: Page, url: string) => page.evaluate((u) => (globalThis as any).__ie.follow({ kind: "url", url: u }), url);
/** The rightmost pane showing a web page of its own. */
const lastPage = (page: Page) => page.locator(".strip .pane.wiki-pane.web").last();
/** The library's notes on a page: their words and text. */
const notesOn = (page: Page, url: string) =>
  page.evaluate((u) => {
    const s = (globalThis as any).__ie.snap;
    return (Object.values(s.nodes) as any[]).filter((n) => n.wanchor && s.nodes[n.parent]?.ref?.kind === "url" && s.nodes[n.parent].ref.url === u).map((n) => `${n.wanchor.q} | ${n.body}`);
  }, url);

/** Tab through the focused text's links and notes until the selection is these words. */
async function tabTo(page: Page, words: string) {
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press("Tab");
    if ((await state(page, (s) => s.selectedText())) === words) return;
  }
  throw new Error(`Tab never reached “${words}”`);
}

/** Press a key and return what the page route it sends answers. */
async function posted(page: Page, key: string, route: "arrange" | "reload"): Promise<any> {
  const res = page.waitForResponse((r) => r.url().endsWith(`/api/page/${route}`) && r.request().method() === "POST");
  await keys(page, key);
  return (await res).json();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  await seedLinks(request);
  await seedWeb(request);
});

test.beforeEach(async ({ context }) => {
  await context.route((u) => /(^|\.)(wikipedia\.org|wikimedia\.org|stanford\.edu|example\.(org|com|net))$/.test(u.hostname), (r) => r.abort());
});

test.afterEach(({ page }) => settle(page));

test("words of a web page take the lenses as an article's do: the bar offers them, a lens writes a note shown in the page's text and filed under the page; Tab, Enter, h, e and D act on it", async ({ page }) => {
  await wide(page, "Error-correcting codes");
  await follow(page, WEB.tracing);
  const web = lastPage(page);
  const lead = web.locator(".wiki > .wiki-text");
  await expect(lead).toContainText("The request leaves the browser");
  // Without words selected, the keys that write say how, as on Wikipedia's text.
  await keys(page, "e");
  await expect(status(page)).toContainText("Select words first");
  await keys(page, "c");
  await expect(status(page)).toContainText("A web page's text cannot be edited here");

  // A click on a sentence selects it, and the bar offers the lenses.
  await lead.locator(".wpara").first().click({ position: { x: 30, y: 8 } });
  const bar = page.locator(".selbar");
  await expect(bar).toBeVisible();
  for (const l of ["expand", "define", "why", "example", "challenge", "ask…"]) await expect(bar).toContainText(l);
  await expect(bar).not.toContainText("original");
  const sentence = (await state(page, (s) => s.selectedText())) as string;
  expect(sentence).toMatch(/^The request leaves the browser/);
  // Its words are not linked by hand, as an article's are not.
  await keys(page, "w");
  await expect(status(page)).toContainText("Words of a web page cannot be linked from here");

  await keys(page, "y");
  await idle(page);
  await expect(lead.locator(".anchor")).toHaveText(sentence);
  await expect(lead.locator(".inset")).toContainText("through the why lens");
  expect(await lead.locator(".inset").evaluate((el) => getComputedStyle(el).fontFamily)).toContain("Serif");
  // In the library: a note anchored by its words, under the page's node in the container.
  const filed = await state(page, (s) => {
    const n = (Object.values(s.snap.nodes) as any[]).find((x) => x.wanchor && s.snap.nodes[x.parent]?.ref?.url === "https://tracing.example.org/posts/following-a-request");
    const p = s.snap.nodes[n.parent];
    return { q: n.wanchor.q, sec: n.wanchor.sec, rev: n.wanchor.rev, ref: p.ref, box: !!s.snap.nodes[p.parent].articles, tops: s.snap.nodes[s.snap.root].children.filter((c: string) => !s.snap.nodes[c].articles).includes(p.parent) };
  });
  expect(filed).toMatchObject({ q: sentence, sec: [], ref: { kind: "url", url: WEB.tracing, title: "Following one request through the stack" }, box: true, tops: false });
  expect(Number.isInteger(filed.rev) && filed.rev > 0).toBe(true);

  // The menu on its words: the note's items and the lenses.
  await lead.locator(".anchor").click({ button: "right" });
  const menu = page.locator(".menu");
  for (const l of ["Open the note", "Delete the note", "Define", "Ask your own question…"]) await expect(menu).toContainText(l);
  await page.keyboard.press("Escape");
  await keys(page, "Escape");

  // Tab reaches its words; Enter steps into the open note, h comes back to its words.
  await tabTo(page, sentence);
  expect(await state(page, (s) => !!s.articleNoteHere())).toBe(true);
  await keys(page, "Enter");
  expect(await state(page, (s) => [s.aux, s.snap.nodes[s.focus.node].wanchor?.q])).toEqual([null, sentence]);
  await keys(page, "h");
  expect(await state(page, (s) => s.selectedText())).toBe(sentence);
  // e folds and unfolds it, as on a node.
  await keys(page, "e");
  await expect(lead.locator(".inset")).toHaveCount(0);
  await keys(page, "e");
  await expect(lead.locator(".inset")).toHaveCount(1);
  // D deletes it, u brings it back.
  await keys(page, "D");
  await expect(status(page)).toContainText("Note deleted");
  await expect(lead.locator(".anchor")).toHaveCount(0);
  expect(await notesOn(page, WEB.tracing)).toEqual([]);
  await keys(page, "u");
  await expect(lead.locator(".anchor")).toHaveText(sentence);
  expect(await notesOn(page, WEB.tracing)).toHaveLength(1);
});

test("a section that is only a link to a page: a note written in its pane is the page's, shown in the page's own pane too, and the other way round", async ({ page }) => {
  await wide(page, "Error-correcting codes");
  await jump(page, "Shannon's limit");
  await keys(page, "l");
  // A new section linked to the page (the model left out: a section added would have its parent summarised again).
  await command(page, "/auto off");
  await keys(page, "a");
  await page.keyboard.type("Letters on maps");
  await keys(page, "Enter");
  await keys(page, "w");
  await page.keyboard.press("Control+a");
  await page.keyboard.type(WEB.letters);
  await expect(page.locator(".picker li.group").first()).toHaveText("Address");
  await keys(page, "Enter");
  await expect(page.locator(".picker")).toHaveCount(0);
  const section = await state(page, (s) => s.focus.node as string);
  // l opens its pane, which is the page; l again is on the page's head, i selects in its lead.
  await keys(page, "l");
  const link = page.locator(".strip .pane.link-pane");
  await expect(link.locator(".wiki > .wiki-text")).toBeVisible();
  await keys(page, "l");
  await expect(link.locator(".wiki-head.focused")).toHaveCount(1);
  await keys(page, "i");
  const first = (await state(page, (s) => s.selectedText())) as string;
  expect(first).toBeTruthy();
  await keys(page, "d");
  await idle(page);
  await expect(link.locator(".wiki > .wiki-text .anchor")).toHaveText(first);
  await expect(link.locator(".wiki > .wiki-text")).toContainText(/through the define lens|mock gloss of/);

  // The page's own pane shows the same note.
  await follow(page, WEB.letters);
  const own = lastPage(page);
  await expect(own.locator(".wiki > .wiki-text .anchor")).toHaveText(first);
  await expect(own.locator(".wiki > .wiki-text")).toContainText(/through the define lens|mock gloss of/);
  // A note written there shows in the section's pane.
  await keys(page, "i j");
  const second = (await state(page, (s) => s.selectedText())) as string;
  expect(second).not.toBe(first);
  await keys(page, "x");
  await idle(page);
  await expect(link.locator(".wiki > .wiki-text .anchor")).toHaveText([first, second]);
  await expect(own.locator(".wiki > .wiki-text .anchor")).toHaveText([first, second]);
  // One node for the page, holding both.
  expect(await state(page, (s) => (Object.values(s.snap.nodes) as any[]).filter((n) => n.ref?.url === "https://letters.example.net/p/on-maps" && s.snap.nodes[n.parent]?.articles).map((n) => n.children.length))).toEqual([2]);
  expect(await notesOn(page, WEB.letters)).toHaveLength(2);
  // The section made for this test goes; the page's notes stay the page's.
  await page.evaluate((id) => (globalThis as any).__ie.apply([{ op: "delete", id }], "Delete the test's section"), section);
  await expect.poll(() => state(page, (s) => Object.values(s.snap.nodes).some((n: any) => n.title === "Letters on maps"))).toBe(false);
  expect(await notesOn(page, WEB.letters)).toHaveLength(2);
});

test("a note on a page a model arranged shows in the section that holds its words, and is detached, not lost, when a reload finds them gone", async ({ page }) => {
  // The page has no headings: it is read in parts by length, and a model arranges it by itself. (That a
  // note written on a part follows its words into the model's sections is tests/article.test.ts's.)
  const url = `/api/page/article?url=${encodeURIComponent(CHANGING)}`;
  await page.request.get(url);
  await expect.poll(async () => (await (await page.request.get(url)).json()).article.outline).toBe("model");
  const read = await (await page.request.get(url)).json();
  const m = read.article.sections.find((x: any) => x.html.includes(CHANGING_LINE));
  expect(m.id).toMatch(/^m\d$/);
  await wide(page, "Error-correcting codes");
  await follow(page, CHANGING);
  await expect(lastPage(page).locator(".wiki")).toHaveAttribute("data-outline", "model");
  await lastPage(page).locator(`[data-wrow="${m.id}"]`).click();
  const section = lastPage(page);
  await expect(section.locator(".wiki-head .wsub")).toContainText(m.heading);
  await expect(section.locator(".wiki-text")).toContainText(CHANGING_LINE);
  await section.locator(".wiki-text .wpara", { hasText: CHANGING_LINE }).click({ position: { x: 20, y: 8 } });
  expect(await state(page, (s) => s.selectedText())).toBe(CHANGING_LINE);
  await keys(page, "x");
  await idle(page);
  await expect(section.locator(".wiki-text .anchor")).toHaveText(CHANGING_LINE);
  await expect(section.locator(".wiki-text")).toContainText("through the example lens");
  const rev = (await state(page, (s) => (Object.values(s.snap.nodes) as any[]).find((n) => n.wanchor?.q?.startsWith("The tide table pinned")).wanchor.rev)) as number;

  // Read again: the text has changed and the line is gone. The note is kept, listed as detached.
  const again = await posted(page, "R", "reload");
  expect(again.ok).toBe(true);
  expect(JSON.stringify(again.article)).not.toContain("The tide table pinned");
  // The new text is arranged by itself in its turn; the detached note stays through that.
  // Detached, it is listed at the top of its section, as the new copy still has one of that heading (else at the top of the page).
  const whole = lastPage(page);
  await expect(whole.locator(".wiki")).toHaveAttribute("data-outline", "model");
  await whole.locator(".wrow", { hasText: m.heading }).click();
  const now = lastPage(page);
  await expect(now.locator(".wiki-head .wsub")).toContainText(m.heading);
  await expect(now.locator(".wdetached .meta")).toContainText("“The tide table pinned inside the harbour office");
  await expect(now.locator(".wdetached .meta")).toContainText("is not in the page as it now reads");
  await expect(now.locator(".wdetached .inset")).toContainText("through the example lens");
  await expect(now.locator(".wiki-text .anchor")).toHaveCount(0);
  const kept = await notesOn(page, CHANGING);
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatch(/^The tide table pinned/);
  expect(await state(page, (s) => (Object.values(s.snap.nodes) as any[]).find((n) => n.wanchor?.q?.startsWith("The tide table pinned")).wanchor.rev)).toBe(rev);
  // A click on it focuses it: it is a note like any other.
  await now.locator(".wdetached .inset").click();
  expect(await state(page, (s) => s.snap.nodes[s.focus.node].wanchor?.q)).toBe(CHANGING_LINE);
});

test("column: on the page of its own, the page's notes show, and a note on a section opened in place shows in it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await visit(page, "Error-correcting codes");
  await follow(page, WEB.tracing);
  const art = page.locator(".wiki-page.web");
  await expect(art.locator(".wiki-head h2")).toHaveText("Following one request through the stack");
  // The note written on its lead in a pane (the first test) is the page's: here too.
  await expect(art.locator(".wiki > .wiki-text .anchor")).toHaveText(/^The request leaves the browser/);
  await keys(page, "j l");
  const open = art.locator(".wrow.open").first();
  await expect(open.locator(".wiki-text")).toContainText("Each span in the trace records");
  await keys(page, "i");
  const words = (await state(page, (s) => s.selectedText())) as string;
  expect(words).toBeTruthy();
  await keys(page, "c");
  await idle(page);
  await expect(open.locator(".wiki-text .anchor")).toHaveText(words);
  await expect(open.locator(".wiki-text")).toContainText(/through the challenge lens|mock gloss of/);
  expect(await notesOn(page, WEB.tracing)).toHaveLength(2);
});

test("a page that cannot be shown lists the notes kept on it, each reachable, none lost", async ({ page }) => {
  await wide(page, "Error-correcting codes");
  // A note kept from when the page could be read (robots.txt now refuses it).
  await state(page, (s) => {
    const snap = s.snap;
    const box = snap.nodes[snap.root].children.find((c: string) => snap.nodes[c].articles);
    const ops: any[] = box ? [] : [{ op: "create", parent: snap.root, kind: "section", title: "Articles and pages", body: "", articles: true }];
    ops.push({ op: "create", parent: box ?? "$0", kind: "section", title: "How do tides work?", body: "", ref: { kind: "url", url: "https://qa.example.com/questions/42/how-do-tides-work" } });
    ops.push({ op: "create", parent: `$${ops.length - 1}`, kind: "note", form: "note", body: "Kept from when the page could be read.", wanchor: { sec: [], q: "when the tide turns", pre: "", post: "", rev: 1 } });
    s.apply(ops, "A note on a page");
    return null;
  });
  await follow(page, WEB.robots);
  const web = lastPage(page);
  await expect(web.locator(".wiki")).toHaveAttribute("data-reason", "robots");
  await expect(web.locator(".wdetached .meta")).toContainText("“when the tide turns”, in a page not shown here");
  await expect(web.locator(".wdetached .inset")).toContainText("Kept from when the page could be read.");
  await web.locator(".wdetached .inset").click();
  expect(await state(page, (s) => s.snap.nodes[s.focus.node].body)).toBe("Kept from when the page could be read.");
  expect(await notesOn(page, WEB.robots)).toEqual(["when the tide turns | Kept from when the page could be read."]);
});
