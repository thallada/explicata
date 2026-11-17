/**
 * Everything is a node, from the keyboard: the library root is the first page and a node like any
 * other, addresses name a node by its id, the jump box searches the whole library, and a node with
 * everything under it is imported into, exported, copied and moved under any other node, wherever
 * it is; history's f and r act on the node the reader is on. These tests make their own nodes
 * (under “Scratch pad”) and leave the starter trees alone: the other specs share them.
 */
import { expect, test, type Page } from "@playwright/test";
import { autoLayout, command, focusedTitle, idle, jump, keys, nodeAt, openAt, openPage, settle, state, synced } from "./helpers";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDoc } from "../src/core/format";

const FIXTURE = fileURLToPath(new URL("../tests/fixtures/menu-fixture.md", import.meta.url));
/** The fixture with a link inside it, written relative to its top. */
const LINKED = readFileSync(FIXTURE, "utf8").replace("More text.", "More text.\n\n^ \"More text\" link -> ./First section");

/** The title of the parent of the (first) node with this title. */
const parentOf = (page: Page, title: string) =>
  page.evaluate((t) => {
    const s = (globalThis as any).__ie;
    const n = (Object.values(s.snap.nodes) as any[]).find((x) => x.title === t);
    return n?.parent ? (s.snap.nodes[n.parent].title as string) : null;
  }, title);
/** The titles of the sections under the (first) node with this title. */
const kids = (page: Page, title: string) =>
  page.evaluate((t) => {
    const s = (globalThis as any).__ie;
    const n = (Object.values(s.snap.nodes) as any[]).find((x) => x.title === t);
    return (n?.children ?? []).map((c: string) => s.snap.nodes[c]).filter((c: any) => c.kind === "section").map((c: any) => c.title) as string[];
  }, title);
const status = (page: Page) => page.locator(".status .message");
/** After a load (Back and Forward too): the page has booted. */
const ready = (page: Page) => page.waitForFunction(() => (globalThis as any).__ie?.ready);
/** No reconciling after edits and no link scans: what these tests check is the history their own keys make. */
async function quiet(page: Page) {
  await command(page, "/auto off");
  await command(page, "/autolink off");
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

test("the library root is the first page and a node like any other: its sections open in place, and standing on it is allowed", async ({ page }) => {
  await openAt(page);
  await expect(page.locator(".top h1")).toHaveText("Library");
  await expect(page.locator(".top .byline")).toContainText(/^library · \d+ sections · \d+ nodes/);
  await expect(page.locator(".docbar .lib-name")).toHaveText("Library");
  const tops = await state(page, (s) => s.snap.nodes[s.snap.root].children.filter((c: string) => !s.snap.nodes[c].articles).length);
  await expect(page.locator("article > .outline > .node")).toHaveCount(tops);
  await expect(page.locator("article > .outline > .node.open")).toHaveCount(0);
  // The first top-level node opens in place, as any section does: the library stays the page.
  await keys(page, "j l");
  await expect(page.locator(".top h1")).toHaveText("Library");
  await expect(page.locator("article > .outline > .node.open > .row .title")).toHaveText("Infinispand");
  // Its text is a prompt its sections cite: folded there too.
  await expect(page.locator("article > .outline > .node.open > .content > .abstract.seed.folded")).toBeVisible();
  const first = await state(page, (s) => s.focus.node);
  await expect(page).toHaveURL(new RegExp(`/n/${encodeURIComponent(first)}$`));
  await expect(page).toHaveTitle("Infinispand");
  // Back up onto the root itself: its address is the library's, /l/<id>, and it is the node the keys act on.
  await keys(page, "h k");
  expect(await state(page, (s) => s.focus.node === s.snap.root)).toBe(true);
  await expect(page).toHaveURL(/\/l\/[0-9a-z]+$/);
  await expect(page).toHaveTitle("Library");
  await keys(page, "D");
  await expect(status(page)).toHaveText("The library itself cannot be deleted.");
  await keys(page, "M");
  await expect(status(page)).toContainText("The library root stays where it is");
  await command(page, "/duplicate");
  await expect(status(page)).toContainText("The library itself is not copied");
  // Its own text is never stale, and nothing rewrites it.
  expect(await state(page, (s) => s.snap.nodes[s.snap.root].seenUp)).toBe("");
  // Its menu is a node's menu, without what it cannot do.
  await page.locator(".top .byline .more").click();
  const menu = page.locator(".menu");
  await expect(menu).toContainText("Export as .md");
  await expect(menu).toContainText("Import a .md file into it…");
  await expect(menu).not.toContainText("Move under…");
  await expect(menu).not.toContainText("Delete");
  await keys(page, "Escape");
  // z makes a node the page; Esc at its top steps back out to the library, on its row.
  await keys(page, "j z");
  await expect(page.locator(".top h1")).toHaveText("Infinispand");
  await expect(page.locator(".crumbs")).toHaveText(/^Library ›/);
  await expect(page.locator(".top .byline")).toContainText(/^\d+ sections · \d+ nodes/);
  await keys(page, "Escape");
  await expect(page.locator(".top h1")).toHaveText("Library");
  expect(await focusedTitle(page)).toBe("Infinispand");
});

test("an address names a node by its id, and survives a reload, Back and Forward; an old /doc/ address shows the library", async ({ page }) => {
  await openAt(page);
  await jump(page, "Amphidromes");
  const amph = await state(page, (s) => s.focus.node);
  await expect(page).toHaveURL(new RegExp(`/n/${encodeURIComponent(amph)}$`));
  await page.reload();
  await page.waitForSelector("article");
  expect(await state(page, (s) => s.focus.node)).toBe(amph);
  // A link to another node opens it; Back returns, Forward comes again.
  await openAt(page, "Fixed points");
  expect(await focusedTitle(page)).toBe("Fixed points");
  await page.goBack();
  await ready(page);
  await expect.poll(() => state(page, (s) => s.focus.node)).toBe(amph);
  await page.goForward();
  await ready(page);
  await expect.poll(() => focusedTitle(page)).toBe("Fixed points");
  // What names nothing says so and shows the library: an address from before, a node that is gone.
  await page.goto("/doc/the-tides");
  await page.waitForSelector("article");
  await expect(page.locator(".top h1")).toHaveText("Library");
  await expect(status(page)).toContainText("/doc/the-tides");
  await page.goto("/n/999%40999");
  await page.waitForSelector("article");
  await expect(page.locator(".top h1")).toHaveText("Library");
  await expect(status(page)).toContainText("999@999");
});

test("the jump box searches the whole library, says where each match is, and goes there", async ({ page }) => {
  await openPage(page, "Infinispand");
  await expect(page.locator(".top h1")).toHaveText("Infinispand");
  await page.keyboard.press("/");
  await page.keyboard.type("amphidromes");
  const hit = page.locator(".jump li").first();
  await expect(hit.locator(".t")).toHaveText("Amphidromes");
  await expect(hit.locator(".in")).toHaveText("The tides");
  await page.keyboard.press("Enter");
  // Outside the hoisted node: the page goes back to the library, with the node open to it.
  await expect(page.locator(".top h1")).toHaveText("Library");
  expect(await focusedTitle(page)).toBe("Amphidromes");
  // Back to where the jump started.
  await page.goBack();
  await ready(page);
  await expect.poll(() => focusedTitle(page)).toBe("Infinispand");
  // A top-level node is found like any other, and says it is in the library.
  await page.keyboard.press("/");
  await page.keyboard.type("Fixed points");
  await expect(page.locator(".jump li").first().locator(".in")).toHaveText("Library");
  await page.keyboard.press("Enter");
  expect(await focusedTitle(page)).toBe("Fixed points");
});

test("a .md file is imported into a node deep in the library, exported from there the same, and copied just after itself", async ({ page }) => {
  // A place two levels down: Scratch pad › Inbox, made from the keyboard on the library page.
  await openAt(page);
  await quiet(page);
  await keys(page, "a");
  await page.keyboard.type("Scratch pad");
  await page.keyboard.press("Enter");
  await keys(page, "a");
  await page.keyboard.type("Inbox");
  await page.keyboard.press("Enter");
  expect(await parentOf(page, "Inbox")).toBe("Scratch pad");
  // :/import reads it into the node the reader is on, as its last child.
  const chooser = page.waitForEvent("filechooser");
  await command(page, "/import");
  await (await chooser).setFiles({ name: "menu-fixture.md", mimeType: "text/markdown", buffer: Buffer.from(LINKED) });
  await expect(status(page)).toContainText("Imported menu-fixture.md as “Menu fixture”, under “Inbox”");
  await expect.poll(() => focusedTitle(page)).toBe("Menu fixture");
  expect(await parentOf(page, "Menu fixture")).toBe("Inbox");
  // Its link, written relative to the file's top, is kept from the library root, and finds its section.
  const link = await state(page, (s) => {
    const n = (Object.values(s.snap.nodes) as any[]).find((x) => x.kind === "note" && x.ref?.kind === "node" && x.anchors[0]?.text === "More text");
    return { path: n.ref.path, to: s.snap.nodes[n.ref.id]?.title };
  });
  expect(link).toEqual({ path: ["Scratch pad", "Inbox", "Menu fixture", "First section"], to: "First section" });
  // :/export saves it, from where it is, and the file is what was read in.
  const download = page.waitForEvent("download");
  await command(page, "/export");
  expect(await (await download).suggestedFilename()).toBe("menu-fixture.md");
  const text = readFileSync(await (await download).path(), "utf8");
  expect(parseDoc(text)).toEqual(parseDoc(LINKED));
  expect(text).toContain("^ \"More text\" link -> ./First section");
  // :/duplicate copies it with everything under it, just after itself, as one commit; the copy has the focus.
  await command(page, "/duplicate");
  await expect(status(page)).toContainText("Saved a copy as “Menu fixture (copy)”");
  expect(await focusedTitle(page)).toBe("Menu fixture (copy)");
  expect(await kids(page, "Inbox")).toEqual(["Menu fixture", "Menu fixture (copy)"]);
  expect(await kids(page, "Menu fixture (copy)")).toEqual(["First section", "Second section"]);
  expect(await state(page, (s) => s.commits()[0].message)).toBe("Duplicate “Menu fixture” as “Menu fixture (copy)”");
  // On the library root an import is a new top-level node.
  await keys(page, "O");
  expect(await state(page, (s) => s.focus.node === s.snap.root)).toBe(true);
  const again = page.waitForEvent("filechooser");
  await command(page, "/import");
  await (await again).setFiles({ name: "exported.md", mimeType: "text/markdown", buffer: Buffer.from(text) });
  await expect(status(page)).toHaveText("Imported exported.md as “Menu fixture”.");
  expect(await state(page, (s) => [s.snap.nodes[s.focus.node].title, s.snap.nodes[s.focus.node].parent === s.snap.root])).toEqual(["Menu fixture", true]);
  await keys(page, "D");
  await expect(status(page)).toContainText("Deleted “Menu fixture”");
  // A file with a quote that is not in its text is refused, naming the section and the quote.
  const bad = readFileSync(FIXTURE, "utf8").replace('"a phrase worth a note"', '"words that are not there"');
  await jump(page, "Inbox");
  const broken = page.waitForEvent("filechooser");
  await command(page, "/import");
  await (await broken).setFiles({ name: "broken.md", mimeType: "text/markdown", buffer: Buffer.from(bad) });
  await expect(status(page)).toContainText('Could not import broken.md: broken.md:5: in “Menu fixture”: quote not found: "words that are not there"');
  expect(await kids(page, "Inbox")).toEqual(["Menu fixture", "Menu fixture (copy)"]);
});

test("Move under…: M picks any node in the library, or the root, and the node goes there with everything under it; u undoes", async ({ page }) => {
  await openAt(page);
  await quiet(page);
  await jump(page, "Menu fixture (copy)");
  await keys(page, "M");
  const picker = page.locator(".jump.move");
  await expect(picker.locator(".jump-head")).toContainText("Move “Menu fixture (copy)” and everything under it under…");
  // Never the node itself or anything under it: its own sections are not offered, the original's are.
  await page.keyboard.type("First section");
  const offered = await picker.locator("li[data-hit]").evaluateAll((els) => els.map((e) => e.getAttribute("data-hit")));
  const own = await state(page, (s) => {
    const id = s.moving;
    const out = [id];
    const visit = (x: string) => s.snap.nodes[x].children.forEach((c: string) => (out.push(c), visit(c)));
    visit(id);
    return out;
  });
  expect(offered.length).toBeGreaterThan(0);
  for (const id of offered) expect(own).not.toContain(id);
  await page.keyboard.press("Control+a");
  await page.keyboard.type("scratch pad");
  await expect(picker.locator("li").first().locator(".t")).toHaveText("Scratch pad");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  expect(await parentOf(page, "Menu fixture (copy)")).toBe("Scratch pad");
  expect(await focusedTitle(page)).toBe("Menu fixture (copy)");
  expect(await state(page, (s) => s.commits()[0].message)).toBe("Move “Menu fixture (copy)” under “Scratch pad”");
  await expect(status(page)).toContainText("Moved “Menu fixture (copy)” under “Scratch pad”. u undoes.");
  await keys(page, "u");
  expect(await parentOf(page, "Menu fixture (copy)")).toBe("Inbox");
  // Esc puts the picker away and moves nothing.
  await keys(page, "M");
  await expect(picker).toBeVisible();
  await keys(page, "Escape");
  await expect(picker).toHaveCount(0);
  expect(await state(page, (s) => s.mode)).toBe("normal");
  expect(await parentOf(page, "Menu fixture (copy)")).toBe("Inbox");
  // From the menu, and to the top of the library: with nothing typed, the root is offered first.
  await page.locator(".node.focused > .row .more").click();
  await page.locator(".menu .mi", { has: page.locator('.lbl:text-is("Move under…")') }).click();
  await expect(picker).toBeVisible();
  await expect(picker.locator("li").first().locator(".p")).toHaveText("the library root");
  await page.keyboard.press("Enter");
  expect(await parentOf(page, "Menu fixture (copy)")).toBe("Library");
  // And back under the original's place, for what follows.
  await keys(page, "M");
  await page.keyboard.type("inbox");
  await page.keyboard.press("Enter");
  expect(await parentOf(page, "Menu fixture (copy)")).toBe("Inbox");
  await synced(page);
});

test("history: f shows only what touched the node the reader is on and what is under it; r reverts only that", async ({ page }) => {
  await openAt(page);
  await quiet(page);
  await jump(page, "Inbox");
  await keys(page, "a");
  await page.keyboard.type("Child to revert");
  await page.keyboard.press("Enter");
  // An edit outside Inbox: its parent renamed.
  await jump(page, "Scratch pad");
  await keys(page, "r");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Scratch pad, renamed");
  await page.keyboard.press("Enter");
  await jump(page, "Inbox");
  await keys(page, "g f");
  await expect(page.locator(".panel .panel-head")).toContainText("History · Inbox");
  const messages = await state(page, (s) => s.panel().filter((i: any) => i.type === "commit").map((i: any) => i.commit.message) as string[]);
  expect(messages[0]).toBe("Rename “Child to revert”");
  expect(messages).not.toContain("Rename “Scratch pad, renamed”");
  expect(messages.some((m) => m.startsWith("Import"))).toBe(true);
  // r on the commit before the child was added: Inbox goes back, its renamed parent stays as it is.
  const target = await state(page, (s) => s.panel().findIndex((i: any) => i.type === "commit" && i.commit.message === "Add section") + 1);
  while ((await state(page, (s) => s.historyIndex)) < target) await page.keyboard.press("j");
  await keys(page, "r");
  await expect(status(page)).toContainText("Reverted “Inbox” and what is under it");
  expect(await kids(page, "Inbox")).toEqual(["Menu fixture", "Menu fixture (copy)"]);
  expect(await parentOf(page, "Inbox")).toBe("Scratch pad, renamed");
  expect(await state(page, (s) => s.commits()[0].tag)).toBe("revert");
  // f again: everything. On the library root there is nothing to narrow to.
  await keys(page, "f");
  await expect(page.locator(".panel .panel-head")).toContainText("History · the library");
  await keys(page, "Escape O g f");
  await expect(status(page)).toContainText("On the library root history shows everything");
  await keys(page, "Escape");
});

test("the library opens from this browser without the network, and catches up when it returns", async ({ page }) => {
  await openPage(page, "The tides");
  await synced(page);
  const tides = await nodeAt(page, "The tides");
  await page.route("**/api/**", (route) => route.abort());
  await page.reload();
  await page.waitForSelector("article");
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
  expect(JSON.stringify(await (await page.request.get(`/api/nodes/${encodeURIComponent(tides)}/tree`)).json())).toContain("Renamed offline");
});

test("a note being written in one place lands there after the reader has gone elsewhere, and undo works wherever the last edit was", async ({ page }) => {
  await openAt(page);
  await quiet(page);
  await jump(page, "Inbox");
  await keys(page, "l j"); // Inbox open, and its first section: Menu fixture
  expect(await focusedTitle(page)).toBe("Menu fixture");
  await keys(page, "l i j e"); // select its second sentence and expand it
  await expect.poll(() => state(page, (s) => s.pending.size)).toBe(1);
  await jump(page, "Fixed points");
  await idle(page);
  await expect(page.locator(".pending, .writing")).toHaveCount(0);
  const notes = await state(page, (s) => s.snap.nodes[(Object.values(s.snap.nodes) as any[]).find((x) => x.title === "Menu fixture").id].children.filter((c: string) => /mock/i.test(s.snap.nodes[c].body)).length);
  expect(notes).toBe(1);
  // Undo is the library's: u here takes back the last edit, made under Inbox.
  await jump(page, "Inbox");
  await keys(page, "a");
  await page.keyboard.type("Only in the inbox");
  await page.keyboard.press("Enter");
  await jump(page, "Fixed points");
  await keys(page, "u");
  expect(await kids(page, "Inbox")).not.toContain("Only in the inbox");
  await keys(page, "U");
  expect(await kids(page, "Inbox")).toContain("Only in the inbox");
});

test("an outside agent reads, exports and imports into any node over HTTP; /api/docs is gone", async ({ page, request }) => {
  await openAt(page);
  await synced(page);
  const inbox = await nodeAt(page, "Scratch pad, renamed", "Inbox");
  const tree = await (await request.get(`/api/nodes/${encodeURIComponent(inbox)}/tree`)).json();
  expect(tree.root).toBe(inbox);
  expect(Object.values<any>(tree.nodes).map((n) => n.title)).toContain("Menu fixture");
  const res = await request.get(`/api/nodes/${encodeURIComponent(inbox)}/export`);
  expect(res.headers()["content-disposition"]).toContain('filename="inbox.md"');
  expect(await res.text()).toMatch(/^# Inbox\n/);
  const made = await request.post(`/api/nodes/${encodeURIComponent(inbox)}/import?name=agent.md`, { data: "# From an agent\n\nIts text.\n" });
  expect(made.status()).toBe(201);
  await expect.poll(() => kids(page, "Inbox")).toContain("From an agent");
  const refused = await request.post(`/api/nodes/${encodeURIComponent(inbox)}/import?name=bad.md`, { data: readFileSync(FIXTURE, "utf8").replace('"a phrase worth a note"', '"nowhere"') });
  expect(refused.status()).toBe(422);
  expect((await refused.json()).problems[0]).toContain("quote not found");
  expect((await request.get("/api/docs")).status()).toBe(404);
  expect((await request.get("/api/nodes/999%40999/tree")).status()).toBe(404);
});

test("in panes and at phone width: a node's address opens its pane, and the top bar fits", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await autoLayout(page);
  await openAt(page, "Fixed points");
  await expect(page.locator(".strip .pane")).toHaveCount(2); // the library, and the node's own pane
  await expect(page.locator(".strip .pane.root h1")).toHaveText("Library");
  await expect(page.locator(".strip .pane:not(.root) .pane-head h2")).toHaveText("Fixed points");
  // Move under… works from a pane too, and the picker is the same.
  await jump(page, "Only in the inbox");
  await keys(page, "M");
  await expect(page.locator(".jump.move")).toBeVisible();
  await keys(page, "Escape");
  await page.setViewportSize({ width: 390, height: 800 });
  const bar = (await page.locator(".docbar").boundingBox())!;
  expect(bar.x + bar.width).toBeLessThanOrEqual(390);
  await expect(page.locator(".docbar .lib-name")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
