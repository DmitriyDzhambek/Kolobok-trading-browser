import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const marketApi = require("./api/market.js");
const newsApi = require("./api/news.js");

// Adapts a Vercel-style (req, res) handler to connect middleware so the very
// same serverless code answers /api requests during `vite dev`.
function devApiHandler(handler) {
  return async (req, res, next) => {
    try {
      const parsed = new URL(req.originalUrl || req.url, "http://127.0.0.1");
      req.query = Object.fromEntries(parsed.searchParams.entries());
      res.status = code => { res.statusCode = code; return res; };
      res.json = body => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(body));
        return res;
      };
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

function kolobokDevApi() {
  return {
    name: "kolobok-dev-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/market", devApiHandler(marketApi));
      server.middlewares.use("/api/news", devApiHandler(newsApi));
    }
  };
}

export default defineConfig({
  plugins: [react(), kolobokDevApi()],
  // Relative base lets dist/index.html work from any subfolder, including the
  // VS Code Live Server document root.
  base: "./",
  server: {
    host: "127.0.0.1",
    // Live Server usually owns 5500; with strictPort off Vite moves to the next
    // free port instead of failing with a blank page.
    port: 5500,
    strictPort: false,
    cors: true
  },
  preview: { host: "127.0.0.1", port: 5500, strictPort: false }
});