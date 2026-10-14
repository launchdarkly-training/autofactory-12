/**
 * Demo frontend (Node / Express). Serves a tiny page and the status contract.
 *   GET /api/status -> { service, version }   (version = deployed SHA)
 *   GET /          -> a page that fetches the backend greeting
 *
 * The "Refresh greeting" button is gated by the LaunchDarkly flag
 * `enable-greeting-refresh`. The flag is string-multivariate: `control` serves
 * the pre-existing page (greeting fetched once on load, no button) and `v1`
 * serves the page with the refresh button. Evaluation fails safe to `control`,
 * so an absent SDK key, an unreachable LaunchDarkly, or an absent flag all
 * keep the existing behavior.
 *
 * Guarded-release metrics: page render duration is tracked on BOTH variations
 * (a real two-armed comparison), while refresh outcomes are reported by the v1
 * page through POST /api/greeting-refresh-outcome and are therefore one-armed —
 * a control user has no button to click.
 */

import express from "express";
import { init } from "@launchdarkly/node-server-sdk";
import { pathToFileURL } from "node:url";

const SHA = process.env.RAILWAY_GIT_COMMIT_SHA || "dev";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

export const FLAG_KEY = "enable-greeting-refresh";
export const LD_CONTEXT = { kind: "user", key: "demo-user" };
export const OUTCOME_PATH = "/api/greeting-refresh-outcome";

/**
 * Build the LaunchDarkly client, or return null when LD is unavailable. Mirrors
 * the backend's `_ld()`: never throws, and a null client means every evaluation
 * falls back to `control`.
 */
export async function initLdClient(sdkKey = process.env.LD_SDK_KEY) {
  if (!sdkKey) return null;
  let client;
  try {
    client = init(sdkKey);
    await client.waitForInitialization({ timeout: 5 });
    return client;
  } catch {
    if (client) {
      try {
        await client.close();
      } catch {
        // nothing to do: we are already degrading to control
      }
    }
    return null;
  }
}

async function greetingRefreshVariation(ldClient) {
  if (!ldClient) return "control";
  try {
    const value = await ldClient.variation(FLAG_KEY, LD_CONTEXT, "control");
    return typeof value === "string" ? value : "control";
  } catch {
    return "control";
  }
}

/**
 * Emit a guarded-release event. Event keys are written as literal strings at
 * every call site on purpose: the release tooling and LaunchDarkly code
 * references both find metrics by grepping for the exact key.
 */
function emit(ldClient, eventKey, metricValue) {
  if (!ldClient) return;
  try {
    ldClient.track(eventKey, LD_CONTEXT, undefined, metricValue);
  } catch {
    // telemetry must never fail a request
  }
}

function renderPage({ buttonHtml, scriptBody }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Auto-Factory Demo</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto">
  <h1>LaunchDarkly Auto-Factory — Demo</h1>
  <p>Frontend deployed SHA: <code>${SHA}</code></p>
  <p id="greeting">Loading greeting from backend…</p>
${buttonHtml}  <script>
${scriptBody}  </script>
</body></html>`;
}

function renderControlPage() {
  return renderPage({
    buttonHtml: "",
    scriptBody: `    fetch("${BACKEND_URL}/api/greeting")
      .then(r => r.json())
      .then(d => { document.getElementById("greeting").textContent =
        d.greeting + "  (new-greeting flag: " + d.flag_new_greeting + ")"; })
      .catch(() => { document.getElementById("greeting").textContent = "backend unavailable"; });
`,
  });
}

function renderRefreshPage() {
  return renderPage({
    buttonHtml: `  <button id="refresh" type="button">Refresh greeting</button>\n`,
    scriptBody: `    function reportRefresh(outcome) {
      try { navigator.sendBeacon("${OUTCOME_PATH}", JSON.stringify({ outcome: outcome })); } catch (e) {}
    }
    function loadGreeting(report) {
      document.getElementById("greeting").textContent = "Loading greeting from backend…";
      fetch("${BACKEND_URL}/api/greeting")
        .then(r => r.json())
        .then(d => { document.getElementById("greeting").textContent =
          d.greeting + "  (new-greeting flag: " + d.flag_new_greeting + ")"; if (report) reportRefresh("ok"); })
        .catch(() => { document.getElementById("greeting").textContent = "backend unavailable"; if (report) reportRefresh("error"); });
    }
    loadGreeting(false);
    document.getElementById("refresh").addEventListener("click", function () { loadGreeting(true); });
`,
  });
}

export function createApp({ ldClient = null } = {}) {
  const app = express();

  app.get("/api/status", (_req, res) => {
    res.json({ service: "demo-frontend", version: SHA });
  });

  app.get("/", async (_req, res) => {
    const startedAt = Date.now();
    const variation = await greetingRefreshVariation(ldClient);
    res.type("html").send(variation === "v1" ? renderRefreshPage() : renderControlPage());
    emit(ldClient, "enable-greeting-refresh-latency", Date.now() - startedAt);
  });

  // The v1 page reports each refresh outcome here via navigator.sendBeacon,
  // which posts a Blob — hence text parsing rather than express.json, which
  // would 400 on a malformed body instead of ignoring it.
  app.post(OUTCOME_PATH, express.text({ type: "*/*", limit: "1kb" }), (req, res) => {
    let outcome;
    try {
      outcome = JSON.parse(req.body)?.outcome;
    } catch {
      outcome = undefined;
    }
    if (outcome === "ok") emit(ldClient, "enable-greeting-refresh-success");
    else if (outcome === "error") emit(ldClient, "enable-greeting-refresh-error");
    res.status(204).end();
  });

  return app;
}

// `process.argv[1]` is undefined under `node -e`, which would make
// pathToFileURL throw, so check it before comparing.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const ldClient = await initLdClient();
  const port = process.env.PORT || 3000;
  createApp({ ldClient }).listen(port, () => console.log(`demo-frontend on :${port}`));
}
