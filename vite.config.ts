import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import topLevelAwait from "vite-plugin-top-level-await";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  plugins: [preact(), wasm(), topLevelAwait()],
  build: { target: "es2022", chunkSizeWarningLimit: 6000 },
  test: { include: ["tests/**/*.test.ts"] },
});
