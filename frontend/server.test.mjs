import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApp, FLAG_KEY, LD_CONTEXT, OUTCOME_PATH } from "./server.mjs";

const SERVER_SOURCE = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
const MANIFEST = JSON.parse(
  readFileSync(new URL("../.release-flags/shift-2-refresh-greeting.json", import.meta.url), "utf8"),
);

/**
 * Records every SDK interaction. `variation` honours the `defaultValue`
 * argument the way the real SDK does for an absent flag, which is what makes
 * the fail-safe-default test meaningful instead of vacuous.
 */
function recordingClient({ value, throws = false, trackThrows = false } = {}) {
  const calls = { variation: [], track: [] };
  return {
    calls,
    client: {
      variation: async (key, context, defaultValue) => {
        calls.variation.push({ key, context, defaultValue });
        if (throws) throw new Error("LaunchDarkly unreachable");
        return value === undefined ? defaultValue : value;
      },
      track: (key, context, data, metricValue) => {
        calls.track.push({ key, context, metricValue });
        if (trackThrows) throw new Error("event pipeline down");
      },
    },
  };
}

async function withServer(ldClient, fn) {
  const server = createApp({ ldClient }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    return await fn(`http://localhost:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const getPage = (ldClient) => withServer(ldClient, async (base) => (await fetch(base + "/")).text());

const postOutcome = (ldClient, body) =>
  withServer(ldClient, (base) =>
    fetch(base + OUTCOME_PATH, {
      method: "POST",
      body,
      headers: { "Content-Type": "text/plain" },
    }),
  );

const TREATMENT_MARKERS = ['id="refresh"', "Refresh greeting", "loadGreeting", "reportRefresh", "sendBeacon"];

function assertIsControlPage(html) {
  for (const marker of TREATMENT_MARKERS) {
    assert.ok(!html.includes(marker), `control page must not contain ${marker}`);
  }
  assert.ok(!html.includes(OUTCOME_PATH), "control page must not reference the beacon route");
  assert.ok(html.includes('<p id="greeting">Loading greeting from backend…</p>'));
  assert.ok(html.includes('fetch("http://localhost:8000/api/greeting")'));
}

function assertIsTreatmentPage(html) {
  for (const marker of TREATMENT_MARKERS) {
    assert.ok(html.includes(marker), `v1 page must contain ${marker}`);
  }
  assert.ok(html.includes('<button id="refresh" type="button">Refresh greeting</button>'));
  assert.ok(html.includes(`navigator.sendBeacon("${OUTCOME_PATH}"`));
  assert.ok(html.includes('addEventListener("click"'));
  assert.ok(html.includes('<p id="greeting">Loading greeting from backend…</p>'));
}

// ---------------------------------------------------------------- control path

test("control: no LaunchDarkly client serves the existing page", async () => {
  assertIsControlPage(await getPage(null));
});

test("control: flag serving 'control' serves the existing page", async () => {
  const { client } = recordingClient({ value: "control" });
  assertIsControlPage(await getPage(client));
});

test("control: an unknown future variation falls back to the existing page", async () => {
  const { client } = recordingClient({ value: "v2" });
  assertIsControlPage(await getPage(client));
});

test("control: non-string variation values fall back to the existing page", async () => {
  for (const value of [true, 1, null, { v: "v1" }, ["v1"]]) {
    const { client } = recordingClient({ value });
    assertIsControlPage(await getPage(client));
  }
});

test("control: a throwing evaluation falls back to the existing page", async () => {
  const { client } = recordingClient({ throws: true });
  assertIsControlPage(await getPage(client));
});

test("control: an absent flag takes the 'control' default, evaluated with the right key and context", async () => {
  // The stub returns defaultValue, like the real SDK does for an unknown flag,
  // so flipping the fail-safe default in server.mjs fails this test.
  const { client, calls } = recordingClient();
  assertIsControlPage(await getPage(client));
  assert.equal(calls.variation.length, 1);
  assert.equal(calls.variation[0].key, "enable-greeting-refresh");
  assert.equal(calls.variation[0].defaultValue, "control");
  assert.deepEqual(calls.variation[0].context, { kind: "user", key: "demo-user" });
});

// -------------------------------------------------------------- treatment path

test("v1: the refresh button, its listener, and the outcome beacon are rendered", async () => {
  const { client } = recordingClient({ value: "v1" });
  assertIsTreatmentPage(await getPage(client));
});

test("v1: the page keeps the deployed SHA and greeting markup the control page has", async () => {
  const { client } = recordingClient({ value: "v1" });
  const html = await getPage(client);
  assert.ok(html.includes("<h1>LaunchDarkly Auto-Factory — Demo</h1>"));
  assert.ok(html.includes("Frontend deployed SHA:"));
});

test("both variations leave GET /api/status untouched", async () => {
  for (const value of ["control", "v1"]) {
    const { client } = recordingClient({ value });
    const body = await withServer(client, async (base) => (await fetch(base + "/api/status")).json());
    assert.deepEqual(body, { service: "demo-frontend", version: "dev" });
  }
});

// -------------------------------------------------------- latency (two-armed)

test("latency is emitted once per render on BOTH variations, as a finite number", async () => {
  for (const value of ["control", "v1"]) {
    const { client, calls } = recordingClient({ value });
    await getPage(client);
    const latency = calls.track.filter((c) => c.key === "enable-greeting-refresh-latency");
    assert.equal(latency.length, 1, `${value} must emit exactly one latency event`);
    assert.ok(Number.isFinite(latency[0].metricValue), "latency must carry a numeric value");
    assert.ok(latency[0].metricValue >= 0);
    assert.deepEqual(latency[0].context, { kind: "user", key: "demo-user" });
  }
});

// ---------------------------------------------------------------- beacon route

test("beacon: outcome 'ok' emits exactly one success event", async () => {
  const { client, calls } = recordingClient({ value: "v1" });
  const res = await postOutcome(client, '{"outcome":"ok"}');
  assert.equal(res.status, 204);
  assert.deepEqual(
    calls.track.map((c) => c.key),
    ["enable-greeting-refresh-success"],
  );
  assert.equal(calls.track[0].metricValue, undefined, "an occurrence event carries no metric value");
  assert.deepEqual(calls.track[0].context, { kind: "user", key: "demo-user" });
});

test("beacon: outcome 'error' emits exactly one error event", async () => {
  const { client, calls } = recordingClient({ value: "v1" });
  const res = await postOutcome(client, '{"outcome":"error"}');
  assert.equal(res.status, 204);
  assert.deepEqual(
    calls.track.map((c) => c.key),
    ["enable-greeting-refresh-error"],
  );
});

test("beacon: unrecognized or malformed bodies emit nothing and never 4xx", async () => {
  for (const body of ['{"outcome":"bogus"}', "not json", "", "null", "[]", '{"outcome":null}', '{"other":1}']) {
    const { client, calls } = recordingClient({ value: "v1" });
    const res = await postOutcome(client, body);
    assert.equal(res.status, 204, `body ${JSON.stringify(body)} should be accepted silently`);
    assert.deepEqual(calls.track, [], `body ${JSON.stringify(body)} must emit no event`);
  }
});

test("beacon: a client-supplied numeric cannot reach the metric value", async () => {
  const { client, calls } = recordingClient({ value: "v1" });
  await postOutcome(client, '{"outcome":"ok","elapsedMs":999999}');
  assert.deepEqual(
    calls.track.map((c) => c.key),
    ["enable-greeting-refresh-success"],
  );
  assert.equal(calls.track[0].metricValue, undefined);
});

// ------------------------------------------------------------------- telemetry

test("a failing track() never fails the request on either route", async () => {
  const { client } = recordingClient({ value: "v1", trackThrows: true });
  const page = await withServer(client, (base) => fetch(base + "/"));
  assert.equal(page.status, 200);
  const beacon = await postOutcome(client, '{"outcome":"error"}');
  assert.equal(beacon.status, 204);
});

test("no LaunchDarkly client emits no events at all", async () => {
  const { calls } = recordingClient();
  await getPage(null);
  await postOutcome(null, '{"outcome":"ok"}');
  assert.deepEqual(calls.track, []);
});

// --------------------------------------------- pin the literals Phase 2 reads

test("flag key, context, and event keys are literals that match the release manifest", () => {
  assert.equal(FLAG_KEY, "enable-greeting-refresh");
  assert.deepEqual(LD_CONTEXT, { kind: "user", key: "demo-user" });
  assert.equal(OUTCOME_PATH, "/api/greeting-refresh-outcome");

  assert.equal(MANIFEST.flagKey, "enable-greeting-refresh");
  assert.equal(MANIFEST.targetVariation, "v1");
  assert.deepEqual(MANIFEST.releasePlan.metricKeys, [
    "enable-greeting-refresh-error-rate",
    "enable-greeting-refresh-latency",
    "enable-greeting-refresh-success-rate",
  ]);
  assert.equal(MANIFEST.releasePlan.randomizationUnit, "user");

  // Each event key must appear in the source as a quoted literal: the release
  // tooling and LaunchDarkly code references find metrics by grepping for it.
  for (const eventKey of [
    "enable-greeting-refresh-error",
    "enable-greeting-refresh-latency",
    "enable-greeting-refresh-success",
  ]) {
    assert.ok(
      SERVER_SOURCE.includes(`"${eventKey}"`),
      `${eventKey} must appear as a quoted literal in server.mjs`,
    );
  }
  assert.ok(SERVER_SOURCE.includes('"enable-greeting-refresh"'));
});

test("the treatment is gated by an exact string comparison, not a boolean helper", () => {
  assert.ok(SERVER_SOURCE.includes('=== "v1"'), "the quoted target variation must be compared exactly");
  assert.ok(
    !/\b(isEnabled|is_enabled|useFlag|Boolean\(\s*(await\s*)?\w*[Vv]ariation)/.test(SERVER_SOURCE),
    "a multivariate flag must never be read through a boolean helper",
  );
});
