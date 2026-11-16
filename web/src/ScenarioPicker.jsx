import React from "react";

// The four-step story, then the extra scenarios. Every button runs one scenario against the mock door.
export default function ScenarioPicker({ scenarios, active, onSelect }) {
  const steps = scenarios.filter((s) => s.group === "step");
  const extras = scenarios.filter((s) => s.group !== "step");
  const button = (s) => (
    <button
      key={s.id}
      type="button"
      className="scenario-btn"
      aria-pressed={Boolean(active && active.id === s.id)}
      onClick={() => onSelect(s)}
    >
      {s.label}
    </button>
  );
  return (
    <section className="card" data-testid="scenario-picker">
      <h2>The walk, in four steps</h2>
      <div className="scenario-list" data-testid="story-steps">{steps.map(button)}</div>
      <h3>Extra scenarios</h3>
      <div className="scenario-list" data-testid="extra-scenarios">{extras.map(button)}</div>
      {active && (
        <div className="scenario-about" data-testid="scenario-about">
          <p><strong>{active.title}</strong></p>
          <p>{active.what}</p>
          <p className="hint">
            <span className={`chip basis-${active.basis === "measured" ? "measured" : "unmeasured"}`}>
              {active.basis === "measured" ? "outcome matches the real run (2026-11-16)" : "simulated, not measured"}
            </span>{" "}
            Policies on the door: {active.policyCount}{active.policyCount ? ` (${active.policyState})` : ""}.
            {active.calls && active.calls.length > 0 && (
              <> Expected: {active.calls.map((t) => `${t} ${active.expect[t]}`).join("; ")}.</>
            )}
          </p>
        </div>
      )}
    </section>
  );
}
