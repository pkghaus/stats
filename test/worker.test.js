// What the page decides without a network: how a suite is labelled and
// ordered, and which inline scripts the CSP allows. Path parsing and the
// counting gate moved to pkghaus/apt with the Worker that serves the archive.

import test from "node:test";
import assert from "node:assert/strict";
import { suiteLabel, page, scriptSrc } from "../src/worker.js";

test("suiteLabel names the role before the codename, and leaves the others alone", () => {
  assert.equal(suiteLabel("trixie"), "stable (trixie)");
  assert.equal(suiteLabel("testing"), "testing");
  assert.equal(suiteLabel("unstable"), "unstable");
});

test("labelling sorts the suites into release order under a naive sort", () => {
  // The bug this fixes: "trixie" sorts between "testing" and "unstable", so a
  // table ordered by name read testing, stable, unstable.
  const bare = ["trixie", "testing", "unstable"].slice().sort();
  assert.deepEqual(bare, ["testing", "trixie", "unstable"]);

  const labelled = ["trixie", "testing", "unstable"].map(suiteLabel).sort();
  assert.deepEqual(labelled, ["stable (trixie)", "testing", "unstable"]);
});

// The CSP names each inline script by hash. Editing PLAUSIBLE_INIT or ENHANCE
// is safe by construction -- the hash comes from the same constant that is
// emitted -- so what this guards is the other way in: a <script> written
// straight into the template, which the CSP would then block with no server-
// side error at all. The page would just quietly lose its analytics or its
// paging. Verified by mutation: adding one inline script to page() fails this.
test("every inline script on the page is named by the CSP", async () => {
  const html = page({
    since: "2026-08-16",
    generated: "2026-08-24T10:00:00.000Z",
    what_is_counted: "test",
    downloads_by_package: [{ package: "zola", downloads: 3 }],
    downloads_by_suite: [{ suite: "trixie", downloads: 3 }],
    downloads_by_day: [{ day: "2026-08-24", downloads: 3 }],
    update_checks: [{ day: "2026-08-24", suite: "trixie", count: 1 }],
  });

  const directive = await scriptSrc();
  const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(inline.length >= 2, `expected inline scripts, found ${inline.length}`);

  for (const [, body] of inline) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body),
    );
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    assert.ok(
      directive.includes(`'sha256-${b64}'`),
      `inline script not covered by the CSP: sha256-${b64}\n${body.slice(0, 80)}`,
    );
  }

  assert.ok(!directive.includes("unsafe-inline"), "script-src must not allow unsafe-inline");
});

// The two metrics deliberately disagree about 304. Downloads must not count
// one (the client already had the file); update checks must (apt sends
// If-Modified-Since and a quiet archive answers 304 without the client
// fetching an index at all, which is what nearly every check looks like).
// Sharing a single 200-only gate is what made update checks undercount by
// roughly 5x, measured 2026-08-24.
