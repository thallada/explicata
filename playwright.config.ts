import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

// EX_E2E_PORT lets two runs go side by side.
const PORT = Number(process.env.EX_E2E_PORT ?? 4760);
// Each run gets an empty data directory, so it starts from a freshly seeded library.
const data = process.env.EX_E2E_DATA ?? mkdtempSync(join(tmpdir(), "ie-e2e-"));
process.env.EX_E2E_DATA = data;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  // The page starts in the column (`/view column`): auto would show panes at this width. A test of
  // the panes view sets its own width and lets the layout follow it (helpers.ts `autoLayout`).
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    storageState: { cookies: [], origins: [{ origin: `http://localhost:${PORT}`, localStorage: [{ name: "ie:settings", value: JSON.stringify({ view: "column" }) }] }] },
  },
  webServer: {
    // The production build with the deterministic mock model: what is measured is the app's
    // own pipeline, not a model's speed.
    // Each port builds into its own directory: two runs side by side must not rebuild the files the
    // other is serving.
    command: `npx vite build --outDir dist-e2e-${PORT} --emptyOutDir && npx tsx server/index.ts`,
    env: { EX_DIST: `dist-e2e-${PORT}`, EX_PROD: "1", EX_LLM: "mock", EX_MOCK_DELAY: "10", EX_DATA: data, PORT: String(PORT), EX_USER: "tester", EX_WIKI: "mock", EX_EMBED: "fake", EX_WIKI_MOCK_BULK_MS: "60" },
    url: `http://localhost:${PORT}/api/state`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
