// Vercel entry: wraps the Express app from the compiled server.
import { loadConfig } from "../dist/config.js";
import { createHttpApp } from "../dist/http.js";

let appPromise;

export default async function handler(req, res) {
  appPromise ??= createHttpApp(loadConfig());
  const app = await appPromise;
  return app(req, res);
}
