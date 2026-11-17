/**
 * Several libraries, from the page: every address names its library (`/l/<id>`), `/` opens the one
 * last used, :/library lists, makes and opens them (a page load), a new library starts with its root
 * alone, nothing of one library is found from another (the jump box, nearby and Related, a node's
 * address), and each library keeps its own view. The panel that lists them is step 4's; these
 * tests use the command and the API. They make their own libraries and delete them at the end: the
 * other specs share the first.
 */
import { expect, test, type Page } from "@playwright/test";
import { command, keys, libraryId, settle, state } from "./helpers";

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
