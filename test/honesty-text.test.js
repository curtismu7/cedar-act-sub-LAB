// Rule 2 (simulation honesty): the words the review refused must not come back in any text the lab ships (B1, M3, M4, M5, M6, m2, BD-1, R2).
// Unmeasured behaviour is written as believed / UNVERIFIED / simulated; what was measured is one real agent, so nothing may read as "a different agent was refused".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
// Code comments are not shown to anyone; only strings and prose are checked.
const shown = (p) => (/\.jsx?$/.test(p) ? read(p).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n") : read(p));
const FILES = [
  "README.md", "docs/talk-track.md", "docs/shelf-entry.json", "content-pack.json", "web/src/studio-data/cedar-act-sub-flow.json",
  "server/src/scenarios.js",
  ...readdirSync(join(root, "web/src")).filter((f) => /\.jsx?$/.test(f)).map((f) => `web/src/${f}`)
];

const BANNED = [
  [/\bverified\b/i, "'verified' (a product claim with no named check); write UNVERIFIED or name the source"],
  [/\bvalidated\b|validation was measured|the controller validated/i, "'validated' (no recorded observation)"],
  [/never matches/i, "'never matches' stated as fact; write 'believed never to match (UNVERIFIED)'"],
  [/never enforced/i, "'never enforced' as fact; write 'not enforced per the console documentation (not re-run)'"],
  [/Cedar has no regex|Can it match a pattern\? No/i, "'Cedar has no regex' (Cedar has a like operator; only this template's rule is a .contains() test)"],
  [/different agent (was refused|refused)/i, "reads as if a second agent was refused (never measured)"],
  [/exact text the template generated|The Cedar that was validated/i, "the Cedar on the page is this lab's generated shape, not a capture"],
  [/\bWhat Privilege did\b|Real mode shows the actual gateway/, "the trace panel's default wording, wrong over a mock"],
  [/Press Run\b/, "there is no Run button"]
];

for (const file of FILES) {
  test(`${file}: none of the refused wordings`, () => {
    const text = shown(file);
    for (const [re, why] of BANNED) {
      const m = text.match(re);
      assert.equal(m, null, `${file} says ${JSON.stringify(m && m[0])}: ${why}`.slice(0, 300));
    }
  });
}

test("every mention of the 7 seconds is framed as one observation, not a propagation time", () => {
  let seen = 0;
  for (const file of FILES) {
    const text = shown(file);
    for (const m of text.matchAll(/7 seconds/g)) {
      seen += 1;
      const around = text.slice(Math.max(0, m.index - 300), m.index + 300);
      assert.match(around, /one (run|observation)/i, `${file}: "7 seconds" without 'one run' / 'one observation'`);
    }
  }
  assert.ok(seen >= 4, `expected the 7 seconds in the evidence card, run note, talk track and pack; saw ${seen}`);
});

test("act as text, Candidate and RequiredClaims are never stated as fact: each mention carries a hedge", () => {
  const HEDGE = /believed|UNVERIFIED|simulated|not measured|not re-run|Expected|should/i;
  for (const file of ["README.md", "docs/talk-track.md", "content-pack.json", "web/src/studio-data/cedar-act-sub-flow.json"]) {
    for (const line of read(file).split("\n")) {
      if (/RequiredClaims|act (emitted )?as (the )?text|Candidate/i.test(line) && /not enforced|never to match|same job|no sub|no act\.sub/i.test(line)) {
        assert.match(line, HEDGE, `${file}: unhedged claim: ${line.slice(0, 140)}`);
      }
    }
  }
});

test("the shelf entry and the pack cards do not say a different agent was refused, and say what was measured", () => {
  const card = JSON.parse(read("content-pack.json")).cards.find((c) => c.id === "try-same-token");
  assert.match(card.description, /policy naming a different agent value refuses the same token/);
  assert.match(card.description, /second agent was not tested/);
  const shelf = JSON.parse(read("docs/shelf-entry.json"));
  assert.match(shelf.description, /one real agent/);
});
