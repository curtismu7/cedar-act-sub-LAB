import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import React from "react";
import App from "../web/src/App.jsx";
import ScenarioPicker from "../web/src/ScenarioPicker.jsx";
import Evidence from "../web/src/Evidence.jsx";
import { setJsonView } from "../web/src/components/JsonPane.jsx";
import { SCENARIOS, EVIDENCE, MOCK_NOTE } from "../server/src/scenarios.js";
import { runScenario } from "../server/src/index.js";

beforeAll(() => {
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  global.DOMMatrixReadOnly = class { constructor() {} };
  if (!HTMLElement.prototype.hasPointerCapture) HTMLElement.prototype.hasPointerCapture = () => false;
  if (!HTMLElement.prototype.releasePointerCapture) HTMLElement.prototype.releasePointerCapture = () => {};
});
beforeEach(() => setJsonView("raw"));
afterEach(() => { cleanup(); try { sessionStorage.clear(); } catch { /* none */ } });

// The catalog and the runs come from the real server modules, so the page is tested against what the server really answers.
const catalog = () => ({
  door: "door-example",
  mockNote: MOCK_NOTE,
  stepIds: SCENARIOS.filter((s) => s.group === "step").map((s) => s.id),
  scenarios: SCENARIOS.map(({ policies, policyState, ...s }) => ({ ...s, policyState: policyState || "Active", policyCount: policies.length })),
  evidence: EVIDENCE
});
const REAL_REASON = "Real is owner-only and runs from your terminal: npm run real";

function mockFetch({ modeStatus = {}, source = "mock" } = {}) {
  const calls = [];
  global.fetch = (path, opts) => {
    const method = (opts && opts.method) || "GET";
    calls.push({ path, method, body: opts && opts.body });
    const j = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
    if (path === "/api/catalog") return j(catalog());
    if (path === "/api/info") return j({ source, realAvailable: source === "real", realReason: REAL_REASON });
    if (path === "/api/run") return j(runScenario(SCENARIOS.find((s) => s.id === JSON.parse(opts.body).scenario)));
    if (path === "/api/reset") return j({ ok: true });
    if (path === "/api/mode") {
      const want = JSON.parse(opts.body).source;
      return want === "real" ? j({ error: REAL_REASON }, 409) : j({ source: "mock" });
    }
    return j({}, 404);
  };
  return calls;
}

describe("the page", () => {
  it("opens on a modal that says MOCK, with what is simulated and that the door is not a Cedar engine, and closes on Got it without coming back this session", async () => {
    mockFetch();
    sessionStorage.clear();
    const { unmount } = render(<App />);
    const modal = await screen.findByTestId("mode-modal");
    expect(modal.dataset.mode).toBe("mock");
    expect(modal.textContent).toMatch(/MOCK/);
    expect(modal.textContent).toMatch(/simulated/i);
    expect(modal.textContent).toMatch(/not a Cedar engine/);
    expect(modal.textContent).toMatch(/decides nothing real/);
    expect(modal.textContent).toMatch(/whether the real rule compares exactly was not measured/);
    expect(modal.textContent).toMatch(/measured card further down is static evidence from a real tenant/);
    expect(document.querySelector(".banner")).toBeNull();
    expect(screen.queryByTestId("sim-banner")).toBeNull();
    fireEvent.click(screen.getByTestId("mode-modal-ok"));
    expect(screen.queryByTestId("mode-modal")).toBeNull();
    unmount();
    render(<App />);
    await screen.findByTestId("intro");
    expect(screen.queryByTestId("mode-modal")).toBeNull();
  });

  it("the modal says REAL, and that everything but the Real run panel stays simulated, when the lab runs in Real", async () => {
    sessionStorage.clear();
    mockFetch({ source: "real" });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("mode-modal").dataset.mode).toBe("real"));
    const modal = screen.getByTestId("mode-modal");
    expect(modal.textContent).toMatch(/REAL/);
    expect(modal.textContent).toMatch(/Everything else on this page stays simulated/);
    expect(modal.textContent).toMatch(/not a Cedar engine/);
  });

  it("a Real lab still shows REAL after the first (Mock) answer was dismissed", async () => {
    sessionStorage.clear();
    sessionStorage.setItem("cas-mode-seen-mock", "1");
    mockFetch({ source: "real" });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("mode-modal").dataset.mode).toBe("real"));
  });

  it("renders the shared TopMenu in the header, with mode, theme, presenter and Reset", async () => {
    mockFetch();
    render(<App />);
    const menu = await screen.findByTestId("top-menu");
    expect(menu.closest("header.shell-bar")).not.toBeNull();
    for (const id of ["mode-select", "theme-select", "presenter", "reset"]) expect(within(menu).getByTestId(id)).toBeTruthy();
  });

  it("the Real option is disabled and carries the visible reason; Mock is the pressed value", async () => {
    mockFetch();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("mode-real").disabled).toBe(true));
    expect(screen.getByTestId("mode-real").title).toBe(REAL_REASON);
    expect(screen.getByTestId("mode-select").value).toBe("mock");
  });

  it("the toggle posts the mode: Real answers 409 and nothing changes, Mock answers 200 and reloads the data", async () => {
    const calls = mockFetch();
    render(<App />);
    const select = await screen.findByTestId("mode-select");
    await waitFor(() => expect(screen.getByTestId("scenario-picker")).toBeTruthy());
    const catalogLoads = () => calls.filter((c) => c.path === "/api/catalog").length;
    const before = catalogLoads();
    fireEvent.change(select, { target: { value: "real" } });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/mode" && JSON.parse(c.body).source === "real")).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    expect(catalogLoads()).toBe(before);
    expect(screen.getByTestId("mode-select").value).toBe("mock");
    fireEvent.change(select, { target: { value: "mock" } });
    await waitFor(() => expect(catalogLoads()).toBe(before + 1));
    expect(calls.some((c) => c.path === "/api/mode" && JSON.parse(c.body).source === "mock")).toBe(true);
  });

  it("theme select sets and clears data-theme", async () => {
    mockFetch();
    render(<App />);
    const select = await screen.findByTestId("theme-select");
    fireEvent.change(select, { target: { value: "dark" } });
    expect(document.documentElement.dataset.theme).toBe("dark");
    fireEvent.change(select, { target: { value: "auto" } });
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("lists the four steps in order, then the three extra scenarios", async () => {
    mockFetch();
    render(<App />);
    await screen.findByRole("button", { name: "1 Baseline: no policy" });
    const steps = within(screen.getByTestId("story-steps")).getAllByRole("button").map((b) => b.textContent);
    expect(steps).toEqual(["1 Baseline: no policy", "2 Add two Active act.sub policies", "3 Same token, two tools", "4 Remove the policies"]);
    const extras = within(screen.getByTestId("extra-scenarios")).getAllByRole("button").map((b) => b.textContent);
    expect(extras).toEqual(["act emitted as text", "No token", "Candidate state"]);
  });

  it("step 3 shows CountTool allowed and ListIndexTool refused with the exact reason, and the trace panel", async () => {
    mockFetch();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "3 Same token, two tools" }));
    await waitFor(() => expect(screen.getByTestId("run-result")).toBeTruthy(), { timeout: 8000 });
    expect(screen.getByTestId("verdict-CountTool").textContent).toBe("ALLOWED");
    expect(screen.getByTestId("verdict-ListIndexTool").textContent).toBe("REFUSED");
    expect(screen.getByTestId("reason-ListIndexTool").textContent).toBe("JSON-RPC -32600 action denied by policy: ListIndexTool requires act.sub to be agent-b-example");
    const panel = screen.getByTestId("gateway-trace");
    expect(panel).toHaveTextContent(/Agent calls the door: tools\/call CountTool/);
    expect(panel).toHaveTextContent(/Agent calls the door: tools\/call ListIndexTool/);
    expect(panel).toHaveTextContent(/AI policy \(Cedar\)/);
    expect(screen.getByTestId("gateway-trace-basis")).toHaveTextContent(/Simulated/);
    expect(screen.getByTestId("token-claims")).toBeTruthy();
  });

  it("step 2 shows the exact Cedar of both policies and the Copy button", async () => {
    mockFetch();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "2 Add two Active act.sub policies" }));
    await waitFor(() => expect(screen.getByTestId("policy-list")).toBeTruthy(), { timeout: 8000 });
    expect(screen.getByTestId("cedar-cedar-list-act-sub").textContent).toBe(
      '@reason("ListIndexTool requires act.sub to be agent-b-example")\n' +
      'forbid (principal, action == Action::"mcp:Invoke", resource == Tool::"ListIndexTool")\n' +
      'when   { context.app == "door-example" }\n' +
      'unless { context.token.claims has "act.sub"\n' +
      '         && context.token.claims["act.sub"].contains("agent-b-example") };'
    );
    expect(within(screen.getByTestId("policy-list")).getAllByRole("button", { name: "Copy" })).toHaveLength(2);
    expect(screen.getByTestId("policy-change-note").textContent).toMatch(/about 7 seconds/);
  });

  it("act as text, no token and Candidate show their own verdicts", async () => {
    mockFetch();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "act emitted as text" }));
    await waitFor(() => expect(screen.getByTestId("verdict-CountTool")).toBeTruthy(), { timeout: 8000 });
    expect(screen.getByTestId("verdict-CountTool").textContent).toBe("REFUSED");
    fireEvent.click(screen.getByRole("button", { name: "No token" }));
    await waitFor(() => expect(screen.getByTestId("no-token")).toBeTruthy(), { timeout: 8000 });
    expect(screen.getByTestId("reason-CountTool").textContent).toMatch(/401 Bearer token required/);
    fireEvent.click(screen.getByRole("button", { name: "Candidate state" }));
    await waitFor(() => expect(screen.getByTestId("verdict-ListIndexTool").textContent).toBe("ALLOWED"), { timeout: 8000 });
  });

  it("Reset (the TopMenu button) clears the result and tells the server", async () => {
    const calls = mockFetch();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "1 Baseline: no policy" }));
    await waitFor(() => expect(screen.getByTestId("run-result")).toBeTruthy(), { timeout: 8000 });
    fireEvent.click(screen.getByTestId("reset"));
    await waitFor(() => expect(screen.queryByTestId("run-result")).toBeNull());
    expect(calls.some((c) => c.path === "/api/reset" && c.method === "POST")).toBe(true);
  });

  it("presenter mode shows the talk-track line and keeps the Real-or-mock modal", async () => {
    sessionStorage.clear();
    mockFetch();
    render(<App />);
    fireEvent.click(await screen.findByTestId("presenter"));
    expect(screen.getByTestId("presenter-say").textContent).toMatch(/Start with step 1/);
    fireEvent.click(screen.getByRole("button", { name: "3 Same token, two tools" }));
    expect(screen.getByTestId("presenter-say").textContent).toMatch(/names a different agent, the call is refused/);
    expect(screen.getByTestId("sim-banner")).toBeTruthy();
  });

  it("the measured card is separate from the runs and labelled with its date", async () => {
    mockFetch();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "3 Same token, two tools" }));
    await waitFor(() => expect(screen.getByTestId("run-result")).toBeTruthy(), { timeout: 8000 });
    const evidence = screen.getByTestId("evidence");
    expect(evidence.contains(screen.getByTestId("run-result"))).toBe(false);
    expect(screen.getByTestId("flow-sim").contains(evidence)).toBe(false);
    expect(within(evidence).getByTestId("evidence-label").textContent).toBe("Measured on a real tenant 2026-11-16");
    expect(within(evidence).getByTestId("real-command").textContent).toBe("npm run real");
  });
});

describe("Evidence", () => {
  it("shows the measured table, what was not measured and what is also true", () => {
    render(<Evidence evidence={EVIDENCE} />);
    const rows = within(screen.getByTestId("evidence-table")).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows[2].textContent).toMatch(/refused: action denied by policy: ListIndexTool requires act\.sub to be agent-b-example/);
    expect(screen.getByTestId("not-measured").textContent).toMatch(/second real agent/);
    expect(screen.getByTestId("not-measured").textContent).toMatch(/TEXT "\{\}"/);
    expect(screen.getByTestId("also-true").textContent).toMatch(/not a pattern/);
    expect(screen.getByTestId("evidence-cedar").textContent).toBe(EVIDENCE.cedar);
  });

  it("renders nothing without data", () => {
    const { container } = render(<Evidence evidence={null} />);
    expect(container.textContent).toBe("");
  });
});

describe("ScenarioPicker", () => {
  const scenarios = catalog().scenarios;
  it("marks the pressed scenario and says whether its shape was measured", () => {
    const active = scenarios.find((s) => s.id === "act-text");
    render(<ScenarioPicker scenarios={scenarios} active={active} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: "act emitted as text" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "No token" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("scenario-about").textContent).toMatch(/simulated, not measured/);
  });

  it("step scenarios are marked as measured shape", () => {
    render(<ScenarioPicker scenarios={scenarios} active={scenarios[2]} onSelect={() => {}} />);
    expect(screen.getByTestId("scenario-about").textContent).toMatch(/outcome matches the real run \(2026-11-16\)/);
    expect(screen.getByTestId("scenario-about").textContent).not.toMatch(/shape measured/);
    expect(screen.getByTestId("scenario-about").textContent).toMatch(/ListIndexTool refused/);
  });
});
