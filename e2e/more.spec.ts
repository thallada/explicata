/** The mouse, narrow screens, hover previews, hoisting, speculation, orphans, and an outside agent over HTTP. */
import { expect, test, type Page } from "@playwright/test";
import { command, idle, jump, keys, openPage, settle, state } from "./helpers";

/** The first tree as the page (hoisted), with the library one step out. */
const open = (page: Page) => openPage(page, "Explicata");

test.afterEach(({ page }) => settle(page));

test("everything is reachable with the mouse: titles, marked spans, and a dragged selection", async ({ page }) => {
  await open(page);
  await page.locator(".row", { hasText: "Borrowed from Gwern" }).click();
  await expect(page.locator(".node.open > .row", { hasText: "Borrowed from Gwern" })).toBeVisible();
  await page.locator(".row", { hasText: "Semantic zoom" }).click();
  // A marked span opens its pre-generated note.
  const anchor = page.locator(".node.open .anchor", { hasText: "StretchText" });
  await anchor.click();
  await expect(page.locator(".anchor.on")).toHaveCount(1);
  await anchor.click();
  await expect(page.locator(".anchor.on")).toHaveCount(0);
  // Dragging across text makes that range the focus; e then expands it like any other.
  await page.locator(".row", { hasText: "Typography" }).click();
  const para = page.locator(".node.open", { hasText: "Typography" }).last().locator(".para").first();
  const box = (await para.boundingBox())!;
  await page.mouse.move(box.x + 6, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 12, { steps: 6 });
  await page.mouse.up();
  const focus = await state(page, (s) => ({ grain: s.focus.grain, text: s.snap.nodes[s.focus.node].body.slice(s.focus.range[0], s.focus.range[1]) }));
  expect(focus.grain).toBe("word");
  expect(focus.text.length).toBeGreaterThan(3);
  await page.keyboard.press("e");
  await idle(page);
  const made = await state(page, (s) => Object.values(s.snap.nodes).filter((n: any) => n.kind === "note" && !n.wanchor && /^[Mm]ock/.test(n.body)).map((n: any) => n.anchors[0].text));
  expect(made).toContain(focus.text);
});

test("hovering a marked span previews its note without opening it", async ({ page }) => {
  await open(page);
  await jump(page, "Semantic zoom");
  await page.keyboard.press("l");
  await page.locator(".node.open .anchor", { hasText: "StretchText" }).hover();
  await expect(page.locator(".popup")).toBeVisible();
  await expect(page.locator(".anchor.on")).toHaveCount(0);
  await page.mouse.move(5, 5);
  await expect(page.locator(".popup")).toHaveCount(0);
});

test("on a narrow screen a margin note falls into the column", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 900 });
  await open(page);
  await jump(page, "Expansion by depth");
  await keys(page, "l Tab Enter");
  const [note, col] = await Promise.all([page.locator(".sidenote").first().boundingBox(), page.locator("article").boundingBox()]);
  expect(note!.x).toBeGreaterThanOrEqual(col!.x);
  expect(note!.x + note!.width).toBeLessThanOrEqual(col!.x + col!.width + 1);
  // And nothing scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("hoisting makes one node the whole page; Esc at its top steps out to its parent's page, and on up to the library", async ({ page }) => {
  await open(page);
  await jump(page, "Semantic conflicts");
  await page.keyboard.press("z");
  await expect(page.locator("h1")).toHaveText("Semantic conflicts");
  await expect(page.locator(".crumbs")).toHaveText(/^Library › Explicata › Versioning and merge ›/);
  await expect(page.locator("article > .outline > .node")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(page.locator("h1")).toHaveText("Versioning and merge");
  // The focus stays on the section it stepped out of, now a row; from each page's own top, out again.
  expect(await state(page, (s) => s.snap.nodes[s.focus.node].title)).toBe("Semantic conflicts");
  await page.keyboard.press("O"); // collapse everything: the focus goes to the top
  await page.keyboard.press("Escape");
  await expect(page.locator("h1")).toHaveText("Explicata");
  await page.keyboard.press("O");
  await page.keyboard.press("Escape");
  await expect(page.locator("h1")).toHaveText("Library");
  expect(await state(page, (s) => s.snap.nodes[s.focus.node].title)).toBe("Explicata");
  await expect(page).toHaveURL(/\/n\/[^/]+$/);
  // On the root itself, the address is the library's.
  await page.keyboard.press("O");
  await expect(page).toHaveURL(/\/l\/[0-9a-z]+$/);
});

test("with speculation on, the focused sentence is already being written when it is asked for", async ({ page }) => {
  await open(page);
  await command(page, "/speculate on");
  await jump(page, "Typography");
  await keys(page, "l i");
  await page.waitForTimeout(1200); // focus rests; the expansion is written in the background
  expect(await state(page, (s) => s.pending.size)).toBe(0); // nothing is shown until asked
  await page.keyboard.press("e");
  // The whole text is there on the first frame: no stream to wait for.
  await expect(page.locator(".sidenote, .inset").filter({ hasText: "Mock" }).first()).toBeVisible({ timeout: 500 });
  await idle(page);
  await command(page, "/speculate off");
});

test("deleting the words a note is about orphans the note, visibly", async ({ page }) => {
  await open(page);
  await command(page, "/auto off");
  await jump(page, "Focus and grain");
  await keys(page, "l Tab Enter"); // open its pre-generated note
  await expect(page.locator(".sidenote", { hasText: "A cursor that only addressed nodes" })).toHaveCount(1);
  await keys(page, "Escape Escape c");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Rewritten so that the anchored words are gone.");
  await page.keyboard.press("Escape");
  const orphan = page.locator(".inset.orphan", { hasText: "orphaned: its text “a node and a grain” was deleted" });
  await expect(orphan).toHaveCount(1);
  await keys(page, "u"); // and undo brings the words, and the anchor, back
  await expect(orphan).toHaveCount(0);
  await expect(page.locator(".sidenote", { hasText: "A cursor that only addressed nodes" })).toHaveCount(1);
  await command(page, "/auto on");
});

test("an outside agent edits over HTTP with the same ops, and the open page follows", async ({ page, request }) => {
  await open(page);
  const tree = await (await request.get("/api/tree/main")).json();
  // The tree is the whole library; its top-level trees are the root's sections.
  expect(Object.values<any>(tree.nodes).filter((n) => n.parent === tree.root).map((n) => n.title)).toContain("Explicata");
  const target = Object.values<any>(tree.nodes).find((n) => n.title === "The first tree");
  expect(target).toBeTruthy();
  const res = await request.post("/api/ops/main", {
    data: { author: "outside-agent", message: "Add a remark", ops: [{ op: "create", parent: target.id, title: "Written over HTTP", body: "By an agent that is not the browser." }] },
  });
  expect(res.ok()).toBe(true);
  await expect.poll(() => state(page, (s) => Object.values(s.snap.nodes).some((n: any) => n.title === "Written over HTTP"))).toBe(true);
  const commit = await state(page, (s) => s.commits().find((c: any) => c.message === "Add a remark"));
  expect(commit).toMatchObject({ by: "outside-agent", tag: "api" });
  // A refused op is reported, not applied.
  const bad = await request.post("/api/ops/main", { data: { ops: [{ op: "delete", id: tree.root }] } });
  expect(bad.status()).toBe(422);
  expect((await bad.json()).error).toMatch(/root/);
});

test("the footer counts this session's model calls, and /api/usage says what it knows", async ({ page, request }) => {
  await open(page);
  const session = page.locator(".status .usage-session");
  await expect(session).toHaveText(/^[\d,]+ calls? · \S+ in · \S+ out$/);
  const before = Number(await session.getAttribute("data-calls"));
  // Ask why about a sentence no other test has touched: always a new model call.
  await jump(page, "Semantic conflicts");
  await keys(page, "l i y");
  await idle(page);
  await expect.poll(async () => Number(await session.getAttribute("data-calls"))).toBeGreaterThan(before);
  // The mock has no plan window, so there is no plan figure.
  await expect(page.locator(".status .usage-plan")).toHaveCount(0);
  // The footer still fits on one line, inside the window.
  const bar = (await page.locator(".status").boundingBox())!;
  const right = (await page.locator(".status .right").boundingBox())!;
  expect(right.x + right.width).toBeLessThanOrEqual(bar.x + bar.width);
  expect(right.height).toBeLessThan(bar.height);

  const u = await (await request.get("/api/usage")).json();
  expect(u).toMatchObject({
    provider: "mock",
    model: "mock",
    plan: null,
    session: {
      calls: expect.any(Number),
      failed: expect.any(Number),
      unreported: expect.any(Number),
      input: { fresh: expect.any(Number), cacheRead: 0, cacheWrite: 0, total: expect.any(Number) },
      output: expect.any(Number),
      lastCall: { at: expect.any(String), input: expect.any(Number), output: expect.any(Number) },
      costUsd: null,
    },
  });
  expect(u.session.calls).toBeGreaterThan(before);
  expect(u.session.input.total).toBe(u.session.input.fresh);
  expect(u.session.input.total).toBeGreaterThan(0);
  expect(Date.parse(u.session.startedAt)).toBeLessThanOrEqual(Date.parse(u.now));
});
