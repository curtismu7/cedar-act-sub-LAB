import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { buildServer, readState, runScenario } from "../server/src/index.js";
import { stop, startVerified } from "./test-helpers.js";
import { installNetguard } from "../server/src/netguard.js";
import { createHealth } from "../server/src/health.js";
import express from "express";
import * as pf from "../server/src/pf.js";
import { SCENARIOS, EVIDENCE, MOCK_NOTE, policiesFor, POLICY_A, POLICY_B } from "../server/src/scenarios.js";
import { callTool, cedarText, claimActSub, policyRefuses, actSubPolicy, DOOR_URL, ISSUER, AGENT_A, AGENT_B } from "../server/src/cedar.js";

const HOST = "localhost:7819";
const TRACEPARENT = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;
const JWT = /^eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}$/;

async function withServer(fn) {
  const saved = process.env.LAB_ALLOWED_HOSTS;
  const savedEnv = process.env.REAL_PROBE_ENV;
  process.env.LAB_ALLOWED_HOSTS = "localhost:7819,127.0.0.1:7819";
  // Tests never depend on the owner's .env: pin the real-mode probe to a path that does not exist.
  process.env.REAL_PROBE_ENV = "/nonexistent/.env";
  const srv = buildServer().listen(0, "127.0.0.1");
  await new Promise((r) => srv.on("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (p, b, method = "POST") => {
    const res = await fetch(base + p, {
      method,
      headers: { "content-type": "application/json", ...(method !== "GET" ? { origin: base } : {}) },
      body: method === "GET" ? undefined : JSON.stringify(b || {})
    });
    return { status: res.status, body: await res.json() };
  };
  try { await fn(j, base); } finally {
    await stop(srv);
    if (saved === undefined) delete process.env.LAB_ALLOWED_HOSTS; else process.env.LAB_ALLOWED_HOSTS = saved;
    if (savedEnv === undefined) delete process.env.REAL_PROBE_ENV; else process.env.REAL_PROBE_ENV = savedEnv;
  }
}

// A server built with the given LAB_ALLOWED_HOSTS value (undefined = the server's own default list), and a raw HTTP helper
// that can set Host (fetch cannot be trusted to).
async function withRaw(env, fn, opts = {}) {
  const saved = process.env.LAB_ALLOWED_HOSTS;
  if (env === undefined) delete process.env.LAB_ALLOWED_HOSTS; else process.env.LAB_ALLOWED_HOSTS = env;
  const srv = buildServer(opts).listen(0, "127.0.0.1");
  await new Promise((r) => srv.on("listening", r));
  const port = srv.address().port;
  const raw = (method, path, headers = {}, body) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
  try { await fn(raw, port); } finally {
    await stop(srv);
    if (saved === undefined) delete process.env.LAB_ALLOWED_HOSTS; else process.env.LAB_ALLOWED_HOSTS = saved;
  }
}

const run = async (j, scenario) => (await j("/api/run", { scenario })).body;
const call = (r, tool) => r.calls.find((c) => c.tool === tool);
const REFUSAL_B = "action denied by policy: ListIndexTool requires act.sub to be agent-b-example";
const REFUSAL_A = "action denied by policy: CountTool requires act.sub to be agent-client-example";

// What the shelf reads (demo-shelf-LAB server/src/poller.js parseHealth and docs/health-contract.md), restated here so the test is portable.
const HEALTH_STATES = new Set(["ready", "needs-setup", "broken", "unknown"]);
function parseHealth(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  if (j.schema === undefined) return null;
  if (j.schema !== "demo-health/1") return { state: "unknown", reason: "unknown-schema" };
  if (!HEALTH_STATES.has(j.state)) return { state: "unknown", reason: "bad-state" };
  return { state: j.state, runtime: ["offline", "live"].includes(j.runtime) ? j.runtime : null, demo: j.demo };
}

test("R15 health: GET /api/health is a demo-health/1 document the shelf's own parser reads as ready", async () => {
  await withServer(async (j, base) => {
    const res = await fetch(base + "/api/health");
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok(text.length < 4096, "the contract caps the reply at 4 KB");
    const body = JSON.parse(text);
    assert.equal(body.schema, "demo-health/1");
    assert.equal(body.state, "ready");
    assert.equal(body.runtime, "offline");
    assert.ok(!Number.isNaN(Date.parse(body.at)) && body.at.length <= 40);
    const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    assert.deepEqual(body.demo, { id: "cedar-act-sub-lab", name: "Cedar act.sub Lab", version });
    assert.ok(body.demo.id.length <= 64 && body.demo.name.length <= 80 && body.demo.version.length <= 32);
    assert.deepEqual(parseHealth(text), { state: "ready", runtime: "offline", demo: body.demo });
    // The contract is public, GET only, no counts, no per-check detail: nothing else is in the document.
    assert.deepEqual(Object.keys(body).sort(), ["at", "demo", "runtime", "schema", "state"]);
    const post = await j("/api/health", {});
    assert.equal(post.status, 405);
    assert.equal(post.body.error, "method_not_allowed");
  });
});

test("step 1 baseline: no policy, both tools allowed", async () => {
  await withServer(async (j) => {
    const r = await run(j, "step-1-baseline");
    assert.equal(r.policies.length, 0);
    assert.deepEqual(r.calls.map((c) => [c.tool, c.http, c.verdict]), [["CountTool", 200, "allowed"], ["ListIndexTool", 200, "allowed"]]);
  });
});

test("step 2 adds two Active policies and shows their Cedar; it makes no tool call", async () => {
  await withServer(async (j) => {
    const r = await run(j, "step-2-add-policies");
    assert.equal(r.kind, "policy-change");
    assert.deepEqual(r.calls, []);
    assert.deepEqual(r.policies.map((p) => [p.id, p.tool, p.agent, p.state]), [
      ["cedar-count-act-sub", "CountTool", "agent-client-example", "Active"],
      ["cedar-list-act-sub", "ListIndexTool", "agent-b-example", "Active"]
    ]);
    assert.equal(r.policies[1].cedar, [
      '@reason("ListIndexTool requires act.sub to be agent-b-example")',
      'forbid (principal, action == Action::"mcp:Invoke", resource == Tool::"ListIndexTool")',
      'when   { context.app == "door-example" }',
      'unless { context.token.claims has "act.sub"',
      '         && context.token.claims["act.sub"].contains("agent-b-example") };'
    ].join("\n"));
  });
});

test("step 3: the same token is allowed on the tool naming its agent and refused on the tool naming a different agent", async () => {
  await withServer(async (j) => {
    const r = await run(j, "step-3-same-token");
    // One run, one token: both calls carry it.
    assert.equal(r.token.claims.act.sub, AGENT_A);
    assert.deepEqual(r.policies.map((p) => p.id), ["cedar-count-act-sub", "cedar-list-act-sub"], "step 3 runs with both policies");
    const count = call(r, "CountTool");
    const list = call(r, "ListIndexTool");
    assert.equal(count.http, 200);
    assert.equal(count.verdict, "allowed");
    assert.equal(list.http, 400);
    assert.equal(list.verdict, "refused");
    assert.equal(list.reason, `JSON-RPC -32600 ${REFUSAL_B}`);
    assert.equal(list.trace.response.body.error.code, -32600);
    assert.equal(list.trace.response.body.error.message, REFUSAL_B);
    // The refusal is the policy's, after a passed sign-in.
    assert.deepEqual(list.hops.map((h) => [h.stage, h.ok]), [["signin", true], ["cedar", false]]);
    // The explanation the trace panel shows for the allowed call names its own policy only (MT-06).
    assert.equal(count.hops[1].reason, "Active policy cedar-count-act-sub did not refuse CountTool: the token's act.sub matched");
    assert.equal(count.trace.decisions[1].evidence, count.hops[1].reason);
  });
});

test("the same token string, called on both tools, is allowed on one and refused on the other", () => {
  const token = pf.mintAgentToken({ agent: AGENT_A, clientId: AGENT_A, audience: DOOR_URL, issuer: ISSUER });
  const policies = policiesFor([POLICY_A, POLICY_B]);
  const a = callTool({ token, tool: "CountTool", policies, verifyFn: pf.verify });
  const b = callTool({ token, tool: "ListIndexTool", policies, verifyFn: pf.verify });
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.rpcMessage, REFUSAL_B);
});

test("step 4: policies removed, back to baseline", async () => {
  await withServer(async (j) => {
    const r = await run(j, "step-4-remove");
    assert.equal(r.policies.length, 0);
    assert.ok(r.calls.every((c) => c.http === 200));
  });
});

test("act emitted as text: the mock finds no act.sub, so both policed tools are refused, even the one naming the token's own agent", async () => {
  await withServer(async (j) => {
    const r = await run(j, "act-text");
    assert.equal(r.token.claims.act, "{}");
    assert.equal(call(r, "CountTool").http, 400);
    assert.equal(call(r, "CountTool").reason, `JSON-RPC -32600 ${REFUSAL_A}`);
    assert.equal(call(r, "ListIndexTool").http, 400);
  });
  assert.equal(claimActSub({ act: "{}" }), undefined);
  assert.equal(claimActSub({ act: { sub: "x" } }), "x");
  assert.equal(claimActSub({ act: ["x"] }), undefined);
});

// MT-02: the realistic shapes of a broken token mapping all leave the rule with nothing to match, so the forbid applies.
test("act shapes that are not {sub: <value>}: an empty object, a null or numeric sub, a nested sub, an inherited sub", () => {
  assert.equal(claimActSub({ act: {} }), undefined, "an empty act object has no sub");
  assert.equal(claimActSub({ act: { x: { sub: AGENT_A } } }), undefined, "a nested sub is not act.sub");
  assert.equal(claimActSub({ act: null }), undefined);
  assert.equal(claimActSub({}), undefined);
  assert.equal(claimActSub(null), undefined);
  assert.equal(claimActSub({ act: Object.create({ sub: AGENT_A }) }), undefined, "an inherited sub is not the token's own claim");
  const p = actSubPolicy(POLICY_A);
  const shapes = [{}, { sub: null }, { sub: 5 }, { sub: {} }, { sub: true }, { x: { sub: AGENT_A } }, null, AGENT_A, 5, [], [{ sub: AGENT_A }], Object.create({ sub: AGENT_A })];
  for (const act of shapes) assert.equal(policyRefuses(p, "CountTool", { act }), true, `act=${JSON.stringify(act)} must be refused`);
  assert.equal(policyRefuses(p, "CountTool", { act: { sub: AGENT_A } }), false);
});

test("no token fails closed: 401 at sign-in on every tool, no policy is evaluated, no Authorization header in the trace", async () => {
  await withServer(async (j) => {
    const r = await run(j, "no-token");
    assert.equal(r.token, null);
    for (const c of r.calls) {
      assert.equal(c.http, 401);
      assert.equal(c.verdict, "refused");
      assert.match(c.reason, /401 Bearer token required/);
      assert.deepEqual(c.hops.map((h) => h.stage), ["signin"]);
      assert.deepEqual(c.trace.decisions.map((d) => d.outcome), ["fail", "skipped"]);
      assert.equal(c.trace.request.headers.authorization, undefined);
    }
  });
  // And the rule itself fails closed: no claims at all means the forbid applies.
  assert.equal(policyRefuses(actSubPolicy(POLICY_A), "CountTool", undefined), true);
  assert.equal(policyRefuses(actSubPolicy(POLICY_A), "CountTool", {}), true);
});

test("Candidate policies are not enforced", async () => {
  await withServer(async (j) => {
    const r = await run(j, "candidate");
    assert.ok(r.policies.every((p) => p.state === "Candidate"));
    assert.ok(r.calls.every((c) => c.http === 200), "a Candidate must not refuse");
    assert.equal(call(r, "ListIndexTool").trace.decisions[1].evidence,
      "policy cedar-list-act-sub is a Candidate: not enforced, so it cannot refuse ListIndexTool (per the console documentation, not re-run here)");
  });
  const p = actSubPolicy({ ...POLICY_B, state: "Candidate" });
  assert.equal(policyRefuses(p, "ListIndexTool", { act: { sub: AGENT_A } }), false);
  assert.equal(policyRefuses({ ...p, state: "Active" }, "ListIndexTool", { act: { sub: AGENT_A } }), true);
});

// Matching semantics of act.sub, decided in server/src/cedar.js (comment above contains()): the mock compares the claim value EXACTLY
// and case-sensitively with the policy's agent id. NOT measured on the real door: whether it is exact, substring or set membership.
test("the mock's match is exact: no prefix, suffix, substring, case-fold, whitespace, look-alike or pattern match", () => {
  const p = actSubPolicy(POLICY_A);
  const refused = (sub) => policyRefuses(p, "CountTool", { act: { sub } });
  assert.equal(refused("agent-client-example"), false);
  const notEqual = [
    "agent-client-example-2", "xagent-client-example", "agent-client", "agent-.*", "agent-client-example.*", ".*",
    "AGENT-CLIENT-EXAMPLE", "Agent-Client-Example", " agent-client-example", "agent-client-example ", "agent-client-example\n", "\tagent-client-example",
    "agent-client-examp1e", "agent-client-exampIe", "agent-client-examplе", "agent-client-example​", "agent-client-example\u0000", "",
    "agent-client-example,agent-b-example", "agent-b-example agent-client-example"
  ];
  for (const sub of notEqual) assert.equal(refused(sub), true, `${JSON.stringify(sub)} must not match`);
  // A policy on another tool never refuses this one.
  assert.equal(policyRefuses(p, "ListIndexTool", {}), false);
  assert.equal(policyRefuses(p, "OtherTool", {}), false);
});

// MT-03: a list-valued claim is set membership with exact element equality, never a substring of an element.
test("a list-valued act.sub matches only when one element equals the agent exactly", () => {
  const p = actSubPolicy(POLICY_A);
  const refused = (sub) => policyRefuses(p, "CountTool", { act: { sub } });
  assert.equal(refused(["x", "agent-client-example"]), false, "a list holding the agent contains it");
  assert.equal(refused(["agent-client-example"]), false);
  assert.equal(refused([]), true);
  assert.equal(refused(["agent-client-example-2"]), true, "no substring of an element");
  assert.equal(refused(["xagent-client-example", "agent-client"]), true);
  assert.equal(refused(["AGENT-CLIENT-EXAMPLE"]), true, "no case fold inside a list");
  assert.equal(refused([5, null, {}, ["agent-client-example"]]), true, "non-string elements and nested lists never match");
  assert.equal(refused(["agent-client-example, agent-b-example"]), true, "one element that merely contains the agent is not the agent");
});

// MT-08 (N11): two Active policies on one tool: any one that refuses refuses the call, whatever its position.
test("two Active policies on one tool: the call is refused when either one refuses, allowed only when both are met", () => {
  const token = pf.mintAgentToken({ agent: AGENT_A, clientId: AGENT_A, audience: DOOR_URL, issuer: ISSUER });
  const mine = { id: "p-mine", tool: "CountTool", agent: AGENT_A };
  const other = { id: "p-other", tool: "CountTool", agent: AGENT_B };
  const go = (specs) => callTool({ token, tool: "CountTool", policies: policiesFor(specs), verifyFn: pf.verify });
  assert.equal(go([mine, { ...mine, id: "p-mine-2" }]).ok, true);
  for (const r of [go([other, mine]), go([mine, other])]) {
    assert.equal(r.ok, false);
    assert.equal(r.http, 400);
    assert.match(r.reason, /CountTool requires act\.sub to be agent-b-example/);
    assert.equal(r.hops.at(-1).policy, "p-other");
  }
});

test("the sign-in check refuses a bad signature, wrong audience, wrong issuer and expired token before any policy", () => {
  const policies = policiesFor([POLICY_A]);
  const good = pf.mintAgentToken({ agent: AGENT_A, clientId: AGENT_A, audience: DOOR_URL, issuer: ISSUER });
  const tampered = good.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  assert.match(callTool({ token: tampered, tool: "CountTool", policies, verifyFn: pf.verify }).reason, /workload token rejected: bad signature/);
  const wrongAud = pf.mintAgentToken({ agent: AGENT_A, clientId: AGENT_A, audience: "https://elsewhere.example/mcp", issuer: ISSUER });
  assert.match(callTool({ token: wrongAud, tool: "CountTool", policies, verifyFn: pf.verify }).reason, /audience https:\/\/elsewhere\.example\/mcp does not match/);
  // MT-07: the issuer check.
  const wrongIss = pf.mintAgentToken({ agent: AGENT_A, clientId: AGENT_A, audience: DOOR_URL, issuer: "https://evil.example" });
  const iss = callTool({ token: wrongIss, tool: "CountTool", policies, verifyFn: pf.verify });
  assert.equal(iss.http, 401);
  assert.match(iss.reason, /workload token rejected: issuer https:\/\/evil\.example does not match https:\/\/pf\.example/);
  const noIss = pf.sign({ aud: DOOR_URL, sub: AGENT_A, act: { sub: AGENT_A }, iat: 1, exp: 9999999999 });
  assert.match(callTool({ token: noIss, tool: "CountTool", policies, verifyFn: pf.verify }).reason, /issuer \(none\) does not match/);
  const expired = pf.sign({ iss: ISSUER, aud: DOOR_URL, sub: AGENT_A, act: { sub: AGENT_A }, iat: 1, exp: 2 });
  assert.match(callTool({ token: expired, tool: "CountTool", policies, verifyFn: pf.verify }).reason, /token expired/);
  const noExp = pf.sign({ iss: ISSUER, aud: DOOR_URL, sub: AGENT_A, act: { sub: AGENT_A }, iat: 1 });
  assert.match(callTool({ token: noExp, tool: "CountTool", policies, verifyFn: pf.verify }).reason, /token expired/);
});

test("MT-07 the expiry boundary: a token whose exp is the current second is expired, one second later it is accepted", () => {
  const policies = policiesFor([POLICY_A]);
  const T = 1_800_000_000;
  const at = { now: () => T * 1000 };
  const withExp = (exp) => pf.sign({ iss: ISSUER, aud: DOOR_URL, sub: AGENT_A, act: { sub: AGENT_A }, iat: T - 10, exp });
  const edge = callTool({ token: withExp(T), tool: "CountTool", policies, verifyFn: pf.verify, ...at });
  assert.equal(edge.ok, false);
  assert.match(edge.reason, /token expired/);
  assert.equal(callTool({ token: withExp(T - 1), tool: "CountTool", policies, verifyFn: pf.verify, ...at }).ok, false);
  assert.equal(callTool({ token: withExp(T + 1), tool: "CountTool", policies, verifyFn: pf.verify, ...at }).ok, true);
});

// MT-06: the explanation shown in the trace panel for each outcome.
test("the explanation of an allowed call names the right policy, the Candidate state and the no-policy case", () => {
  const token = pf.mintAgentToken({ agent: AGENT_A, clientId: AGENT_A, audience: DOOR_URL, issuer: ISSUER });
  const go = (tool, policies) => callTool({ token, tool, policies, verifyFn: pf.verify });
  assert.equal(go("CountTool", policiesFor([POLICY_A, POLICY_B])).hops[1].reason, "Active policy cedar-count-act-sub did not refuse CountTool: the token's act.sub matched");
  assert.equal(go("CountTool", []).hops[1].reason, "no policy targets CountTool");
  assert.equal(go("CountTool", policiesFor([POLICY_B])).hops[1].reason, "no policy targets CountTool", "a policy on another tool is not named");
  const cand = go("ListIndexTool", policiesFor([POLICY_B], "Candidate"));
  assert.equal(cand.ok, true);
  assert.equal(cand.hops[1].reason, "policy cedar-list-act-sub is a Candidate: not enforced, so it cannot refuse ListIndexTool (per the console documentation, not re-run here)");
  // An Active policy that is met wins over a Candidate on the same tool for the wording, and a Candidate never refuses.
  const mixed = go("ListIndexTool", [...policiesFor([POLICY_B], "Candidate"), ...policiesFor([{ ...POLICY_B, id: "x-active", agent: AGENT_A }])]);
  assert.equal(mixed.ok, true);
  assert.equal(mixed.hops[1].reason, "Active policy x-active did not refuse ListIndexTool: the token's act.sub matched");
});

test("a policy is plain ids only: an injected tool or agent cannot break out of the Cedar string", () => {
  assert.throws(() => actSubPolicy({ id: "x", tool: 'CountTool") ; permit (principal, action, resource) ; //', agent: AGENT_A }), /plain ids/);
  assert.throws(() => actSubPolicy({ id: "x", tool: "CountTool", agent: 'a"\n@reason("b' }), /plain ids/);
  assert.throws(() => actSubPolicy({ id: "x", tool: "CountTool", agent: AGENT_A, state: "" }), /Active or Candidate/);
  assert.match(cedarText(actSubPolicy(POLICY_A)), /^@reason\("CountTool requires act\.sub to be agent-client-example"\)\nforbid /);
});

// MT-09: each hostile id fails for ONE reason only, so a loosened character class or a /m flag is caught by its own case.
test("every plain-id rule is tested alone: quote, backslash, newline, trailing newline, space, empty, too long, leading dot", () => {
  const bad = (field, value) => assert.throws(
    () => actSubPolicy({ id: "x", tool: field === "tool" ? value : "CountTool", agent: field === "agent" ? value : AGENT_A }),
    /plain ids/, `${field}=${JSON.stringify(value)}`
  );
  for (const field of ["tool", "agent"]) {
    for (const value of ['a"b', "a\\b", "CountTool\nx", "ok\n", "\nok", "a b", "a b", "", "a".repeat(65), ".leading-dot", "-leading-dash"]) bad(field, value);
  }
  assert.doesNotThrow(() => actSubPolicy({ id: "x", tool: "a".repeat(64), agent: "A.b_c:d-1" }));
});

test("every scenario's calls carry a mock trace that passes assertTrace, all decisions checked", async () => {
  const { assertTrace } = await import("../server/src/gatewayTrace.js");
  await withServer(async (j) => {
    for (const s of SCENARIOS) {
      const r = await run(j, s.id);
      for (const c of r.calls) {
        const t = c.trace;
        assert.deepEqual(assertTrace(t), [], `${s.id}/${c.tool}`);
        assert.equal(t.source, "mock");
        assert.equal(t.response.status, c.http);
        assert.deepEqual(t.decisions.map((d) => d.id), ["signin", "cedar"]);
        for (const d of t.decisions) assert.equal(d.basis, "checked");
        assert.deepEqual(t.request.body, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: c.tool, arguments: {} } });
        for (const h of c.hops) assert.ok(!("payload" in h), "a run record carries no decoded hop payload (MT-08 N05)");
      }
    }
  });
});

test("expectations and basis in the scenario data hold: each scenario's verdicts match what it says", async () => {
  const BASIS = { "step-1-baseline": "measured", "step-2-add-policies": "measured", "step-3-same-token": "measured", "step-4-remove": "measured", "act-text": "not measured", "no-token": "not measured", candidate: "not measured" };
  assert.deepEqual(Object.fromEntries(SCENARIOS.map((s) => [s.id, s.basis])), BASIS);
  await withServer(async (j) => {
    for (const s of SCENARIOS) {
      const r = await run(j, s.id);
      for (const c of r.calls) assert.equal(c.verdict, s.expect[c.tool], `${s.id}/${c.tool}`);
      assert.equal(r.calls.length, s.calls.length);
    }
  });
});

// R4 (owner rule 4): tokens are shown raw, mock-issued ones labelled as mock. Real-probe tokens are another matter and never print.
test("R4 a mock-issued token is returned raw in the run, labelled mock, and is the token the trace sends", async () => {
  await withServer(async (j) => {
    const r = await run(j, "step-3-same-token");
    assert.equal(r.token.mock, true);
    assert.match(r.token.token, JWT);
    assert.equal(pf.verify(r.token.token).ok, true, "the raw token is the mock fixture token the door verified");
    assert.deepEqual(pf.decodePayload(r.token.token), r.token.claims);
    assert.equal(r.token.claims.mock, true);
    assert.match(r.token.note, /mock/i);
    assert.match(r.token.note, /HS256 fixture key/);
    assert.match(r.token.note, /signs nothing real/);
    assert.equal(r.token.hash.length, 8);
    for (const c of r.calls) assert.equal(c.trace.request.headers.authorization, `Bearer ${r.token.token}`);
    // The act-text token is a mock token too, raw and labelled.
    const t = await run(j, "act-text");
    assert.equal(t.token.mock, true);
    assert.match(t.token.token, JWT);
    assert.equal(pf.decodePayload(t.token.token).act, "{}");
    // No token: nothing to show, and no Authorization header in the request.
    const n = await run(j, "no-token");
    assert.equal(n.token, null);
  });
});

test("a scenario run makes zero outbound attempts", () => {
  const g = installNetguard();
  const before = g.attempts.length;
  for (const s of SCENARIOS) runScenario(s);
  assert.equal(g.attempts.length, before);
});

test("mode: Real is refused 409 with the reason, bogus 400, mock accepted", async () => {
  await withServer(async (j) => {
    const real = await j("/api/mode", { source: "real" });
    assert.equal(real.status, 409);
    assert.equal(real.body.error, "real_unavailable");
    assert.match(real.body.message, /owner-gated|\.env/);
    const bogus = await j("/api/mode", { source: "bogus" });
    assert.equal(bogus.status, 400);
    assert.equal(typeof bogus.body.error, "string");
    assert.equal(typeof bogus.body.message, "string");
    const mock = await j("/api/mode", { source: "mock" });
    assert.equal(mock.status, 200);
    assert.equal(mock.body.source, "mock");
  });
});

test("the page's /api/shelf call is answered with { shelfUrl } and never 404s", async () => {
  const saved = process.env.SHELF_URL;
  try {
    await withServer(async (j, base) => {
      delete process.env.SHELF_URL;
      let res = await fetch(base + "/api/shelf");
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { shelfUrl: null });
      process.env.SHELF_URL = "https://shelf.example/";
      res = await fetch(base + "/api/shelf");
      assert.deepEqual(await res.json(), { shelfUrl: "https://shelf.example" });
    });
  } finally { if (saved === undefined) delete process.env.SHELF_URL; else process.env.SHELF_URL = saved; }
});

test("info reports Real unavailable with a visible reason", async () => {
  await withServer(async (j, base) => {
    const body = await (await fetch(base + "/api/info", { headers: { host: HOST } })).json();
    assert.equal(body.realAvailable, false);
    assert.equal(body.source, "mock");
    assert.match(body.realReason, /\.env/);
  });
});

test("catalog serves the four steps in order, the three extras, and the static measured evidence", async () => {
  await withServer(async (j, base) => {
    const body = await (await fetch(base + "/api/catalog", { headers: { host: HOST } })).json();
    assert.deepEqual(body.scenarios.map((s) => s.id), ["step-1-baseline", "step-2-add-policies", "step-3-same-token", "step-4-remove", "act-text", "no-token", "candidate"]);
    assert.deepEqual(body.scenarios.filter((s) => s.group === "step").map((s) => s.n), [1, 2, 3, 4]);
    assert.match(body.mockNote, /not a Cedar engine/);
    assert.equal(body.evidence.label, "Measured on a real tenant 2026-11-16");
    assert.equal(body.evidence.command, "npm run real");
    assert.equal(body.evidence.rows.length, 3);
    const [base0, withPolicies, removed] = body.evidence.rows;
    assert.deepEqual([base0.CountTool, base0.ListIndexTool], ["allowed", "allowed"]);
    assert.equal(withPolicies.CountTool, "allowed");
    assert.ok(withPolicies.ListIndexTool.startsWith("refused: action denied by policy: ListIndexTool requires act.sub to be agent-b-example"), withPolicies.ListIndexTool);
    assert.match(withPolicies.ListIndexTool, /\(JSON-RPC -32600\)$/);
    assert.deepEqual([removed.CountTool, removed.ListIndexTool], ["allowed", "allowed"]);
    assert.ok(body.evidence.notMeasured.some((t) => /second real agent/.test(t)));
    assert.ok(body.evidence.notMeasured.some((t) => /TEXT/.test(t)));
    assert.ok(body.evidence.notMeasured.some((t) => /exact|substring/.test(t)), "the exact-versus-substring question is on the not-measured list");
    assert.match(body.evidence.timing, /about 7 seconds/);
    assert.match(body.evidence.timing, /one (run|observation)/, "the timing is framed as a single observation");
    assert.ok(body.scenarios.every((s) => !("policies" in s) && !("calls_result" in s)), "the catalog carries no mock-run output");
  });
  assert.equal(EVIDENCE.cedar.split("\n").length, 5);
});

// R2 / BD-1 / BD-3: nothing outside the measured set is stated as measured fact on the page.
test("R2 the evidence and scenario texts carry no unsourced 'verified', 'validated' or 'never matches' claim", () => {
  const all = JSON.stringify({ EVIDENCE, MOCK_NOTE, SCENARIOS });
  assert.ok(!/is verified|and is verified/i.test(all), "RequiredClaims is not claimed verified");
  assert.ok(!/validated/i.test(all), "nothing says the controller validated anything");
  assert.ok(!/never matches/i.test(all), "act as text is not stated as never matching");
  assert.ok(!/Cedar has no regex/i.test(all), "the overbroad regex claim is gone (Cedar has a like operator)");
  assert.ok(!/no pattern match/i.test(all));
  for (const line of EVIDENCE.alsoTrue) assert.match(line, /UNVERIFIED/, line);
  assert.ok(EVIDENCE.alsoTrue.some((l) => /RequiredClaims/.test(l)) && EVIDENCE.alsoTrue.some((l) => /Candidate/.test(l)));
  assert.match(EVIDENCE.cedarNote, /UNVERIFIED/, "the wrapper lines are labelled as not read from the tenant");
  assert.match(EVIDENCE.timing, /one observation/);
  assert.match(EVIDENCE.commandNote, /was run against a real PingFederate and door on 2026-11-16, three times/);
  assert.doesNotMatch(EVIDENCE.commandNote, /never been run/);
  const text = SCENARIOS.find((s) => s.id === "act-text");
  assert.match(text.what + text.say, /not measured|should|expected/i);
  assert.match(SCENARIOS.find((s) => s.id === "candidate").say, /not re-run/);
  assert.match(SCENARIOS.find((s) => s.id === "no-token").say, /simulated, not measured|in this mock/i);
});

// R14 (rule 14): a W3C traceparent on every hop the lab simulates and on its own API responses.
test("R14 every simulated call and hop carries a well-formed traceparent of one trace, and the run record carries its own", async () => {
  await withServer(async (j) => {
    for (const s of SCENARIOS) {
      const r = await run(j, s.id);
      assert.match(r.traceparent, TRACEPARENT, s.id);
      const traceId = r.traceparent.split("-")[1];
      const spans = new Set([r.traceparent.split("-")[2]]);
      for (const c of r.calls) {
        const tp = c.trace.request.headers.traceparent;
        assert.match(tp, TRACEPARENT, `${s.id}/${c.tool} request`);
        assert.equal(tp.split("-")[1], traceId, "one trace per run");
        spans.add(tp.split("-")[2]);
        assert.ok(c.hops.length >= 1);
        for (const h of c.hops) {
          assert.match(h.traceparent, TRACEPARENT, `${s.id}/${c.tool}/${h.stage}`);
          assert.equal(h.traceparent.split("-")[1], traceId);
          spans.add(h.traceparent.split("-")[2]);
        }
      }
      const expected = 1 + r.calls.reduce((n, c) => n + 1 + c.hops.length, 0);
      assert.equal(spans.size, expected, "a new span id per hop and per call");
    }
  });
});

test("R14 API responses carry traceparent: a valid incoming one continues its trace, an invalid one starts a new trace", async () => {
  await withRaw(undefined, async (raw, port) => {
    const incoming = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const cont = await raw("GET", "/api/health", { traceparent: incoming });
    assert.match(cont.headers.traceparent, TRACEPARENT);
    assert.equal(cont.headers.traceparent.split("-")[1], "0af7651916cd43dd8448eb211c80319c");
    assert.notEqual(cont.headers.traceparent.split("-")[2], "b7ad6b7169203331", "a new span for this hop");
    for (const bad of ["garbage", "00-" + "0".repeat(32) + "-b7ad6b7169203331-01", "00-0af7651916cd43dd8448eb211c80319c-" + "0".repeat(16) + "-01", incoming.toUpperCase(), incoming + "-x"]) {
      const r = await raw("GET", "/api/health", { traceparent: bad });
      assert.match(r.headers.traceparent, TRACEPARENT, bad);
      assert.notEqual(r.headers.traceparent.split("-")[1], bad.split("-")[1]);
    }
    // POST /api/run: the header on the response is the run's own traceparent, and it continues the incoming trace.
    const body = JSON.stringify({ scenario: "step-3-same-token" });
    const post = await raw("POST", "/api/run", { traceparent: incoming, "content-type": "application/json", origin: `http://127.0.0.1:${port}`, "content-length": Buffer.byteLength(body) }, body);
    assert.equal(post.status, 200);
    assert.equal(post.headers.traceparent, post.json.traceparent);
    assert.equal(post.json.traceparent.split("-")[1], "0af7651916cd43dd8448eb211c80319c");
    for (const c of post.json.calls) assert.equal(c.trace.request.headers.traceparent.split("-")[1], "0af7651916cd43dd8448eb211c80319c");
    // Errors carry it too.
    assert.match((await raw("GET", "/api/nope")).headers.traceparent, TRACEPARENT);
    assert.match((await raw("GET", "/api/health", { host: "evil.example" })).headers.traceparent, TRACEPARENT);
  });
});

// R23: every API error is structured JSON { error, message }, never an HTML page, a stack trace or a blank body.
test("R23 a malformed, oversized or non-object body is a JSON error, not an HTML page, and leaks no stack or path", async () => {
  await withRaw(undefined, async (raw, port) => {
    const h = (body) => ({ "content-type": "application/json", origin: `http://127.0.0.1:${port}`, "content-length": Buffer.byteLength(body) });
    const cases = [
      ["malformed", '{"scenario":', 400, "bad_json"],
      ["garbage", "not json at all", 400, "bad_json"],
      ["bare string", '"x"', 400, "bad_json"],
      ["null", "null", 400, "bad_json"],
      ["too large", JSON.stringify({ scenario: "x".repeat(70 * 1024) }), 413, "payload_too_large"]
    ];
    for (const [name, body, status, code] of cases) {
      const r = await raw("POST", "/api/run", h(body), body);
      assert.equal(r.status, status, name);
      assert.match(r.headers["content-type"], /application\/json/, name);
      assert.equal(r.json.error, code, name);
      assert.equal(typeof r.json.message, "string", name);
      assert.ok(!/<html|<pre|SyntaxError|node_modules|\/Users\/|\/private\/|at parse|stack/i.test(r.text), `${name}: ${r.text.slice(0, 200)}`);
    }
    // Host and origin are checked BEFORE the body is parsed.
    const body = '{"scenario":';
    const evil = await raw("POST", "/api/run", { ...h(body), host: "evil.example" }, body);
    assert.equal(evil.status, 403);
    assert.equal(evil.json.error, "host_not_allowed");
    const cross = await raw("POST", "/api/run", { ...h(body), origin: "https://evil.example" }, body);
    assert.equal(cross.status, 403);
    assert.equal(cross.json.error, "cross_origin");
  });
});

test("R23 an unknown API route, a wrong method and an unhandled error are JSON too", async () => {
  const boom = (app) => { app.get("/api/boom", () => { throw new Error("secret stack detail /Users/someone/x.js"); }); };
  await withRaw(undefined, async (raw, port) => {
    for (const [method, path] of [["GET", "/api/nope"], ["POST", "/api/nope"], ["GET", "/api/run"], ["DELETE", "/api/reset"], ["GET", "/api"], ["GET", "/api/"], ["PUT", "/nope"]]) {
      const headers = method === "GET" ? {} : { "content-type": "application/json", origin: `http://127.0.0.1:${port}`, "content-length": 2 };
      const r = await raw(method, path, headers, method === "GET" ? undefined : "{}");
      assert.equal(r.status, 404, `${method} ${path}`);
      assert.match(r.headers["content-type"], /application\/json/, `${method} ${path}`);
      assert.equal(r.json.error, "not_found");
      assert.equal(typeof r.json.message, "string");
    }
    const r = await raw("GET", "/api/boom");
    assert.equal(r.status, 500);
    assert.match(r.headers["content-type"], /application\/json/);
    assert.deepEqual(Object.keys(r.json).sort(), ["error", "message"]);
    assert.equal(r.json.error, "internal_error");
    assert.ok(!/secret|Users|stack/.test(r.text), "an internal error never leaks its message or stack");
    // 415 and the mode/scenario errors are { error, message } as well.
    const text = await raw("POST", "/api/run", { "content-type": "text/plain", origin: `http://127.0.0.1:${port}`, "content-length": 1 }, "x");
    assert.equal(text.status, 415);
    assert.equal(text.json.error, "unsupported_media_type");
    assert.equal(typeof text.json.message, "string");
  }, { netguard: boom });
});

test("an unknown scenario is a 400 with the list of ids", async () => {
  await withServer(async (j) => {
    const bad = await j("/api/run", { scenario: "nope" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "unknown_scenario");
    assert.match(bad.body.message, /step-1-baseline/);
    assert.equal((await j("/api/run", {})).status, 400);
  });
});

// SWAP / HI-3 / HI-6: the Host check is strict, and the lab-proxy names are on the default list.
test("SWAP the lab-proxy host names are accepted by default (so a proxied request is not a 403) and nothing else is", async () => {
  await withRaw(undefined, async (raw, port) => {
    const ok = [
      "cedar-act-sub-lab.local.ping-devops.com:7819", "cedar-act-sub-lab:7819", "cedar-act-sub-lab.local.ping-devops.com:8443", "local.ping-devops.com:8443",
      "localhost:7819", "127.0.0.1:7819", `127.0.0.1:${port}`, `localhost:${port}`
    ];
    for (const host of ok) assert.equal((await raw("GET", "/api/health", { host })).status, 200, host);
    const refused = [
      "evil.example", "evil.example:7819", "localhost:9999", "127.0.0.1:9999", "localhost.evil.example", `localhost.evil.example:${port}`, "other.local.ping-devops.com:8443",
      "cedar-act-sub-lab.local.ping-devops.com:9999", "cedar-act-sub-lab", `[::1]:9999`, "0.0.0.0:7819", `127.0.0.1.evil.example:${port}`, "local.ping-devops.com:7819"
    ];
    for (const host of refused) {
      const r = await raw("GET", "/api/health", { host });
      assert.equal(r.status, 403, host);
      assert.equal(r.json.error, "host_not_allowed", host);
    }
  });
});

test("SWAP a write behind the lab-proxy: the proxy's own origin is accepted only with a proxy Host and a matching X-Forwarded-Host", async () => {
  await withRaw(undefined, async (raw, port) => {
    const body = JSON.stringify({ scenario: "step-1-baseline" });
    const send = (headers) => raw("POST", "/api/run", { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers }, body);
    const proxyHost = "cedar-act-sub-lab.local.ping-devops.com:7819";
    const viaProxy = { host: proxyHost, origin: "https://local.ping-devops.com:8443", "x-forwarded-host": "local.ping-devops.com:8443", "x-forwarded-proto": "https" };
    assert.equal((await send(viaProxy)).status, 200);
    assert.equal((await send({ ...viaProxy, "sec-fetch-site": "same-origin" })).status, 200);
    // The same headers from a loopback Host (not the proxy): the forwarded host is not believed.
    assert.equal((await send({ ...viaProxy, host: `127.0.0.1:${port}` })).status, 403);
    // A forwarded host that is not on the list, matching a hostile origin.
    assert.equal((await send({ ...viaProxy, origin: "https://evil.example", "x-forwarded-host": "evil.example" })).status, 403);
    // Origin and forwarded host disagree, or the scheme is wrong.
    assert.equal((await send({ ...viaProxy, origin: "https://other.local.ping-devops.com:8443" })).status, 403);
    assert.equal((await send({ ...viaProxy, "x-forwarded-proto": "http" })).status, 403);
  });
});

test("HI-3 the write guard: same origin only, cross-site fetch metadata refused, no any-port loopback allowance", async () => {
  await withRaw(undefined, async (raw, port) => {
    const body = "{}";
    const send = (headers) => raw("POST", "/api/reset", { "content-type": "application/json", "content-length": 2, ...headers }, body);
    assert.equal((await send({ origin: `http://127.0.0.1:${port}` })).status, 200);
    assert.equal((await send({ origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" })).status, 200);
    assert.equal((await send({})).status, 200, "a write with no Origin (a non-browser client) is accepted");
    for (const origin of ["http://127.0.0.1:9", "http://127.0.0.1:9999", "http://localhost:9999", "https://evil.example", "null", "not a url", `http://127.0.0.1:${port}.evil.example`]) {
      const r = await send({ origin });
      assert.equal(r.status, 403, origin);
      assert.equal(r.json.error, "cross_origin", origin);
    }
    for (const site of ["cross-site", "same-site"]) assert.equal((await send({ "sec-fetch-site": site })).status, 403, site);
    assert.equal((await send({ "sec-fetch-site": "none" })).status, 200);
    // X-Forwarded-Host from a loopback Host never vouches for a foreign Origin.
    assert.equal((await send({ origin: "https://evil.example", "x-forwarded-host": "evil.example" })).status, 403);
  });
});

test("host check refuses unknown non-loopback hosts", async () => {
  const srv = await startVerified(async () => {
    const s = buildServer().listen(0, "127.0.0.1");
    await new Promise((r) => s.on("listening", r));
    return s;
  });
  const port = srv.address().port;
  // node:http directly: fetch forbids setting the Host header.
  const status = await new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/health", headers: { host: "evil.example.com" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end();
  });
  assert.equal(status, 403);
  await stop(srv);
});

test("cross-origin write refused, and a non-JSON write is a 415", async () => {
  const srv = await startVerified(async () => {
    const s = buildServer().listen(0, "127.0.0.1");
    await new Promise((r) => s.on("listening", r));
    return s;
  });
  const port = srv.address().port;
  const cross = await fetch(`http://127.0.0.1:${port}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json", host: HOST, origin: "http://evil.example.com" },
    body: JSON.stringify({ scenario: "step-1-baseline" })
  });
  assert.equal(cross.status, 403);
  const text = await fetch(`http://127.0.0.1:${port}/api/run`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
  assert.equal(text.status, 415);
  await stop(srv);
});

test("reset clears runs", async () => {
  await withServer(async (j) => {
    await j("/api/run", { scenario: "step-1-baseline" });
    assert.ok(readState().runs.length > 0);
    await j("/api/reset");
    assert.equal(readState().runs.length, 0);
  });
});

test("pf verify: signature check and decode", () => {
  const t = pf.mintAgentToken({ agent: "a", clientId: "c", audience: "x", issuer: "i" });
  assert.equal(pf.verify(t).ok, true);
  assert.equal(pf.decodePayload(t).act.sub, "a");
  assert.equal(pf.verify("garbage.token.value").reason, "bad signature");
  assert.equal(pf.verify(t.replace(/.$/, (c) => (c === "A" ? "B" : "A"))).reason, "bad signature");
});

// Residual re-check G6b: a Host that is a loopback name on the allowed list (so the host guard lets it in) must never claim the lab-proxy
// origin through a forged X-Forwarded-Host. Only a non-loopback proxy Host may.
test("G6b a loopback Host on the allowed list plus a forged X-Forwarded-Host and the proxy's Origin is refused 403 cross_origin", async () => {
  await withRaw(undefined, async (raw) => {
    const body = JSON.stringify({ scenario: "step-1-baseline" });
    const send = (headers) => raw("POST", "/api/run", { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers }, body);
    const forged = { origin: "https://local.ping-devops.com:8443", "x-forwarded-host": "local.ping-devops.com:8443", "x-forwarded-proto": "https" };
    for (const host of ["localhost:7819", "127.0.0.1:7819"]) {
      const r = await send({ host, ...forged });
      assert.equal(r.status, 403, host);
      assert.equal(r.json.error, "cross_origin", host);
    }
    // the same headers behind the real proxy Host are still believed
    assert.equal((await send({ host: "cedar-act-sub-lab.local.ping-devops.com:7819", ...forged })).status, 200);
  });
});

// Residual re-check H3: a failing door check must show as `broken`, in a document that still has the demo-health/1 shape.
test("H3 health: a failing door check reports state broken (demo-health/1 shape kept); a throwing check is unknown", async () => {
  const get = async (check) => {
    const health = createHealth({ check });
    const app = express();
    app.use("/api/health", health.router);
    const srv = app.listen(0, "127.0.0.1");
    await new Promise((r) => srv.on("listening", r));
    try {
      const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/health`);
      return { status: res.status, body: await res.json() };
    } finally { health.stop(); await stop(srv); }
  };
  const broken = await get(() => false);
  assert.equal(broken.status, 200);
  assert.equal(broken.body.state, "broken");
  assert.equal(broken.body.schema, "demo-health/1");
  assert.equal(broken.body.runtime, "offline");
  assert.deepEqual(Object.keys(broken.body).sort(), ["at", "demo", "runtime", "schema", "state"]);
  assert.equal((await get(() => true)).body.state, "ready");
  assert.equal((await get(() => { throw new Error("boom"); })).body.state, "unknown");
});

// Residual re-check item 5 (rule 19: the body is exactly {source}).
test("mode: any key besides source is a 400 with the structured {error, message} shape; a valid body still works", async () => {
  await withServer(async (j) => {
    for (const body of [{ source: "mock", x: 1 }, { source: "real", x: 1 }, { x: 1 }, { source: "mock", source2: "mock" }, []]) {
      const r = await j("/api/mode", body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, "bad_request");
      assert.match(r.body.message, /exactly/);
    }
    assert.equal((await j("/api/mode", { source: "mock" })).status, 200);
    assert.equal((await j("/api/mode", { source: "real" })).status, 409);
  });
});
