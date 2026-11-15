/**
 * Documents in the library, from the keyboard: the menu (filter and open, create, rename,
 * duplicate, delete, export and import), addresses that survive a reload and Back, a jump that
 * crosses documents, and moving between documents without closing anything. These tests make
 * their own documents and leave the first one alone: the other specs share it.
 */
import { expect, test, type Page } from "@playwright/test";
import { command, idle, jump, keys, settle, state, synced } from "./helpers";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDoc } from "../src/core/format";

const FIXTURE = fileURLToPath(new URL("../tests/fixtures/menu-fixture.md", import.meta.url));

/** The titles in the document on screen. */
const titles = (page: Page) =>
  state(page, (s) => {
    const d = s.currentDoc;
    const out: string[] = [];
    const visit = (id: string) => (out.push(s.snap.nodes[id].title), s.snap.nodes[id].children.forEach(visit));
    if (d) visit(d);
    return out;
  });
/** m, type to filter, Enter. */
const openByMenu = async (page: Page, filter: string) => {
  await page.keyboard.press("m");
  await expect(page.locator(".panel.docs .filter")).toBeFocused();
  await page.keyboard.type(filter);
  await page.keyboard.press("Enter");
};
/** m, then Esc to the list, where single keys act. */
const menuList = async (page: Page) => {
  await page.keyboard.press("m");
  await expect(page.locator(".panel.docs .filter")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".panel.docs .filter")).not.toBeFocused();
  await expect.poll(() => state(page, (s) => `${s.mode}/${s.menu.focus}`)).toBe("docs/list");
};
async function open(page: Page, path = "/doc/infinite-expand") {
  await page.goto(path);
  await page.waitForSelector("article");
}

test.describe.configure({ mode: "serial" });

// Playwright turns on file-chooser interception only when something listens for it, and does so
// asynchronously: a waitForEvent("filechooser") made just before the key that opens the picker can
// lose that race, and then the picker opens unintercepted and no event ever comes (seen under load:
// the app had appended and clicked its file input). Listening from the start keeps it on throughout.
test.beforeEach(async ({ page }) => {
  page.on("filechooser", () => {});
});

test.afterEach(({ page }) => settle(page));

test("the library is the first page: its documents are its sections, and opening one needs no closing step", async ({ page }) => {
  await open(page, "/");
  await expect(page.locator(".top h1")).toHaveText("Library");
  const docs = await state(page, (s) => s.snap.nodes[s.snap.root].children.length);
  await expect(page.locator("article > .outline > .node")).toHaveCount(docs);
  await expect(page.locator("article > .outline > .node.open")).toHaveCount(0);
  await keys(page, "j Enter"); // the first document's row: it opens in place of the list
  await expect(page.locator(".top h1")).toHaveText("Infinispand");
  await expect(page.locator(".crumbs")).toHaveText(/Library/);
  await expect(page).toHaveURL(/\/doc\/infinite-expand$/);
  await expect(page.locator(".docbar .doc-title .name")).toHaveText("Infinispand");
  await keys(page, "h"); // stepping out of the document returns to the library, on its row
  await expect(page.locator(".top h1")).toHaveText("Library");
  expect(await state(page, (s) => s.snap.nodes[s.focus.node].title)).toBe("Infinispand");
  await keys(page, "j l"); // the next one
  await expect(page.locator(".top h1")).toHaveText("A mind made of text");
  // The library's own text is never stale and the library is not rewritten by anything.
  expect(await state(page, (s) => s.snap.nodes[s.snap.root].seenUp)).toBe("");
});

test("m opens the menu, in library order, and the title in the top bar opens it too", async ({ page }) => {
  await open(page);
  await keys(page, "m");
  const panel = page.locator(".panel.docs");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".doc.current")).toContainText("Infinispand");
  await expect(panel.locator(".doc.current")).toContainText(/open · (saved|saving…)/);
  const listed = await panel.locator(".doc .title").allTextContents();
  expect(listed).toEqual(await state(page, (s) => s.snap.nodes[s.snap.root].children.map((c: string) => s.snap.nodes[c].title)));
  await keys(page, "Escape Escape");
  await expect(panel).toHaveCount(0);
  await page.locator(".docbar .doc-title").click();
  await expect(panel).toBeVisible();
  await expect(page.locator(".docbar .save-state")).toHaveText("saved");
});

test("import a .md file, then export it and get the same document back", async ({ page }) => {
  await open(page);
  await menuList(page);
  const chooser = page.waitForEvent("filechooser");
  await keys(page, "i");
  await (await chooser).setFiles(FIXTURE);
  await expect(page.locator(".top h1")).toHaveText("Menu fixture");
  await expect(page).toHaveURL(/\/doc\/menu-fixture$/);
  const shape = () => state(page, (s) => s.doc.shape(undefined, s.currentDoc));
  const imported = await shape();

  await menuList(page);
  const download = page.waitForEvent("download");
  await keys(page, "x");
  const file = await (await download).path();
  const text = readFileSync(file, "utf8");
  expect(await (await download).suggestedFilename()).toBe("menu-fixture.md");
  expect(parseDoc(text)).toEqual(parseDoc(readFileSync(FIXTURE, "utf8")));

  // Importing the exported file gives a second document with the same shape.
  await keys(page, "Escape");
  const again = page.waitForEvent("filechooser");
  await command(page, "/import");
  await (await again).setFiles({ name: "menu-fixture.md", mimeType: "text/markdown", buffer: Buffer.from(text) });
  await expect(page).toHaveURL(/\/doc\/menu-fixture-2$/);
  expect(await shape()).toBe(imported);
  expect(await state(page, (s) => [s.currentDoc, ...s.snap.nodes[s.currentDoc].children].filter((id: string) => s.snap.nodes[id].by !== "llm").length)).toBe(0);
  // Both are on the server, as sections of the library.
  await synced(page);
  expect((await (await page.request.get("/api/docs")).json()).map((d: any) => d.slug)).toEqual(expect.arrayContaining(["menu-fixture", "menu-fixture-2"]));
});

test("a file with a quote that is not in its text is refused, naming the section and the quote", async ({ page }) => {
  await open(page);
  const bad = readFileSync(FIXTURE, "utf8").replace('"a phrase worth a note"', '"words that are not there"');
  await menuList(page);
  const chooser = page.waitForEvent("filechooser");
  await keys(page, "i");
  await (await chooser).setFiles({ name: "broken.md", mimeType: "text/markdown", buffer: Buffer.from(bad) });
  await expect(page.locator(".panel.docs .problems")).toContainText('broken.md:5: in “Menu fixture”: quote not found: "words that are not there"');
  await expect(page.locator(".top h1")).toHaveText("Infinispand");
});

test("filter and open; the address names the document and the node, and survives a reload, Back and Forward", async ({ page }) => {
  await open(page, "/");
  await keys(page, "m");
  await page.keyboard.type("menu fix");
  await expect(page.locator(".panel.docs .doc")).toHaveCount(2);
  await keys(page, "Escape j k Enter");
  await expect(page.locator(".top h1")).toHaveText("Menu fixture");
  await expect(page.locator(".panel.docs")).toHaveCount(0);
  await expect(page).toHaveTitle("Menu fixture");
  await expect(page).toHaveURL(/\/doc\/menu-fixture$/);
  // Into a section: the address follows the focus to the node.
  await keys(page, "j");
  const section = await state(page, (s) => s.focus.node);
  await expect(page).toHaveURL(new RegExp(`/doc/menu-fixture/${encodeURIComponent(section)}$`));
  await page.reload();
  await page.waitForSelector("article");
  await expect(page.locator(".top h1")).toHaveText("Menu fixture");
  expect(await state(page, (s) => s.focus.node)).toBe(section);
  // A link to a document opens it; Back returns to the node; Back again to the library.
  await open(page, "/doc/infinite-expand");
  await expect(page.locator(".top h1")).toHaveText("Infinispand");
  await page.goBack();
  await expect(page.locator(".top h1")).toHaveText("Menu fixture");
  await expect.poll(() => state(page, (s) => s.focus.node)).toBe(section);
  await page.goForward();
  await expect(page.locator(".top h1")).toHaveText("Infinispand");
  // An address that names nothing says so and shows the library.
  await open(page, "/doc/no-such-document");
  await expect(page.locator(".top h1")).toHaveText("Library");
  await expect(page.locator(".status .message")).toContainText("no-such-document");
});

test("the jump box searches every document, says which one each match is in, and goes there", async ({ page }) => {
  await open(page);
  await page.keyboard.press("/");
  await page.keyboard.type("amphidromes");
  const hit = page.locator(".jump li").first();
  await expect(hit.locator(".t")).toHaveText("Amphidromes");
  await expect(hit.locator(".in")).toHaveText("The tides");
  await page.keyboard.press("Enter");
  await expect(page.locator(".top h1")).toHaveText("The tides");
  expect(await state(page, (s) => s.snap.nodes[s.focus.node].title)).toBe("Amphidromes");
  await expect(page).toHaveURL(/\/doc\/tides\/\d+%40\d+$/);
  // Back to where the jump started.
  await page.goBack();
  await expect(page.locator(".top h1")).toHaveText("Infinispand");
  // A document's own title opens it.
  await jump(page, "Fixed points");
  await expect(page.locator(".top h1")).toHaveText("Fixed points");
});

test("the library opens from this browser without the network, and catches up when it returns", async ({ page }) => {
  await open(page, "/doc/menu-fixture");
  await synced(page);
  await page.route("**/api/**", (route) => route.abort());
  await page.reload();
  await page.waitForSelector("article");
  await expect(page.locator(".top h1")).toHaveText("Menu fixture");
  await command(page, "/open tides");
  await expect(page.locator(".top h1")).toHaveText("The tides");
  await keys(page, "j r");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Renamed offline");
  await page.keyboard.press("Enter");
  await expect(page.locator(".docbar .save-state")).toHaveText(/offline|saving/);
  await page.waitForTimeout(300); // the replica reaches IndexedDB a moment after the edit
  await page.unroute("**/api/**");
  await page.reload();
  await page.waitForSelector("article");
  await expect(page.locator(".docbar .save-state")).toHaveText("saved", { timeout: 15_000 });
  expect(JSON.stringify(await (await page.request.get("/api/docs/tides/tree")).json())).toContain("Renamed offline");
});

test("create, rename and duplicate from the menu", async ({ page }) => {
  await open(page);
  await menuList(page);
  await keys(page, "n");
  await page.keyboard.type("Scratch pad");
  await page.keyboard.press("Enter");
  await expect(page.locator(".top h1")).toHaveText("Scratch pad");
  await expect(page).toHaveURL(/\/doc\/scratch-pad$/);

  await menuList(page);
  await keys(page, "r");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Scratch pad, renamed");
  await page.keyboard.press("Enter");
  await expect(page.locator(".top h1")).toHaveText("Scratch pad, renamed");
  await expect(page.locator(".panel.docs .doc.current .title")).toHaveText("Scratch pad, renamed");
  await expect(page).toHaveURL(/\/doc\/scratch-pad$/); // the slug, and so links, stay
  await synced(page);
  const listed = await (await page.request.get("/api/docs/scratch-pad")).json();
  expect(listed.title).toBe("Scratch pad, renamed");

  await keys(page, "s");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Scratch copy");
  await page.keyboard.press("Enter");
  await expect(page.locator(".top h1")).toHaveText("Scratch copy");
  await expect(page).toHaveURL(/\/doc\/scratch-copy$/);
  // The copy sits after the original in the library, and is one commit in its history.
  expect(await state(page, (s) => s.commits()[0].message)).toBe("Duplicate “Scratch pad, renamed” as “Scratch copy”");
  const order = await state(page, (s) => s.snap.nodes[s.snap.root].children.map((c: string) => s.snap.nodes[c].slug));
  expect(order.indexOf("scratch-copy")).toBe(order.indexOf("scratch-pad") + 1);
});

test("delete asks first, and is an ordinary delete that u undoes", async ({ page }) => {
  await open(page, "/doc/scratch-copy");
  await keys(page, "m");
  await page.keyboard.type("scratch copy");
  await keys(page, "Escape D");
  await expect(page.locator(".panel.docs .confirm")).toContainText("u brings it back");
  await keys(page, "n");
  await expect(page.locator(".panel.docs .confirm")).toHaveCount(0);
  await keys(page, "D y");
  await expect(page.locator(".status .message")).toContainText("Deleted “Scratch copy”");
  await expect(page.locator(".top h1")).toHaveText("Library");
  await synced(page);
  expect((await page.request.get("/api/docs/scratch-copy")).status()).toBe(404);
  await keys(page, "Escape u");
  await expect.poll(() => state(page, (s) => s.snap.nodes[s.snap.root].children.map((c: string) => s.snap.nodes[c].slug))).toContain("scratch-copy");
  await synced(page);
  expect((await page.request.get("/api/docs/scratch-copy")).status()).toBe(200);
});

test("a node moves from one document to another, and undo works wherever the last edit was", async ({ page }) => {
  await open(page, "/doc/scratch-pad");
  await keys(page, "a");
  await page.keyboard.type("Only in the scratch pad");
  await page.keyboard.press("Enter");
  // Move straight on: the edit is the library's, and goes to the server from wherever the reader is.
  await openByMenu(page, "menu fixture");
  await expect(page.locator(".top h1")).toHaveText("Menu fixture");
  expect(await titles(page)).not.toContain("Only in the scratch pad");
  await expect
    .poll(async () => JSON.stringify(await (await page.request.get("/api/docs/scratch-pad/tree")).json()))
    .toContain("Only in the scratch pad");
  expect(JSON.stringify(await (await page.request.get("/api/docs/menu-fixture/tree")).json())).not.toContain("Only in the scratch pad");
  // Undo is the library's too: u here takes back the edit made in the scratch pad.
  await keys(page, "u");
  await openByMenu(page, "scratch pad");
  expect(await titles(page)).not.toContain("Only in the scratch pad");
  await keys(page, "U");
  expect(await titles(page)).toContain("Only in the scratch pad");
  // An outside agent moves the section into another document with one ordinary move.
  await synced(page);
  const tree = await (await page.request.get("/api/tree")).json();
  const node = Object.values<any>(tree.nodes).find((n) => n.title === "Only in the scratch pad");
  const target = Object.values<any>(tree.nodes).find((n) => n.slug === "menu-fixture");
  const res = await page.request.post("/api/ops", { data: { author: "mover", message: "Move it across", ops: [{ op: "move", id: node.id, parent: target.id }] } });
  expect(res.ok()).toBe(true);
  await expect.poll(() => titles(page)).not.toContain("Only in the scratch pad");
  await openByMenu(page, "menu fixture");
  expect(await titles(page)).toContain("Only in the scratch pad");
  // Its address still finds it, under its new document.
  await page.reload();
  await page.waitForSelector("article");
  await jump(page, "Only in the scratch pad");
  await expect(page).toHaveURL(new RegExp(`/doc/menu-fixture/${encodeURIComponent(node.id)}$`));
});

test("a note being written in one document lands there after the reader has moved to another", async ({ page }) => {
  await open(page, "/doc/menu-fixture");
  await keys(page, "i j e"); // select the document's second sentence and expand it
  await expect.poll(() => state(page, (s) => s.pending.size)).toBe(1);
  const where = await state(page, (s) => s.focus.node);
  await openByMenu(page, "scratch pad");
  await expect(page.locator(".top h1")).toHaveText("Scratch pad, renamed");
  await idle(page);
  await expect(page.locator(".pending, .writing")).toHaveCount(0);
  const notes = await state(page, (s) => s.snap.nodes[s.snap.nodes[s.snap.root].children.find((c: string) => s.snap.nodes[c].slug === "menu-fixture")].children.filter((c: string) => /mock/i.test(s.snap.nodes[c].body)).length);
  expect(notes).toBe(1);
  expect(await state(page, (s) => s.snap.nodes[s.focus.node].title)).not.toBe(where);
});

test("the : commands do the same", async ({ page }) => {
  await open(page);
  await command(page, "/new Made by command");
  await expect(page.locator(".top h1")).toHaveText("Made by command");
  await command(page, "/rename Renamed by command");
  await expect(page.locator(".top h1")).toHaveText("Renamed by command");
  await command(page, "/open menu-fixture");
  await expect(page.locator(".top h1")).toHaveText("Menu fixture");
  const download = page.waitForEvent("download");
  await command(page, "/export");
  expect(await (await download).suggestedFilename()).toBe("menu-fixture.md");
  await command(page, "/open made-by-command");
  await expect(page.locator(".top h1")).toHaveText("Renamed by command");
});

test("the menu works in panes and at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page, "/doc/infinite-expand");
  await expect(page.locator(".strip > .pane")).toHaveCount(2); // the library, and the document
  await openByMenu(page, "menu fixture");
  await expect(page.locator(".strip .pane.root h1")).toHaveText("Library");
  await expect(page.locator(".strip .pane.doc h1")).toHaveText("Menu fixture");
  await keys(page, "l l");
  await expect(page.locator(".strip > .pane")).toHaveCount(3);
  await openByMenu(page, "infinispand");
  await expect(page.locator(".strip > .pane")).toHaveCount(2); // the pane path is the other document's own
  await expect(page.locator(".strip .pane.doc h1")).toHaveText("Infinispand");

  await page.setViewportSize({ width: 390, height: 800 });
  await keys(page, "m");
  await expect(page.locator(".panel.docs .filter")).toBeFocused();
  const box = (await page.locator(".panel.docs").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.type("scratch pad");
  await page.keyboard.press("Enter");
  await expect(page.locator(".top h1")).toHaveText("Scratch pad, renamed");
  const bar = (await page.locator(".docbar").boundingBox())!;
  expect(bar.x + bar.width).toBeLessThanOrEqual(390);
});
