// Vercel の入口。Hono のアプリを default export する（public/ の画面は Vercel の CDN が配信する）
// Vercel entrypoint: default-export the Hono app (Vercel's CDN serves public/ itself)
import { Hono } from "hono";
import { createApp } from "./app.js";
import { resolveRuntimeDeps } from "./runtime.js";

const app = new Hono();
app.route("/", createApp(resolveRuntimeDeps));

export default app;
