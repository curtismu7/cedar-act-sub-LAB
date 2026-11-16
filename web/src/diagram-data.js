// Studio diagram (rule 17): the diagram is diagram-studio/1 data, looked up BY NAME (its id), never hand-built in a component.
// The data is the studio's own flow, CEDAR_ACT_SUB_FLOW in the diagram-studio repo (core/src/apps.js), vendored byte for byte into
// studio-data/ with a sha256 pin (studio-data.sha256; re-vendor, never edit). The ReactFlow canvas renders the data's nodes and edges;
// Simulate walks the picked scenario over them.
import cedarActSubFlow from "./studio-data/cedar-act-sub-flow.json";

const DIAGRAMS = { [cedarActSubFlow.id]: cedarActSubFlow };

export function getDiagram(id) {
  if (!Object.hasOwn(DIAGRAMS, id)) throw new Error(`unknown diagram "${id}"; known: ${Object.keys(DIAGRAMS).join(", ")}`);
  return DIAGRAMS[id];
}

// The edge between two nodes, by their ids, so reordering the data's edges never colours the wrong arrow.
export function edgeIndex(diagram, source, target) {
  const i = diagram.edges.findIndex((e) => e.source === source && e.target === target);
  if (i < 0) throw new Error(`no edge from ${source} to ${target} in diagram "${diagram.id}"`);
  return i;
}
