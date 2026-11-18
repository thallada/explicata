/**
 * Pictures and videos in article text, against the mock Wikipedia and the mock web (EX_WIKI=mock,
 * EX_PAGES=mock): a Wikipedia picture comes through the app's own image route and a click opens
 * its File page, which credits it; a video is a still with a play mark that loads nothing from
 * elsewhere until it is clicked, and then becomes a <video> with the checked source, or the
 * privacy-enhanced YouTube player (Vimeo's for Vimeo) in a sandboxed frame. Nothing here touches
 * the network: the browser's requests elsewhere are refused (matched by host, since the app's own
 * requests name other sites in their query), so a click only shows the address it would load.
 */
import { expect, test, type Page } from "@playwright/test";
import { WEB, settle, wide } from "./helpers";

/** Open in the next pane, as following a link does. */
const follow = (page: Page, ref: object) => page.evaluate((r) => (globalThis as any).__ie.follow(r), ref);

/** Record what would open in a new tab instead of opening it. */
const recordOpens = (page: Page) =>
  page.addInitScript(() => {
    (globalThis as any).__opened = [];
    window.open = ((url: string) => ((globalThis as any).__opened.push(String(url)), null)) as typeof window.open;
  });
const opened = (page: Page) => page.evaluate(() => (globalThis as any).__opened as string[]);

/** Every request the page makes to a host other than the app's own. */
function outside(page: Page): string[] {
  const out: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.hostname !== "localhost" && u.protocol !== "data:" && u.protocol !== "blob:") out.push(r.url());
  });
  return out;
}

const YOUTUBE_ID = "Wx7bQk2pL9a"; // server/pageMock.ts MOCK_YOUTUBE_ID
const VIMEO_ID = "123456789";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ context }) => {
  await context.route((u) => /(^|\.)(wikipedia\.org|wikimedia\.org|youtube\.com|youtube-nocookie\.com|youtu\.be|ytimg\.com|vimeo\.com|example\.(org|com|net))$/.test(u.hostname), (r) => r.abort());
});

test.afterEach(({ page }) => settle(page));

test("a Wikipedia article's pictures come through the app's image route, captioned; a click opens the picture's File page; the infobox's picture opens the lead", async ({ page }) => {
  await recordOpens(page);
  const away = outside(page);
  await wide(page);
  await follow(page, { kind: "wiki", title: "Grey heron", lang: "en" });
  const art = page.locator(".wiki-pane").last();
  await expect(art.locator(".wiki-head h2")).toHaveText("Grey heron");
  const lead = art.locator(".wiki > .wiki-text");
  const fig = lead.locator("figure").first();
  await expect(fig.locator("figcaption")).toHaveText("An adult at a weir");
  const img = fig.locator("img");
  expect(await img.getAttribute("src")).toBe(`/api/wiki/media?u=${encodeURIComponent("https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/Grey_heron_at_the_weir.jpg/500px-Grey_heron_at_the_weir.jpg")}`);
  await img.scrollIntoViewIfNeeded();
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth)).toBe(1);
  // No wider than the pane's text, nor taller than most of the window.
  expect((await img.boundingBox())!.width).toBeLessThanOrEqual((await lead.boundingBox())!.width + 0.5);
  expect(await img.evaluate((el) => getComputedStyle(el).maxHeight)).toBe(`${0.7 * 1080}px`);
  // The caption is the lead's first text; the paragraph follows; no infobox, no flag.
  await expect(lead.locator("p.wpara").first()).toContainText("The grey heron (Ardea cinerea) is a long-legged wading bird");
  expect(await art.locator(".wiki-text table, .wiki-text img[src*='Flag']").count()).toBe(0);
  // The attribution says where the credit is.
  await expect(art.locator(".wattr")).toContainText("each picture is credited on its own file page");
  await img.click();
  expect(await opened(page)).toEqual(["https://en.wikipedia.org/wiki/File:Grey_heron_at_the_weir.jpg"]);
  expect(away).toEqual([]);
});

test("a Wikipedia video plays only when clicked: before, a still through the image route and nothing from elsewhere; after, a <video> with the checked source, no autoplay; its File page is linked", async ({ page }) => {
  const away = outside(page);
  await wide(page);
  await follow(page, { kind: "wiki", title: "Grey heron", lang: "en" });
  const art = page.locator(".wiki-pane").last();
  await art.locator(".wrow .row", { hasText: "Behaviour" }).dispatchEvent("click");
  const sec = page.locator(".wiki-pane").last();
  await expect(sec.locator(".wiki-head .wsub")).toHaveText(" › Behaviour");
  const fig = sec.locator(".wiki-text figure.video");
  await expect(fig.locator("figcaption")).toHaveText("A heron taking off from the weir");
  const still = fig.locator(".video-box img");
  expect(await still.getAttribute("src")).toMatch(/^\/api\/wiki\/media\?u=https%3A%2F%2Fupload\.wikimedia\.org%2F/);
  await still.scrollIntoViewIfNeeded();
  await expect.poll(() => still.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);
  await expect(fig.locator(".video-play")).toBeVisible();
  await expect(fig.locator("a.video-credit")).toHaveAttribute("href", "https://en.wikipedia.org/wiki/File:Heron_takes_off.webm");
  await expect(fig.locator("a.video-credit")).toHaveAttribute("target", "_blank");
  expect(await page.locator("video, iframe").count()).toBe(0);
  await page.waitForTimeout(300);
  expect(away).toEqual([]);

  const before = await page.locator(".wiki-pane").count();
  await fig.locator(".video-box").click();
  const video = fig.locator("video");
  await expect(video).toHaveCount(1);
  const panes = await page.locator(".wiki-pane").count();
  expect(await video.evaluate((v: HTMLVideoElement) => ({ src: v.getAttribute("src"), controls: v.controls, preload: v.getAttribute("preload"), autoplay: v.hasAttribute("autoplay"), loop: v.loop, muted: v.muted }))).toEqual({
    src: "https://upload.wikimedia.org/wikipedia/commons/transcoded/b/b2/Heron_takes_off.webm/Heron_takes_off.webm.480p.vp9.webm",
    controls: true,
    preload: "none",
    autoplay: false,
    loop: false,
    muted: false,
  });
  // Its still stays as its poster, through the image route.
  expect(await video.getAttribute("poster")).toMatch(/^\/api\/wiki\/media\?u=https%3A%2F%2Fupload\.wikimedia\.org%2F/);
  // The click was the video's alone: no pane opened or closed, nothing selected.
  expect(panes).toBe(before);
  expect(await page.evaluate(() => (globalThis as any).__ie.aux?.grain ?? null)).toBeNull();
  // What loads from elsewhere after the click is the video file (the page's CSP lets it; the test refuses it), and nothing else.
  await expect.poll(() => away.some((u) => u.startsWith("https://upload.wikimedia.org/wikipedia/commons/transcoded/b/b2/Heron_takes_off.webm/"))).toBe(true);
  await expect.poll(() => away.filter((u) => !u.startsWith("https://upload.wikimedia.org/wikipedia/commons/transcoded/b/b2/Heron_takes_off.webm/"))).toEqual([]);
});

test("a web page's YouTube and Vimeo players are stills until clicked, then the privacy-enhanced player in a sandboxed frame; its <video> plays its own file; an unknown frame stays a link", async ({ page }) => {
  const away = outside(page);
  await wide(page);
  await follow(page, { kind: "url", url: WEB.videos });
  const web = page.locator(".wiki-pane.web").last();
  await expect(web.locator(".wiki-head h2")).toHaveText("Films from the weir");
  const text = web.locator(".wiki-text");
  await expect(text.locator("figure.video")).toHaveCount(4);
  await expect(text.locator("a", { hasText: "Embedded content from maps.example.net ↗" })).toHaveAttribute("href", "https://maps.example.net/embed?pb=weir");
  const yt = text.locator(`figure.video[data-embed="youtube"][data-id="${YOUTUBE_ID}"]`);
  const still = yt.locator(".video-box img");
  expect(await still.getAttribute("src")).toBe(`/api/page/media?u=${encodeURIComponent(`https://i.ytimg.com/vi/${YOUTUBE_ID}/hqdefault.jpg`)}`);
  await still.scrollIntoViewIfNeeded();
  await expect.poll(() => still.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);
  // 16:9, within the pane.
  const box = (await yt.locator(".video-box").boundingBox())!;
  expect(Math.abs(box.width / box.height - 16 / 9)).toBeLessThan(0.02);
  expect(box.width).toBeLessThanOrEqual((await web.locator(".wiki > .wiki-text").boundingBox())!.width + 0.5);
  expect(await page.locator("video, iframe").count()).toBe(0);
  await page.waitForTimeout(300);
  expect(away).toEqual([]);

  await yt.locator(".video-box").click();
  const frame = yt.locator("iframe");
  await expect(frame).toHaveCount(1);
  expect(await frame.evaluate((f: HTMLIFrameElement) => Object.fromEntries([...f.attributes].map((a) => [a.name, a.value])))).toEqual({
    src: `https://www.youtube-nocookie.com/embed/${YOUTUBE_ID}`,
    title: "Video from YouTube",
    sandbox: "allow-scripts allow-same-origin allow-presentation",
    allow: "fullscreen; picture-in-picture",
    referrerpolicy: "no-referrer",
  });

  const vimeo = text.locator(`figure.video[data-embed="vimeo"]`);
  await vimeo.locator(".video-box").scrollIntoViewIfNeeded();
  await vimeo.locator(".video-box").click();
  await expect(vimeo.locator("iframe")).toHaveAttribute("src", `https://player.vimeo.com/video/${VIMEO_ID}`);

  const file = text.locator(`figure.video[data-video="https://media.example.org/weir.mp4"]`);
  await file.locator(".video-box").scrollIntoViewIfNeeded();
  await file.locator(".video-box").click();
  const video = file.locator("video");
  await expect(video).toHaveCount(1);
  expect(await video.evaluate((v: HTMLVideoElement) => [v.getAttribute("src"), v.controls, v.getAttribute("preload"), v.hasAttribute("autoplay"), v.loop, v.muted, v.getAttribute("width"), v.getAttribute("height")])).toEqual([
    "https://media.example.org/weir.mp4",
    true,
    "none",
    false,
    false,
    false,
    "640",
    "360",
  ]);
  // The players and the file clicked were asked for (the page's CSP lets them; the test refuses them), and nothing else.
  for (const start of [`https://www.youtube-nocookie.com/embed/${YOUTUBE_ID}`, `https://player.vimeo.com/video/${VIMEO_ID}`, "https://media.example.org/weir.mp4"]) {
    await expect.poll(() => away.some((u) => u.startsWith(start)), start).toBe(true);
  }
  for (const u of away) expect(u).toMatch(new RegExp(`^(https://www\\.youtube-nocookie\\.com/embed/${YOUTUBE_ID}|https://player\\.vimeo\\.com/video/${VIMEO_ID}|https://media\\.example\\.org/weir\\.mp4)`));
});
