# cedar-act-sub-LAB

Tier: Tester

Structure forked from pf-privilege-obo-LAB (server, web shell, vendored shared components, scripts, tests and CI layout). That lab's scenario content was removed and replaced; none of its scenarios, ids or copy is kept.

**Does Privilege's Cedar match the agent's `act.sub` claim? A measured run, simulated here.**

Cedar is the policy language Privilege uses for its AI policies; this lab shows one rule shape in it. The AI Policy template "Restrict a tool to tokens carrying a claim" generates a Cedar `forbid ... unless` rule on `context.token.claims["act.sub"]`. On 2026-11-16 that rule was run on a real Privilege tenant with a real PingFederate token (`act` as an object `{"sub": "<agent>"}`), and the result is on the page as static evidence. This lab replays that shape in-process so you can click through it.

## What the page walks

1. **Baseline** (no policy): the same token calls `CountTool` and `ListIndexTool`; both are allowed.
2. **Add two Active `act.sub` policies**: the Cedar this lab generates for them is shown (the shape of the template, with example ids; only the `contains(...)` test inside `forbid ... unless` was read from the tenant, the lines around it are copied from the sibling lab and are UNVERIFIED). Policy A on `CountTool` requires the token's own agent; policy B on `ListIndexTool` requires a different agent.
3. **Same token, two tools**: `CountTool` allowed, `ListIndexTool` refused (`action denied by policy: ListIndexTool requires act.sub to be agent-b-example`, JSON-RPC -32600, HTTP 400 on the mock).
4. **Remove the policies**: back to baseline.

Extra scenarios (simulated, none measured): `act` emitted as the text `"{}"` is believed to leave the rule with no `act.sub`, so it should never match (UNVERIFIED); with no token this mock refuses at sign-in (401, wording copied from the sibling lab); per the Privilege console documentation a Candidate policy is not enforced (not re-run here, UNVERIFIED), so the mock allows the call.

Every call shows **What the mock door did (simulated)** (the family's shared trace panel, relabelled for this lab through its title and basis-note props; the panel's own fixed lead sentence is hidden by the lab's stylesheet because the panel file is byte-pinned): the request, the reply, and the two checks in between (sign-in, AI policy), each marked `checked` because the lab's own mock door computed it. It is not Privilege.

## Honest scope

- The mock door is an in-process **evaluator of this one rule shape** (a tool, the claim path `act.sub`, a value it compares exactly). It is **not a Cedar engine** and it decides nothing real. Whether the real rule compares exactly, by substring or by set membership was **not measured** (UNVERIFIED).
- The measured card is separate from the mock runs and labelled "Measured on a real tenant 2026-11-16". It lists what was **not** measured: a second real agent with a different `act.sub` (the one real client always had one), and `act` emitted as text.
- Claims from outside the measured run, all UNVERIFIED and shown apart from the measured card: RequiredClaims on the identity or grant is believed to do the same job earlier, at sign-in (not tested here); this template's rule is a `.contains()` test on the claim, not a pattern; per the console documentation a Candidate policy is not enforced and only Active is (not re-run here).
- Timing: in one run on 2026-11-16 the first poll, about 7 seconds after the policies were created, already showed the refusal. That is one observation, not a measured or guaranteed propagation time.
- What was measured is one real agent and policies naming a different `act.sub` value: that policy refused the same token. No second agent called, so no result here is about a second agent.

## The diagram (rule 17)

The diagram is `diagram-studio/1` data in `data/diagram.json` (id `cedar-act-sub`), looked up **by name** in `web/src/diagram-data.js` (`getDiagram("cedar-act-sub")`); the page builds its boxes and arrows from that data and finds the arrows Simulate colours by the boxes they join, not by list position. diagram-studio's own `apps.js` library has no entry for this lab yet, so this is the lab's copy of the data (the studio's own instruction: "apps load these by id from their own copy of the JSON"). Adding it to the studio is a pull request in that repo, not done here. Boxes follow the cursor while dragged, Simulate keeps where you put them, **Reset** (header) and **Reset diagram** restore the positions, and the speed control is in the header.

## Run

```bash
npm ci
npm test          # server (node --test) + web (vitest) + repo checks
npm run doctor    # spins a throwaway server on 17819 and proves the mock walk
npm run build     # vite build -> dist/
npm start         # http://localhost:7819
```

Docker (OrbStack only, never Docker Desktop):

```bash
docker compose up --build -d     # publishes 127.0.0.1:7819 only
```

Port 7819 is the next free port in the shelf registry (catalog id D134, provisional).

## Modes (rule 19)

Mock / Real toggle in the header. The lab runs in **Mock**. **Real is owner-only and disabled in the page** with a reason shown as text beside the toggle (linked to it with `aria-describedby`, and also as its tooltip); `POST /api/mode {"source":"real"}` answers 409 and the server never makes an outbound call (netguard with a self-test stays on).

**Decision for the owner (rule 19).** Rule 19 says Real uses the app's own `.env` and is the default when configured. Here Real is script-only by the builder's choice: the page can never switch to Real, even with a complete `.env`, because the server makes no outbound call at all. That is not signed off by the owner yet; until it is, treat it as an open question.

The real probe is a script you run in a terminal instead:

```bash
cp .env.example .env     # git-ignored; fill in the five values
npm run real
```

`.env` needs `PF_ISSUER`, `PF_CLIENT_ID`, `PF_CLIENT_SECRET`, `PF_SCOPE` and `DOOR_URL` (optional: `PROBE_INDEX`, default `gateway-events`). The probe refuses to run unless all five are set and none is still a placeholder (`.example` / `.invalid` hosts, `replace-me`, `agent-client-example`).

What it does, in order:

1. Mints a PingFederate client-credentials token: `POST <PF_ISSUER>/as/token.oauth2` (the path is taken from the issuer's root), HTTP Basic client authentication, form fields `grant_type`, `scope` (= `PF_SCOPE`) and `audience`. **The audience is `DOOR_URL`, exactly as written in `.env`; there is no separate audience setting.**
2. `POST`s JSON-RPC to `DOOR_URL` with `content-type: application/json`, `accept: application/json, text/event-stream` and the Bearer token: `tools/list`, then `CountTool` with `{"index": "<PROBE_INDEX>"}` and `ListIndexTool` with `{}`. No `initialize` handshake and no session id. A reply is read as plain JSON or as an event stream (`data:` frames).
3. Prints one verdict per call: `allowed` (a tool that answers with an error result is still `allowed (tool returned an error, not a policy refusal)`), `refused-by-policy` (only when the JSON-RPC error message contains "denied by policy", reason kept), `refused-at-grant` (HTTP 403), `token-rejected` (HTTP 401) or `unreadable` (anything else, including a bare JSON-RPC -32600). Exit code 0 when done, 1 when a request failed, 2 when `.env` was refused, 3 when a call was `unreadable`, the token was rejected, or every call was refused with HTTP 403 (no AI policy was evaluated; each of these says nothing about the policy, and the probe says so instead of printing the baseline sentence).

It never creates, changes or deletes a tenant policy and follows no redirect. It prints the access token it was issued once, on a labelled line with its decoded claims, because this is a learning lab and you read it in your own terminal. It never prints the client secret or the Basic value (not even upper-cased or base64-encoded), and every other printed line, including anything a server echoes back, is redacted.

**Evidence status (what is and is not known).** The call sequence above copies a scratch script that was run on 2026-11-16 against a real PingFederate and a real Privilege door: it minted a token with Basic auth, a scope and the door URL as audience, then called `tools/list`, `CountTool` (with `{"index": "gateway-events"}`) and `ListIndexTool` (with `{}`) with no handshake. **This probe itself has never been run against a real tenant.** The lab only runs it against local fake listeners in `test/real-probe-e2e.test.js` (plain JSON and event-stream replies, allow and refusal), which prove the wire format, the printing rules and the exit codes, not how a real PingFederate or door behaves. Assumed, not tested by the lab:

- your PingFederate client accepts Basic client authentication and the scope you put in `PF_SCOPE` (the scratch run needed a scope; which one is yours to supply);
- the index named by `PROBE_INDEX` exists on your door (the default is the one the scratch run used);
- HTTP 403 means a refusal at the grant layer, and 401 means the token was rejected (the status that accompanies a real AI-policy refusal was not measured; the probe decides on the message, not the status);
- a policy refusal carries "denied by policy" in the JSON-RPC error message (the scratch run matched on it);
- the token endpoint lives at `/as/token.oauth2` at the issuer's root.

Treat the first owner run as the check of these.

## Safety

- Loopback-only host bind (0.0.0.0 inside the container only because Docker routes via eth0; the host publish is pinned to `127.0.0.1`).
- Host allowlist (`LAB_ALLOWED_HOSTS`) + same-origin write guard + JSON-only writes (415).
- Zero real outbound calls from the server. Example ids only (`agent-client-example`, `agent-b-example`, `door-example`, `.example` hosts). No real secrets: the mock token of a run is shown whole and labelled mock-issued (an HS256 fixture JWT that signs nothing real, rule 4); client secrets and real tokens are never shown or logged.

## Tests

- `test/*.test.js` (node --test): scenario verdicts and exact refusal texts, match-allowed vs different-refused on one token, act as text, no token, Candidate, traces, the mode endpoint, real-probe pure functions, vendored pins, content pack, netguard.
- `test/*.test.jsx` and the vendored `web/src/gateway-trace/gateway-trace.test.jsx` (vitest): the page, the shared TopMenu, the disabled Real toggle and its reason, the trace panel.
- `npm run test:repo`: forbidden-identifier scan and the vendored stylesheet check.
