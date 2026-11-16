// The vendored shared pieces match their pin files byte for byte (rules 22, 24): TopMenu, JsonPane and the shared dialogs. Change them in the canonical
// copy under AI-DEMO-Standalone/shared, re-vendor with cp, re-pin; never edit them here. (gateway-trace and verify-mark have their own pin tests.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (p) => createHash("sha256").update(readFileSync(join(root, p))).digest("hex");
const pins = (file) => readFileSync(join(root, file), "utf8").split("\n").filter((l) => /^[0-9a-f]{64}\s/.test(l)).map((l) => l.split(/\s+/));

test("web/src/top-menu/* matches top-menu.sha256 and both files are pinned", () => {
  const dir = "web/src/top-menu";
  const p = pins(`${dir}/top-menu.sha256`);
  assert.deepEqual(p.map(([, f]) => f).sort(), ["TopMenu.jsx", "top-menu.css"]);
  for (const [hash, file] of p) assert.equal(sha(`${dir}/${file}`), hash, `${file} differs from top-menu.sha256 (hand-edited, or re-vendored without re-pinning)`);
});

test("web/src/components/JsonPane.* matches its pin files", () => {
  const dir = "web/src/components";
  for (const [file, pinFile] of [["JsonPane.jsx", "JsonPane.sha256"], ["JsonPane.css", "JsonPane.css.sha256"]]) {
    const [hash, name] = readFileSync(join(root, dir, pinFile), "utf8").trim().split(/\s+/);
    assert.equal(name, file, pinFile);
    assert.equal(sha(`${dir}/${file}`), hash, `${file} differs from ${pinFile}`);
  }
});

test("the shared dialogs (floating-dialog, help-dialog, talk-track) and ShelfLink match their pin files, and every file in those folders is pinned", () => {
  const sets = [
    ["web/src/floating-dialog", "floating-dialog.sha256", ["FloatingDialog.jsx", "floating-dialog.css", "floating-dialog.test.jsx", "geometry.js", "useFloatingPanel.js"]],
    ["web/src/help-dialog", "help-dialog.sha256", ["HelpDialog.jsx"]],
    ["web/src/talk-track", "talk-track.sha256", ["TalkTrackDialog.jsx"]],
    ["web/src/components", "ShelfLink.sha256", ["ShelfLink.jsx"]]
  ];
  for (const [dir, pinFile, files] of sets) {
    const p = pins(`${dir}/${pinFile}`);
    assert.deepEqual(p.map(([, f]) => f).sort(), [...files].sort(), `${dir}/${pinFile} pins`);
    for (const [hash, file] of p) assert.equal(sha(`${dir}/${file}`), hash, `${dir}/${file} differs from ${pinFile} (hand-edited, or re-vendored without re-pinning)`);
  }
});

test("the shared TopMenu is the one the page imports, and the vendored stylesheet and attribution check are present", () => {
  const app = readFileSync(join(root, "web/src/App.jsx"), "utf8");
  assert.match(app, /import TopMenu from "\.\/top-menu\/TopMenu\.jsx"/);
  assert.match(app, /<TopMenu\b/);
  assert.ok(existsSync(join(root, "web/standalone-ui.css")));
  assert.ok(existsSync(join(root, "scripts/check-no-ai-attribution.sh")));
  assert.ok(existsSync(join(root, "test/kit/demo-kit-conformance.mjs")));
});
