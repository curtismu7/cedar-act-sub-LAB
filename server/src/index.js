// Express server: run the mock door, serve the story and the static evidence, mode and health APIs.
import express from "express";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as pf from "./pf.js";
import { callTool, cedarText, ISSUER, DOOR_URL, AGENT_A, DOOR } from "./cedar.js";
import { doorTrace, startTrace } from "./cedarTrace.js";
import { installNetguard } from "./netguard.js";
import { hostGuard, writeGuard, parseAllowedHosts } from "./guards.js";
import { createHealth } from "./health.js";
import { SCENARIOS, STEP_IDS, EVIDENCE, MOCK_NOTE, policiesFor } from "./scenarios.js";

const APP_ID = "cedar-act-sub-lab";
const PORT_DEFAULT = 7819;
const REAL_REASON =
  "Real is owner-only and runs from your terminal, not from this page: npm run real (reads a local .env, see .env.example). The server never calls out.";

const state = { source: "mock", runs: [] };
const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "..", "dist");

const sha8 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);

let runCounter = 0;
function nextRunId() {
  runCounter += 1;
  return `run-${Date.now()}-${runCounter}`;
}

// Rule 4: a mock-issued token is shown raw and labelled mock. It is an HS256 fixture JWT that signs nothing real (pf.js), never a credential.
function tokenSummary(token) {
  if (!token) return null;
  return {
    mock: true,
    token,
    hash: sha8(token),
    claims: pf.decodePayload(token),
    note: "mock token issued by this lab's in-process PingFederate stand-in (HS256 fixture key, signs nothing real)"
  };
}

function mintFor(kind) {
  if (kind === "none") return null;
  return pf.mintAgentToken({ agent: AGENT_A, clientId: AGENT_A, audience: DOOR_URL, issuer: ISSUER, actIsText: kind === "act-text" });
}

// Run one scenario against the mock door. Stateless: the scenario carries the policies the door holds while it runs.
export function runScenario(scenario, trace = startTrace()) {
  const policies = policiesFor(scenario.policies, scenario.policyState);
  const token = mintFor(scenario.token);
  const calls = scenario.calls.map((tool) => {
    const result = callTool({ token, tool, policies, verifyFn: pf.verify });
    return {
      tool,
      http: result.http,
      ok: result.ok,
      verdict: result.ok ? "allowed" : "refused",
      reason: result.reason,
      hops: result.hops.map(({ payload, ...h }) => ({ ...h, traceparent: trace.child() })),
      trace: doorTrace({ token, tool, result, traceparent: trace.child() })
    };
  });
  return {
    id: nextRunId(),
    at: new Date().toISOString(),
    scenario: scenario.id,
    label: scenario.label,
    kind: scenario.kind,
    door: DOOR,
    traceparent: trace.root,
    policies: policies.map((p) => ({ ...p, cedar: cedarText(p) })),
    token: tokenSummary(token),
    calls
  };
}

export function buildServer({ netguard } = {}) {
  // Rule 1: zero real outbound by default. The mock issuer/gateway/backend are
  // in-process, so nothing here has a reason to leave the machine.
  installNetguard();
  const app = express();
  app.disable("x-powered-by");
  // Rule 14: every API response carries a traceparent; a valid incoming one continues its trace.
  app.use("/api", (req, res, next) => {
    req.trace = startTrace(req.headers.traceparent);
    res.set("traceparent", req.trace.root);
    next();
  });
  // Host and write-origin are checked BEFORE the body is read or parsed (HI-3, HI-4).
  const allowedHosts = parseAllowedHosts(process.env.LAB_ALLOWED_HOSTS, PORT_DEFAULT);
  app.use(hostGuard(allowedHosts));
  app.use(writeGuard(allowedHosts));
  // Writes must be JSON: express.json skips other types, so refuse them explicitly.
  app.use((req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const ct = String(req.headers["content-type"] || "");
    if (!ct.includes("application/json")) return res.status(415).json({ error: "unsupported_media_type", message: "content-type must be application/json" });
    next();
  });
  app.use(express.json({ limit: "64kb" }));

  // The mock door still behaves as written: step 3 allows CountTool and refuses ListIndexTool. Refreshed in the background.
  const step3 = SCENARIOS.find((s) => s.id === "step-3-same-token");
  const health = createHealth({
    check: () => runScenario(step3).calls.every((c) => c.verdict === step3.expect[c.tool])
  });
  app.use("/api/health", health.router);

  // Rule 19: Real is owner-only here. The toggle is shown but disabled, with this reason; the server never calls out.
  app.get("/api/info", (req, res) => {
    res.json({ source: state.source, realAvailable: false, realReason: REAL_REASON });
  });

  app.post("/api/mode", (req, res) => {
    const { source } = req.body || {};
    if (source === "real") return res.status(409).json({ error: "real_unavailable", message: REAL_REASON });
    if (source !== "mock") return res.status(400).json({ error: "bad_request", message: "body must be {source:\"mock\"|\"real\"}" });
    state.source = "mock";
    res.json({ source: state.source });
  });

  // The header's Shelf button and the verification mark ask this lab for the shelf's address. Opened on its own port the lab answers with
  // only { shelfUrl } (from SHELF_URL, null when unset), so the page makes no failing call; behind the lab-proxy the shelf answers it.
  app.get("/api/shelf", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ shelfUrl: String(process.env.SHELF_URL || "").trim().replace(/\/+$/, "") || null });
  });

  app.get("/api/catalog", (req, res) => {
    res.json({
      door: DOOR,
      mockNote: MOCK_NOTE,
      stepIds: STEP_IDS,
      scenarios: SCENARIOS.map(({ policies, policyState, ...s }) => ({ ...s, policyState: policyState || "Active", policyCount: policies.length })),
      evidence: EVIDENCE
    });
  });

  // Run a scenario by id against the mock door.
  app.post("/api/run", (req, res) => {
    const { scenario } = req.body || {};
    const found = SCENARIOS.find((s) => s.id === scenario);
    if (!found) return res.status(400).json({ error: "unknown_scenario", message: `unknown scenario; one of ${SCENARIOS.map((s) => s.id).join(", ")}` });
    const run = runScenario(found, req.trace);
    state.runs.push(run);
    if (state.runs.length > 200) state.runs.shift();
    res.json(run);
  });

  app.get("/api/runs", (req, res) => res.json({ runs: state.runs }));

  app.post("/api/reset", (req, res) => {
    state.runs = [];
    res.json({ ok: true });
  });

  if (netguard) netguard(app);

  // Serve the built UI when present (Docker/dev build).
  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^(?!\/api(\/|$)).*/, (req, res) => res.sendFile(join(distDir, "index.html")));
  }

  // Rule 23: whatever is left is a structured JSON answer, never Express's HTML page, and an error never leaks its message or stack.
  app.use((req, res) => res.status(404).json({ error: "not_found", message: "no such route" }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number(err && (err.status || err.statusCode));
    if (err && err.type === "entity.too.large") return res.status(413).json({ error: "payload_too_large", message: "the request body is over 64 KB" });
    if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) return res.status(400).json({ error: "bad_json", message: "the request body is not valid JSON" });
    if (status >= 400 && status < 500) return res.status(status).json({ error: "bad_request", message: "the request could not be read" });
    return res.status(500).json({ error: "internal_error", message: "the lab server hit an unexpected error" });
  });

  return app;
}

export function readState() {
  return state;
}

// Entry point when run directly (`node server/src/index.js`).
const invoked = process.argv[1] && new URL("file://" + process.argv[1]).pathname;
if (invoked && invoked === new URL(import.meta.url).pathname) {
  const port = Number(process.env.PORT || PORT_DEFAULT);
  // Host binding: 0.0.0.0 when explicitly asked (Docker routes to the container
  // via its eth0 address); the Docker publish pins 127.0.0.1 on the HOST, which
  // is the loopback-only guarantee. Bare host runs default to loopback.
  const bind = process.env.BIND_ALL === "1" ? "0.0.0.0" : "127.0.0.1";
  buildServer().listen(port, bind, () => {
    console.log(`${APP_ID} listening on http://${bind}:${port}`);
  });
}
