import React from "react";

// Simulation banner: required first on every page (rule 2), also in presenter mode.
export default function SimulationBanner({ source }) {
  return (
    <div className="banner" role="note" data-testid="sim-banner">
      <strong>Simulation</strong> — the runs on this page are simulated. A mock PingFederate token and a mock Privilege door run in-process
      (mode: {source || "mock"}). The door is an evaluator of ONE Cedar rule shape (a tool, the claim <code>act.sub</code>, a value it
      compares exactly; whether the real rule does was not measured): it is not a Cedar engine and it decides nothing real. Nothing leaves this machine. The measured result further down is static
      evidence from a real tenant, kept apart from the runs.
    </div>
  );
}
