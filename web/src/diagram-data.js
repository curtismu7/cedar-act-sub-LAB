// Studio diagram (rule 17): the diagram is diagram-studio/1 data, looked up BY NAME (its id), never hand-built in a component.
// diagram-studio's apps.js tells apps to "load these by id from their own copy of the JSON": data/diagram.json is this lab's copy,
// registered here under its id. The ReactFlow canvas renders the data's nodes and edges; Simulate walks the picked scenario over them.
import cedarActSub from "../../data/diagram.json";

const DIAGRAMS = { [cedarActSub.id]: cedarActSub };

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
