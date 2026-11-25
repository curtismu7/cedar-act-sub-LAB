import React, { useState, useEffect, useRef } from "react";
import ReactFlow, { Background, Controls, MarkerType, Position, useNodesState } from "reactflow";
import "reactflow/dist/style.css";
import { postJson, failureText } from "./api.js";
import { getDiagram, edgeIndex } from "./diagram-data.js";
import LabTrace from "./LabTrace.jsx";
import RunResult from "./RunResult.jsx";

// Studio diagram (rule 17): the nodes and edges come from the diagram-studio/1 data, looked up by name, never hand-built here.
const studio = getDiagram("cedar-act-sub-flow");

// The shared outline + stripe look (standalone-ui.css .dg-node); colour by studio group.
const GROUP_CLASS = { pf: "dg-blue", agent: "dg-amber", gw: "dg-dark", tools: "dg-green" };

// Which side of a box an arrow leaves from and arrives at: a layout hint for this data's compact grid (rows flow right, then down).
const SIDES = {
  pf: [Position.Left, Position.Right],
  agent: [Position.Left, Position.Right],
  door: [Position.Left, Position.Bottom],
  cedar: [Position.Top, Position.Bottom],
  count: [Position.Top, Position.Bottom],
  list: [Position.Top, Position.Bottom]
};

// The arrows Simulate colours, found by the boxes they join (not by their position in the data's list).
const EDGE_TOKEN = edgeIndex(studio, "pf", "agent");
const EDGE_CALL = edgeIndex(studio, "agent", "door");
const EDGE_SIGNIN = edgeIndex(studio, "door", "cedar");
const EDGE_TOOL = { CountTool: edgeIndex(studio, "cedar", "count"), ListIndexTool: edgeIndex(studio, "cedar", "list") };

function studioNodes() {
  return studio.nodes.map((n) => {
    const [targetPosition, sourcePosition] = SIDES[n.id] || [Position.Top, Position.Bottom];
    return {
      id: n.id,
      position: { x: n.x ?? 0, y: n.y ?? 0 },
      targetPosition,
      sourcePosition,
      className: `dg-node ${GROUP_CLASS[n.group] || "dg-grey"}`,
      data: {
        label: (
          <>
            <strong>{n.label}</strong>
            {(n.sub || []).map((t) => <span key={t}>{t}</span>)}
          </>
        )
      },
      style: { width: 220 }
    };
  });
}

function studioEdges() {
  return studio.edges.map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target, label: e.label, animated: true }));
}

const summary = (r) => (r.kind === "policy-change" ? "Done: the policies were created." : `Done: ${r.calls.map((c) => `${c.tool} ${c.verdict.toUpperCase()}`).join(", ")}.`);

export default function FlowSim({ activeScenario, speed, resetKey }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(studioNodes());
  const [edges, setEdges] = useState(() => studioEdges());
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const resultRef = useRef(null);
  const latest = useRef(0);

  // Only the walk is cleared (arrow colours, result, error): where the viewer put the boxes stays until Reset.
  const clearWalk = () => {
    setEdges(studioEdges());
    setResult(null);
    setError(null);
  };

  // Reset (header button and "Reset diagram"): restores box positions too.
  const reset = () => {
    latest.current += 1;
    setNodes(studioNodes());
    clearWalk();
    setRunning(false);
    window.dispatchEvent(new CustomEvent("cas:reset"));
  };

  useEffect(() => {
    if (activeScenario) run(activeScenario);
  }, [activeScenario]);

  useEffect(() => {
    if (resetKey) reset();
  }, [resetKey]);

  const colorEdge = (index, ok) => {
    const color = ok ? "var(--status-ok)" : "var(--accent)";
    setEdges((prev) =>
      prev.map((e, i) =>
        i === index
          ? { ...e, animated: false, style: { stroke: color, strokeWidth: 3 }, markerEnd: { type: MarkerType.ArrowClosed, color } }
          : e
      )
    );
  };

  const run = async (scenario) => {
    const mine = ++latest.current;
    const stale = () => mine !== latest.current;
    setRunning(true);
    clearWalk();
    // Story host hook: the page announces runs (storyWiring.js listens). ok is false only when the request itself failed;
    // a policy refusal is a completed run (the refusal IS the result).
    window.dispatchEvent(new CustomEvent("cas:run-start"));
    const finishRun = (ok) => window.dispatchEvent(new CustomEvent("cas:run-end", { detail: { ok } }));
    // One pause of the walk; false when a Reset or a newer run took over meanwhile (nothing more is drawn then).
    const wait = async () => {
      await new Promise((r) => setTimeout(r, 250 / (speed || 1)));
      return !stale();
    };
    try {
      if (!(await wait())) { finishRun(true); return; }
      const res = await postJson("/api/run", { scenario: scenario.id });
      if (stale()) { finishRun(true); return; }
      if (res.status !== 200 || !res.body || !res.body.calls) {
        setError(`The run failed: ${failureText(res.status, res.body)}`);
        finishRun(false);
        return;
      }
      const body = res.body;
      // Walk the diagram in step with what the mock door computed.
      if (body.kind === "calls") {
        colorEdge(EDGE_TOKEN, Boolean(body.token));
        if (!(await wait())) return;
        colorEdge(EDGE_CALL, Boolean(body.token));
        if (!(await wait())) return;
        const signin = body.calls[0] && body.calls[0].hops[0];
        colorEdge(EDGE_SIGNIN, Boolean(signin && signin.ok));
        if (signin && signin.ok) {
          for (const c of body.calls) {
            if (!(await wait())) return;
            colorEdge(EDGE_TOOL[c.tool], c.ok);
          }
        }
      }
      setResult(body);
      finishRun(true);
    } finally {
      // A failed or interrupted run never leaves Simulate disabled.
      if (!stale()) setRunning(false);
    }
  };

  useEffect(() => {
    if (result && resultRef.current && resultRef.current.scrollIntoView) resultRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [result]);

  const exchanges = result && result.calls
    ? result.calls.map((c, i) => ({ step: i + 1, title: `Agent calls the door: tools/call ${c.tool}`, status: c.trace.response ? c.trace.response.status : null, trace: c.trace }))
    : [];

  return (
    <section className="card" data-testid="flow-sim" id="flow">
      <h2>{studio.title}</h2>
      <p className="hint">{studio.lede}</p>
      <div className="flow-controls">
        <button type="button" className="primary" disabled={running || !activeScenario} onClick={() => activeScenario && run(activeScenario)}>
          Simulate
        </button>
        <button type="button" onClick={reset}>
          Reset diagram
        </button>
        <span className="hint">Drag the boxes; Simulate keeps them where you put them. Speed is in the header; Reset restores the box positions.</span>
      </div>
      <p className="hint run-status" role="status" data-testid="run-status">{running ? "Running the walk…" : result ? summary(result) : ""}</p>
      <div className="flow-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          nodesDraggable
          nodesConnectable={false}
          fitView
          fitViewOptions={{ padding: 0.12, minZoom: 0.2 }}
          minZoom={0.2}
          zoomOnScroll={false}
          preventScrolling={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {error && (
        <div className="error-pane" role="alert" data-testid="run-error">
          <span>{error}</span>
          <button type="button" onClick={() => activeScenario && run(activeScenario)} disabled={!activeScenario}>Retry</button>
        </div>
      )}
      <div ref={resultRef}>
        <RunResult result={result} />
      </div>
      <LabTrace exchanges={exchanges} result={result} />
    </section>
  );
}
