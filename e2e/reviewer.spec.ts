/**
 * The link reviewer, keyboard and mouse: in review mode (the default with a model) what a scan
 * finds is judged by the model and the approved links are made as one commit by "reviewer" (u
 * undoes it); what it rejected waits behind the links list's filter, with its reason; a person
 * reverses either; a link removed in the text (by D or the right-click menu) is declined and not
 * made again; a failed review leaves everything as suggestions and says so; a background job is
 * reviewed as it goes and can be stopped. Against the mock model, whose reviewer links a name or a
 * term of several words and not a single lower-case word, and fails on a sentence that says
 * "mockfail" (src/llm/mock.ts).
 *
 * IE_SHOTS=<dir> also saves the links list with each filter, light and dark, into that directory.
 */
import { expect, test, type Page } from "@playwright/test";
import { addTop, command, idle, keys, selected, settle, state, visit } from "./helpers";

const SHOTS = process.env.IE_SHOTS;

/** The links on the focused node: quote → target title. */
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
const nolink = (page: Page) => state(page, (s) => (s.snap.nodes[s.focus.node].nolink ?? []) as string[]);
const panel = (page: Page) => page.locator("[data-links-panel]");
const count = (page: Page, status: string) => panel(page).locator(`.lfilter[data-filter=${status}] .n`);
const row = (page: Page, quote: string) => panel(page).locator(".lrow", { has: page.locator(`.lq:text-is("“${quote}”")`) });

async function column(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
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
  await settle(page);
});

test("review mode: the approved links are made as one commit by the reviewer, the rejected wait behind a filter with the reason, and u undoes", async ({ page }) => {
  await column(page);
  expect(await state(page, (s) => s.settings.autolink)).toBe("review");
  await newDoc(page, "Reviewed links", "The cephalopod met Fred Hoyle, who taught it the lambda calculus.");
  await idle(page);
  expect(await linksHere(page)).toEqual({ "Fred Hoyle": "Fred Hoyle", "lambda calculus": "Lambda calculus" });
  const top = await state(page, (s) => s.commits()[0]);
  expect(top).toMatchObject({ by: "reviewer", tag: "review" });
  await expect(page.locator(".status .message")).toContainText("Linked");
  await expect(page.locator(".status .message")).toContainText("1 rejected");
  // The rejected one is not drawn as a suggestion.
  await expect(page.locator("article .sugg")).toHaveCount(0);

  // The list: two linked, one rejected (hidden at first), none pending; each with who and why.
  await keys(page, "S");
  await expect(panel(page)).toBeVisible();
  await expect(count(page, "linked")).toHaveText("2");
  await expect(count(page, "rejected")).toHaveText("1");
  await expect(count(page, "pending")).toHaveText("0");
  await expect(panel(page).locator(".lrow")).toHaveCount(2);
  await expect(row(page, "Fred Hoyle")).toContainText("linked by the reviewer: mock: a name or a term");
  await expect(row(page, "cephalopod")).toHaveCount(0);
  if (SHOTS) await shots(page, "linked");
  // 2 shows the rejected, with the reviewer's reason; a click on the toggle does the same as the key.
  await keys(page, "2");
  await expect(row(page, "cephalopod")).toContainText("rejected by the reviewer: mock: one ordinary word needs no link");
  if (SHOTS) await shots(page, "linked-rejected");
  await keys(page, "1");
  await expect(panel(page).locator(".lrow")).toHaveCount(1);
  if (SHOTS) await shots(page, "rejected");
  await panel(page).locator(".lfilter[data-filter=linked]").click();
  await expect(panel(page).locator(".lrow")).toHaveCount(3);
  await keys(page, "Escape");

  // u takes the reviewer's links back; they are then offered as suggestions.
  await keys(page, "u");
  await expect(page.locator("article .lnk")).toHaveCount(0);
  expect(await state(page, (s) => s.snap.nodes[s.focus.node].body)).toContain("Fred Hoyle");
  await expect(page.locator("article .sugg")).toHaveCount(2);
});

test("in the list a person reverses the reviewer either way: links one it rejected, removes one it linked for good", async ({ page }) => {
  await column(page);
  await newDoc(page, "Reversed links", "The cephalopod met Fred Hoyle, who taught it the lambda calculus.");
  await idle(page);
  await keys(page, "S 2");
  // Select the rejected row with a click: its words are selected in the text.
  await row(page, "cephalopod").click();
  expect(await selected(page)).toBe("cephalopod");
  await keys(page, "y");
  await expect(row(page, "cephalopod")).toContainText("linked by tester · the reviewer said no");
  await expect(page.locator(".status .message")).toContainText("over the reviewer's no");
  expect(await linksHere(page)).toMatchObject({ cephalopod: "Cephalopod" });
  // The person's link is their own commit.
  expect(await state(page, (s) => s.commits()[0].by)).toBe("tester");
  await expect(count(page, "linked")).toHaveText("3");
  // n on a linked row removes the link and declines its words.
  await row(page, "Fred Hoyle").click();
  await keys(page, "n");
  await expect(row(page, "Fred Hoyle")).toContainText("declined by tester · the reviewer said yes");
  expect(await linksHere(page)).toEqual({ cephalopod: "Cephalopod", "lambda calculus": "Lambda calculus" });
  expect(await nolink(page)).toEqual(["fred hoyle"]);
  await keys(page, "Escape");
  // An edit (a rescan) brings neither decision back.
  await keys(page, "Escape Escape c End");
  await page.keyboard.type(" Indeed.");
  await keys(page, "Escape");
  await idle(page);
  expect(await linksHere(page)).toEqual({ cephalopod: "Cephalopod", "lambda calculus": "Lambda calculus" });
  await expect(page.locator("article .sugg")).toHaveCount(0);
});

test("a link removed in the text, by D or by the right-click menu, is declined and not made again on a rescan", async ({ page }) => {
  await column(page);
  await newDoc(page, "Removed links", "Fred Hoyle wrote about the lambda calculus and the Hoyle state.");
  await idle(page);
  expect(Object.keys(await linksHere(page)).sort()).toEqual(["Fred Hoyle", "Hoyle state", "lambda calculus"]);
  // By key: Tab to the first link, D.
  await keys(page, "Tab");
  expect(await selected(page)).toBe("Fred Hoyle");
  await keys(page, "D");
  await expect(page.locator(".status .message")).toContainText("Removed the link on “Fred Hoyle”");
  expect(await nolink(page)).toEqual(["fred hoyle"]);
  // By the menu: right-click a library or Wikipedia link, Remove the link.
  await keys(page, "Escape Escape");
  await page.locator("article .lnk", { hasText: "lambda calculus" }).first().click({ button: "right" });
  const item = page.locator(".menu .mi", { has: page.locator('.lbl:text-is("Remove the link")') });
  await expect(item).toContainText("D");
  await item.click();
  expect(Object.keys(await linksHere(page))).toEqual(["Hoyle state"]);
  expect(await nolink(page)).toEqual(["fred hoyle", "lambda calculus"]);
  // An edit rescans the node; /linkhere rescans it and all under it: neither puts them back.
  await keys(page, "Escape Escape c End");
  await page.keyboard.type(" Again.");
  await keys(page, "Escape");
  await idle(page);
  await command(page, "/linkhere");
  await page.waitForFunction(() => (globalThis as any).__ie.links.job?.state === "done", undefined, { timeout: 30_000 });
  await idle(page);
  expect(Object.keys(await linksHere(page))).toEqual(["Hoyle state"]);
  await expect(page.locator("article .sugg")).toHaveCount(0);
  // The help lists the key.
  await keys(page, "?");
  await expect(page.locator(".help")).toContainText("decline its words in that node so it is not made again");
  await keys(page, "Escape");
});

test("when the model fails, nothing is linked unreviewed: everything is suggested, and the status line says so", async ({ page }) => {
  await column(page);
  await newDoc(page, "Failed review", "Fred Hoyle left mockfail notes on the lambda calculus.");
  await idle(page);
  await expect(page.locator("article .lnk")).toHaveCount(0);
  await expect(page.locator("article .sugg")).toHaveCount(2);
  await expect(page.locator(".status .message")).toContainText("Not reviewed (the reviewer failed: mock reviewer: the call failed)");
  await keys(page, "S");
  await expect(count(page, "pending")).toHaveText("2");
  await expect(panel(page).locator(".lrow.pending").first()).toContainText("not reviewed");
  await keys(page, "1");
  await expect(panel(page).locator(".lrow")).toHaveCount(2);
  if (SHOTS) await shots(page, "pending");
  await keys(page, "Escape");
  // Without a model, review is suggest, and the page says so when asked for it.
  await state(page, (s) => (s.llm = { ...s.llm, kind: "off" }));
  await command(page, "/autolink review");
  await expect(page.locator(".status .message")).toContainText("no model on this server, so for now links are only suggested");
  expect(await state(page, (s) => s.links.effective())).toBe("suggest");
});

test("a background job is reviewed as it goes, with the model's calls counted, and can be stopped; a finished one links what was approved", async ({ page }) => {
  await column(page);
  await visit(page, "The tides");
  await command(page, "/linkall");
  await page.waitForFunction(() => (globalThis as any).__ie.links.job?.state === "running" && (globalThis as any).__ie.links.job.done > 0);
  expect(await state(page, (s) => s.links.job.review)).toMatchObject({ max: 50 });
  await expect(page.locator(".status .message")).toContainText("reviewer");
  await command(page, "/linkcancel");
  await page.waitForFunction(() => (globalThis as any).__ie.links.job?.state === "cancelled");
  await expect(page.locator(".status .message")).toContainText("Stopped looking for links in the library");
  // A job on one tree (/linkhere on its top) runs to the end: its approved links are made as one commit by the reviewer.
  const before = await state(page, (s) => s.commits()[0].id);
  await command(page, "/linkhere");
  await page.waitForFunction(() => (globalThis as any).__ie.links.job?.state === "done", undefined, { timeout: 30_000 });
  await expect(page.locator(".status .message")).toContainText("linked by the reviewer");
  const job = await state(page, (s) => s.links.job);
  expect(job.review.calls).toBeGreaterThan(0);
  expect(job.review.calls).toBeLessThan(job.auto + job.suggest);
  await page.waitForFunction((id) => (globalThis as any).__ie.commits()[0].id !== id, before);
  expect(await state(page, (s) => s.commits()[0])).toMatchObject({ by: "reviewer", tag: "review" });
});

/** The links list as it stands, light and dark. */
async function shots(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(100);
    await page.screenshot({ path: `${SHOTS}/list-${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}
