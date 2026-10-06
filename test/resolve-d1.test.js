// scripts/resolve-d1.sh against a stub `npx`, in a scratch copy of the real
// wrangler.toml: deploy and the weekly export both depend on it.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/resolve-d1.sh", import.meta.url));
const CONFIG = fileURLToPath(new URL("../wrangler.toml", import.meta.url));
const UUID = "0b7e5c1a-3f2d-4e6b-9a8c-1d2e3f4a5b6c";

function run({ list, fail = false }) {
  const dir = mkdtempSync(join(tmpdir(), "resolve-d1-"));
  copyFileSync(CONFIG, join(dir, "wrangler.toml"));
  writeFileSync(join(dir, "list.json"), JSON.stringify(list ?? []));
  writeFileSync(
    join(dir, "npx"),
    `#!/bin/sh
[ "$*" = "wrangler d1 list --json" ] || { echo "unexpected: $*" >&2; exit 9; }
${fail ? 'echo "Authentication error [code: 10000]" >&2; exit 1' : `cat "${dir}/list.json"`}
`,
    { mode: 0o755 },
  );
  const r = spawnSync("bash", [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  return { ...r, toml: readFileSync(join(dir, "wrangler.toml"), "utf8") };
}

test("the placeholder is a real line of the config, so the substitution has something to hit", () => {
  assert.match(readFileSync(CONFIG, "utf8"), /^database_id = "PLACEHOLDER_RESOLVED_IN_CI"$/m);
});

test("substitutes the id of the database named exactly pkghaus-stats", () => {
  const r = run({
    list: [
      { name: "pkghaus-stats-old", uuid: "11111111-1111-1111-1111-111111111111" },
      { name: "pkghaus-stats", uuid: UUID },
    ],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.toml, new RegExp(`^database_id = "${UUID}"$`, "m"));
  assert.doesNotMatch(r.toml, /PLACEHOLDER_RESOLVED_IN_CI/);
});

test("fails, and leaves the placeholder, when the database is absent", () => {
  const r = run({ list: [{ name: "something-else", uuid: UUID }] });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^::error title=D1 database missing::/m);
  assert.match(r.toml, /PLACEHOLDER_RESOLVED_IN_CI/);
});

test("a failing wrangler fails the step as itself, not as a missing database", () => {
  const r = run({ fail: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Authentication error/);
  assert.doesNotMatch(r.stdout, /D1 database missing/);
  assert.match(r.toml, /PLACEHOLDER_RESOLVED_IN_CI/);
});
