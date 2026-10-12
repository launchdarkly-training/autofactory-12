import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FLAG_KEY, TELEMETRY_PATH, createApp } from "./server.mjs";

const SHA = "test-sha";
const BACKEND = "http://backend.test";

/** Records every evaluation and event so tests can assert on the arguments. */
function recorder({ value, throws = false, trackThrows = false } = {}) {
  const calls = { variation: [], track: [] };
  return {
    calls,
    client: {
      variation: async (key, context, defaultValue) => {
        calls.variation.push({ key, context, defaultValue });
        if (throws) throw new Error("LaunchDarkly unreachable");
        return value;
      },
      track: (key, context, data, metricValue) => {
        calls.track.push({ key, context, metricValue });
        if (trackThrows) throw new Error("event buffer full");
      },
    },
  };
}

/**
 * Behaves like the real SDK when the flag does not exist: it returns whatever
 * default the caller passed. This is what makes the fail-safe default
 * observable — a stub with a hardcoded return value cannot catch a regression
 * there.
 */
function sdkLikeMissingFlag() {
  const calls = { variation: [], track: [] };
  return {
    calls,
    client: {
      variation: async (key, context, defaultValue) => {
        calls.variation.push({ key, context, defaultValue });
        return defaultValue;
      },
      track: (key, context, data, metricValue) => {
        calls.track.push({ key, context, metricValue });
      },
    },
  };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function app(ldClient) {
  return createApp({ ldClient, sha: SHA, backendUrl: BACKEND });
}

async function render(ldClient) {
  return withServer(app(ldClient), async (base) => (await fetch(`${base}/`)).text());
}

async function beacon(ldClient, body) {
  return withServer(app(ldClient), async (base) => {
    const res = await fetch(base + TELEMETRY_PATH, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
    });
    return res.status;
  });
}

const hasStatusLine = (html) => html.includes('<p id="backend-status">');
const hasStatusFetch = (html) => html.includes(`${BACKEND}/api/status`);

// --- control path -----------------------------------------------------------

test("control: no LaunchDarkly client renders the page without the status line", async () => {
  const html = await render(null);
  assert.ok(!hasStatusLine(html));
  assert.ok(!hasStatusFetch(html));
  assert.ok(html.includes('<p id="greeting">'), "existing greeting is untouched");
});

test('control: the "control" variation renders the pre-flag page', async () => {
  const { client } = recorder({ value: "control" });
  const html = await render(client);
  assert.ok(!hasStatusLine(html));
  assert.ok(!hasStatusFetch(html));
});

test("control: an unknown future variation falls back to control", async () => {
  const { client } = recorder({ value: "v2" });
  assert.ok(!hasStatusLine(await render(client)));
});

test("control: a non-string variation value falls back to control", async () => {
  const { client } = recorder({ value: true });
  assert.ok(!hasStatusLine(await render(client)));
});

test("control: a throwing LaunchDarkly client falls back to control", async () => {
  const { client } = recorder({ throws: true });
  assert.ok(!hasStatusLine(await render(client)));
});

test("control: an SDK that only knows the default value serves control", async () => {
  const { client, calls } = sdkLikeMissingFlag();
  const html = await render(client);
  assert.ok(!hasStatusLine(html), "an absent flag must not expose the treatment");
  assert.equal(calls.variation.length, 1);
  assert.equal(calls.variation[0].defaultValue, "control", "fail-safe default must be control");
});

test("control: the page emits no telemetry beacon", async () => {
  const { client } = recorder({ value: "control" });
  const html = await render(client);
  assert.ok(!html.includes("sendBeacon"));
  assert.ok(!html.includes(TELEMETRY_PATH));
});

// --- v1 path ----------------------------------------------------------------

test('v1: the "v1" variation renders the backend status line', async () => {
  const { client } = recorder({ value: "v1" });
  const html = await render(client);
  assert.ok(hasStatusLine(html));
  assert.ok(hasStatusFetch(html));
  assert.ok(html.includes("Backend online: "));
  assert.ok(html.includes("Backend offline"));
});

test("v1: the status line is added without disturbing the greeting", async () => {
  const { client } = recorder({ value: "v1" });
  const html = await render(client);
  assert.ok(html.includes(`${BACKEND}/api/greeting`));
  assert.ok(html.indexOf('<p id="greeting">') < html.indexOf('<p id="backend-status">'));
});

test("v1: the page beacons its outcome back to the telemetry route", async () => {
  const { client } = recorder({ value: "v1" });
  const html = await render(client);
  assert.ok(html.includes(`navigator.sendBeacon("${TELEMETRY_PATH}"`));
  assert.ok(html.includes('report("ok")'));
  assert.ok(html.includes('report("error")'));
});

// --- evaluation mechanics ---------------------------------------------------

test("the flag is evaluated by its literal key, on the repo's context, defaulting to control", async () => {
  const { client, calls } = recorder({ value: "v1" });
  await render(client);
  assert.equal(calls.variation.length, 1);
  assert.deepEqual(calls.variation[0], {
    key: "enable-backend-status",
    context: { kind: "user", key: "demo-user" },
    defaultValue: "control",
  });
});

test("the status contract endpoint is unaffected by the flag", async () => {
  for (const value of ["control", "v1"]) {
    const { client } = recorder({ value });
    const body = await withServer(app(client), async (base) =>
      (await fetch(`${base}/api/status`)).json(),
    );
    assert.deepEqual(body, { service: "demo-frontend", version: SHA });
  }
});

// --- guarded-release telemetry ----------------------------------------------

test("latency is reported on BOTH variations, so the comparison is two-armed", async () => {
  for (const value of ["control", "v1"]) {
    const { client, calls } = recorder({ value });
    await render(client);
    const latency = calls.track.filter((c) => c.key === "enable-backend-status-latency");
    assert.equal(latency.length, 1, `expected one latency event on ${value}`);
    assert.equal(typeof latency[0].metricValue, "number");
    assert.ok(latency[0].metricValue >= 0);
    assert.deepEqual(latency[0].context, { kind: "user", key: "demo-user" });
  }
});

test('a beacon reporting "ok" emits the success event', async () => {
  const { client, calls } = recorder({ value: "v1" });
  assert.equal(await beacon(client, JSON.stringify({ outcome: "ok" })), 204);
  assert.deepEqual(
    calls.track.map((c) => c.key),
    ["enable-backend-status-success"],
  );
});

test('a beacon reporting "error" emits the killswitch event', async () => {
  const { client, calls } = recorder({ value: "v1" });
  assert.equal(await beacon(client, JSON.stringify({ outcome: "error" })), 204);
  assert.deepEqual(
    calls.track.map((c) => c.key),
    ["enable-backend-status-error"],
  );
});

test("the telemetry route ignores payloads it does not understand", async () => {
  for (const body of ["not json", JSON.stringify({ outcome: "bogus" }), "", "[]", "null"]) {
    const { client, calls } = recorder({ value: "v1" });
    assert.equal(await beacon(client, body), 204, `status for ${JSON.stringify(body)}`);
    assert.deepEqual(calls.track, [], `no event for ${JSON.stringify(body)}`);
  }
});

test("a telemetry failure never breaks the request", async () => {
  const { client } = recorder({ value: "v1", trackThrows: true });
  const html = await render(client);
  assert.ok(hasStatusLine(html));
  assert.equal(await beacon(client, JSON.stringify({ outcome: "error" })), 204);
});

// --- the release contract ---------------------------------------------------

test("the literal flag and event keys match the release manifest", () => {
  const source = readFileSync(fileURLToPath(new URL("./server.mjs", import.meta.url)), "utf8");
  const manifest = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../.release-flags/shift-1-backend-status.json", import.meta.url)),
      "utf8",
    ),
  );

  assert.equal(FLAG_KEY, "enable-backend-status");
  assert.equal(manifest.flagKey, "enable-backend-status");
  assert.equal(manifest.targetVariation, "v1");
  assert.ok(source.includes('"v1"'), "the target variation is compared as a literal");
  assert.ok(source.includes('"enable-backend-status"'));

  assert.deepEqual(manifest.releasePlan.metricKeys, [
    "enable-backend-status-error-rate",
    "enable-backend-status-latency",
    "enable-backend-status-success-rate",
  ]);
  assert.equal(manifest.releasePlan.randomizationUnit, "user");

  // Metric event keys must be greppable literals in the source (M12).
  for (const eventKey of [
    "enable-backend-status-error",
    "enable-backend-status-latency",
    "enable-backend-status-success",
  ]) {
    assert.ok(source.includes(`"${eventKey}"`), `${eventKey} must appear as a quoted literal`);
  }
});
