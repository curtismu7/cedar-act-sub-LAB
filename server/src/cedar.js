// The mock Privilege door. It evaluates ONE rule shape, the one the AI Policy template "Restrict a tool to tokens carrying a claim"
// generates for act.sub. It is not a Cedar engine and it decides nothing real: any other policy text is out of scope here.
//
// The rule, per tool and agent. Only the `contains` test inside `forbid ... unless` was read from a real tenant on 2026-11-16 (see EVIDENCE
// in scenarios.js); the lines around it are the shape this lab reconstructs, copied from the sibling lab, and are UNVERIFIED against the tenant.
// Door scoping (`context.app == "<door>"`) is only shown in the text: the mock has no door argument and does not evaluate it.
//   @reason("<Tool> requires act.sub to be <agent>")
//   forbid (principal, action == Action::"mcp:Invoke", resource == Tool::"<Tool>")
//   when   { context.app == "<door>" }
//   unless { context.token.claims has "act.sub" && context.token.claims["act.sub"].contains("<agent>") };

export const DOOR = "door-example";
export const DOOR_URL = "https://door.example/mcp";
export const ISSUER = "https://pf.example";
export const TOOLS = ["CountTool", "ListIndexTool"];
export const AGENT_A = "agent-client-example";
export const AGENT_B = "agent-b-example";

// A tool or agent id goes into Cedar text, so it must be plain: no quotes, no newlines, nothing that ends the string early.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function actSubPolicy({ id, tool, agent, state = "Active" }) {
  if (!SAFE_ID.test(tool) || !SAFE_ID.test(agent)) throw new Error("tool and agent must be plain ids");
  if (state !== "Active" && state !== "Candidate") throw new Error("state must be Active or Candidate");
  return { id, tool, agent, state, reason: `${tool} requires act.sub to be ${agent}` };
}

// The exact Cedar text of one policy.
export function cedarText(p) {
  return [
    `@reason("${p.reason}")`,
    `forbid (principal, action == Action::"mcp:Invoke", resource == Tool::"${p.tool}")`,
    `when   { context.app == "${DOOR}" }`,
    `unless { context.token.claims has "act.sub"`,
    `         && context.token.claims["act.sub"].contains("${p.agent}") };`
  ].join("\n");
}

// The act.sub the policy reads. In the measured token act was an object {"sub": "<agent>"}; the mock reads the nested value act -> sub.
// act that is not an object with its OWN `sub` (the TEXT "{}", an empty object, a list, null, an inherited sub) gives no act.sub here,
// so `has` is false and the forbid applies. That is this mock's rule; whether the real door agrees for act as text was not measured.
export function claimActSub(claims) {
  const act = claims && claims.act;
  if (act && typeof act === "object" && !Array.isArray(act) && Object.prototype.hasOwnProperty.call(act, "sub")) return act.sub;
  return undefined;
}

// MATCHING SEMANTICS of `<claim>.contains("<agent>")` in this mock: EXACT, case-sensitive equality of the whole claim value with the
// policy's agent id (a string claim), or exact element equality (a list claim, i.e. set membership). No substring, prefix, suffix, case
// folding, trimming, Unicode normalisation or pattern matching; a non-string value, a nested list or null never matches.
//
// Why exact, and how much of that is known (no overclaiming):
//  - MEASURED (2026-11-16, one real tenant, one real agent): a policy whose agent id equals the token's act.sub allowed the call, and a
//    policy naming a different id refused it. That is all that was observed.
//  - NOT measured: whether the real door compares exactly, by substring, or by set membership (for example whether "agent-client"
//    matches "agent-client-example"). The mock chooses exact because that is what Cedar's own semantics give for the pieces involved:
//    Cedar's `.contains()` is a SET operation (membership by element equality), and Cedar string `==` is exact and case-sensitive. The
//    language, as far as that reference goes, has no substring `.contains()` on strings; its string pattern operator is `like` (so Cedar
//    is not regex-free, but this template does not use `like`).
//    Source: the Cedar language reference, operators and functions (docs.cedarpolicy.com), from general knowledge, NOT re-fetched or
//    re-run for this lab.
//  - ASSUMED, not measured: how Privilege hands a JWT claim that is a plain string (act.sub in the measured token) to `.contains()`.
//    A set-typed `.contains()` on a string is a type error in Cedar proper, yet the real door allowed and refused as above, so Privilege
//    evidently presents the claim so that `.contains()` works. The mock treats a string claim as a one-element set. The real door's
//    treatment of a list-valued claim was not measured either.
function contains(value, wanted) {
  if (typeof value === "string") return value === wanted;
  if (Array.isArray(value)) return value.includes(wanted);
  return false;
}

// Does the policy forbid this call? Only Active policies on the tool are enforced; a Candidate is not (per the Privilege console
// documentation; not re-run here, UNVERIFIED).
// Fails closed: no claims at all means the `has` test is false, so the `unless` is false and the forbid applies.
export function policyRefuses(p, tool, claims) {
  if (p.state !== "Active" || p.tool !== tool) return false;
  const actSub = claimActSub(claims);
  return !(actSub !== undefined && contains(actSub, p.agent));
}

// One tools/call through the mock door. Returns the HTTP status, the JSON-RPC refusal if any, and the hops (for the trace).
// `now` (ms) is a parameter so the expiry boundary can be tested deterministically.
export function callTool({ token, tool, policies, verifyFn, now = () => Date.now() }) {
  const hops = [];
  if (!token) {
    hops.push({ stage: "signin", ok: false, reason: "gateway refused the call at sign-in: 401 Bearer token required (simulated wording, mirrored from the sibling lab, not measured)" });
    return { ok: false, http: 401, hops, reason: hops[0].reason };
  }
  const v = verifyFn(token);
  const p = v.ok ? v.payload : null;
  let problem = null;
  if (!v.ok) problem = v.reason;
  else if (p.iss !== ISSUER) problem = `issuer ${p.iss || "(none)"} does not match ${ISSUER}`;
  else if (p.aud !== DOOR_URL) problem = `audience ${p.aud || "(none)"} does not match ${DOOR_URL}`;
  else if (typeof p.exp !== "number" || p.exp <= Math.floor(now() / 1000)) problem = "token expired";
  if (problem) {
    hops.push({ stage: "signin", ok: false, reason: `workload token rejected: ${problem}` });
    return { ok: false, http: 401, hops, reason: hops[0].reason };
  }
  hops.push({ stage: "signin", ok: true, reason: "simulated sign-in: issuer, signature, audience and lifetime matched (the real door's checks were not measured)", payload: p });

  const onTool = policies.filter((x) => x.tool === tool);
  const refusing = onTool.find((x) => policyRefuses(x, tool, p));
  if (refusing) {
    const reason = `action denied by policy: ${refusing.reason}`;
    hops.push({ stage: "cedar", ok: false, reason, policy: refusing.id });
    return { ok: false, http: 400, hops, reason: `JSON-RPC -32600 ${reason}`, rpcMessage: reason };
  }
  const active = onTool.filter((x) => x.state === "Active");
  const candidates = onTool.filter((x) => x.state === "Candidate");
  let why;
  if (active.length) why = `Active policy ${active.map((x) => x.id).join(", ")} did not refuse ${tool}: the token's act.sub matched`;
  else if (candidates.length) why = `policy ${candidates.map((x) => x.id).join(", ")} is a Candidate: not enforced, so it cannot refuse ${tool} (per the console documentation, not re-run here)`;
  else why = `no policy targets ${tool}`;
  hops.push({ stage: "cedar", ok: true, reason: why });
  hops.push({ stage: "done", ok: true, reason: `200: ${tool} served` });
  return { ok: true, http: 200, hops, reason: `200: ${tool} served` };
}
