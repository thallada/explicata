/**
 * Several libraries, from the page: every address names its library (`/l/<id>`), `/` opens the one
 * last used, :/library makes and opens them (a page load), a new library starts with its root
 * alone, nothing of one library is found from another (the jump box, nearby and Related, a node's
 * address), and each library keeps its own view. The libraries panel (m, or the library's name in
 * the top bar): opening and closing it by key, click and a press outside, its rows, making,
 * renaming and deleting a library from it by key and by mouse, the last one refusing, switching
 * with each library's view kept, the panes beside it with their curves, a phone's width, and a page
 * whose library was deleted while it was away. The tests make their own libraries and delete them
 * at the end: the other specs share the first.
 */
import { expect, test, type Page } from "@playwright/test";
import { autoLayout, command, curveFaults, frames, keys, libraryId, settle, state } from "./helpers";

const ready = (page: Page) => page.waitForFunction(() => (globalThis as any).__ie?.ready);
const status = (page: Page) => page.locator(".status .message");
const lib = (page: Page) => state(page, (s) => s.library as string);

test.describe.configure({ mode: "serial" });
test.afterEach(({ page }) => settle(page));

test("a new library starts with its root alone, has an address of its own, and finds nothing of the first", async ({ page }) => {
  const first = await libraryId(page);
  await page.goto("/");
  await ready(page);
  // `/` opens the first library in a browser that has used none, at its own address.
  expect(await lib(page)).toBe(first);
  await expect(page).toHaveURL(new RegExp(`/l/${first}$`));

  await command(page, "/library new Work notes");
  await page.waitForURL((u) => /^\/l\/[0-9a-z]+$/.test(u.pathname) && !u.pathname.endsWith(first));
  await ready(page);
  const work = await lib(page);
  expect(work).not.toBe(first);
  await expect(page.locator(".top h1")).toHaveText("Work notes");
  await expect(page.locator(".docbar .lib-name")).toHaveText("Work notes");
  // Its root alone: no seed, no starter trees.
  expect(await state(page, (s) => s.snap.nodes[s.snap.root].children.length)).toBe(0);

  // A section with the same title as one in the first library, and text that mentions the first's titles.
  await keys(page, "a");
  await page.keyboard.type("Fixed points");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => Object.values((globalThis as any).__ie.snap.nodes).some((n: any) => n.title === "Fixed points"));
  await page.waitForFunction(() => (globalThis as any).__ie.synced());

  // The jump box offers this library's nodes only.
  await keys(page, "/");
  await page.keyboard.type("Amphidromes");
  await expect(page.locator(".jump li[data-hit]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await keys(page, "/");
  await page.keyboard.type("Fixed points");
  await expect(page.locator(".jump li[data-hit]")).toHaveCount(1);
  await page.keyboard.press("Escape");

  // The server's routes for it hold only it.
  const tree = await (await page.request.get(`/api/l/${work}/tree`)).json();
  expect(Object.values(tree.nodes).map((n: any) => n.title).sort()).toEqual(["Fixed points", "Work notes"]);
  const firstTree = await (await page.request.get(`/api/l/${first}/tree`)).json();
  expect(Object.values(firstTree.nodes).some((n: any) => n.title === "Work notes")).toBe(false);
  // Nearby and Related never come from the first library, though it has a "Fixed points" too.
  const mine = Object.values(tree.nodes).find((n: any) => n.title === "Fixed points") as { id: string };
  const nearby = await (await page.request.get(`/api/l/${work}/links/nearby?node=${encodeURIComponent(mine.id)}`)).json();
  for (const n of nearby.nearby) expect(tree.nodes[n.handle]).toBeTruthy();
  const related = await (await page.request.get(`/api/l/${work}/links/related?node=${encodeURIComponent(mine.id)}`)).json();
  for (const r of related.related) expect(tree.nodes[r.node]).toBeTruthy();

  // A node of the first library, at this library's address, is not found here.
  const amph = Object.values(firstTree.nodes).find((n: any) => n.title === "Amphidromes") as { id: string };
  await page.goto(`/l/${work}/n/${encodeURIComponent(amph.id)}`);
  await ready(page);
  await expect(page.locator(".top h1")).toHaveText("Work notes");
  await expect(status(page)).toContainText(amph.id);

  // `/` now opens the library last used here.
  await page.goto("/");
  await ready(page);
  expect(await lib(page)).toBe(work);
  // :/library with a name opens another, by a page load; each keeps its own view.
  await command(page, "/library Library");
  await page.waitForURL(new RegExp(`/l/${first}`));
  await ready(page);
  expect(await lib(page)).toBe(first);
  await expect(page.locator(".top h1")).toHaveText("Library");
  const keysNow = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("ie:view:")).sort());
  expect(keysNow).toEqual(expect.arrayContaining([`ie:view:${first}:main`, `ie:view:${work}:main`]));
});

test("rename and delete over the API; an unknown library's address goes to the first; the last library cannot be deleted", async ({ page }) => {
  const first = await libraryId(page);
  const listed = (await (await page.request.get("/api/libraries")).json()).libraries as { id: string; title: string }[];
  const work = listed.find((l) => l.title === "Work notes")!;
  expect(work).toBeTruthy();
  const renamed = await page.request.patch(`/api/libraries/${work.id}`, { data: { title: "Work, renamed" } });
  expect(renamed.ok()).toBe(true);
  await page.goto(`/l/${work.id}`);
  await ready(page);
  await expect(page.locator(".top h1")).toHaveText("Work, renamed");
  // The page learns of its library's deletion and stops sending.
  const gone = await page.request.delete(`/api/libraries/${work.id}`);
  expect(gone.ok()).toBe(true);
  expect((await gone.json()).movedTo).toContain(".deleted");
  await expect(status(page)).toContainText("This library has been deleted");
  // Its address now goes to the first library, saying so.
  await page.goto(`/l/${work.id}`);
  await page.waitForURL(new RegExp(`/l/${first}$`));
  await ready(page);
  await expect(status(page)).toContainText(`There is no library ${work.id} here`);
  // The first, now alone, cannot be deleted.
  const last = await page.request.delete(`/api/libraries/${first}`);
  expect(last.status()).toBe(409);
});

// ---- the libraries panel ----

const panel = (page: Page) => page.locator(".panel.left[data-libraries]");
const trigger = (page: Page) => page.locator(".docbar .lib-name");
const rows = (page: Page) => panel(page).locator(".lib-row[data-lib]");
const row = (page: Page, title: string) => panel(page).locator(".lib-row[data-lib]", { has: page.locator(".lib-t", { hasText: title }) });
const titles = (page: Page) => rows(page).locator(".lib-t").allTextContents();
const loaded = (page: Page) => expect(panel(page)).not.toHaveAttribute("data-loading", /./);
/** Until the strip and its panes have stopped scrolling (a pane opened slides into view), then two frames for the curves. */
async function still(page: Page) {
  await page.waitForFunction(
    () =>
      new Promise((r) => {
        const at = () => [document.querySelector(".strip")!, ...document.querySelectorAll(".strip > .col, .strip .pane-scroll")].map((el) => `${el.scrollLeft},${el.scrollTop},${Math.round(el.getBoundingClientRect().left)},${Math.round(el.getBoundingClientRect().width)}`).join();
        const x = at();
        setTimeout(() => r(at() === x), 250);
      }),
  );
  await frames(page);
}
const api = async (page: Page) => ((await (await page.request.get("/api/libraries")).json()).libraries as { id: string; title: string; nodes: number }[]);
const focusTitle = (page: Page) => state(page, (s) => s.snap.nodes[s.focus.node]?.title as string);

test("the library's name opens the panel; a second click, m, Esc or a press outside closes it", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  await expect(trigger(page)).toHaveText("Library");
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
  // A click opens it, on the left, and the page makes room.
  await trigger(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".app")).toHaveClass(/with-left/);
  const box = (await panel(page).boundingBox())!;
  expect(box.x).toBe(0);
  // It hangs below the top bar: the name that opened it stays where it was, clear of it.
  const bar = (await trigger(page).boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
  const article = (await page.locator("article").boundingBox())!;
  expect(article.x).toBeGreaterThanOrEqual(box.x + box.width);
  await expect(page.locator(".status .grain")).toHaveText("libraries");
  await expect(page.locator(".status .message")).toContainText("open");
  // A second click on the name closes it, and does not open it again.
  await trigger(page).click();
  await expect(panel(page)).toHaveCount(0);
  await page.waitForTimeout(150);
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator(".app")).not.toHaveClass(/with-left/);
  // m opens and closes it; so does Esc.
  await keys(page, "m");
  await expect(panel(page)).toBeVisible();
  await keys(page, "m");
  await expect(panel(page)).toHaveCount(0);
  await keys(page, "m");
  await expect(panel(page)).toBeVisible();
  await keys(page, "Escape");
  await expect(panel(page)).toHaveCount(0);
  // The top bar's menu offers it too.
  await page.locator(".docbar .tool", { hasText: "menu" }).click();
  await page.locator(".menu .mi", { hasText: "Libraries…" }).click();
  await expect(panel(page)).toBeVisible();
  // A press outside closes it, and the click does nothing else: the row under it is not opened.
  const openBefore = await state(page, (s) => s.open.size);
  await page.locator("article .row", { hasText: "Octopus minds" }).click();
  await expect(panel(page)).toHaveCount(0);
  expect(await state(page, (s) => s.open.size)).toBe(openBefore);
  // While it is open the keys are its own: j does not move the page's focus.
  const before = await focusTitle(page);
  await keys(page, "m j j Escape");
  expect(await focusTitle(page)).toBe(before);
  // The help lists it.
  await keys(page, "?");
  await expect(page.locator(".help")).toContainText("the libraries panel");
  await keys(page, "Escape");
});

test("the panel lists every library with its size, marks the one open here, and will not delete the last", async ({ page }) => {
  const first = await libraryId(page);
  expect((await api(page)).map((l) => l.id)).toEqual([first]);
  await page.goto("/");
  await ready(page);
  await keys(page, "m");
  await loaded(page);
  expect(await titles(page)).toEqual(["Library"]);
  const mine = row(page, "Library");
  await expect(mine).toHaveClass(/current/);
  await expect(mine).toHaveClass(/selected/);
  await expect(mine.locator(".lib-mark")).toHaveText("●");
  // Its size, as the library's own byline counts it.
  const byline = (await page.locator(".top .byline").textContent())!;
  const count = /(\d[\d,]*) nodes/.exec(byline)![1];
  await expect(mine.locator(".sub")).toHaveText(`${count} nodes · open here`);
  // D refuses, saying why; its menu offers Delete disabled.
  await keys(page, "D");
  await expect(page.locator(".lib-confirm")).toHaveCount(0);
  await expect(status(page)).toContainText("The last library cannot be deleted");
  await mine.click({ button: "right" });
  await expect(page.locator(".menu .mi", { hasText: "Delete…" })).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator(".menu .mi", { hasText: "Open here already" })).toHaveAttribute("aria-disabled", "true");
  await keys(page, "Escape");
  // The server agrees.
  expect((await page.request.delete(`/api/libraries/${first}`)).status()).toBe(409);
  // A click on this page's own library just closes the panel.
  await mine.locator(".lib-t").click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/l/${first}$`));
});

test("from the panel: n makes a library and opens it, r renames inline, D asks and y deletes; switching keeps each library's view", async ({ page }) => {
  const first = await libraryId(page);
  await page.goto("/");
  await ready(page);
  // Leave the first library somewhere: Octopus minds open, the focus on it.
  await keys(page, "/");
  await page.keyboard.type("Octopus minds");
  await page.keyboard.press("Enter");
  await expect.poll(() => focusTitle(page)).toBe("Octopus minds");
  await keys(page, "Enter");
  await expect.poll(() => state(page, (s) => s.open.has(s.focus.node))).toBe(true);
  // n: a name, typed in the panel; Enter makes the library and opens it (a page load).
  await keys(page, "m");
  await keys(page, "n");
  const box = panel(page).locator(".lib-input");
  await expect(box).toBeFocused();
  // An empty name is refused; Esc leaves it.
  await page.keyboard.press("Enter");
  await expect(status(page)).toContainText("Give it a name");
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await keys(page, "n");
  await page.keyboard.type("Scratch");
  await page.keyboard.press("Enter");
  await page.waitForURL((u) => /^\/l\/[0-9a-z]+$/.test(u.pathname) && !u.pathname.endsWith(first));
  await ready(page);
  const scratch = await lib(page);
  await expect(page.locator(".top h1")).toHaveText("Scratch");
  await expect(trigger(page)).toHaveText("Scratch");
  // Somewhere of its own here: a section, focused.
  await keys(page, "a");
  await page.keyboard.type("A scratch section");
  await page.keyboard.press("Enter");
  await expect.poll(() => focusTitle(page)).toBe("A scratch section");
  await page.waitForFunction(() => (globalThis as any).__ie.synced());

  // The panel lists both, in order, this one marked; j k move.
  await keys(page, "m");
  await loaded(page);
  expect(await titles(page)).toEqual(["Library", "Scratch"]);
  await expect(row(page, "Scratch")).toHaveClass(/current/);
  await expect(row(page, "Scratch").locator(".sub")).toHaveText("1 node · open here");
  await keys(page, "k");
  await expect(row(page, "Library")).toHaveClass(/selected/);
  await keys(page, "j");
  await expect(row(page, "Scratch")).toHaveClass(/selected/);
  // r renames inline: this page's own library, so its root's title follows.
  await keys(page, "r");
  await expect(box).toHaveValue("Scratch");
  await page.keyboard.press("End");
  await page.keyboard.type(" pad");
  await page.keyboard.press("Enter");
  await expect(row(page, "Scratch pad")).toHaveCount(1);
  await expect(trigger(page)).toHaveText("Scratch pad");
  await expect(page.locator(".top h1")).toHaveText("Scratch pad");

  // Enter on the other row opens it, by a page load, where it was left.
  await keys(page, "k Enter");
  await page.waitForURL(new RegExp(`/l/${first}`));
  await ready(page);
  await expect.poll(() => focusTitle(page)).toBe("Octopus minds");
  expect(await state(page, (s) => s.open.has(s.focus.node))).toBe(true);
  // And back by a click on its row: there too.
  await trigger(page).click();
  await row(page, "Scratch pad").locator(".lib-t").click();
  await page.waitForURL(new RegExp(`/l/${scratch}`));
  await ready(page);
  await expect.poll(() => focusTitle(page)).toBe("A scratch section");

  // Rename by the mouse: a right-click on a row, Rename…; Esc in the box leaves the name as it was.
  await keys(page, "m");
  await row(page, "Library").click({ button: "right" });
  await page.locator(".menu .mi", { hasText: "Rename…" }).click();
  await expect(box).toHaveValue("Library");
  await page.keyboard.press("Escape");
  await expect(row(page, "Library")).toHaveCount(1);
  expect((await api(page)).find((l) => l.id === first)!.title).toBe("Library");

  // D asks first, saying where the files go; n keeps it.
  const doomed = (await (await page.request.post("/api/libraries", { data: { title: "Doomed" } })).json()).library.id as string;
  await keys(page, "Escape m");
  await loaded(page);
  expect(await titles(page)).toEqual(["Library", "Scratch pad", "Doomed"]);
  await keys(page, "j D");
  await expect(row(page, "Doomed").locator(".lib-confirm")).toContainText("libraries/.deleted/");
  await expect(status(page)).toContainText("delete “Doomed”?");
  // While it asks, j moves nothing.
  await keys(page, "k");
  await expect(row(page, "Doomed")).toHaveClass(/selected/);
  await keys(page, "n");
  await expect(page.locator(".lib-confirm")).toHaveCount(0);
  expect((await api(page)).some((l) => l.id === doomed)).toBe(true);
  // y deletes it: gone from the list and the server, and the panel says where its files went.
  await keys(page, "D y");
  await expect(row(page, "Doomed")).toHaveCount(0);
  await expect(panel(page).locator(".lib-note")).toContainText(`libraries/.deleted/${doomed}-`);
  expect((await api(page)).some((l) => l.id === doomed)).toBe(false);
  await expect(row(page, "Scratch pad")).toHaveClass(/selected/);

  // Deleting the library open here, by the mouse (its ⋯, Delete…, then the y button): the page goes to the first.
  await row(page, "Scratch pad").hover();
  await row(page, "Scratch pad").locator("[data-lib-more]").click();
  await page.locator(".menu .mi", { hasText: "Delete…" }).click();
  await row(page, "Scratch pad").locator(".lib-confirm .key[data-key=y]").click();
  await page.waitForURL(new RegExp(`/l/${first}$`));
  await ready(page);
  await expect(status(page)).toContainText("Deleted “Scratch pad”");
  expect((await api(page)).map((l) => l.id)).toEqual([first]);
});

test("in the panes view the panel narrows the panes, and the curves follow it there and back", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await autoLayout(page);
  const other = (await (await page.request.post("/api/libraries", { data: { title: "Beside" } })).json()).library.id as string;
  await page.goto("/");
  await page.waitForSelector(".strip .pane");
  await page.evaluate(() => document.fonts.ready);
  await page.locator(".pane .row", { hasText: "Infinispand" }).first().dispatchEvent("click");
  await page.locator(".pane .row", { hasText: "Expansion by depth" }).first().dispatchEvent("click");
  await expect(page.locator(".strip .pane")).toHaveCount(3);
  await still(page);
  expect(await curveFaults(page), "before").toEqual([]);
  expect(await page.locator(".curves path:not(.foot):not(.frame)").count()).toBeGreaterThan(0);
  const strip = (await page.locator(".strip").boundingBox())!;
  await keys(page, "m");
  await expect(panel(page)).toBeVisible();
  const p = (await panel(page).boundingBox())!;
  // The panes start where the panel ends; the top bar runs on above both.
  await expect.poll(async () => Math.round((await page.locator(".panes").boundingBox())!.x)).toBe(Math.round(p.x + p.width));
  expect(Math.round((await page.locator(".docbar").boundingBox())!.x)).toBe(0);
  await expect.poll(async () => Math.round((await page.locator(".strip").boundingBox())!.width)).toBe(Math.round(strip.width - p.width));
  await still(page);
  expect(await curveFaults(page), "with the panel").toEqual([]);
  // With the history panel open on the right as well: the panes between the two.
  await keys(page, "Escape g");
  await trigger(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(page.locator(".panel:not(.left)")).toBeVisible();
  const right = (await page.locator(".panel:not(.left)").boundingBox())!;
  await expect.poll(async () => { const b = (await page.locator(".panes").boundingBox())!; return Math.round(b.x + b.width); }).toBe(Math.round(right.x));
  await still(page);
  expect(await curveFaults(page), "between two panels").toEqual([]);
  // The panel has the keys over the history panel's; closed, history has them again.
  await keys(page, "Escape");
  await expect(panel(page)).toHaveCount(0);
  expect(await state(page, (s) => s.mode)).toBe("history");
  await keys(page, "Escape");
  await expect.poll(async () => Math.round((await page.locator(".strip").boundingBox())!.width)).toBe(Math.round(strip.width));
  await still(page);
  expect(await curveFaults(page), "after").toEqual([]);
  expect((await page.request.delete(`/api/libraries/${other}`)).ok()).toBe(true);
});

test("on a phone the panel covers the page instead of squeezing the column", async ({ browser }) => {
  const port = new URL(test.info().project.use.baseURL!).port;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true, baseURL: `http://localhost:${port}` });
  const page = await ctx.newPage();
  const other = (await (await page.request.post("/api/libraries", { data: { title: "Pocket" } })).json()).library.id as string;
  await page.goto("/");
  await ready(page);
  const article = (await page.locator("article").boundingBox())!;
  await trigger(page).tap();
  await expect(panel(page)).toBeVisible();
  await loaded(page);
  const p = (await panel(page).boundingBox())!;
  expect(p.x).toBe(0);
  expect(Math.round(p.width)).toBe(390);
  // The column under it is as it was.
  const after = (await page.locator("article").boundingBox())!;
  expect([after.x, after.width]).toEqual([article.x, article.width]);
  expect(await titles(page)).toEqual(["Library", "Pocket"]);
  // A row's ⋯ shows without hovering; a tap on the name closes the panel.
  await expect(row(page, "Pocket").locator("[data-lib-more]")).toBeVisible();
  await trigger(page).tap();
  await expect(panel(page)).toHaveCount(0);
  // A tap on a row opens that library.
  await trigger(page).tap();
  await row(page, "Pocket").locator(".lib-t").tap();
  await page.waitForURL(new RegExp(`/l/${other}`));
  await ready(page);
  await expect(page.locator(".top h1")).toHaveText("Pocket");
  expect((await page.request.delete(`/api/libraries/${other}`)).ok()).toBe(true);
  await ctx.close();
});

test("a page whose library was deleted while it was away says so and offers the others", async ({ page }) => {
  const first = await libraryId(page);
  const away = (await (await page.request.post("/api/libraries", { data: { title: "Away" } })).json()).library.id as string;
  // The page cannot hear the server: its notice stream fails, as when the machine slept.
  let cut = true;
  await page.route(/\/events$/, (r) => (cut ? r.abort() : r.continue()));
  await page.goto(`/l/${away}`);
  await ready(page);
  await expect(page.locator(".top h1")).toHaveText("Away");
  // Deleted meanwhile, elsewhere; the page missed the notice.
  expect((await page.request.delete(`/api/libraries/${away}`)).ok()).toBe(true);
  // An edit goes nowhere: the server has no such library (a 404), and the page says so instead of "offline".
  await keys(page, "a");
  await page.keyboard.type("Written after");
  await page.keyboard.press("Enter");
  await expect(page.locator(".save-state")).toHaveText("deleted · not saved");
  await expect(status(page)).toContainText("This library has been deleted");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator(".lib-gone")).toContainText("deleted on the server");
  await loaded(page);
  expect(await titles(page)).toEqual(["Library"]);
  await keys(page, "Enter");
  await page.waitForURL(new RegExp(`/l/${first}`));
  await ready(page);

  // The same when the page learns it from its notice stream coming back (no edit made).
  const again = (await (await page.request.post("/api/libraries", { data: { title: "Away again" } })).json()).library.id as string;
  cut = true;
  await page.goto(`/l/${again}`);
  await ready(page);
  await expect(page.locator(".top h1")).toHaveText("Away again");
  expect((await page.request.delete(`/api/libraries/${again}`)).ok()).toBe(true);
  cut = false;
  await expect(page.locator(".save-state")).toHaveText("deleted · not saved", { timeout: 15_000 });
  await expect(panel(page)).toBeVisible();
});
