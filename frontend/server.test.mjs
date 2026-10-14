import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { BEACON_PATH, createApp, FLAG_KEY, LD_CONTEXT } from "./server.mjs";

const SERVER_SOURCE = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
const MANIFEST = JSON.parse(
  readFileSync(new URL("../.release-flags/shift-1-backend-status.json", import.meta.url), "utf8"),
);

/**
 * Records everything the app asks of LaunchDarkly. `variation` honours the
 * caller's default when `value` is undefined, exactly like the real SDK does
 * for an absent flag — that is what makes the fail-safe default testable.
 */
function stubClient({ value, variationThrows = false, trackThrows = false } = {}) {
  const calls = { variation: [], track: [] };
  return {
    calls,
    variation: async (key, context, defaultValue) => {
      calls.variation.push({ key, context, defaultValue });
      if (variationThrows) throw new Error("LaunchDarkly unreachable");
      return value === undefined ? defaultValue : value;
    },
    track: (key, context, data, metricValue) => {
      calls.track.push({ key, context, data, metricValue });
      if (trackThrows) throw new Error("event delivery failed");
    },
  };
}

async function withApp(ldClient, run) {
  const server = createApp({ ldClient }).listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    return await run({
      base,
      page: async () => {
        const res = await fetch(`${base}/`);
        return { status: res.status, body: await res.text() };
      },
      beacon: async (body) => {
        const res = await fetch(base + BEACON_PATH, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body,
        });
        return res.status;
      },
    });
  } finally {
    server.close();
  }
}

test("the flag key, context and event keys are pinned to their literals", () => {
  assert.equal(FLAG_KEY, "enable-backend-status");
  assert.deepEqual(LD_CONTEXT, { kind: "user", key: "demo-user" });
  assert.equal(MANIFEST.flagKey, "enable-backend-status");
  assert.equal(MANIFEST.targetVariation, "v1");

  // Greppability is the contract: LaunchDarkly only resolves literal keys.
  for (const eventKey of [
    "enable-backend-status-latency",
    "enable-backend-status-success",
    "enable-backend-status-error-rate",
  ]) {
    assert.ok(
      SERVER_SOURCE.includes(`"${eventKey}"`),
      `${eventKey} must appear in server.mjs as a quoted literal`,
    );
  }
  assert.ok(
    !/track\(\s*[^"')]*`/.test(SERVER_SOURCE),
    "event keys must never be built with a template literal",
  );
});

test("control renders the pre-existing page", async () => {
  await withApp(null, async ({ page }) => {
    const { status, body } = await page();
    assert.equal(status, 200);
    assert.ok(body.includes('<p id="greeting">'));
    assert.ok(!body.includes("backend-status"));
    assert.ok(!body.includes("/api/status"));
    assert.ok(!body.includes(BEACON_PATH));
  });
});

test("v1 renders the backend status line and its beacon", async () => {
  await withApp(stubClient({ value: "v1" }), async ({ page }) => {
    const { body } = await page();
    assert.ok(body.includes('<p id="backend-status">Checking backend status…</p>'));
    assert.ok(body.includes("/api/status"));
    assert.ok(body.includes('reportBackendStatus("ok")'));
    assert.ok(body.includes('reportBackendStatus("error")'));
    assert.ok(body.includes(BEACON_PATH));
  });
});

test("the flag is evaluated by key, on the rollout context, defaulting to control", async () => {
  const client = stubClient({ value: "v1" });
  await withApp(client, async ({ page }) => {
    await page();
    assert.equal(client.calls.variation.length, 1);
    const [call] = client.calls.variation;
    assert.equal(call.key, "enable-backend-status");
    assert.deepEqual(call.context, { kind: "user", key: "demo-user" });
    assert.equal(call.defaultValue, "control");
  });
});

test("an absent flag falls back to control", async () => {
  // `value: undefined` makes the stub return the caller's default, like the SDK.
  const client = stubClient({});
  await withApp(client, async ({ page }) => {
    const { body } = await page();
    assert.equal(client.calls.variation[0].defaultValue, "control");
    assert.ok(!body.includes("backend-status"));
  });
});

for (const [label, value] of [
  ["an unknown variation", "v2"],
  ["an empty string", ""],
  ["a non-string value", 42],
  ["null", null],
]) {
  test(`${label} falls back to control`, async () => {
    await withApp(stubClient({ value }), async ({ page }) => {
      const { status, body } = await page();
      assert.equal(status, 200);
      assert.ok(!body.includes("backend-status"));
    });
  });
}

test("a failing LaunchDarkly evaluation still serves the control page", async () => {
  await withApp(stubClient({ variationThrows: true }), async ({ page }) => {
    const { status, body } = await page();
    assert.equal(status, 200);
    assert.ok(!body.includes("backend-status"));
  });
});

test("latency is tracked on BOTH variations, so the comparison is two-armed", async () => {
  for (const value of ["control", "v1"]) {
    const client = stubClient({ value });
    await withApp(client, async ({ page }) => {
      await page();
      const latency = client.calls.track.filter(
        (c) => c.key === "enable-backend-status-latency",
      );
      assert.equal(latency.length, 1, `${value} must emit exactly one latency event`);
      assert.ok(Number.isFinite(latency[0].metricValue), "latency needs a numeric value");
      assert.ok(latency[0].metricValue >= 0);
      assert.deepEqual(latency[0].context, LD_CONTEXT);
    });
  }
});

test("a successful status fetch reports a success event with no metric value", async () => {
  const client = stubClient({ value: "v1" });
  await withApp(client, async ({ beacon }) => {
    assert.equal(await beacon(JSON.stringify({ outcome: "ok" })), 204);
    const events = client.calls.track.filter((c) => c.key === "enable-backend-status-success");
    assert.equal(events.length, 1);
    assert.equal(events[0].metricValue, undefined);
    assert.deepEqual(events[0].context, LD_CONTEXT);
  });
});

test("a failed status fetch reports the killswitch error event", async () => {
  const client = stubClient({ value: "v1" });
  await withApp(client, async ({ beacon }) => {
    assert.equal(await beacon(JSON.stringify({ outcome: "error" })), 204);
    assert.deepEqual(
      client.calls.track.map((c) => c.key),
      ["enable-backend-status-error-rate"],
    );
  });
});

test("the beacon ignores anything that is not a known outcome", async () => {
  const client = stubClient({ value: "v1" });
  await withApp(client, async ({ beacon }) => {
    for (const body of [
      "not json",
      "",
      "null",
      "[]",
      JSON.stringify({ outcome: "bogus" }),
      JSON.stringify({ outcome: ["error"] }),
      JSON.stringify({ elapsedMs: 12 }),
    ]) {
      assert.equal(await beacon(body), 204, `body ${JSON.stringify(body)} must not 4xx/5xx`);
    }
    assert.deepEqual(client.calls.track, []);
  });
});

test("the beacon is harmless when LaunchDarkly is unavailable", async () => {
  await withApp(null, async ({ beacon }) => {
    assert.equal(await beacon(JSON.stringify({ outcome: "error" })), 204);
  });
});

test("a telemetry failure never breaks a request", async () => {
  const client = stubClient({ value: "v1", trackThrows: true });
  await withApp(client, async ({ page, beacon }) => {
    assert.equal((await page()).status, 200);
    assert.equal(await beacon(JSON.stringify({ outcome: "ok" })), 204);
  });
});

test("the status contract is unchanged on both variations", async () => {
  for (const ldClient of [null, stubClient({ value: "v1" })]) {
    await withApp(ldClient, async ({ base }) => {
      const res = await fetch(`${base}/api/status`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.service, "demo-frontend");
      assert.equal(typeof body.version, "string");
    });
  }
});
