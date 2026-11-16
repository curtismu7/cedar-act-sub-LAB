#!/usr/bin/env node
// Owner-run real probe: `npm run real`. NOT part of the server and never run by tests against a tenant or by CI.
//   1. reads a local, git-ignored .env (PF_ISSUER, PF_CLIENT_ID, PF_CLIENT_SECRET, PF_SCOPE, DOOR_URL; optional PROBE_INDEX) and refuses to run
//      unless all five are set and none is still a placeholder
//   2. mints a PingFederate client-credentials token: POST <issuer>/as/token.oauth2, HTTP Basic client auth, form fields grant_type, scope and
//      audience (audience = DOOR_URL)
//   3. POSTs JSON-RPC to DOOR_URL with that Bearer token: tools/list, then CountTool {index} and ListIndexTool {}; no handshake, no session.
//      Replies are read as plain JSON or as server-sent-event `data:` frames. A verdict is printed for each call.
// It never creates or deletes a policy, follows no redirect, and contacts only the two origins in .env. It prints the access token it was issued
// (once, on a labelled line, with its decoded claims: this is a learning lab) but never the client secret or the Basic value, and everything else
// it prints, including anything the servers echo back, is redacted.
//
// EVIDENCE STATUS: the call sequence copies a scratch script that WAS run against a real PingFederate and a real Privilege door on 2026-11-16.
// This file itself has never been run against a real tenant: it is only exercised against local fake listeners (test/real-probe-e2e.test.js).
// Assumed, not tested by the lab: that your PF client accepts Basic auth and the scope in PF_SCOPE, that the index named by PROBE_INDEX exists
// on your door, that HTTP 403 means a grant-layer refusal, and that a policy refusal carries "denied by policy" in the JSON-RPC error message.
// Exit codes: 0 done, 1 a request failed, 2 refused to run (.env), 3 ran but a verdict was unreadable or the token was rejected.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { parseEnv, validateEnv, parseMcpBody, classifyVerdict, isInconclusive, toolNames, describeAct, redact, tokenLine, formatVerdict, probeCalls, basicAuthValue } from "./real-probe-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = process.env.REAL_PROBE_ENV || join(root, ".env");
const TIMEOUT_MS = 15000;
const MAX_BYTES = 256 * 1024;

// Everything printed goes through here. `secrets` is filled in as soon as each value exists, before anything could print it.
const secrets = [];
const say = (line) => console.log(redact(line, secrets));
const warn = (line) => console.error(redact(line, secrets));

async function readCapped(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) { await reader.cancel(); throw new Error("reply larger than the size cap"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function post(url, { headers, body }) {
  const res = await fetch(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: res.status, text: await readCapped(res) };
}

async function main() {
  if (!existsSync(envPath)) {
    warn(`real probe: no .env at ${envPath}. Copy .env.example to .env and fill in the five values. Nothing was sent.`);
    return 2;
  }
  const env = parseEnv(readFileSync(envPath, "utf8"));
  const check = validateEnv(env);
  if (!check.ok) {
    if (check.missing.length) warn(`real probe: .env is missing ${check.missing.join(", ")}. Nothing was sent.`);
    for (const p of check.problems) warn(`real probe: ${p}. Nothing was sent.`);
    return 2;
  }
  const basic = basicAuthValue(env.PF_CLIENT_ID, env.PF_CLIENT_SECRET);
  secrets.push(env.PF_CLIENT_SECRET, basic);
  const door = env.DOOR_URL;
  say(`real probe: token from ${new URL(env.PF_ISSUER).origin}, door ${new URL(door).origin}. Read-only: no policy is created or deleted.`);

  // 1. client-credentials token: HTTP Basic client auth, scope, audience = the door.
  let token;
  try {
    const tokenUrl = new URL("/as/token.oauth2", env.PF_ISSUER).toString();
    const form = new URLSearchParams({ grant_type: "client_credentials", scope: env.PF_SCOPE, audience: door });
    const r = await post(tokenUrl, { headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", authorization: `Basic ${basic}` }, body: form });
    const j = parseMcpBody(r.text);
    if (r.status !== 200 || !j || typeof j.access_token !== "string") {
      warn(`real probe: PingFederate did not issue a token (HTTP ${r.status}): ${(j && (j.error_description || j.error)) || "no JSON reply"}`);
      return 1;
    }
    token = j.access_token;
    secrets.push(token);
  } catch (e) {
    warn(`real probe: token request failed: ${e.message}`);
    return 1;
  }
  let claims = null;
  try { claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); } catch { /* opaque token */ }
  const act = describeAct(claims);
  say(`token          issued; act is ${act.actType}${act.actSub ? `, act.sub = ${act.actSub}` : ""}`);
  // Showing the token is deliberate: this is a learning lab. The client secret and the Basic value are never printed.
  console.log(tokenLine(token) ?? "token          (not shown: it contains characters a token never has)");
  if (claims) say(`claims         ${JSON.stringify(claims)}`);

  // 2. the baseline probe: tools/list, then one call per tool.
  let id = 0;
  const rpc = async (method, params) => {
    id += 1;
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` };
    const r = await post(door, { headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    return { status: r.status, body: parseMcpBody(r.text) };
  };
  const verdicts = [];
  try {
    const list = await rpc("tools/list", {});
    const names = toolNames(list.body);
    const listVerdict = classifyVerdict(list);
    verdicts.push(listVerdict);
    say(formatVerdict("tools/list", listVerdict, secrets) + (names ? ` (${names.length} tools)` : ""));
    for (const call of probeCalls(env.PROBE_INDEX)) {
      const v = classifyVerdict(await rpc("tools/call", call));
      verdicts.push(v);
      say(formatVerdict(call.name, v, secrets));
    }
  } catch (e) {
    warn(`real probe: the door call failed: ${e.message}`);
    return 1;
  }
  if (verdicts.some(isInconclusive)) {
    say("real probe: done, but at least one call was unreadable or the token was rejected, so this run says nothing about the policy.");
    return 3;
  }
  say("real probe: done. This prints one token's two calls. With no policy it is the baseline; whether a policy exists is up to you, this script creates none.");
  return 0;
}

// Let stdout and stderr drain before exiting, so a piped reader never loses the last lines.
const code = await main();
process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
