// The real probe, run as a whole process against fake PingFederate + door listeners on 127.0.0.1 (started here, closed after).
// This proves the probe's wire behaviour and its printing rules without a tenant. It does NOT prove anything about a real PingFederate or a real
// Privilege door: the fakes only encode what the 2026-11-16 scratch run showed (see README, "Run it yourself").
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_ID = "probe-client-1";
const SECRET = "sekret-Value-9f8e7d6c5b4a";
const SCOPE = "probe:read";
const B64 = Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64");
const SECRET_B64 = Buffer.from(SECRET).toString("base64");
const seg = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = `${seg({ alg: "none" })}.${seg({ act: { sub: "probe-agent-example" }, iss: "x" })}.c2lnbmF0dXJlc2lnbmF0dXJl`;
const OPAQUE = "opaque-access-token-0123456789abcdef";
// A hostile token whose act.sub carries the client secret: the line that prints act.sub must redact it too.
const SECRET_SUB_TOKEN = `${seg({ alg: "none" })}.${seg({ act: { sub: `agent-${SECRET}` } })}.c2lnbmF0dXJlc2lnbmF0dXJl`;

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}
const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => resolve(b)); });

// opts: shape json|sse, refuse, echo, doorStatus, toolError, strictSession, pfFail, pfRedirect, doorRedirect, opaque, expectIndex
async function fakes(opts = {}) {
  const log = [];
  const token = opts.opaque ? OPAQUE : opts.secretSub ? SECRET_SUB_TOKEN : TOKEN;
  const other = await listen((req, res) => { log.push({ who: "other", method: req.method, url: req.url }); res.end("other"); });
  const otherUrl = `http://127.0.0.1:${other.address().port}/landed`;
  let doorUrl;
  const pf = await listen(async (req, res) => {
    const body = await readBody(req);
    const form = new URLSearchParams(body);
    const entry = { who: "pf", method: req.method, url: req.url, auth: req.headers.authorization, fields: [...form.keys()], form: Object.fromEntries(form) };
    log.push(entry);
    if (opts.pfRedirect) { res.writeHead(302, { location: otherUrl }); return res.end(); }
    const good = req.method === "POST" && req.url === "/as/token.oauth2" && req.headers.authorization === `Basic ${B64}`
      && form.get("grant_type") === "client_credentials" && form.get("scope") === SCOPE && form.get("audience") === doorUrl
      && !form.has("client_id") && !form.has("client_secret") && /^application\/x-www-form-urlencoded/.test(req.headers["content-type"] || "");
    entry.good = good;
    if (opts.pfFail || !good) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid_client", error_description: opts.echo ? `bad auth ${req.headers.authorization || ""} secret ${SECRET} upper ${SECRET.toUpperCase()} b64 ${SECRET_B64} body ${body}` : "bad client" }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 300 }));
  });
  const door = await listen(async (req, res) => {
    const text = await readBody(req);
    const entry = { who: "door", method: req.method, url: req.url, headers: req.headers };
    log.push(entry);
    if (opts.doorRedirect) { res.writeHead(307, { location: otherUrl }); return res.end(); }
    let rpc = null;
    try { rpc = JSON.parse(text); } catch { /* leave null */ }
    entry.rpcMethod = rpc && rpc.method;
    entry.params = rpc && rpc.params;
    // The first thing in the echo is the new forms (the probe caps a printed reason at 240 characters): upper-cased secret, base64 of the secret.
    const echo = opts.echo ? ` echo upper=${SECRET.toUpperCase()} sb64=${SECRET_B64} sb64u=${SECRET_B64.toUpperCase()} basicu=${B64.toUpperCase()} auth=${req.headers.authorization} secret=${SECRET} b64=${B64} access_token="${token}" client_secret=${SECRET} raw=${token}` : "";
    const send = (status, obj) => {
      if (opts.shape === "sse") {
        res.writeHead(status === 400 ? 200 : status, { "content-type": "text/event-stream" });
        return res.end(`event: message\ndata: ${JSON.stringify(obj)}\n\n`);
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const headersOk = req.method === "POST" && /^application\/json/.test(req.headers["content-type"] || "")
      && /application\/json/.test(req.headers.accept || "") && /text\/event-stream/.test(req.headers.accept || "")
      && req.headers.authorization === `Bearer ${token}`;
    entry.headersOk = headersOk;
    if (!headersOk || !rpc) return send(400, { jsonrpc: "2.0", id: null, error: { code: -32000, message: `bad request${echo}` } });
    if (opts.forbidTool && rpc.method === "tools/call" && rpc.params && rpc.params.name === opts.forbidTool) { res.writeHead(403, { "content-type": "text/plain" }); return res.end("no"); }
    if (opts.doorStatus) { res.writeHead(opts.doorStatus, { "content-type": "text/plain" }); return res.end(`no${echo}`); }
    if (opts.strictSession) return send(400, { jsonrpc: "2.0", id: rpc.id, error: { code: -32600, message: `Bad Request: server not initialized${echo}` } });
    if (opts.echo && rpc.method === "tools/list") return send(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: `list failed${echo}` } });
    if (rpc.method === "tools/list") return send(200, { jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "CountTool" }, { name: "ListIndexTool" }] } });
    if (rpc.method === "tools/call") {
      const { name, arguments: args } = rpc.params || {};
      if (name === "CountTool") {
        if (!args || args.index !== (opts.expectIndex || "gateway-events")) return send(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: "Invalid params: index required" } });
        if (opts.toolError) return send(200, { jsonrpc: "2.0", id: rpc.id, result: { isError: true, content: [{ type: "text", text: "no such index" }] } });
        return send(200, { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "3" }] } });
      }
      if (name === "ListIndexTool") {
        if (args && Object.keys(args).length) return send(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: "Invalid params" } });
        if (opts.refuse) return send(400, { jsonrpc: "2.0", id: rpc.id, error: { code: -32600, message: `action denied by policy: ListIndexTool requires act.sub to be agent-b-example${echo}` } });
        return send(200, { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "[]" }] } });
      }
    }
    return send(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
  });
  doorUrl = `http://127.0.0.1:${door.address().port}/mcp`;
  const issuer = `http://127.0.0.1:${pf.address().port}`;
  const close = () => Promise.all([pf, door, other].map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); })));
  return { log, doorUrl, issuer, close, token };
}

function runProbe(envObj) {
  const dir = mkdtempSync(join(tmpdir(), "real-probe-e2e-"));
  const envFile = join(dir, "probe.env");
  writeFileSync(envFile, Object.entries(envObj).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/real-probe.mjs"], { cwd: root, env: { ...process.env, REAL_PROBE_ENV: envFile } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 40000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, out: `${stdout}${stderr}` }); });
  });
}
const baseEnv = (f, extra = {}) => ({ PF_ISSUER: f.issuer, PF_CLIENT_ID: CLIENT_ID, PF_CLIENT_SECRET: SECRET, PF_SCOPE: SCOPE, DOOR_URL: f.doorUrl, ...extra });
async function withFakes(opts, fn, envExtra) {
  const f = await fakes(opts);
  try { return await fn(f, await runProbe(baseEnv(f, envExtra))); } finally { await f.close(); }
}
// The secret and the Basic value, in every form a door could echo them: as is, upper-cased, base64 of the secret (also upper-cased).
const noSecretIn = (out) => {
  const low = out.toLowerCase();
  for (const v of [SECRET, B64, SECRET_B64, SECRET_B64.replace(/=+$/, "")]) assert.ok(!low.includes(v.toLowerCase()), `leaked ${v.slice(0, 6)}... (any case): ${out.slice(0, 400)}`);
};
const doorCalls = (f) => f.log.filter((e) => e.who === "door");

for (const shape of ["json", "sse"]) {
  test(`end to end (${shape} replies), no policy: token minted with Basic auth + scope + audience, tools/list and both tools allowed, exit 0`, async () => {
    await withFakes({ shape }, (f, r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.stdout, /^tools\/list\s+allowed \(2 tools\)$/m);
      assert.match(r.stdout, /^CountTool\s+allowed$/m);
      assert.match(r.stdout, /^ListIndexTool\s+allowed$/m);
      assert.match(r.stdout, /token\s+issued; act is object, act\.sub = probe-agent-example/);
      const pfReqs = f.log.filter((e) => e.who === "pf");
      assert.equal(pfReqs.length, 1);
      assert.equal(pfReqs[0].good, true, "Basic client auth, grant_type, scope, audience = DOOR_URL, no client_id/client_secret in the body");
      assert.deepEqual(doorCalls(f).map((e) => e.rpcMethod), ["tools/list", "tools/call", "tools/call"], "RP-2: no initialize, nothing else");
      assert.ok(doorCalls(f).every((e) => e.headersOk && e.method === "POST" && e.url === "/mcp" && !("mcp-session-id" in e.headers)));
      assert.deepEqual(doorCalls(f)[1].params, { name: "CountTool", arguments: { index: "gateway-events" } });
      assert.deepEqual(doorCalls(f)[2].params, { name: "ListIndexTool", arguments: {} });
      assert.ok(f.log.every((e) => e.method === "POST"), "only POST, to the token endpoint and the door");
      assert.ok(f.log.every((e) => e.who !== "other"));
    });
  });

  test(`end to end (${shape} replies), a policy refuses ListIndexTool: refused-by-policy with the reason, CountTool still allowed, exit 0`, async () => {
    await withFakes({ shape, refuse: true }, (f, r) => {
      assert.equal(r.code, 0, r.out);
      assert.match(r.stdout, /^CountTool\s+allowed$/m);
      assert.match(r.stdout, /^ListIndexTool\s+refused-by-policy: action denied by policy: ListIndexTool requires act\.sub to be agent-b-example$/m);
    });
  });

  test(`HI-1 (${shape} replies): a door that echoes the bearer token, the client secret and the Basic value never gets them printed`, async () => {
    for (const refuse of [false, true]) {
      await withFakes({ shape, echo: true, refuse }, (f, r) => {
        noSecretIn(r.out);
        assert.equal(r.out.split(TOKEN).length - 1, 1, "the token is shown once, on its labelled line, and the door's echo of it is redacted");
        assert.match(r.stdout, new RegExp(`^token\\s+REAL access token, shown on purpose \\(learning lab\\): ${TOKEN.replace(/\./g, "\\.")}$`, "m"));
        assert.match(r.stdout, /^tools\/list\s+unreadable: JSON-RPC error -32000: list failed/m, "the line is still printed, redacted");
        assert.match(r.stdout, /<redacted>/);
        assert.match(r.stdout, /^CountTool\s+allowed$/m);
        if (refuse) assert.match(r.stdout, /^ListIndexTool\s+refused-by-policy: action denied by policy/m);
        assert.equal(r.code, 3, "tools/list was unreadable, so the run proved nothing about the policy");
      });
    }
  });
}

test("HI-1: an opaque (non-JWT) token is shown once on its labelled line and the door's echo of it is redacted", async () => {
  await withFakes({ shape: "json", echo: true, opaque: true }, (f, r) => {
    noSecretIn(r.out);
    assert.equal(r.out.split(OPAQUE).length - 1, 1, r.out);
    assert.match(r.stdout, new RegExp(`^token\\s+REAL access token, shown on purpose \\(learning lab\\): ${OPAQUE}$`, "m"));
    assert.match(r.stdout, /^tools\/list\s+unreadable/m);
  });
});

test("HI-1: a token whose act.sub contains the client secret does not print the secret on the token line", async () => {
  await withFakes({ secretSub: true }, (f, r) => {
    assert.ok(!r.out.includes(SECRET), r.out);
    assert.match(r.stdout, /token\s+issued; act is object, act\.sub = agent-<redacted>/);
  });
});

test("HI-1: when PingFederate refuses and echoes the Basic value, the secret and the body, none of it is printed (exit 1)", async () => {
  await withFakes({ pfFail: true, echo: true }, (f, r) => {
    assert.equal(r.code, 1);
    assert.match(r.out, /PingFederate did not issue a token \(HTTP 401\)/);
    noSecretIn(r.out);
    assert.equal(doorCalls(f).length, 0, "no door call without a token");
  });
});

test("HI-1: 401 / 403 bodies that echo the token are redacted (the token itself appears once, on its own line)", async () => {
  for (const doorStatus of [401, 403]) {
    await withFakes({ doorStatus, echo: true }, (f, r) => {
      noSecretIn(r.out);
      assert.equal(r.out.split(TOKEN).length - 1, 1, "only the labelled token line shows the token; the echoed error body is redacted");
    });
  }
});

test("RP-7: HTTP 401 is 'token-rejected' (exit 3); HTTP 403 on every call is 'refused-at-grant' and also exit 3 (no AI policy was evaluated)", async () => {
  await withFakes({ doorStatus: 401 }, (f, r) => {
    assert.match(r.stdout, /^CountTool\s+token-rejected: HTTP 401/m);
    assert.equal(r.code, 3);
  });
  await withFakes({ doorStatus: 403 }, (f, r) => {
    assert.match(r.stdout, /^CountTool\s+refused-at-grant: HTTP 403: refused by a policy at the grant layer/m);
    assert.doesNotMatch(r.stdout, /refused-by-policy/);
    assert.equal(r.code, 3, "every call 403: no AI policy was evaluated, so the run says nothing about the policy");
    assert.match(r.stdout, /says nothing about the policy/);
    assert.doesNotMatch(r.stdout, /it is the baseline/, "never the baseline sentence");
  });
});

test("a 200 with a tool isError result is 'allowed (tool returned an error, not a policy refusal)'", async () => {
  await withFakes({ toolError: true }, (f, r) => {
    assert.match(r.stdout, /^CountTool\s+allowed \(tool returned an error, not a policy refusal\)$/m);
    assert.equal(r.code, 0);
  });
});

test("RP-1: a strict door answering -32600 'not initialized' to everything is 'unreadable', never 'refused-by-policy', and exits 3", async () => {
  await withFakes({ strictSession: true }, (f, r) => {
    assert.doesNotMatch(r.out, /refused-by-policy/);
    assert.match(r.stdout, /^CountTool\s+unreadable: JSON-RPC error -32600: Bad Request: server not initialized/m);
    assert.equal(r.code, 3);
  });
});

test("RP-3: PROBE_INDEX changes the index CountTool is called with", async () => {
  await withFakes({ expectIndex: "other-events" }, (f, r) => {
    assert.match(r.stdout, /^CountTool\s+allowed$/m, r.out);
    assert.deepEqual(doorCalls(f)[1].params.arguments, { index: "other-events" });
  }, { PROBE_INDEX: "other-events" });
});

test("redirects are not followed: a 302 from the token endpoint and a 307 from the door never reach another host", async () => {
  await withFakes({ pfRedirect: true }, (f, r) => {
    assert.equal(r.code, 1);
    assert.equal(f.log.filter((e) => e.who === "other").length, 0);
    assert.equal(doorCalls(f).length, 0);
  });
  await withFakes({ doorRedirect: true }, (f, r) => {
    assert.equal(r.code, 1, r.out);
    assert.equal(f.log.filter((e) => e.who === "other").length, 0);
    assert.equal(r.out.split(TOKEN).length - 1, 1, "the token is shown once, on its labelled line");
  });
});

test("HI-2: placeholder client id, secret or scope with real-looking hosts: exit 2, nothing sent, no value printed", async () => {
  for (const extra of [{ PF_CLIENT_SECRET: "replace-me" }, { PF_CLIENT_ID: "agent-client-example" }, { PF_SCOPE: "replace-me" }]) {
    const f = await fakes();
    try {
      const r = await runProbe({ ...baseEnv(f), ...extra });
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, /placeholder/);
      assert.match(r.out, /Nothing was sent/);
      assert.equal(f.log.length, 0, "no request reached either listener");
      assert.ok(!r.out.includes(Object.values(extra)[0]));
    } finally { await f.close(); }
  }
});

test("the probe sends nothing but POSTs to the token endpoint and the door (never a policy call)", async () => {
  await withFakes({ shape: "json", refuse: true }, (f) => {
    const paths = new Set(f.log.map((e) => `${e.method} ${e.who} ${e.url}`));
    assert.deepEqual([...paths].sort(), ["POST door /mcp", "POST pf /as/token.oauth2"]);
  });
});

test("a run with no 403 still prints the baseline sentence and exits 0; a partly 403 run is not inconclusive", async () => {
  await withFakes({}, (f, r) => {
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /it is the baseline/);
    assert.doesNotMatch(r.stdout, /says nothing about the policy/);
  });
  await withFakes({ forbidTool: "ListIndexTool" }, (f, r) => {
    assert.match(r.stdout, /^CountTool\s+allowed$/m);
    assert.match(r.stdout, /^ListIndexTool\s+refused-at-grant/m);
    assert.equal(r.code, 0, r.out);
  });
});

test("redaction is case-insensitive and covers the base64 of the secret: nothing leaks even upper-cased or base64-encoded, the token stays shown", async () => {
  for (const refuse of [false, true]) {
    await withFakes({ echo: true, refuse }, (f, r) => {
      noSecretIn(r.out);
      assert.match(r.stdout, new RegExp(`^token\\s+REAL access token, shown on purpose \\(learning lab\\): ${TOKEN.replace(/\./g, "\\.")}$`, "m"));
    });
  }
});
