/** server/csp.ts: the page's Content-Security-Policy, exactly, so a loosening shows up as a failing test. */
import { describe, expect, it } from "vitest";
import { CSP } from "../server/csp";

describe("the page's Content-Security-Policy", () => {
  it("lets video files load from https and frames only YouTube's privacy-enhanced player and Vimeo's; nothing else loads from elsewhere", () => {
    expect(CSP).toBe(
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src https:; font-src 'self' data:; connect-src 'self'; frame-src https://www.youtube-nocookie.com https://player.vimeo.com; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
    const d = Object.fromEntries(CSP.split("; ").map((x) => [x.split(" ")[0], x.split(" ").slice(1)]));
    // Images only from the app itself: every picture in article text comes through a media route.
    expect(d["img-src"]).toEqual(["'self'", "data:", "blob:"]);
    expect(d["frame-src"]).toEqual(["https://www.youtube-nocookie.com", "https://player.vimeo.com"]);
    expect(d["media-src"]).toEqual(["https:"]);
    expect(d["script-src"]).not.toContain("'unsafe-inline'");
  });
});
