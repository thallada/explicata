/**
 * /research with the mock model: its fake web search and fetch (no network) are shown step by step
 * above the status line, the section it writes carries links to the pages it read, those open in a
 * new tab, and Esc stops a run without keeping anything it did.
 */
import { expect, test, type Page } from "@playwright/test";
import { command, idle, jump, keys, settle, state } from "./helpers";


async function open(page: Page) {
  // Record what would open in a new tab instead of opening it.
  await page.addInitScript(() => {
    (globalThis as any).__opened = [];
    window.open = ((url: string) => ((globalThis as any).__opened.push(String(url)), null)) as typeof window.open;
  });
  await page.goto("/doc/infinispand");
  await page.waitForSelector("article");
}

test.describe.configure({ mode: "serial" });

test.afterEach(({ page }) => settle(page));

test("/research shows its searches and pages, writes a section, and links its claim to a page it read", async ({ page }) => {
  await open(page);
  expect(await state(page, (s) => s.web)).toEqual({ on: true, searches: 5, fetches: 5 });
  await jump(page, "The tree underneath");
  await command(page, "/research how tides work");

  const panel = page.locator(".agent-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-agent", "running");
  await expect(panel.locator(".agent-head")).toContainText("researching on the web");
  // Esc stops it, and says so as a button that presses Esc.
  await expect(panel.locator('.agent-head .key[data-key="Escape"]')).toHaveCount(1);
  await expect(panel.locator(".agent-steps")).toContainText("searched “how tides work”: 3 results");
  await expect(panel.locator(".agent-steps")).toContainText("read “How tides work” · example.org");
  await expect(panel).toHaveAttribute("data-agent", "done");
  // The edits are steps too, after the research.
  const steps = await panel.locator(".agent-steps li").allTextContents();
  const searched = steps.findIndex((s) => s.startsWith("searched"));
  const edited = steps.findIndex((s) => s.startsWith("added “On how tides work”"));
  expect(searched).toBeGreaterThanOrEqual(0);
  expect(edited).toBeGreaterThan(searched);
  expect(steps).toContain("linked “pulled by the Moon” to How tides work (example.org)");
  // The summary lists the sources it linked.
  await expect(panel.locator(".agent-summary")).toContainText("mock agent");
  await expect(panel.locator(".agent-sources a")).toHaveText("How tides work");
  await expect(panel.locator(".agent-sources a")).toHaveAttribute("href", "https://example.org/research/tides");
  await expect(page.locator(".status .message")).toContainText("sources: How tides work (example.org)");
  await idle(page);

  // The section is in the document, with the phrase linked to the page: a web link, marked ↗.
  const link = await state(page, (s) => {
    const snap = s.snap;
    const sec = Object.values(snap.nodes).find((n: any) => n.title === "On how tides work") as any;
    const note = sec && sec.children.map((c: string) => snap.nodes[c]).find((c: any) => c.kind === "note" && c.ref);
    return note ? { ref: note.ref, words: note.anchors[0].text, body: note.body, by: snap.nodes[sec.id].by } : null;
  });
  expect(link).toEqual({ ref: { kind: "url", url: "https://example.org/research/tides", title: "How tides work" }, words: "pulled by the Moon", body: "", by: "llm" });

  // Esc puts the finished panel away.
  await keys(page, "Escape");
  await expect(panel).toHaveCount(0);

  // The link opens: go to the section, Tab to the linked words, Enter (twice in the column: a
  // preview first) opens the page in a new tab.
  await jump(page, "On how tides work");
  await keys(page, "l");
  const sec = page.locator(".node.open", { hasText: "pulled by the Moon" }).last();
  await expect(sec.locator(".lmark.l-url")).toHaveText("↗");
  await keys(page, "Tab");
  expect(await state(page, (s) => s.snap.nodes[s.focus.node].body.slice(s.focus.range?.[0], s.focus.range?.[1]))).toBe("pulled by the Moon");
  for (let i = 0; i < 2 && !(await page.evaluate(() => (globalThis as any).__opened.length)); i++) await keys(page, "Enter");
  expect(await page.evaluate(() => (globalThis as any).__opened)).toEqual(["https://example.org/research/tides"]);
});

test("an ordinary request that asks to look something up uses the web too", async ({ page }) => {
  await open(page);
  await jump(page, "The tree underneath");
  await command(page, "look up neap tides");
  await expect(page.locator(".agent-panel .agent-steps")).toContainText("searched “look up neap tides”");
  await expect(page.locator(".agent-panel")).toHaveAttribute("data-agent", "done");
  await idle(page);
  await keys(page, "Escape");
});

test("Esc stops a research run, and nothing it did is kept", async ({ page }) => {
  await open(page);
  await jump(page, "The tree underneath");
  const before = await state(page, (s) => Object.keys(s.snap.nodes).length);
  await command(page, "/research stop me");
  const panel = page.locator(".agent-panel");
  await expect(panel.locator(".agent-steps")).toContainText("searched “stop me”");
  await keys(page, "Escape");
  await expect(page.locator(".status .message")).toContainText("stopped; nothing it did was kept");
  await expect(panel).toHaveAttribute("data-agent", "done");
  await expect(panel.locator(".agent-summary")).toHaveText("Stopped. Nothing it did was kept.");
  await idle(page);
  expect(await state(page, (s) => Object.keys(s.snap.nodes).length)).toBe(before);
  expect(await state(page, (s) => Object.values(s.snap.nodes).some((n: any) => n.title === "On stop me"))).toBe(false);
  await keys(page, "Escape");
  await expect(panel).toHaveCount(0);
});
