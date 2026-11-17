/**
 * Every starter file in library/ parses and builds. A failure names the file, the line, the
 * section and the quote, all of them at once, so the files can be fixed in one pass.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FormatError } from "../src/core/format";
import { Doc, descendants, isStale } from "../src/core/model";
import { writeText } from "../src/core/seed";
import { slugify } from "../src/core/text";

const dir = new URL("../library/", import.meta.url);
const files = (() => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
})();

describe("library", () => {
  it("parses and builds every file into one library, with nothing stale", () => {
    const failures: string[] = [];
    const lib = Doc.library("test");
    for (const f of files) {
      const id = f.slice(0, -3);
      if (slugify(id) !== id) failures.push(`${f}: the file name is not a valid id (lowercase letters, digits, hyphens); it would be imported as "${slugify(id)}"`);
      try {
        const id = writeText(lib, readFileSync(new URL(f, dir), "utf8"), f);
        const snap = lib.snap();
        const stale = [id, ...descendants(snap, id)].filter((n) => isStale(snap, n));
        if (stale.length) failures.push(`${f}: ${stale.length} nodes start out stale`);
        if (!snap.nodes[id].title) failures.push(`${f}: the file has no title`);
      } catch (err) {
        if (!(err instanceof FormatError)) throw err;
        failures.push(...err.problems);
      }
    }
    console.log(`library: ${files.length} files, ${failures.length} problems${failures.length ? `\n  ${failures.join("\n  ")}` : ""}`);
    expect(failures).toEqual([]);
  });
});
