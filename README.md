# stats

Self-owned download statistics for [apt.pkg.haus](https://apt.pkg.haus),
published at [apt.pkg.haus/stats](https://apt.pkg.haus/stats)
(machine-readable: [/stats.json](https://apt.pkg.haus/stats.json)).

APT clients never execute JavaScript, so browser analytics see none of the
archive's real traffic, and the GitHub Pages origin produces no logs. This
worker is the smallest possible replacement for that missing log source:
it counts requests at the edge and publishes the aggregates.

## How it works

Two Cloudflare Workers, split writer from reader.

`pkghaus-archive`, deployed from [pkghaus/apt](https://github.com/pkghaus/apt),
serves `pool/` and `dists/` out of the R2 bucket and writes a counter row for
each thing it serves. It has to be the one counting: it is the only point
every download passes through, and a bucket exposed on its own hostname would
serve the same bytes and count none of them.

This repository is the reader. One route, `apt.pkg.haus/stats*`, which queries
the same D1 database and renders it as HTML and JSON, edge-cached for five
minutes. That pattern is more specific than anything the archive Worker
matches, and Cloudflare resolves overlapping routes by specificity.

The split means a bad deploy here cannot take the archive down.

What gets counted:

- `.deb` downloads, parsed into package, version, suite (from the version
  qualifier) and architecture.
- Update checks, one per `dists/<suite>/InRelease` fetch.

Counters live in a D1 (SQLite) table keyed on
`(day, package, version, suite, arch)`. Everything runs on the Cloudflare
free plan.

## What the numbers mean

Request counts, not an install base. Mirrors, CI containers and
re-downloads all count. No per-client data is stored: no IP addresses,
no user agents, only aggregate counters per day. Ranged requests
(download resumes) are deliberately not counted, so a resumed download
counts once, not twice.

An update check counts whether the archive answers `200` or `304`. A `304` is
not a download, but it is the ordinary shape of an update check: apt sends
`If-Modified-Since`, an unchanged archive answers `304`, and the client never
fetches an index at all. Counting only `200`s measured fresh caches rather
than how often the archive is polled, which undercounted by roughly five to
one.

## Security

The archive Worker takes attacker-controllable input (any URL path) and this
page publishes data derived from it, so it defends in layers:

- A request is only counted once the archive has actually answered for it, so
  a fabricated pool path finds no object, is never served, and never reaches
  the database. Nobody can inject made-up package names into this page or burn
  the daily D1 write budget with junk rows.
- On top of that gate, parsed fields must match Debian-legal charsets
  with length caps, and heartbeats accept only the three real suites.
- Everything rendered into the HTML is escaped, and the responses carry
  a deny-all Content-Security-Policy (no scripts, inline styles only),
  nosniff and no-referrer headers.
- /stats is cached under a canonical key, so query-string variants
  cannot bypass the edge cache to hammer the database.
- All statements are parameterized D1 queries; no string-built SQL.

## Deploying

CI deploys on every push to master. It needs two repository settings:

- Secret `CLOUDFLARE_API_TOKEN` with **Account > Workers Scripts > Edit**,
  **Account > D1 > Edit** and **Zone (pkg.haus) > Workers Routes > Edit**.
- Variable `CLOUDFLARE_ACCOUNT_ID`.

The D1 database is created on first deploy and resolved by name on every
deploy after that; the schema is idempotent. One dashboard step after the
first deploy: set the worker's failure mode to "Fail open"
(Workers & Pages, pkghaus-stats, Settings).

Local development:

```bash
npx wrangler@4 dev
```

## License

```
Copyright 2026 pkg.haus

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## Buy us a coffee?

If you feel like buying us a coffee (or a beer?), donations are welcome:

```
BTC : bc1qq04jnuqqavpccfptmddqjkg7cuspy3new4sxq9
DOGE: DRBkryyau5CMxpBzVmrBAjK6dVdMZSBsuS
ETH : 0x2238A11856428b72E80D70Be8666729497059d95
LTC : MQwXsBrArLRHQzwQZAjJPNrxGS1uNDDKX6
```
