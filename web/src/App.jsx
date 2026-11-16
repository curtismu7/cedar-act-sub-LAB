import React, { useEffect, useRef, useState } from "react";
import TopMenu from "./top-menu/TopMenu.jsx";
import VerifyMark from "./components/VerifyMark.jsx";
import "./top-menu/top-menu.css";
import SimulationBanner from "./Banner.jsx";
import FlowSim from "./FlowSim.jsx";
import ScenarioPicker from "./ScenarioPicker.jsx";
import Evidence from "./Evidence.jsx";
import { useApi, postJson } from "./api.js";

// Presenter mode (rule 3): shows the talk-track line for the current scenario while presenting.
function presenterSay(active) {
  return active ? active.say : "Pick a step and press Simulate. Start with step 1: no policy, both tools allowed.";
}

export default function App() {
  const [reloadKey, setReloadKey] = useState(0);
  const catalog = useApi("/api/catalog", [reloadKey]);
  const info = useApi("/api/info", [reloadKey]);
  const [source, setSource] = useState("mock");
  const [activeScenario, setActiveScenario] = useState(null);
  const [resetKey, setResetKey] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("theme") || "auto"; } catch { return "auto"; }
  });
  const [presenter, setPresenter] = useState(false);
  // The section the nav marks as current: follows the link the viewer picked, and the address when it changes.
  const [section, setSection] = useState(() => (typeof location !== "undefined" && location.hash === "#evidence" ? "evidence" : "flow"));
  const modeBox = useRef(null);

  useEffect(() => {
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("theme", theme); } catch { /* none */ }
  }, [theme]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && presenter) setPresenter(false);
      if (e.key.toLowerCase() === "p" && e.altKey) setPresenter((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenter]);

  useEffect(() => {
    const onHash = () => setSection(location.hash === "#evidence" ? "evidence" : location.hash === "#flow" ? "flow" : (s) => s);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (info.data) setSource(info.data.source);
  }, [info.data]);

  const realOff = info.data ? info.data.realAvailable === false : false;
  // The shared TopMenu (byte-pinned) draws the Mode select without a way to describe it, so the visible reason is linked to it here.
  useEffect(() => {
    const select = modeBox.current && modeBox.current.querySelector('[data-testid="mode-select"]');
    if (!select) return undefined;
    if (realOff) select.setAttribute("aria-describedby", "real-reason");
    else select.removeAttribute("aria-describedby");
    return () => select.removeAttribute("aria-describedby");
  }, [realOff]);

  // Rule 19: the toggle posts the mode, then reloads all data. Real answers 409 here (owner-only, see the reason in the toggle).
  const switchMode = async (target) => {
    const r = await postJson("/api/mode", { source: target });
    if (r.status === 200) {
      setSource(r.body.source);
      setReloadKey((k) => k + 1);
    }
  };

  const reset = async () => {
    await postJson("/api/reset", {});
    setActiveScenario(null);
    setResetKey((k) => k + 1);
  };

  const data = catalog.data;
  return (
    <div className="app">
      <header className="shell-bar">
        <div className="shell-brand">
          <span className="brand-mark" aria-hidden="true">◆</span>
          Cedar act.sub Lab
        </div>
        <nav className="shell-nav" aria-label="Sections">
          <a href="#flow" aria-current={section === "flow" ? "page" : undefined} onClick={() => setSection("flow")}>Walk</a>
          <a href="#evidence" aria-current={section === "evidence" ? "page" : undefined} onClick={() => setSection("evidence")}>Measured</a>
        </nav>
        <div className="shell-right" ref={modeBox}>
          <TopMenu
            mode={{ value: source === "real" ? "real" : "mock", onChange: (m) => switchMode(m === "real" ? "real" : "mock"), realAvailable: info.data ? info.data.realAvailable !== false : null, realHint: info.data?.realReason || undefined }}
            theme={{ value: theme, onChange: setTheme }}
            present={{ active: presenter, onToggle: () => setPresenter((v) => !v), label: "Presenter (Alt+P)" }}
            onReset={reset}
            extra={<>
              <label className="speed-control" htmlFor="speed">Speed
                <select id="speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                  <option value={0.5}>0.5×</option>
                  <option value={1}>1×</option>
                  <option value={2}>2×</option>
                  <option value={4}>4×</option>
                </select>
              </label>
              {realOff && (
                <span id="real-reason" className="real-reason" data-testid="real-reason">
                  Real is owner-only: run <code>npm run real</code> in a terminal (see Run it yourself, below).
                </span>
              )}
            </>}
          >
            <VerifyMark id="cedar-act-sub-lab" />
          </TopMenu>
        </div>
      </header>
      <div className="accent-rule" aria-hidden="true" />
      <main>
        <SimulationBanner source={source} />
        {(catalog.error || info.error) && (
          <div className="error-pane" role="alert" data-testid="load-error">
            <span>The page could not load its data: {catalog.error || info.error}.</span>
            <button type="button" onClick={() => setReloadKey((k) => k + 1)}>Retry</button>
          </div>
        )}
        <section className="card intro" data-testid="intro">
          <h1>Does Privilege's Cedar match the agent's act.sub claim?</h1>
          <p>Cedar is the policy language Privilege uses for its AI policies; this lab shows one rule shape in it. A measured run, simulated here. One agent token, two tools, one act.sub policy on each: the tool whose policy names this agent is allowed, the tool whose policy names a different agent is refused.</p>
          {data && <p className="hint">{data.mockNote}</p>}
        </section>
        {presenter && (
          <aside className="presenter-say" data-testid="presenter-say" aria-label="Talk track">
            {presenterSay(activeScenario)}
          </aside>
        )}
        <ScenarioPicker scenarios={(data && data.scenarios) || []} active={activeScenario} onSelect={setActiveScenario} />
        <FlowSim activeScenario={activeScenario} speed={speed} resetKey={resetKey} />
        <Evidence evidence={data && data.evidence} />
      </main>
      <footer className="app-footer">
        Tester tier · runs are simulated · mock tokens labelled · the measured card is static evidence from 2026-11-16
      </footer>
    </div>
  );
}
