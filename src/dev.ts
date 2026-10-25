// ローカル実行の入口。Vercel の入口（src/index.ts）と同じアプリを、Node のサーバーで動かす
// Local entrypoint: runs the same app as the Vercel entrypoint (src/index.ts) on a Node server.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createApp } from "./routes.js";
import { ConfigError } from "./config.js";
import { resolveRuntimeDeps } from "./runtime.js";

try {
  const { config, store } = resolveRuntimeDeps();
  console.log(`provider=${config.provider} model=${config.model} storage=${store.kind} maxTurns=${config.maxTurns}`);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error("設定に問題があります / Invalid configuration:");
    for (const problem of error.problems) console.error(`  - ${problem}`);
    console.error(".env.example を .env にコピーして値を入れてください / Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
  throw error;
}

const app = new Hono();
app.route("/", createApp(resolveRuntimeDeps));

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port }, () => {
  console.log(`参加者の画面: http://localhost:${port}/`);
  console.log(`講師の画面:   http://localhost:${port}/admin`);
});
