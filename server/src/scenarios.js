// The story as data: four steps and three extra scenarios, plus the measured evidence (static, never produced by a mock run).
// Every id here is an example id. Scenarios are stateless: each carries the policies the mock door holds while it runs.
import { actSubPolicy, AGENT_A, AGENT_B } from "./cedar.js";

export const POLICY_A = { id: "cedar-count-act-sub", tool: "CountTool", agent: AGENT_A };
export const POLICY_B = { id: "cedar-list-act-sub", tool: "ListIndexTool", agent: AGENT_B };

export const policiesFor = (specs, state = "Active") => specs.map((s) => actSubPolicy({ ...s, state }));

// basis: what backs the scenario. "measured" = the shape was measured on a real tenant (2026-11-16);
// "not measured" = this lab simulates it and nothing here proves the real door does the same.
export const SCENARIOS = [
  {
    id: "step-1-baseline", group: "step", n: 1, label: "1 Baseline: no policy", kind: "calls", token: "agent", policies: [],
    calls: ["CountTool", "ListIndexTool"], expect: { CountTool: "allowed", ListIndexTool: "allowed" }, basis: "measured",
    title: "1. Baseline: no policy",
    what: "The door holds no AI policy. The agent's token carries act = {\"sub\": \"agent-client-example\"}. Both tools answer.",
    say: "No policy yet. The same token calls CountTool and ListIndexTool and both are allowed. That is the baseline everything else is compared with."
  },
  {
    id: "step-2-add-policies", group: "step", n: 2, label: "2 Add two Active act.sub policies", kind: "policy-change", token: "agent", policies: [POLICY_A, POLICY_B],
    calls: [], expect: {}, basis: "measured",
    title: "2. Add two Active act.sub policies",
    what: "Policy A on CountTool requires act.sub = agent-client-example (the token's own agent). Policy B on ListIndexTool requires act.sub = agent-b-example (a different agent). Both are created as Active; the Cedar this lab generates for them is below.",
    say: "Two policies from the template 'Restrict a tool to tokens carrying a claim'. Same Cedar shape, different tool and different agent. Only Active policies are enforced."
  },
  {
    id: "step-3-same-token", group: "step", n: 3, label: "3 Same token, two tools", kind: "calls", token: "agent", policies: [POLICY_A, POLICY_B],
    calls: ["CountTool", "ListIndexTool"], expect: { CountTool: "allowed", ListIndexTool: "refused" }, basis: "measured",
    title: "3. Same token, two tools",
    what: "One token, two calls. CountTool: the policy asks for the token's own agent, so it is allowed. ListIndexTool: the policy asks for a different agent, so it is refused with JSON-RPC -32600.",
    say: "Same token, same door, two tools. Where the policy names this agent the call goes through; where it names a different agent, the call is refused and the reason names the claim."
  },
  {
    id: "step-4-remove", group: "step", n: 4, label: "4 Remove the policies", kind: "calls", token: "agent", policies: [],
    calls: ["CountTool", "ListIndexTool"], expect: { CountTool: "allowed", ListIndexTool: "allowed" }, basis: "measured",
    title: "4. Remove the policies: back to baseline",
    what: "Both policies are deleted. The same token now gets both tools again, exactly as in step 1.",
    say: "Delete the two policies and the same token is allowed on both tools again. The policy is the only thing that changed."
  },
  {
    id: "act-text", group: "extra", label: "act emitted as text", kind: "calls", token: "act-text", policies: [POLICY_A, POLICY_B],
    calls: ["CountTool", "ListIndexTool"], expect: { CountTool: "refused", ListIndexTool: "refused" }, basis: "not measured",
    title: "act emitted as text",
    what: "The token's act claim is the TEXT \"{}\" instead of an object. Expected (simulated, not measured): there is no act.sub, so the `has` test should be false and the forbid should apply to every policed tool, even the one that names the token's own agent.",
    say: "Same policies, but suppose the token mapping produced the text \"{}\" for act. The rule should then find no act.sub, so both policed tools should be refused (simulated, not measured). If you see this, check that act is an object."
  },
  {
    id: "no-token", group: "extra", label: "No token", kind: "calls", token: "none", policies: [POLICY_A, POLICY_B],
    calls: ["CountTool", "ListIndexTool"], expect: { CountTool: "refused", ListIndexTool: "refused" }, basis: "not measured",
    title: "No token",
    what: "The call carries no Authorization header. The door refuses at sign-in (401), before any policy is evaluated: it fails closed. The 401 wording mirrors the sibling lab; it was not measured here.",
    say: "No token, no call: in this mock the door refuses at sign-in, before any policy (simulated, not measured)."
  },
  {
    id: "candidate", group: "extra", label: "Candidate state", kind: "calls", token: "agent", policies: [POLICY_A, POLICY_B], policyState: "Candidate",
    calls: ["CountTool", "ListIndexTool"], expect: { CountTool: "allowed", ListIndexTool: "allowed" }, basis: "not measured",
    title: "Candidate state",
    what: "Both policies exist but are Candidate. Per the Privilege console documentation (not re-run here, UNVERIFIED) a Candidate is not enforced, so the mock allows ListIndexTool even though its policy names a different agent. Only Active is enforced here.",
    say: "Per the console documentation (not re-run here), a policy that is still a Candidate is not enforced. If a refusal you expected does not happen, check the state first."
  }
];

export const STEP_IDS = SCENARIOS.filter((s) => s.group === "step").map((s) => s.id);

export const MOCK_NOTE =
  "The mock door is an in-process evaluator of this one rule shape (a tool, a claim path act.sub, a value it compares exactly). It is not a Cedar engine and it decides nothing real. Whether the real door compares exactly, by substring or by set membership was not measured (UNVERIFIED).";

// Static evidence. It is NOT produced by a mock run and is shown apart from them, labelled with its date.
export const EVIDENCE = {
  label: "Measured on a real tenant 2026-11-16",
  setup: "A real Privilege tenant, a real PingFederate token (act as an OBJECT {\"sub\": \"<agent>\"}), two ACTIVE policies on one door. The ids on this page are examples.",
  cedar: [
    "@reason(\"<Tool> requires act.sub to be <agent>\")",
    "forbid (principal, action == Action::\"mcp:Invoke\", resource == Tool::\"<Tool>\")",
    "when   { context.app == \"<door>\" }",
    "unless { context.token.claims has \"act.sub\"",
    "         && context.token.claims[\"act.sub\"].contains(\"<agent>\") };"
  ].join("\n"),
  cedarNote: "The AI Policy template \"Restrict a tool to tokens carrying a claim\" generates the contains(...) test inside forbid ... unless; that part was read from the tenant. The lines around it (@reason, the action and resource, the when context.app clause, the has guard) are this lab's reconstruction from the sibling lab, UNVERIFIED against the tenant. The ids are examples.",
  rows: [
    { phase: "Baseline (no policy)", CountTool: "allowed", ListIndexTool: "allowed" },
    { phase: "Policy A on CountTool (act.sub = the token's own agent) and policy B on ListIndexTool (act.sub = a different agent), both Active", CountTool: "allowed", ListIndexTool: "refused: action denied by policy: ListIndexTool requires act.sub to be agent-b-example (JSON-RPC -32600)" },
    { phase: "Both policies deleted", CountTool: "allowed", ListIndexTool: "allowed" }
  ],
  timing: "In one run on 2026-11-16 the first poll, about 7 seconds after the policies were created, already showed the refusal. That is one observation, not a measured or guaranteed propagation time.",
  wire: "On the wire the refusal is a JSON-RPC error with code -32600. The mock in this lab answers HTTP 400 for it, like pf-privilege-obo-LAB.",
  notMeasured: [
    "A second real agent whose token carries a different act.sub: the one real client always had a single act.sub, so the refusal came from a policy naming a different agent, not from a second agent calling.",
    "act emitted as the TEXT \"{}\": the rule needs an object, and the 'act emitted as text' scenario is the simulation of that, not a measurement.",
    "Whether the real door matches act.sub exactly, by substring or by set membership: only a policy naming a different value was refused, so 'agent-client' against 'agent-client-example' was never tried.",
    "The no-token and Candidate scenarios on the real door."
  ],
  alsoTrue: [
    "UNVERIFIED, not tested here: RequiredClaims on the identity or grant is believed to do the same job earlier, at sign-in.",
    "UNVERIFIED, not tested here: this template's rule is a .contains() test on the claim, not a pattern. The mock compares exactly (an equal string or a list member).",
    "UNVERIFIED, per the Privilege console documentation and not re-run here: a Candidate policy is not enforced, only Active is."
  ],
  command: "npm run real",
  commandNote: "Run by the owner in a terminal with a local, git-ignored .env (see .env.example). It mints a client-credentials token, runs the baseline probe (tools/list, CountTool, ListIndexTool) and prints verdicts. It never creates or deletes policies, and the server never makes this call. This script has never been run against a real PingFederate or door: it copies the call sequence of a scratch script that was run on 2026-11-16, but nothing has re-run it. Assumed, not tested: that your PingFederate client accepts Basic client authentication and your scope, the token endpoint path, that the index it names exists on your door, that HTTP 403 means a grant-layer refusal and that a policy refusal says \"denied by policy\". The first owner run is the first test. Only its baseline row can be compared with the measured table."
};
