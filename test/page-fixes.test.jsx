// Review fixes on the page (honesty-and-evidence-audit, browser-drive, mutation-testing, rulebook-audit). Every test here failed on the
// code before the fix; the finding id is in the title.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import React from "react";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import App from "../web/src/App.jsx";
import Evidence from "../web/src/Evidence.jsx";
import ScenarioPicker from "../web/src/ScenarioPicker.jsx";
import RunResult from "../web/src/RunResult.jsx";
import { setJsonView } from "../web/src/components/JsonPane.jsx";
import { SCENARIOS, EVIDENCE, MOCK_NOTE } from "../server/src/scenarios.js";
import { runScenario } from "../server/src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
beforeAll(() => {
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  global.DOMMatrixReadOnly = class { constructor() {} };
  if (!HTMLElement.prototype.hasPointerCapture) HTMLElement.prototype.hasPointerCapture = () => false;
  if (!HTMLElement.prototype.releasePointerCapture) HTMLElement.prototype.releasePointerCapture = () => {};
});
beforeEach(() => setJsonView("raw"));
afterEach(() => cleanup());

const catalog = () => ({
  door: "door-example",
  mockNote: MOCK_NOTE,
  stepIds: SCENARIOS.filter((s) => s.group === "step").map((s) => s.id),
  scenarios: SCENARIOS.map(({ policies, policyState, ...s }) => ({ ...s, policyState: policyState || "Active", policyCount: policies.length })),
  evidence: EVIDENCE
});
const REAL_REASON = "Real is owner-only and runs from your terminal: npm run real";
const j = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

// `fail`: (path) => undefined | "reject" | { status, html: true }
function mockFetch({ fail = () => undefined } = {}) {
  const calls = [];
  global.fetch = (path, opts) => {
    const method = (opts && opts.method) || "GET";
    calls.push({ path, method, body: opts && opts.body, headers: (opts && opts.headers) || {} });
    const f = fail(path, calls.filter((c) => c.path === path).length);
    if (f === "reject") return Promise.reject(new TypeError("Failed to fetch"));
    if (f && f.html) return Promise.resolve({ ok: false, status: f.status, json: () => Promise.reject(new SyntaxError("<html")) });
    if (f && f.json) return j(f.json, f.status);
    if (path === "/api/catalog") return j(catalog());
    if (path === "/api/info") return j({ source: "mock", realAvailable: false, realReason: REAL_REASON });
    if (path === "/api/run") return j(runScenario(SCENARIOS.find((s) => s.id === JSON.parse(opts.body).scenario)));
    if (path === "/api/reset") return j({ ok: true });
    if (path === "/api/mode") return j({ error: REAL_REASON }, 409);
    return j({}, 404);
  };
  return calls;
}
const pick = async (name) => fireEvent.click(await screen.findByRole("button", { name }));
const ran = () => waitFor(() => expect(screen.getByTestId("run-result")).toBeTruthy(), { timeout: 8000 });

describe("honesty (B1, M1, M3, M4, M5, M6, BD-1, BD-3, BD-7, R2)", () => {
  it("B1/M6 step 2 does not claim the controller's validation was measured, and frames the 7 seconds as one observation", async () => {
    mockFetch();
    render(<App />);
    await pick("2 Add two Active act.sub policies");
    await ran();
    const note = screen.getByTestId("policy-change-note").textContent;
    expect(note).not.toMatch(/validat/i);
    expect(note).toMatch(/In one run on 2026-11-16/);
    expect(note).toMatch(/one observation, not a measured or guaranteed propagation time/);
    expect(note).toMatch(/measured card/);
  });

  it("BD-7 the chip on a step says the outcome mirrors the real run, never 'measured' next to a mock number; extras stay 'simulated, not measured'", () => {
    const scenarios = catalog().scenarios;
    const { rerender } = render(<ScenarioPicker scenarios={scenarios} active={scenarios[2]} onSelect={() => {}} />);
    const chip = () => screen.getByTestId("scenario-about").querySelector(".chip");
    expect(chip().textContent).toBe("outcome matches the real run (2026-11-16)");
    expect(chip().className).toContain("basis-measured");
    rerender(<ScenarioPicker scenarios={scenarios} active={scenarios.find((s) => s.id === "act-text")} onSelect={() => {}} />);
    expect(chip().textContent).toBe("simulated, not measured");
    expect(chip().className).toContain("basis-unmeasured");
  });

  it("MT-08 the basis of every scenario, as an independent golden list", () => {
    const golden = { "step-1-baseline": "measured", "step-2-add-policies": "measured", "step-3-same-token": "measured", "step-4-remove": "measured", "act-text": "not measured", "no-token": "not measured", candidate: "not measured" };
    expect(Object.fromEntries(catalog().scenarios.map((s) => [s.id, s.basis]))).toEqual(golden);
  });

  it("M1 the trace panel is labelled as the mock door's simulated work, and never says 'What Privilege did' or 'Real mode shows the actual gateway'", async () => {
    mockFetch();
    render(<App />);
    await pick("3 Same token, two tools");
    await ran();
    const panel = screen.getByTestId("gateway-trace");
    expect(panel.querySelector("h2").textContent).toBe("What the mock door did (simulated)");
    expect(screen.getByTestId("gateway-trace-basis").textContent).toMatch(/not Privilege and not a Cedar engine/);
    expect(screen.getByTestId("gateway-trace-basis").textContent).toMatch(/Real mode is owner-only/);
    expect(panel.textContent).not.toMatch(/What Privilege did|Real mode shows the actual gateway/);
    expect(panel.closest(".lab-trace")).not.toBeNull();
    // the vendored panel's lead sentence names "the Privilege gateway"; it is hidden for this lab by the stylesheet, since the panel is byte-pinned
    expect(readFileSync(join(root, "web/app.css"), "utf8")).toMatch(/\.lab-trace \.gw-lead\s*\{\s*display:\s*none/);
  });

  it("BD-4 the empty trace tells the viewer what to do (there is no Run button), and says step 2 makes no calls", async () => {
    mockFetch();
    render(<App />);
    await screen.findByRole("button", { name: "1 Baseline: no policy" });
    expect(screen.getByTestId("gateway-trace-empty").textContent).toMatch(/Pick a step above/);
    expect(screen.getByTestId("gateway-trace").textContent).not.toMatch(/Press Run/);
    await pick("2 Add two Active act.sub policies");
    await ran();
    expect(screen.getByTestId("gateway-trace-empty").textContent).toMatch(/Step 2 makes no tool calls; run step 3/);
  });

  it("B1/BD-1 the measured card heading and note do not say 'validated', and the unverified claims are outside the measured card", () => {
    render(<Evidence evidence={EVIDENCE} />);
    const card = screen.getByTestId("evidence");
    expect(within(card).getByRole("heading", { name: "The Cedar the template generates (example ids)" })).toBeTruthy();
    expect(card.textContent).not.toMatch(/validated|\bverified\b/i);
    expect(card.contains(screen.getByTestId("also-true"))).toBe(false);
    const other = screen.getByTestId("unverified");
    expect(within(other).getByRole("heading").textContent).toMatch(/UNVERIFIED/);
    expect(other.contains(screen.getByTestId("also-true"))).toBe(true);
    expect(screen.getByTestId("evidence-label").className).toContain("basis-measured");
  });

  it("MT-10 the static-card hint, the 'simulated run' chip, the banner and the no-token note are pinned", async () => {
    mockFetch();
    render(<App />);
    expect(await screen.findByTestId("sim-banner")).toHaveTextContent("Nothing leaves this machine.");
    expect(screen.getByTestId("evidence")).toHaveTextContent("This card is static text, not a run of the mock above.");
    await pick("No token");
    await ran();
    expect(screen.getByTestId("run-result").querySelector("h3 .chip").textContent).toBe("simulated run");
    expect(screen.getByTestId("no-token").textContent).toBe("This run sends no token.");
    await pick("3 Same token, two tools");
    await waitFor(() => expect(screen.getByTestId("policy-cedar-list-act-sub")).toBeTruthy(), { timeout: 8000 });
    expect(screen.getByTestId("policy-cedar-list-act-sub").querySelector("header .hint").textContent).toBe("on ListIndexTool, act.sub = agent-b-example");
  });

  it("M3/BD-3 the three extra scenarios say 'not measured' in their presenter line, and the rendered page never states the extras as fact", async () => {
    mockFetch();
    render(<App />);
    fireEvent.click(await screen.findByTestId("presenter"));
    for (const name of ["act emitted as text", "No token", "Candidate state"]) {
      await pick(name);
      expect(screen.getByTestId("presenter-say").textContent).toMatch(/not measured|not re-run/i);
    }
  });

  it("every page text, for every scenario, avoids the claims the audit refused (verified, validated, never matches, no regex, a different agent was refused)", { timeout: 60000 }, async () => {
    mockFetch();
    render(<App />);
    const BANNED = /\bverified\b|validated|validation was measured|never matches|never enforced|Cedar has no regex|different agent (was )?refused|What Privilege did|Press Run/i;
    for (const s of SCENARIOS) {
      await pick(s.label);
      await waitFor(() => expect(screen.getByTestId("run-result").querySelector("h3").textContent).toContain(s.label), { timeout: 8000 });
      expect(document.body.textContent).not.toMatch(BANNED);
    }
  });

  it("m4 the intro says what Cedar is, and still says the door is not an engine", async () => {
    mockFetch();
    render(<App />);
    const intro = await screen.findByTestId("intro");
    expect(intro.textContent).toMatch(/Cedar is the policy language Privilege uses for its AI policies/);
    expect(screen.getByTestId("sim-banner").textContent).toMatch(/not a Cedar engine/);
  });

  it("m2 the policy list says the Cedar is this lab's generated shape, and only the contains test was read from the tenant", async () => {
    mockFetch();
    render(<App />);
    await pick("2 Add two Active act.sub policies");
    await ran();
    const note = screen.getByTestId("policy-provenance").textContent;
    expect(note).toMatch(/generated by this lab/i);
    expect(note).toMatch(/contains/);
    expect(note).toMatch(/UNVERIFIED/);
    expect(note).not.toMatch(/exact(ly)? (text|as)/i);
  });
});

// Residual re-check (H2, H3, H4 and the unhedged sentences): each hedge phrase is pinned where the viewer reads it, so deleting it fails a test.
describe("honesty hedges are pinned where they are read (residual re-check)", () => {
  const whatOf = () => screen.getByTestId("scenario-about").querySelectorAll("p")[1].textContent;
  const sentenceWith = (text, needle) => text.split(/(?<=[.!?])\s+/).find((x) => x.includes(needle)) || "";

  it("H2 the act-text scenario text says '(simulated, not measured)' in the description and in the presenter line", async () => {
    mockFetch();
    render(<App />);
    fireEvent.click(await screen.findByTestId("presenter"));
    await pick("act emitted as text");
    expect(whatOf()).toContain("(simulated, not measured)");
    expect(screen.getByTestId("presenter-say").textContent).toContain("(simulated, not measured)");
  });

  it("H3 the Candidate scenario text says UNVERIFIED", async () => {
    mockFetch();
    render(<App />);
    await pick("Candidate state");
    expect(whatOf()).toContain("UNVERIFIED");
    expect(whatOf()).toMatch(/not re-run here/);
  });

  it("H4 the banner says whether the real rule compares exactly was not measured", async () => {
    mockFetch();
    render(<App />);
    expect((await screen.findByTestId("sim-banner")).textContent).toContain("whether the real rule does was not measured");
  });

  it("the no-token text hedges in the very sentence that says the door refuses at sign-in (401)", async () => {
    mockFetch();
    render(<App />);
    fireEvent.click(await screen.findByTestId("presenter"));
    await pick("No token");
    const sentence = sentenceWith(whatOf(), "refuses at sign-in");
    expect(sentence).toMatch(/401/);
    expect(sentence).toMatch(/simulated, not measured/);
    expect(sentenceWith(screen.getByTestId("presenter-say").textContent, "refuses at sign-in")).toMatch(/simulated, not measured/);
  });

  it("the 'Not measured' item about act as text says it is believed, not measured, instead of a flat claim", () => {
    render(<Evidence evidence={EVIDENCE} />);
    const item = [...screen.getByTestId("not-measured").querySelectorAll("li")].find((li) => li.textContent.includes("act emitted as the TEXT"));
    expect(item).toBeTruthy();
    expect(item.textContent).toMatch(/believed/);
    expect(item.textContent).toMatch(/UNVERIFIED/);
    expect(item.textContent).not.toMatch(/the rule needs an object/);
  });
});

describe("the Run it yourself note (M2)", () => {
  it("says the probe was run against a real tenant on 2026-11-16 and what that did and did not test, and no longer names a handshake the probe does not do", () => {
    render(<Evidence evidence={EVIDENCE} />);
    const card = screen.getByTestId("evidence").textContent;
    expect(card).toMatch(/was run against a real PingFederate and door on 2026-11-16, three times/);
    expect(card).toMatch(/reproduced the three rows of the measured table/);
    expect(card).not.toMatch(/never been run/);
    for (const tested of [/Basic client authentication/, /token endpoint path/, /default index/, /denied by policy/, /Not tested: that HTTP 403/, /status that accompanies a policy refusal/, /your own PingFederate client, scope or door/, /Your first run is the check/]) expect(card).toMatch(tested);
    expect(card).not.toMatch(/handshake/i);
  });
});

describe("Real toggle reason (BD-2)", () => {
  it("the reason is visible text beside the toggle, linked by aria-describedby, not only a tooltip", async () => {
    mockFetch();
    render(<App />);
    const select = await screen.findByTestId("mode-select");
    await waitFor(() => expect(select.getAttribute("aria-describedby")).toBeTruthy());
    const reason = document.getElementById(select.getAttribute("aria-describedby"));
    expect(reason.textContent).toMatch(/Real is owner-only/);
    expect(reason.textContent).toMatch(/npm run real/);
    expect(reason.closest("header")).not.toBeNull();
    expect(reason.hidden).toBe(false);
    expect(screen.getByTestId("mode-real").title).toBe(REAL_REASON); // the tooltip stays as well
  });
});

describe("mock token (R4)", () => {
  it("the raw mock token is shown whole and labelled mock-issued", async () => {
    mockFetch();
    render(<App />);
    await pick("3 Same token, two tools");
    await ran();
    const result = screen.getByTestId("run-result");
    const token = within(result).getByTestId("mock-token").textContent;
    expect(token).toMatch(/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/);
    expect(within(result).getByTestId("mock-token-label").textContent).toMatch(/mock-issued/);
    expect(within(result).getByTestId("mock-token-label").textContent).toMatch(/signs nothing real/);
    expect(within(result).getAllByRole("button", { name: "Copy" }).length).toBeGreaterThan(0);
  });
});

describe("traceparent (R14)", () => {
  it("the page sends a W3C traceparent on the run and shows the one the server answers with", async () => {
    const calls = mockFetch();
    render(<App />);
    await pick("1 Baseline: no policy");
    await ran();
    const run = calls.find((c) => c.path === "/api/run");
    expect(run.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(screen.getByTestId("run-traceparent").textContent).toMatch(/00-[0-9a-f]{32}-[0-9a-f]{16}-01/);
  });
});

describe("an unreachable server (R23)", () => {
  it("a failed /api/run shows a visible error with Retry, Simulate comes back, and Retry runs it again", async () => {
    let down = true;
    mockFetch({ fail: (path) => (path === "/api/run" && down ? "reject" : undefined) });
    render(<App />);
    await pick("1 Baseline: no policy");
    const err = await screen.findByTestId("run-error", {}, { timeout: 8000 });
    expect(err.textContent).toMatch(/lab server is not reachable/);
    expect(err.getAttribute("role")).toBe("alert");
    await waitFor(() => expect(screen.getByRole("button", { name: "Simulate" }).disabled).toBe(false));
    down = false;
    fireEvent.click(within(err.closest("section")).getByRole("button", { name: "Retry" }));
    await ran();
    expect(screen.queryByTestId("run-error")).toBeNull();
  });

  it("an HTML 502 or a structured server error is named, with the server's own message", async () => {
    mockFetch({ fail: (path) => (path === "/api/run" ? { status: 502, html: true } : undefined) });
    render(<App />);
    await pick("1 Baseline: no policy");
    expect((await screen.findByTestId("run-error", {}, { timeout: 8000 })).textContent).toMatch(/HTTP 502/);
    cleanup();
    mockFetch({ fail: (path) => (path === "/api/run" ? { status: 400, json: { error: "unknown_scenario", message: "unknown scenario; one of a, b" } } : undefined) });
    render(<App />);
    await pick("1 Baseline: no policy");
    expect((await screen.findByTestId("run-error", {}, { timeout: 8000 })).textContent).toMatch(/unknown scenario; one of a, b/);
  });

  it("when the catalog cannot be loaded the page says so and Retry loads it", async () => {
    let down = true;
    mockFetch({ fail: (path) => (path === "/api/catalog" && down ? "reject" : undefined) });
    render(<App />);
    const err = await screen.findByTestId("load-error");
    expect(err.textContent).toMatch(/lab server is not reachable/);
    expect(err.getAttribute("role")).toBe("alert");
    down = false;
    fireEvent.click(within(err).getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "1 Baseline: no policy" });
    await waitFor(() => expect(screen.queryByTestId("load-error")).toBeNull());
  });
});

describe("navigation (BD-8)", () => {
  it("aria-current follows the section the viewer picked", async () => {
    mockFetch();
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Sections" });
    const cur = () => [...nav.querySelectorAll("a")].filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent);
    expect(cur()).toEqual(["Walk"]);
    fireEvent.click(within(nav).getByRole("link", { name: "Measured" }));
    expect(cur()).toEqual(["Measured"]);
    fireEvent.click(within(nav).getByRole("link", { name: "Walk" }));
    expect(cur()).toEqual(["Walk"]);
  });
});

describe("MT-04 / MT-05 pins", () => {
  it("MT-04 the measured table: CountTool allowed and ListIndexTool refused sit in their own columns", () => {
    render(<Evidence evidence={EVIDENCE} />);
    const rows = within(screen.getByTestId("evidence-table")).getAllByRole("row");
    const head = within(rows[0]).getAllByRole("columnheader").map((c) => c.textContent);
    expect(head).toEqual(["Door state", "CountTool", "ListIndexTool"]);
    const cells = (r) => within(r).getAllByRole("cell").map((c) => c.textContent);
    expect(cells(rows[1]).slice(1)).toEqual(["allowed", "allowed"]);
    expect(cells(rows[2])[1]).toBe("allowed");
    expect(cells(rows[2])[2]).toMatch(/^refused: action denied by policy: ListIndexTool requires act\.sub to be agent-b-example/);
    expect(cells(rows[3]).slice(1)).toEqual(["allowed", "allowed"]);
  });

  it("MT-04 the Candidate scenario labels its policies Candidate on the chip and in the picker", async () => {
    mockFetch();
    render(<App />);
    await pick("Candidate state");
    await ran();
    for (const id of ["cedar-count-act-sub", "cedar-list-act-sub"]) {
      const chip = within(screen.getByTestId(`policy-${id}`)).getByText("Candidate");
      expect(chip.className).toContain("state-candidate");
      expect(within(screen.getByTestId(`policy-${id}`)).queryByText("Active")).toBeNull();
    }
    expect(screen.getByTestId("scenario-about").textContent).toMatch(/Policies on the door: 2 \(Candidate\)/);
    await pick("3 Same token, two tools");
    await waitFor(() => expect(within(screen.getByTestId("policy-cedar-list-act-sub")).getByText("Active").className).toContain("state-active"), { timeout: 8000 });
    expect(screen.getByTestId("scenario-about").textContent).toMatch(/Policies on the door: 2 \(Active\)/);
  });

  it("MT-05 an allowed call and a refused call carry different card and chip classes", async () => {
    mockFetch();
    render(<App />);
    await pick("3 Same token, two tools");
    await ran();
    expect(screen.getByTestId("call-CountTool").className).toMatch(/\bok\b/);
    expect(screen.getByTestId("call-CountTool").className).not.toMatch(/refused/);
    expect(screen.getByTestId("call-ListIndexTool").className).toMatch(/\brefused\b/);
    expect(screen.getByTestId("verdict-CountTool").className).toContain("verdict-allowed");
    expect(screen.getByTestId("verdict-ListIndexTool").className).toContain("verdict-refused");
  });

  it("RunResult renders nothing without a result", () => {
    const { container } = render(<RunResult result={null} />);
    expect(container.textContent).toBe("");
  });
});
