/**
 * A large library in the browser: 100 more documents of 50 nodes each (over 5,000 nodes in all),
 * written over the op API. Keypress → paint is measured as in the other specs, while moving
 * through the library page, inside documents and across them, in the column and in panes, and
 * between four forks of the library pane, each three panes deep; a body edit is timed from the
 * store call to the painted frame. Runs last: it fills the shared library.
 */
import { expect, test, type Page } from "@playwright/test";
import { idle, state, synced, writeReport, type Sample } from "./helpers";

const ready = (page: Page) => page.waitForFunction(() => (globalThis as any).__ie?.ready === true, undefined, { timeout: 30_000 });
/** One keystroke per frame, as in the other latency tests. */
const paced = async (page: Page, seq: string) => {
  for (const k of seq.split(" ")) {
    await page.keyboard.press(k);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  }
};
const SENTENCE = "This sentence is about something that matters here. Another follows it, with a few more words. ";

/** Edit a leaf's body through the store, and time it to the painted frame. */
const editTimes = (page: Page, rounds: number) =>
  page.evaluate(async (rounds) => {
    const s = (globalThis as any).__ie;
    const paint = () => new Promise<void>((r) => requestAnimationFrame(() => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => r();
      ch.port2.postMessage(0);
    }));
    const out: number[] = [];
    for (let i = 0; i < rounds; i++) {
      const t = performance.now();
      s.startEdit("body");
      s.commitEdit(`Edited in the large library, round ${i}. ` + s.snap.nodes[s.focus.node].body);
      await paint();
      out.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 30));
    }
    return out;
  }, rounds);

const stats = (ms: number[]) => {
  const sorted = [...ms].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return { n: sorted.length, median: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1), max: +sorted[sorted.length - 1].toFixed(1) };
};
const keySamples = async (page: Page) => (await state(page, (s) => s.samples as Sample[])).filter((x) => x.what !== "first-token").map((x) => x.ms);

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

test("a library of over 5,000 nodes in 100 more documents: keypress → paint and a body edit, in the column and in panes", async ({ page, request }) => {
  // Write the documents, one commit each, as an outside agent would.
  const tree = await (await request.get("/api/tree")).json();
  let t = Date.now();
  for (let d = 0; d < 100; d++) {
    const ops: any[] = [{ op: "create", parent: tree.root, title: `Scale document ${d}`, body: SENTENCE.repeat(3) }];
    let n = 1;
    for (let s = 0; s < 7; s++) {
      const sec = n++;
      ops.push({ op: "create", parent: "$0", title: `Part ${d}.${s}`, body: SENTENCE.repeat(2) });
      for (let k = 0; k < 6; k++, n++) ops.push({ op: "create", parent: `$${sec}`, title: `Leaf ${d}.${s}.${k}`, body: SENTENCE.repeat(2) });
    }
    ops.push({ op: "create", parent: "$0", kind: "note", quote: "something that matters", body: "A note." });
    for (let i = 0; i < n; i++) ops.push({ op: "bless", id: `$${i}` });
    const res = await request.post("/api/ops", { data: { author: "scale", message: `Scale document ${d}`, ops } });
    expect(res.ok()).toBe(true);
  }
  const written = Date.now() - t;

  // Boot: a fresh page fetches the whole library and reads it.
  t = Date.now();
  await page.goto("/");
  await ready(page);
  const bootFresh = Date.now() - t;
  const nodes = await state(page, (s) => Object.keys(s.snap.nodes).length);
  expect(nodes).toBeGreaterThan(5000);
  await synced(page);
  // And again, from the replica this browser now keeps.
  t = Date.now();
  await page.reload();
  await ready(page);
  const bootStored = Date.now() - t;
  await page.evaluate(() => document.fonts.ready);

  // ---- the column ----
  await page.evaluate(() => ((globalThis as any).__ie.samples.length = 0));
  // Down the library page's 113 rows, into documents and out, across to the next.
  for (let i = 0; i < 40; i++) await paced(page, "j");
  for (let i = 0; i < 6; i++) await paced(page, "l j l j l i j Escape h h h j");
  await paced(page, "O");
  const column = stats(await keySamples(page));
  // A body edit inside a document deep in the library.
  await page.goto("/doc/scale-document-97");
  await ready(page);
  await paced(page, "j l j");
  const columnEdit = stats(await editTimes(page, 15));

  // ---- panes ----
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await ready(page);
  await expect(page.locator(".strip > .pane")).toHaveCount(1);
  await page.evaluate(() => ((globalThis as any).__ie.samples.length = 0));
  for (let i = 0; i < 40; i++) await paced(page, "j");
  for (let i = 0; i < 6; i++) await paced(page, "l l l j l i j Escape h h h j");
  const panes = stats(await keySamples(page));

  // ---- forks: four documents opened side by side from the library pane, each three panes deep (document, part, leaf) ----
  await page.goto("/doc/scale-document-90");
  await ready(page);
  await paced(page, "l l l l");
  for (let d = 1; d < 4; d++) await paced(page, "h h j Shift+Enter l l l l");
  await idle(page);
  // The twelve panes' Related lists are fetched as they are first drawn: let them arrive, so what is timed is moving between forks.
  await page.waitForTimeout(1000);
  const depths = await state(page, (s) => s.tree.kids.map((k: any) => {
    let depth = 0;
    for (let n = k; n; n = n.kids[n.pick]) depth++;
    return depth;
  }));
  expect(depths).toEqual([3, 3, 3, 3]);
  await page.evaluate(() => ((globalThis as any).__ie.samples.length = 0));
  for (let i = 0; i < 8; i++) await paced(page, "[ [ [ ] ] ]");
  const forks = stats(await keySamples(page));
  await page.goto("/doc/scale-document-98");
  await ready(page);
  await paced(page, "l l j");
  const panesEdit = stats(await editTimes(page, 15));

  const report = { nodes, documents: await state(page, (s) => s.snap.nodes[s.snap.root].children.length), writtenMs: written, bootFreshMs: bootFresh, bootStoredMs: bootStored, column, columnEdit, panes, panesEdit, forks };
  console.log("large library:", JSON.stringify(report));
  writeReport("scale", report);
  for (const r of [column, panes]) {
    expect(r.n).toBeGreaterThan(80);
    expect(r.p95).toBeLessThan(50);
  }
  expect(forks.n).toBeGreaterThanOrEqual(40);
  expect(forks.p95).toBeLessThan(50);
  for (const r of [columnEdit, panesEdit]) expect(r.median).toBeLessThan(50);
  expect(bootStored).toBeLessThan(10_000);
});
