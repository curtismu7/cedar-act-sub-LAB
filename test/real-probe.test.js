// The owner-run real probe: its pure parts (env validation, verdict classification) and its refusal to run, all without a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv, validateEnv, parseMcpBody, classifyVerdict, toolNames, describeAct, redact, tokenLine, formatVerdict, probeCalls, basicAuthValue, isAllGrantRefused, REQUIRED_ENV, DEFAULT_INDEX } from "../scripts/real-probe-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const example0 = () => parseEnv(readFileSync(join(root, ".env.example"), "utf8"));
const FILLED = {
  PF_ISSUER: "https://pf.test",
  PF_CLIENT_ID: "probe-client-1",
  PF_CLIENT_SECRET: "s3cret-value-for-test",
  PF_SCOPE: "probe:read",
  DOOR_URL: "https://door.test/mcp"
};

test("the five required names are exactly the documented ones, and .env.example lists them", () => {
  assert.deepEqual(REQUIRED_ENV, ["PF_ISSUER", "PF_CLIENT_ID", "PF_CLIENT_SECRET", "PF_SCOPE", "DOOR_URL"]);
  assert.ok(!("PF_AUDIENCE" in example0()), "RP-4: the audience is DOOR_URL, there is no separate PF_AUDIENCE");
  const example = parseEnv(readFileSync(join(root, ".env.example"), "utf8"));
  for (const k of REQUIRED_ENV) assert.ok(k in example, k);
  for (const k of ["PF_ISSUER", "DOOR_URL"]) assert.match(example[k], /\.(example|invalid)(\/|$)/, `${k} is a placeholder host`);
});

test("parseEnv reads KEY=VALUE, skips comments and blanks, strips one pair of quotes", () => {
  const env = parseEnv('# comment\n\nA=1\nexport B="two words"\nC=\'x\'\n  D = spaced  \nnot a pair\n#E=hidden');
  assert.deepEqual(env, { A: "1", B: "two words", C: "x", D: "spaced" });
});

test("validateEnv: a full, real-looking .env is accepted", () => {
  assert.deepEqual(validateEnv(FILLED), { ok: true, missing: [], problems: [] });
});

test("validateEnv refuses unless all five values are set (each one, one at a time)", () => {
  for (const k of REQUIRED_ENV) {
    const env = { ...FILLED, [k]: "" };
    const r = validateEnv(env);
    assert.equal(r.ok, false, k);
    assert.deepEqual(r.missing, [k]);
  }
  assert.equal(validateEnv({}).missing.length, 5);
  assert.equal(validateEnv(undefined).ok, false);
  assert.equal(validateEnv({ ...FILLED, PF_CLIENT_ID: "   " }).ok, false);
});

test("validateEnv refuses placeholder hosts, plain http off loopback, credentials in a URL and bad URLs, and never echoes a value", () => {
  assert.match(validateEnv({ ...FILLED, PF_ISSUER: "https://pf.example" }).problems[0], /placeholder host/);
  assert.match(validateEnv({ ...FILLED, DOOR_URL: "https://door.invalid/mcp" }).problems[0], /placeholder host/);
  assert.match(validateEnv({ ...FILLED, DOOR_URL: "http://door.test/mcp" }).problems[0], /must be https/);
  assert.equal(validateEnv({ ...FILLED, DOOR_URL: "http://127.0.0.1:9000/mcp" }).ok, true, "loopback http is allowed");
  assert.match(validateEnv({ ...FILLED, PF_ISSUER: "https://user:pw@pf.test" }).problems.join(), /credentials/);
  assert.match(validateEnv({ ...FILLED, PF_ISSUER: "not a url" }).problems[0], /not a URL/);
  assert.match(validateEnv({ ...FILLED, PROBE_INDEX: "two words" }).problems[0], /PROBE_INDEX/);
  const all = JSON.stringify(validateEnv({ ...FILLED, PF_ISSUER: "https://user:pw@pf.test", PROBE_INDEX: "a b" }));
  assert.ok(!all.includes(FILLED.PF_CLIENT_SECRET) && !all.includes("pw@"), "no value is echoed");
});

test("classifyVerdict: allowed, refused by policy (reason kept), token rejected, grant-layer refusal, allowed-with-tool-error, unreadable", () => {
  const ok = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "3" }] } };
  assert.deepEqual(classifyVerdict({ status: 200, body: ok }), { verdict: "allowed", reason: "served" });
  const deny = { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "action denied by policy: ListIndexTool requires act.sub to be agent-b-example" } };
  assert.deepEqual(classifyVerdict({ status: 400, body: deny }), { verdict: "refused-by-policy", reason: deny.error.message });
  assert.equal(classifyVerdict({ status: 200, body: deny }).verdict, "refused-by-policy", "even on a 200 the JSON-RPC error message decides");
  assert.equal(classifyVerdict({ status: 400, body: { error: { code: 0, message: "Action DENIED BY POLICY: X" } } }).verdict, "refused-by-policy", "case-insensitive");
  assert.equal(classifyVerdict({ status: 400, body: { error: { code: -32000, message: "denied by policy" } } }).verdict, "refused-by-policy", "any code with the phrase");
  assert.deepEqual(classifyVerdict({ status: 401, body: null }), { verdict: "token-rejected", reason: "HTTP 401: the door did not accept the token" });
  assert.equal(classifyVerdict({ status: 403, body: null }).verdict, "refused-at-grant");
  assert.match(classifyVerdict({ status: 403, body: null }).reason, /^HTTP 403: refused by a policy at the grant layer/);
  const te = classifyVerdict({ status: 200, body: { result: { isError: true, content: [] } } });
  assert.equal(te.verdict, "allowed");
  assert.equal(te.toolError, true);
  assert.equal(te.reason, "tool returned an error, not a policy refusal");
  assert.equal(classifyVerdict({ status: 200, body: ok }).toolError, undefined);
  assert.equal(classifyVerdict({ status: 200, body: null }).verdict, "unreadable");
  assert.equal(classifyVerdict({ status: 500, body: "html" }).verdict, "unreadable");
  assert.equal(classifyVerdict({ status: 200, body: { error: { code: -32000, message: "boom" } } }).verdict, "unreadable");
});

test("RP-1: a bare JSON-RPC -32600 (Invalid Request, session or protocol faults) is NOT a policy refusal", () => {
  for (const status of [200, 400]) {
    const r = classifyVerdict({ status, body: { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Bad Request: server not initialized" } } });
    assert.equal(r.verdict, "unreadable", `HTTP ${status}`);
    assert.match(r.reason, /-32600/);
  }
  assert.equal(classifyVerdict({ status: 400, body: { error: { code: -32600 } } }).verdict, "unreadable", "no message at all");
  assert.equal(classifyVerdict({ status: 400, body: { error: { code: -32600, message: "denied by" } } }).verdict, "unreadable", "only the whole phrase counts");
});

test("RP-7: 401 and 403 are told apart, and the labels say what they mean", () => {
  assert.equal(classifyVerdict({ status: 401, body: null }).verdict, "token-rejected");
  assert.equal(classifyVerdict({ status: 403, body: null }).verdict, "refused-at-grant");
  assert.equal(classifyVerdict({ status: 403, body: { error: { message: "denied by policy: x" } } }).verdict, "refused-by-policy", "a policy message wins over the status");
});

test("parseMcpBody reads plain JSON and the data: line of an event stream, and nothing else", () => {
  assert.deepEqual(parseMcpBody('{"a":1}'), { a: 1 });
  assert.deepEqual(parseMcpBody('event: message\ndata: {"result":{"tools":[]}}\n\n'), { result: { tools: [] } });
  assert.equal(parseMcpBody(""), null);
  assert.equal(parseMcpBody("<html>"), null);
  assert.equal(parseMcpBody(undefined), null);
  // several frames: the one that carries the reply wins over notifications; a data: payload split over lines is joined
  const multi = 'event: message\ndata: {"method":"notifications/progress","params":{}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
  assert.deepEqual(parseMcpBody(multi), { jsonrpc: "2.0", id: 1, result: { ok: true } });
  assert.deepEqual(parseMcpBody('data: {"a":\ndata: 1}\n\n'), { a: 1 });
  assert.deepEqual(parseMcpBody('data:{"x":2}\r\n\r\n'), { x: 2 }, "no space after the colon, CRLF");
  assert.equal(parseMcpBody("data: not json\n\n"), null);
});

test("toolNames lists the names in a tools/list reply, or null", () => {
  assert.deepEqual(toolNames({ result: { tools: [{ name: "CountTool" }, { name: "ListIndexTool" }, {}] } }), ["CountTool", "ListIndexTool"]);
  assert.equal(toolNames({ result: {} }), null);
  assert.equal(toolNames(null), null);
});

test("describeAct tells an object, text and absent apart, and shows only act.sub", () => {
  assert.deepEqual(describeAct({ act: { sub: "agent-client-example", other: "x" } }), { actType: "object", actSub: "agent-client-example" });
  assert.deepEqual(describeAct({ act: "{}" }), { actType: "text", actSub: null });
  assert.deepEqual(describeAct({}), { actType: "absent", actSub: null });
  assert.deepEqual(describeAct(null), { actType: "absent", actSub: null });
  assert.deepEqual(describeAct({ act: {} }), { actType: "object", actSub: null });
});

test("redact removes secrets and JWT-shaped strings and caps the length", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
  assert.equal(redact(`token ${jwt} and s3cret-value`, ["s3cret-value"]), "token <token> and <redacted>");
  assert.equal(redact("x".repeat(500)).length, 243);
  assert.equal(redact(undefined), "");
  assert.equal(redact("ab", ["ab"]), "ab", "a too-short secret is not treated as one");
});

test("HI-1: redact also removes bearer/basic values, token-shaped key=value pairs, and control characters", () => {
  assert.equal(redact("auth=Bearer abc.def-ghi_jkl== done"), "auth=Bearer <redacted> done");
  assert.equal(redact("authorization: Basic Zm9vOmJhcg== x"), "authorization: Basic <redacted> x");
  assert.equal(redact('{"access_token":"opaque-value-123","x":1}'), '{"access_token":"<redacted>","x":1}');
  assert.equal(redact("client_secret=zzzz1234&a=b"), "client_secret=<redacted>&a=b");
  assert.equal(redact("a\u001b[31mred\u001b[0m\nb\u202ec"), "a [31mred [0m b c");
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(redact("x\u0000y\u0007z\r\n\u2028\u202e\u2066")));
  const tok = "opaque0123456789token";
  assert.ok(!redact(`${tok} and ${encodeURIComponent("a b&c")}`, [tok, "a b&c"]).includes(tok));
  assert.ok(!redact(`x ${encodeURIComponent("p@ss w/rd")} y`, ["p@ss w/rd"]).includes("p%40ss"), "the url-encoded form of a secret is redacted too");
});

test("basicAuthValue is the client credentials as HTTP Basic (the proven client auth method)", () => {
  assert.equal(basicAuthValue("id1", "sec2"), Buffer.from("id1:sec2").toString("base64"));
});

test("RP-3: the probe calls CountTool with {index} (default gateway-events, configurable) and ListIndexTool with {}", () => {
  assert.equal(DEFAULT_INDEX, "gateway-events");
  assert.deepEqual(probeCalls(), [
    { name: "CountTool", arguments: { index: "gateway-events" } },
    { name: "ListIndexTool", arguments: {} }
  ]);
  assert.deepEqual(probeCalls("other-index")[0], { name: "CountTool", arguments: { index: "other-index" } });
  assert.deepEqual(probeCalls("")[0].arguments, { index: "gateway-events" }, "empty falls back to the default");
});

test("HI-2: placeholder client id, secret and scope are refused even when both hosts are real, and no value is echoed", () => {
  for (const [k, v] of [["PF_CLIENT_SECRET", "replace-me"], ["PF_CLIENT_SECRET", "Replace-Me"], ["PF_CLIENT_ID", "agent-client-example"], ["PF_SCOPE", "replace-me"], ["PF_SCOPE", "ok:scope replace-me"]]) {
    const r = validateEnv({ ...FILLED, [k]: v });
    assert.equal(r.ok, false, `${k}=${v}`);
    assert.match(r.problems.join(), new RegExp(`${k} is still a placeholder`));
    assert.ok(!JSON.stringify(r).includes(v), "value not echoed");
  }
  assert.equal(validateEnv({ ...FILLED, PF_SCOPE: "a:b c:d" }).ok, true, "a multi-scope value is fine");
});

test("optional PROBE_INDEX: absent is fine, a bad value is a problem that does not echo it", () => {
  assert.equal(validateEnv({ ...FILLED, PROBE_INDEX: "my-index" }).ok, true);
  const bad = validateEnv({ ...FILLED, PROBE_INDEX: "x".repeat(200) });
  assert.equal(bad.ok, false);
  assert.ok(!JSON.stringify(bad).includes("xxxxxxxx"));
});

test("formatVerdict prints the label, the verdict and the reason unless allowed", () => {
  assert.equal(formatVerdict("CountTool", { verdict: "allowed", reason: "served" }), "CountTool      allowed");
  assert.match(formatVerdict("ListIndexTool", { verdict: "refused-by-policy", reason: "why" }), /^ListIndexTool\s+refused-by-policy: why$/);
  assert.equal(formatVerdict("CountTool", { verdict: "allowed", reason: "tool returned an error, not a policy refusal", toolError: true }), "CountTool      allowed (tool returned an error, not a policy refusal)");
});

test("HI-1: formatVerdict redacts the reason itself, so no call site can skip it", () => {
  const out = formatVerdict("tools/list", { verdict: "unreadable", reason: "echo Bearer tok-abcdef123456 and sekret-value-77" }, ["sekret-value-77"]);
  assert.ok(!out.includes("tok-abcdef123456") && !out.includes("sekret-value-77"), out);
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
  assert.ok(!formatVerdict("x", { verdict: "unreadable", reason: `see ${jwt}` }).includes(jwt), "even with no secrets passed");
});

function runProbe(envText) {
  const dir = mkdtempSync(join(tmpdir(), "real-probe-"));
  const envFile = join(dir, "probe.env");
  if (envText !== null) writeFileSync(envFile, envText);
  // The probe is refused before any request, so no network is needed; an unreachable proxy makes a stray request fail loudly instead.
  const r = spawnSync(process.execPath, ["scripts/real-probe.mjs"], { cwd: root, env: { ...process.env, REAL_PROBE_ENV: envFile }, encoding: "utf8", timeout: 20000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("the probe refuses to run with no .env, with a partial .env, and with the placeholder file, printing no value", () => {
  let r = runProbe(null);
  assert.equal(r.code, 2);
  assert.match(r.out, /no \.env/);
  assert.match(r.out, /Nothing was sent/);

  r = runProbe("PF_ISSUER=https://pf.test\nPF_CLIENT_SECRET=hunter2-secret\n");
  assert.equal(r.code, 2);
  assert.match(r.out, /missing PF_CLIENT_ID, PF_SCOPE, DOOR_URL/);
  assert.ok(!r.out.includes("hunter2-secret"));

  r = runProbe(readFileSync(join(root, ".env.example"), "utf8"));
  assert.equal(r.code, 2);
  assert.match(r.out, /placeholder host/);
  assert.ok(!r.out.includes("replace-me"));
});

test("the probe script is read-only toward the tenant: it only POSTs the token request and MCP calls, never touches policies", () => {
  const src = readFileSync(join(root, "scripts", "real-probe.mjs"), "utf8") + readFileSync(join(root, "scripts", "real-probe-lib.mjs"), "utf8");
  assert.ok(!/DELETE|PUT|PATCH/.test(src), "no mutating verb");
  assert.ok(!/\/polic/i.test(src), "no policy endpoint");
  assert.ok(!/initialize/.test(src), "RP-2: no initialize handshake and no session plumbing");
  assert.ok(!/mcp-session-id/i.test(src), "RP-2: no session header");
  const server = readFileSync(join(root, "server", "src", "index.js"), "utf8");
  assert.ok(!/real-probe/.test(server), "the server never imports the probe");
});

test("tokenLine shows a token-shaped value on one labelled line and nothing else", () => {
  const jwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
  assert.equal(tokenLine(jwt), `token          REAL access token, shown on purpose (learning lab): ${jwt}`);
  assert.ok(tokenLine("opaque-ref_token~abc123=="), "an opaque token is shown too");
  assert.equal(tokenLine("short"), null, "too short to be a token");
  assert.equal(tokenLine("a".repeat(8193)), null, "too long to be a token");
  for (const bad of ["abc def ghi jkl", "token\nsecond-line-injected", "tok\u001b[31men-with-escape", "tok\u202een-with-bidi", "tok;rm -rf x", `"quoted-token-value"`]) {
    assert.equal(tokenLine(bad), null, `refused: ${JSON.stringify(bad)}`);
  }
  assert.equal(tokenLine(undefined), null);
});

test("the client secret and the Basic value are still redacted even though the token is shown", () => {
  assert.equal(redact("client_secret=s3cret-value-123 and Basic YWJjOmRlZg==", ["s3cret-value-123"]), "client_secret=<redacted> and Basic <redacted>");
});

test("redact is case-insensitive and also removes the base64 forms of a secret", () => {
  const secret = "Sekret-Value-9f8e7d6c";
  const b64 = Buffer.from(secret).toString("base64");
  const b64url = Buffer.from(secret).toString("base64url");
  for (const form of [secret, secret.toUpperCase(), secret.toLowerCase(), encodeURIComponent(secret).toUpperCase(), b64, b64.toUpperCase(), b64.toLowerCase(), b64.replace(/=+$/, ""), b64url]) {
    const out = redact(`reply says ${form} here`, [secret]);
    assert.ok(!out.toLowerCase().includes(form.toLowerCase()), `leaked ${form.slice(0, 8)}...: ${out}`);
    assert.match(out, /<redacted>/);
  }
});

test("redact treats regex characters in a secret literally", () => {
  assert.equal(redact("a.b*c(d) and aXbbbc(d)", ["a.b*c(d)"]), "<redacted> and aXbbbc(d)");
});

test("isAllGrantRefused: only a run where every call was HTTP 403 (no AI policy was evaluated)", () => {
  const g = { verdict: "refused-at-grant" };
  assert.equal(isAllGrantRefused([g, g, g]), true);
  assert.equal(isAllGrantRefused([g, g, { verdict: "allowed" }]), false);
  assert.equal(isAllGrantRefused([g, g, { verdict: "refused-by-policy" }]), false);
  assert.equal(isAllGrantRefused([]), false);
});
