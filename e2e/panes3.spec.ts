/**
 * The panes view: a click anywhere in a pane makes it active and anywhere clears a
 * selection; a column's panes stand in the order of their sources; every pane in a crowded column
 * shows at least its tab, above or below; the active pane is never cut short by its share of a
 * column; a pane cut off for any reason peeks out whole; the curves
 * keep to their sources and landing lines through every kind of layout change (curveFaults); the
 * selection bar keeps clear of a tab; a dotted curve turns toward its source; Alt with h j k l moves
 * between panes. Same build, mock model and mock Wikipedia as the others.
 */
import { expect, test, type Page } from "@playwright/test";
import { clickOpen, curveFaults, keys, library, noFaults, pane, seedLinks, settle, state, still } from "./helpers";

const TAB = 30;
const activeTitle = (page: Page) => page.locator(".pane.active").evaluate((p) => p.querySelector(".pane-head h2, .top h1, .wiki-head h2")?.textContent?.trim() ?? "");
const colTitles = (page: Page, i: number) =>
  page.evaluate((i) => [...document.querySelectorAll(".strip > .col")[i].querySelectorAll(":scope > .pane")].map((p) => p.querySelector(".pane-head h2, .top h1, .wiki-head h2")?.textContent?.trim() ?? ""), i);

test.use({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ request }) => {
  await seedLinks(request);
});
test.beforeEach(async ({ context }) => {
  await context.route(/wikipedia\.org|wikimedia\.org|stanford\.edu|example\.org/, (r) => r.abort());
});
test.afterEach(({ page }) => settle(page));

test("a column's panes stand in the order of their sources: opened from a row higher up, a pane stands higher", async ({ page }) => {
  await library(page);
  await clickOpen(page, "Library", "Octopus minds");
  await clickOpen(page, "Library", "Explicata");
  await expect.poll(() => colTitles(page, 1)).toEqual(["Explicata", "Octopus minds"]);
  await clickOpen(page, "Library", "Fixed points");
  await expect.poll(() => colTitles(page, 1)).toEqual(["Explicata", "Fixed points", "Octopus minds"]);
  // Kept with the view.
  await page.reload();
  await page.waitForSelector(".strip .pane");
  expect(await colTitles(page, 1)).toEqual(["Explicata", "Fixed points", "Octopus minds"]);
  await noFaults(page, "after a reload");
});

test("a click anywhere in a pane that is not text, a row or a link makes that pane the active one; anywhere at all clears a selection, and so does Esc", async ({ page }) => {
  await library(page);
  await clickOpen(page, "Library", "Fixed points");
  await clickOpen(page, "Fixed points", "The idea itself");
  for (const t of ["Library", "Fixed points", "The idea itself", "Library", "The idea itself", "Fixed points"]) {
    const p = pane(page, t);
    /** A grid of points over the pane; those that fall on nothing that acts. */
    const spots = () =>
      p.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const out: { x: number; y: number }[] = [];
        for (let i = 1; i < 12; i++)
          for (let j = 1; j < 12; j++) {
            const x = r.left + (r.width * i) / 12;
            const y = r.top + (r.height * j) / 12;
            const hit = document.elementFromPoint(x, y) as HTMLElement | null;
            if (!hit || !el.contains(hit) || hit.closest("[data-node], [data-row], a, button, [role=button], [data-more], [data-linking], [data-related], [data-target], [data-wrow], .pane-ctl, .grip, .tabline, .spine, [data-wtext], .lnk, .anchor")) continue;
            out.push({ x: x - r.left, y: y - r.top });
          }
        return out;
      });
    const n = (await spots()).length;
    expect(n, t).toBeGreaterThan(3);
    for (let k = 0; k < Math.min(6, n); k++) {
      // Away first, so each click is a change; then the point, measured where the pane is now.
      const other = t === "Library" ? "Fixed points" : "Library";
      await pane(page, other).locator(".pane-head h2, .top h1").first().dispatchEvent("click");
      await still(page);
      const s = (await spots())[k];
      if (!s) continue;
      const b = (await p.boundingBox())!;
      await page.mouse.click(b.x + s.x, b.y + s.y);
      await expect.poll(() => activeTitle(page), `${t} at ${Math.round(s.x)},${Math.round(s.y)}`).toBe(t);
    }
  }
  // A selection goes on a click elsewhere: in another pane's margin, on the top bar, and with Esc.
  const bar = page.locator(".selbar");
  const select = async () => {
    await pane(page, "The idea itself").locator(".pane-body .para").first().click({ position: { x: 40, y: 10 } });
    await expect(bar).toBeVisible();
  };
  await select();
  const lib = (await pane(page, "Library").boundingBox())!;
  await page.mouse.click(lib.x + lib.width - 12, lib.y + lib.height - 20);
  await expect(bar).toHaveCount(0);
  expect(await activeTitle(page)).toBe("Library");
  expect(await state(page, (s) => s.focus.grain)).toBe("node");
  await select();
  const top = (await page.locator(".docbar").boundingBox())!;
  await page.mouse.click(top.x + top.width / 2, top.y + top.height / 2);
  await expect(bar).toHaveCount(0);
  await select();
  await keys(page, "Escape");
  await expect(bar).toHaveCount(0);
  expect(await state(page, (s) => s.focus.grain)).toBe("node");
});

test("every pane of a crowded column shows at least its tab, above or below the one looked at; tabs line up with the active rule; curves stay on their sources and lines", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 700 });
  await library(page);
  for (const t of ["Octopus minds", "Explicata", "The tides", "Fixed points", "What a proof is"]) await clickOpen(page, "Library", t);
  // The one looked at near the top: those below it stack at the column's foot.
  await pane(page, "Explicata").locator(".pane-head h2").dispatchEvent("click");
  await still(page);
  for (const first of ["Explicata", "What a proof is"]) {
    if (first !== "Explicata") {
      await pane(page, first).locator(".pane-head h2").dispatchEvent("click");
      await still(page);
    }
    const shown = await page.evaluate(() => {
      const col = [...document.querySelectorAll<HTMLElement>(".strip > .col")][1];
      const c = col.getBoundingClientRect();
      const ps = [...col.querySelectorAll<HTMLElement>(":scope > .pane")];
      return ps.map((p, i) => {
        const r = p.getBoundingClientRect();
        const next = ps[i + 1]?.getBoundingClientRect().top ?? Infinity;
        return { t: p.querySelector(".pane-head h2, .top h1")?.textContent?.trim(), shown: Math.min(next, c.bottom) - Math.max(r.top, c.top) };
      });
    });
    for (const s of shown) expect(s.shown, `${first} looked at: ${s.t}`).toBeGreaterThanOrEqual(TAB - 1);
    await noFaults(page, `${first} looked at`);
  }
  // A folded tab's title is centred between the rule over the pane and the tab's foot; on the active pane, under its heavy rule.
  const centred = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".strip .pane[data-covered], .strip .pane[data-scrolled]")].map((p) => {
      const r = p.getBoundingClientRect();
      const t = p.querySelector<HTMLElement>(".tabline .tabtitle")!.getBoundingClientRect();
      const a = getComputedStyle(p, "::after");
      const rule = parseFloat(a.borderTopWidth) || parseFloat(a.height) || 0;
      return { active: p.classList.contains("active"), off: Math.abs((t.top + t.bottom) / 2 - (r.top + rule + r.top + 29) / 2) };
    }),
  );
  expect(centred.length).toBeGreaterThan(0);
  for (const c of centred) expect(c.off).toBeLessThanOrEqual(1.5);
  // The curve becomes a tab's line where it meets it: no stub of it before the meeting.
  const stubs = await page.evaluate(() =>
    [...document.querySelectorAll<SVGPathElement>(".curves path:not(.foot):not(.frame)")].filter((p) => {
      const pe = document.querySelector<HTMLElement>(`.pane[data-tid="${p.dataset.to}"]`);
      return pe?.dataset.ruled?.includes("tab") && (p.getAttribute("d")!.match(/M/g) ?? []).length > 1;
    }).length,
  );
  expect(stubs).toBe(0);
});

test("the active pane is never cut short by its share of a column: the others give way, folding to their tabs, as its Wikipedia card arrives; once the active pane is elsewhere, the column shares again", async ({ page }) => {
  await library(page);
  await clickOpen(page, "Library", "Octopus minds");
  await clickOpen(page, "Octopus minds", "A separate experiment");
  await clickOpen(page, "Octopus minds", "A body with many minds");
  await clickOpen(page, "A body with many minds", "Counting neurons");
  // A definition beside it, active: its line and then, once it has arrived, the article's card.
  await clickOpen(page, "A separate experiment", "cephalopod", ".lnk, .anchor");
  await page.mouse.move(5, 500);
  /** The panes of the column holding Counting neurons: what each needs, its height, what shows of it. */
  const column = () =>
    pane(page, "Counting neurons").evaluate((el) => {
      const col = el.parentElement!;
      const c = col.getBoundingClientRect();
      const ps = [...col.querySelectorAll<HTMLElement>(":scope > .pane")];
      return {
        crowded: col.classList.contains("crowded"),
        h: c.height,
        panes: ps.map((p, i) => {
          const r = p.getBoundingClientRect();
          const sc = getComputedStyle(p.querySelector(".pane-scroll")!);
          return {
            t: p.querySelector(".pane-head h2, .top h1")?.textContent?.trim(),
            active: p.classList.contains("active"),
            height: r.height,
            shown: Math.min(ps[i + 1]?.getBoundingClientRect().top ?? Infinity, c.bottom) - Math.max(r.top, c.top),
            need: p.querySelector<HTMLElement>(".pane-body")!.offsetHeight + parseFloat(sc.paddingTop) + parseFloat(sc.paddingBottom),
          };
        }),
      };
    });
  /** The active pane shows all it needs, up to the column less a tab for each other pane; every other pane shows at least its tab. */
  const whole = async (label: string) => {
    await still(page);
    await expect
      .poll(async () => {
        const c = await column();
        const a = c.panes.find((p) => p.active)!;
        return a.shown >= Math.min(a.need, c.h - (c.panes.length - 1) * TAB) - 2 && c.panes.every((p) => p.shown >= TAB - 1);
      }, label)
      .toBe(true);
  };
  await whole("the definition active");
  let c = await column();
  expect(c.panes.map((p) => p.t)).toEqual(["“cephalopod”", "Counting neurons"]);
  // Its card is in (it needs more than half the column, which an even share would give it), and the column stacks to show it whole.
  expect(c.panes[0].need).toBeGreaterThan(c.h / 2);
  expect(c.crowded).toBe(true);
  await noFaults(page, "the definition active");
  // The other pane active: it is the one shown whole.
  await pane(page, "Counting neurons").locator(".pane-head h2").dispatchEvent("click");
  await whole("Counting neurons active");
  // The active pane in another column: this one shares its height as before, each pane what it needs or an even share.
  await pane(page, "A body with many minds").locator(".pane-head h2").dispatchEvent("click");
  await still(page);
  c = await column();
  expect(c.crowded).toBe(false);
  for (const p of c.panes) expect(p.height, p.t).toBeGreaterThanOrEqual(Math.min(p.need, c.h / 2) - 2);
  await noFaults(page, "the active pane elsewhere");
});

test("a pane cut off for any reason peeks out whole, across and down, and the curves follow it: covered from below or above, by its share, by the column's foot, beside a pinned pane, and with its column covered", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 700 });
  await library(page);
  for (const t of ["Octopus minds", "Explicata", "The tides", "Fixed points"]) await clickOpen(page, "Library", t);
  /** Hover each pane of the top-level trees' column that is cut off, and check it comes out whole, and the curves with it. */
  const sweep = async (label: string, across: boolean) => {
    const col = page.locator(".strip > .col").nth(1);
    const n = await col.locator(":scope > .pane").count();
    let peeked = 0;
    for (let i = 0; i < n; i++) {
      const p = col.locator(":scope > .pane").nth(i);
      const info = await p.evaluate((el) => {
        const c = el.parentElement!.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const next = (el.nextElementSibling as HTMLElement | null)?.getBoundingClientRect().top ?? Infinity;
        const sc = getComputedStyle(el.querySelector(".pane-scroll")!);
        const need = el.querySelector<HTMLElement>(".pane-body")!.offsetHeight + parseFloat(sc.paddingTop) + parseFloat(sc.paddingBottom);
        const top = Math.max(r.top, c.top);
        const bottom = Math.min(r.bottom, next, c.bottom);
        // A point on what shows of it, clear of the pin and x.
        return { cut: bottom - top < Math.min(need, c.height) - 4, x: Math.max(r.left, c.left) + 14, y: top + Math.min(14, (bottom - top) / 2), colH: c.height, need, title: el.querySelector(".pane-head h2, .top h1")?.textContent?.trim() };
      });
      if (!info.cut && !across) continue;
      await page.mouse.move(info.x, info.y);
      await page.waitForTimeout(450);
      if (!info.cut) {
        await expect(col).toHaveAttribute("data-peek", "");
        continue;
      }
      peeked++;
      await expect(p, `${label}: ${info.title}`).toHaveAttribute("data-peek", "");
      const whole = await p.evaluate((el) => {
        const c = el.parentElement!.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(Math.max(r.left, c.left) + 60, (Math.max(r.top, c.top) + Math.min(r.bottom, c.bottom)) / 2);
        return { h: r.height, inside: r.top >= c.top - 1 && r.bottom <= c.bottom + 1, top: !!hit && el.contains(hit) };
      });
      expect(whole.h, `${label}: ${info.title} height`).toBeGreaterThanOrEqual(Math.min(info.need, info.colH) - 3);
      expect(whole.inside, `${label}: ${info.title} inside its column`).toBe(true);
      expect(whole.top, `${label}: ${info.title} on top`).toBe(true);
      expect(await curveFaults(page), `${label}: ${info.title} peeking`).toEqual([]);
      await page.mouse.move(1910, 690);
      await expect(p).not.toHaveAttribute("data-peek", "");
      await noFaults(page, `${label}: ${info.title} back`);
    }
    return peeked;
  };
  // Covered from below (the one looked at near the top) and from above (near the foot).
  await pane(page, "Explicata").locator(".pane-head h2").dispatchEvent("click");
  await still(page);
  expect(await sweep("top looked at", false)).toBeGreaterThan(0);
  await pane(page, "Octopus minds").locator(".pane-head h2").dispatchEvent("click");
  await still(page);
  expect(await sweep("foot looked at", false)).toBeGreaterThan(0);
  // Beside a pinned pane.
  await pane(page, "The tides").locator(".pane-head h2").dispatchEvent("click");
  await keys(page, "P");
  await still(page);
  expect(await sweep("beside a pinned one", false)).toBeGreaterThan(0);
  await keys(page, "P");
  // Its column covered too: deeper panes push it under; a cut-off pane comes out across and down at once.
  await clickOpen(page, "Fixed points", "The idea itself");
  await clickOpen(page, "The idea itself", "Three questions");
  await still(page);
  const col = page.locator(".strip > .col").nth(1);
  expect(await col.evaluate((c) => c.hasAttribute("data-covered") || !!c.nextElementSibling?.hasAttribute("data-over"))).toBe(true);
  expect(await sweep("column covered", true)).toBeGreaterThan(0);

  // By its share of a column that is not crowded: a tall window, two top-level trees, one longer than its share, the active pane in another column (the active one is never cut short by its share).
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("ie:view:")).forEach((k) => localStorage.removeItem(k)));
  await library(page);
  await clickOpen(page, "Library", "Explicata");
  await clickOpen(page, "Library", "Octopus minds");
  await pane(page, "Library").locator(".top h1").dispatchEvent("click");
  await still(page);
  expect(await page.locator(".strip > .col").nth(1).evaluate((c) => c.classList.contains("crowded"))).toBe(false);
  expect(await sweep("by share", false)).toBeGreaterThan(0);
});

test("the curves keep to their sources and landing lines through every kind of layout change: scrolls, a resize, folding, a drag, an article arriving, a sticky tab", async ({ page }) => {
  await library(page);
  for (const t of ["Explicata", "Fixed points"]) await clickOpen(page, "Library", t);
  await clickOpen(page, "Fixed points", "Recursion without names");
  await noFaults(page, "opened");
  await clickOpen(page, "Recursion without names", "fixed-point combinator", ".lnk, .anchor");
  await expect(pane(page, "Fixed-point combinator").locator(".wrow").first()).toBeVisible();
  await noFaults(page, "article arrived");
  // Scrolls: a pane's text, the strip.
  await pane(page, "Recursion without names").locator(".pane-scroll").evaluate((el) => (el.scrollTop = 120));
  await noFaults(page, "a pane scrolled (sticky tab)");
  await pane(page, "Recursion without names").locator(".pane-scroll").evaluate((el) => (el.scrollTop = 0));
  await noFaults(page, "scrolled back");
  await page.locator(".strip").evaluate((el) => (el.scrollLeft = Math.max(0, el.scrollLeft - 300)));
  await noFaults(page, "the strip scrolled");
  // A resize that folds the top-level trees' column, and back.
  await page.setViewportSize({ width: 1920, height: 520 });
  await noFaults(page, "folded");
  await page.setViewportSize({ width: 1600, height: 900 });
  await noFaults(page, "resized");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await noFaults(page, "unfolded");
  // A drag down the top-level trees' column.
  await page.evaluate(() => {
    const ie = (globalThis as any).__ie;
    const col = ie.paneColumns.get(1);
    ie.reorderPane(col[0].node.id, null);
  });
  await noFaults(page, "dragged");
});

test("the selection bar keeps clear of a pane's tab and of the words it is about", async ({ page }) => {
  await library(page);
  await clickOpen(page, "Library", "Fixed points");
  const p = pane(page, "Fixed points");
  await p.locator(".pane-scroll").evaluate((el) => (el.scrollTop = 160));
  await expect(p).toHaveAttribute("data-scrolled", "");
  // A sentence just under the tab.
  const at = await p.evaluate((el) => {
    const top = el.getBoundingClientRect().top + 30;
    const para = [...el.querySelectorAll<HTMLElement>(".pane-body .para")].find((x) => x.getBoundingClientRect().bottom > top + 12);
    const r = para!.getBoundingClientRect();
    return { x: r.left + 30, y: Math.max(r.top, top) + 8 };
  });
  await page.mouse.click(at.x, at.y);
  const bar = page.locator(".selbar");
  await expect(bar).toBeVisible();
  const b = (await bar.boundingBox())!;
  const tab = (await p.locator(".tabline").boundingBox())!;
  expect(b.y).toBeGreaterThanOrEqual(tab.y + tab.height - 1);
  const words = await page.evaluate(() => [...document.querySelectorAll(".sel")].flatMap((s) => [...s.getClientRects()].map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right }))));
  for (const w of words) expect(b.y >= w.bottom - 1 || b.y + b.height <= w.top + 1, "the bar covers the words").toBe(true);
});

test("a dotted curve to a source out of sight in its pane turns, at its end, toward where the source is", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 560 });
  await library(page);
  await clickOpen(page, "Library", "A mind made of text");
  const lib = pane(page, "Library").locator(".pane-scroll");
  const lead = async () =>
    page.evaluate(() => {
      const p = [...document.querySelectorAll<SVGPathElement>(".curves path:not(.foot):not(.frame)")].find((x) => x.classList.contains("lost"));
      if (!p) return null;
      const a = p.getPointAtLength(0);
      const b = p.getPointAtLength(8);
      return { dy: b.y - a.y };
    });
  // The row below what shows: the curve's end turns down to the pane's foot.
  await lib.evaluate((el) => (el.scrollTop = 0));
  await still(page);
  let l = await lead();
  if (l) expect(l.dy, "turns down").toBeLessThan(0);
  // The row above what shows: it turns up.
  await lib.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await still(page);
  l = await lead();
  expect(l, "a dotted curve").not.toBeNull();
  expect(l!.dy, "turns up").toBeGreaterThan(0);
});

test("Alt with h j k l moves between panes from a node, a selection or an article; left then right comes back; [ ] still go up and down", async ({ page }) => {
  await library(page);
  await clickOpen(page, "Library", "Explicata");
  await clickOpen(page, "Library", "Fixed points");
  await clickOpen(page, "Fixed points", "Recursion without names");
  await pane(page, "Recursion without names").locator(".pane-head h2").dispatchEvent("click");
  await still(page);
  expect(await activeTitle(page)).toBe("Recursion without names");
  await page.keyboard.press("Alt+h");
  await expect.poll(() => activeTitle(page)).toBe("Fixed points");
  await page.keyboard.press("Alt+l");
  await expect.poll(() => activeTitle(page)).toBe("Recursion without names");
  await page.keyboard.press("Alt+h");
  await page.keyboard.press("Alt+k");
  await expect.poll(() => activeTitle(page)).toBe("Explicata");
  await page.keyboard.press("Alt+j");
  await expect.poll(() => activeTitle(page)).toBe("Fixed points");
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => activeTitle(page)).toBe("Explicata");
  await keys(page, "]");
  await expect.poll(() => activeTitle(page)).toBe("Fixed points");
  await page.keyboard.press("Alt+h");
  await expect.poll(() => activeTitle(page)).toBe("Library");
  await page.keyboard.press("Alt+l");
  await expect.poll(() => activeTitle(page)).toBe("Fixed points");
  // From a selected sentence, and from an article.
  await page.keyboard.press("Alt+l");
  await expect.poll(() => activeTitle(page)).toBe("Recursion without names");
  await pane(page, "Recursion without names").locator(".pane-body .para").first().click({ position: { x: 40, y: 10 } });
  expect(await state(page, (s) => s.focus.grain)).toBe("sentence");
  await page.keyboard.press("Alt+h");
  await expect.poll(() => activeTitle(page)).toBe("Fixed points");
  await page.keyboard.press("Alt+l");
  await clickOpen(page, "Recursion without names", "fixed-point combinator", ".lnk, .anchor");
  await expect(pane(page, "Fixed-point combinator").locator(".wrow").first()).toBeVisible();
  await pane(page, "Fixed-point combinator").locator(".wiki-head h2").dispatchEvent("click");
  await expect.poll(() => activeTitle(page)).toBe("Fixed-point combinator");
  await page.keyboard.press("Alt+h");
  await expect.poll(() => activeTitle(page)).toBe("Recursion without names");
  await page.keyboard.press("Alt+l");
  await expect.poll(() => activeTitle(page)).toBe("Fixed-point combinator");
  await noFaults(page, "after moving by keys");
});
