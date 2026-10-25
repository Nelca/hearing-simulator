import { defaultLogSink, type Deps } from "./routes.js";
import { ConfigError, loadConfig } from "./config.js";
import { createProvider } from "./providers/index.js";
import { createStore } from "./store/index.js";

let cached: Deps | ConfigError | undefined;

/** 環境変数から部品を組み立てる。1つのプロセスで1回だけ / Builds dependencies from env vars, once per process */
export function resolveRuntimeDeps(): Deps {
  if (cached instanceof ConfigError) throw cached;
  if (cached) return cached;

  try {
    const config = loadConfig();
    const store = createStore();
    cached = { config, store, provider: createProvider(config), logs: defaultLogSink(config, store) };
    return cached;
  } catch (error) {
    if (error instanceof ConfigError) cached = error;
    throw error;
  }
}
