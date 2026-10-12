/**
 * Demo frontend (Node / Express). Serves a tiny page and the status contract.
 *   GET /api/status -> { service, version }   (version = deployed SHA)
 *   GET /          -> a page that fetches the backend greeting
 *
 * The backend-status line on the page is gated by the LaunchDarkly flag
 * "enable-backend-status": "control" (the fail-safe default) renders the page
 * exactly as it was before, "v1" adds the status line.
 */

import express from "express";
import { pathToFileURL } from "node:url";

const SHA = process.env.RAILWAY_GIT_COMMIT_SHA || "dev";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

export const FLAG_KEY = "enable-backend-status";
const LD_CONTEXT = { kind: "user", key: "demo-user" };

/**
 * Lazily initialize the LaunchDarkly client (or return null if unavailable).
 * Mirrors the backend's convention: without LD_SDK_KEY the app still runs and
 * every flag falls back to its control variation.
 */
export async function initLdClient() {
  const sdkKey = process.env.LD_SDK_KEY;
  if (!sdkKey) return null;
  let client = null;
  try {
    const { init } = await import("@launchdarkly/node-server-sdk");
    client = init(sdkKey);
    await client.waitForInitialization({ timeout: 5 });
    return client;
  } catch {
    // Degrade without LD rather than block the page; don't leak the client.
    if (client) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
    return null;
  }
}

async function evaluateVariation(ldClient) {
  if (!ldClient) return "control";
  try {
    const value = await ldClient.variation(FLAG_KEY, LD_CONTEXT, "control");
    return typeof value === "string" ? value : "control";
  } catch {
    return "control";
  }
}

function renderPage({ sha, backendUrl, showBackendStatus }) {
  const statusParagraph = showBackendStatus
    ? `\n  <p id="backend-status">Checking backend status…</p>`
    : "";
  const statusScript = showBackendStatus
    ? `
    fetch("${backendUrl}/api/status")
      .then(r => r.json())
      .then(d => { document.getElementById("backend-status").textContent =
        "Backend online: " + d.service + " version " + d.version; })
      .catch(() => { document.getElementById("backend-status").textContent = "Backend offline"; });`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Auto-Factory Demo</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto">
  <h1>LaunchDarkly Auto-Factory — Demo</h1>
  <p>Frontend deployed SHA: <code>${sha}</code></p>
  <p id="greeting">Loading greeting from backend…</p>${statusParagraph}
  <script>
    fetch("${backendUrl}/api/greeting")
      .then(r => r.json())
      .then(d => { document.getElementById("greeting").textContent =
        d.greeting + "  (new-greeting flag: " + d.flag_new_greeting + ")"; })
      .catch(() => { document.getElementById("greeting").textContent = "backend unavailable"; });${statusScript}
  </script>
</body></html>`;
}

export function createApp({ ldClient = null, sha = SHA, backendUrl = BACKEND_URL } = {}) {
  const app = express();

  app.get("/api/status", (_req, res) => {
    res.json({ service: "demo-frontend", version: sha });
  });

  app.get("/", async (_req, res) => {
    const variation = await evaluateVariation(ldClient);
    const showBackendStatus = variation === "v1";
    res.type("html").send(renderPage({ sha, backendUrl, showBackendStatus }));
  });

  return app;
}

async function main() {
  const ldClient = await initLdClient();
  const app = createApp({ ldClient });
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`demo-frontend on :${port}`));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
