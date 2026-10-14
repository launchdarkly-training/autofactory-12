/**
 * Demo frontend (Node / Express). Serves a tiny page and the status contract.
 *   GET /api/status -> { service, version }   (version = deployed SHA)
 *   GET /          -> a page that fetches the backend greeting
 *
 * The backend status line is gated by the multivariate flag
 * "enable-backend-status": "v1" renders it, anything else (including an
 * unreachable LaunchDarkly) falls back to "control", the pre-existing page.
 */

import express from "express";
import { pathToFileURL } from "node:url";
import { init } from "@launchdarkly/node-server-sdk";

const SHA = process.env.RAILWAY_GIT_COMMIT_SHA || "dev";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

export const FLAG_KEY = "enable-backend-status";
export const LD_CONTEXT = { kind: "user", key: "demo-user" };
export const BEACON_PATH = "/internal/backend-status";

/**
 * Build the LaunchDarkly client, or null when LD is unavailable — callers then
 * take the control path.
 */
export async function initLdClient(sdkKey = process.env.LD_SDK_KEY) {
  if (!sdkKey) return null;
  let client = null;
  try {
    client = init(sdkKey);
    await client.waitForInitialization({ timeout: 5 });
    return client;
  } catch {
    if (client) {
      try {
        await client.close();
      } catch {
        /* nothing useful to do if shutdown also fails */
      }
    }
    return null;
  }
}

/** Telemetry must never be able to fail a request. */
function safeTrack(ldClient, eventKey, metricValue) {
  if (!ldClient) return;
  try {
    ldClient.track(eventKey, LD_CONTEXT, undefined, metricValue);
  } catch {
    /* a dropped guarded-release event is not worth a 500 */
  }
}

async function resolveVariation(ldClient) {
  if (!ldClient) return "control";
  try {
    const value = await ldClient.variation(FLAG_KEY, LD_CONTEXT, "control");
    return typeof value === "string" ? value : "control";
  } catch {
    return "control";
  }
}

function renderPage({ showBackendStatus }) {
  const statusElement = showBackendStatus
    ? `
  <p id="backend-status">Checking backend status…</p>`
    : "";
  const statusFetch = showBackendStatus
    ? `
    function reportBackendStatus(outcome) {
      try { navigator.sendBeacon("${BEACON_PATH}", JSON.stringify({ outcome: outcome })); } catch (e) {}
    }
    fetch("${BACKEND_URL}/api/status")
      .then(r => r.json())
      .then(d => { document.getElementById("backend-status").textContent =
        "Backend online: " + d.service + " version " + d.version; reportBackendStatus("ok"); })
      .catch(() => { document.getElementById("backend-status").textContent = "Backend offline"; reportBackendStatus("error"); });`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Auto-Factory Demo</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto">
  <h1>LaunchDarkly Auto-Factory — Demo</h1>
  <p>Frontend deployed SHA: <code>${SHA}</code></p>
  <p id="greeting">Loading greeting from backend…</p>${statusElement}
  <script>
    fetch("${BACKEND_URL}/api/greeting")
      .then(r => r.json())
      .then(d => { document.getElementById("greeting").textContent =
        d.greeting + "  (new-greeting flag: " + d.flag_new_greeting + ")"; })
      .catch(() => { document.getElementById("greeting").textContent = "backend unavailable"; });${statusFetch}
  </script>
</body></html>`;
}

export function createApp({ ldClient = null } = {}) {
  const app = express();

  app.get("/api/status", (_req, res) => {
    res.json({ service: "demo-frontend", version: SHA });
  });

  app.get("/", async (_req, res) => {
    const startedAt = Date.now();
    const variation = await resolveVariation(ldClient);
    res.type("html").send(renderPage({ showBackendStatus: variation === "v1" }));
    // Tracked on BOTH variations so the guarded release has a real comparison.
    safeTrack(ldClient, "enable-backend-status-latency", Date.now() - startedAt);
  });

  // Only the v1 page beacons here: the status fetch runs in the browser, where
  // the server SDK cannot see its outcome.
  app.post(BEACON_PATH, express.text({ type: "*/*", limit: "1kb" }), (req, res) => {
    let outcome;
    try {
      outcome = JSON.parse(req.body)?.outcome;
    } catch {
      outcome = undefined;
    }
    if (outcome === "ok") {
      safeTrack(ldClient, "enable-backend-status-success");
    } else if (outcome === "error") {
      safeTrack(ldClient, "enable-backend-status-error-rate");
    }
    res.status(204).end();
  });

  return app;
}

// process.argv[1] is undefined under `node --input-type=module -e ...`.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const ldClient = await initLdClient();
  const port = process.env.PORT || 3000;
  createApp({ ldClient }).listen(port, () => console.log(`demo-frontend on :${port}`));
}
