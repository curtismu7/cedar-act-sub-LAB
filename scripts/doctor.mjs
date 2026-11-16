#!/usr/bin/env node
// Preflight: netguard self-test, health, the mock door behaves as written, Real is refused, reset works.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// Netguard self-test: every route out is refused and recorded (rule 1).
const ng = await import(new URL("../server/src/netguard.js", import.meta.url));
const ngResult = await ng.netguardSelfTest();
ok(`netguard self-test (${ngResult.blocked}/8 routes blocked)`, ngResult.ok, ngResult.ok ? "" : ngResult.detail);

// Use a doctor-only port so the check never collides with a running lab.
const PORT = Number(process.env.DOCTOR_PORT || 17819);
const base = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ["server/src/index.js"], {
  env: { ...process.env, PORT: String(PORT), LAB_ALLOWED_HOSTS: `localhost:${PORT},127.0.0.1:${PORT}` },
  stdio: "ignore"
});

const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body || {}) });

try {
  let healthy = false;
  for (let i = 0; i < 40 && !healthy; i++) {
    await sleep(250);
    try { healthy = (await fetch(`${base}/api/health`)).status === 200; } catch { /* not up yet */ }
  }
  ok("server healthy", healthy);

  const healthRes = await fetch(`${base}/api/health`);
  const health = await healthRes.json();
  ok("health contract demo-health/1: schema, state ready, runtime offline, no-store", health.schema === "demo-health/1" && health.state === "ready" && health.runtime === "offline" && health.demo?.id === "cedar-act-sub-lab" && healthRes.headers.get("cache-control") === "no-store");
  ok("API answers carry a W3C traceparent", /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(healthRes.headers.get("traceparent") || ""));
  const missing = await fetch(`${base}/api/nope`);
  const missingBody = await missing.json().catch(() => null);
  ok("an unknown API route is a JSON error, not an HTML page", missing.status === 404 && missingBody?.error === "not_found" && typeof missingBody?.message === "string");

  const info = await (await fetch(`${base}/api/info`)).json();
  ok("info reports mock, Real unavailable with a reason", info.source === "mock" && info.realAvailable === false && /npm run real/.test(info.realReason));

  const base1 = await (await post("/api/run", { scenario: "step-1-baseline" })).json();
  ok("baseline: both tools allowed", base1.calls.length === 2 && base1.calls.every((c) => c.http === 200));

  const same = await (await post("/api/run", { scenario: "step-3-same-token" })).json();
  ok("the run shows the raw mock token, labelled mock", same.token?.mock === true && /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(same.token.token));
  const [count, list] = same.calls;
  ok("same token: CountTool allowed", count.tool === "CountTool" && count.http === 200);
  ok("same token: ListIndexTool refused with the policy reason", list.tool === "ListIndexTool" && list.http === 400 && /action denied by policy: ListIndexTool requires act\.sub to be agent-b-example/.test(list.reason));

  const removed = await (await post("/api/run", { scenario: "step-4-remove" })).json();
  ok("policies removed: back to baseline", removed.calls.every((c) => c.http === 200));

  const real = await post("/api/mode", { source: "real" });
  ok("real mode refused 409", real.status === 409);

  await post("/api/reset", {});
  const runs = await (await fetch(`${base}/api/runs`)).json();
  ok("reset clears runs", runs.runs.length === 0);
} finally {
  server.kill();
}

console.log(failures ? `doctor: ${failures} FAIL` : "doctor: all checks PASS");
process.exit(failures ? 1 : 0);
