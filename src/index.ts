// Vercel の入口。Hono のアプリを default export する（画面も API も、このアプリが返す）
// Vercel entrypoint: default-export the Hono app (it serves both the screens and the API).
import { Hono } from "hono";
import { createApp } from "./routes.js";
import { resolveRuntimeDeps } from "./runtime.js";

const app = new Hono();
app.route("/", createApp(resolveRuntimeDeps));

export default app;
