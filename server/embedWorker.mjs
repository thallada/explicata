// The embedding model in a worker thread (see workerLoader in embed.ts), so a long batch never
// holds up the server's event loop. Plain JavaScript, so it runs without a TypeScript loader.
import { parentPort, workerData } from "node:worker_threads";

const { id, pooling, cacheDir, offline, threads } = workerData;
let extractor;
try {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = cacheDir;
  // Offline: read the files downloaded before from the cache directory as local models.
  env.allowLocalModels = !!offline;
  if (offline) (env.allowRemoteModels = false), (env.localModelPath = cacheDir);
  extractor = await pipeline("feature-extraction", id, {
    dtype: "q8",
    device: "cpu",
    session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
  });
  parentPort.postMessage({ ready: true });
} catch (e) {
  parentPort.postMessage({ failed: String(e?.message ?? e) });
}

parentPort.on("message", async ({ n, texts }) => {
  try {
    const out = await extractor(texts, { pooling, normalize: true });
    const buf = new Float32Array(out.data);
    parentPort.postMessage({ n, dims: out.dims, buf }, [buf.buffer]);
  } catch (e) {
    parentPort.postMessage({ n, error: String(e?.message ?? e) });
  }
});
