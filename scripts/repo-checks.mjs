#!/usr/bin/env node
// Repo checks: forbidden identifiers, attribution lines, compose policies.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const root = new URL("..", import.meta.url).pathname;
const failures = [];

// The forbidden identifiers are assembled from parts so this file does not itself contain them.
const j = (...p) => p.join("");
// Hostname-level check: the family lab-proxy domain (local.<domain> or <lab>.local.<domain>) is the only host of that domain a lab may name;
// any other host of it fails.
const DOMAIN = j("ping-", "devops");
const FORBIDDEN_HOST_RE = new RegExp(`(?:[\\w.-]+\\.)?${DOMAIN}\\.com(?::\\d+)?`, "g");
const ALLOWED_PROXY_HOSTS = [new RegExp(`^local\\.${DOMAIN}\\.com(?::\\d+)?$`), new RegExp(`^[\\w-]+\\.local\\.${DOMAIN}\\.com(?::\\d+)?$`)];
function forbiddenHostHits(text) {
  const hits = [];
  for (const m of String(text).matchAll(FORBIDDEN_HOST_RE)) {
    if (!ALLOWED_PROXY_HOSTS.some((re) => re.test(m[0]))) hits.push(m[0]);
  }
  return hits;
}
const FORBIDDEN = [
  /pingone\.com(?!\.invalid)/,
  new RegExp(j("proc", "yon"), "i"),
  new RegExp(j("c", "muir"), "i"),
  new RegExp(j("pf-", "route-", "c", "-test")),
  new RegExp(j("mcp", "gw"), "i"),
  new RegExp(j("curtis", "mu7")),
  new RegExp(j("ping-", "sandbox")),
  /ai[-_]?demo2/i,
  new RegExp(j("Co-Authored", "-By")),
  new RegExp(j("Generated ", "with"))
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// The vendored family stylesheet is canonical and shared; its comments mention
// other projects by design. Skip it for the cross-project-identifier scan but
// keep its sha pinned against drift (the vendored-sha check below).
// The vendored conformance gate and the family attribution checker quote the
// patterns they enforce (org names, attribution lines); skip them the same way.
const VENDORED_ALLOWED = new Set(["standalone-ui.css", "demo-kit-conformance.mjs", "check-no-ai-attribution.sh"]);

let files = 0;
for (const file of walk(root)) {
  if (!/\.(js|mjs|jsx|ts|json|md|yml|yaml|html|css|sh|example)$/.test(file)) continue;
  files++;
  // The vendored family stylesheet is canonical and shared; its comments name
  // other projects by design. Drift is caught separately by check-css/vendored sha.
  const text = readFileSync(file, "utf8");
  if (VENDORED_ALLOWED.has(file.split("/").pop()) || file.endsWith("repo-checks.mjs")) continue;
  const hostHits = forbiddenHostHits(text);
  if (hostHits.length) failures.push(`${file}: non-proxy host(s) of the family domain: ${[...new Set(hostHits)].join(", ")}`);
  for (const re of FORBIDDEN) {
    if (re.test(text)) failures.push(`${file}: matches ${re}`);
  }
}

console.log(`repo-checks: scanned ${files} files`);

// Vendored stylesheet: must equal the hash pinned in scripts/standalone-ui.sha256 (so CI, which has no family checkout, catches a
// hand edit), and must equal the family canonical when that checkout exists (re-vendor with cp, then re-pin).
const vendored = join(root, "web", "standalone-ui.css");
const pinFile = join(root, "scripts", "standalone-ui.sha256");
const canonical = join(process.env.HOME || "", "Development", "AI-DEMO-Standalone", "shared", "standalone-ui.css");
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
if (existsSync(vendored)) {
  const v = sha(vendored);
  const [pin, pinName] = existsSync(pinFile) ? readFileSync(pinFile, "utf8").trim().split(/\s+/) : [];
  if (!pin || pinName !== "standalone-ui.css") failures.push("scripts/standalone-ui.sha256 is missing or malformed");
  else if (v !== pin) failures.push(`web/standalone-ui.css differs from its pin in scripts/standalone-ui.sha256 (${v.slice(0, 8)} vs ${pin.slice(0, 8)})`);
  else console.log("repo-checks: vendored standalone-ui.css matches its pin");
  if (existsSync(canonical)) {
    const c = sha(canonical);
    if (v !== c) failures.push(`web/standalone-ui.css drifts from the family canonical (${v.slice(0, 8)} vs ${c.slice(0, 8)})`);
    else console.log("repo-checks: vendored standalone-ui.css matches canonical");
  }
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log(`repo-checks: PASS (0 forbidden-identifier hits)`);
