// ローカル実行の入口。Vercel と違い、画面（public/）もこのサーバーが配信する
// Local entrypoint. Unlike Vercel, this server also serves the screens in public/.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApp } from "./app.js";
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

// vercel.json の headers と同じ内容 / Mirrors the headers in vercel.json
app.use("*", async (c, next) => {
  await next();
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
});

app.route("/", createApp(resolveRuntimeDeps));
app.get("/admin", serveStatic({ path: "./public/admin.html" }));
app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port }, () => {
  console.log(`参加者の画面: http://localhost:${port}/`);
  console.log(`講師の画面:   http://localhost:${port}/admin`);
});
