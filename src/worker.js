// pkghaus-stats: aggregate download statistics for apt.pkg.haus.
//
// One worker, three routes (wrangler.toml): pool downloads, per-suite
// InRelease heartbeats, and the /stats page itself. Counting must never
// break serving: every path through fetch() ends in fetch(request), the
// whole handler is wrapped in try/catch, writes happen after the response
// via waitUntil, and the routes run fail-open so even a worker outage or
// the Workers Free daily limit leaves apt untouched.
//
// Privacy: aggregate counters only. No IPs, no user agents, nothing
// per-client is stored or forwarded.

const STATS_CACHE_SECONDS = 300;
const COUNTING_SINCE = "2026-08-16";
// How many days the two day-indexed sections cover, on the page and in
// /stats.json alike -- they are served from one windowed query each, so
// the two can never disagree. D1 keeps every day forever regardless;
// this is only what gets served, and it is what stops the page growing
// a row (and, for update checks, a bar) per day without end.
const DISPLAY_DAYS = 30;

export default {
  async fetch(request, env, ctx) {
    let hit = null;
    try {
      const path = decodeURIComponent(new URL(request.url).pathname);

      if (path === "/stats" || path === "/stats.json") {
        try {
          return await stats(request, env, ctx, path);
        } catch {
          return new Response("stats temporarily unavailable\n", {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
      }

      // Full downloads only: no Range header (apt resume sends one and a
      // resumed download would double-count), GET only.
      if (request.method === "GET" && !request.headers.has("range")) {
        hit = parse(path);
      }
    } catch {
      // Counting is best-effort; serving is not.
    }

    const response = await fetch(request);
    try {
      // Count only what the origin actually serves: a junk path 404s at
      // GitHub Pages and never reaches the database. Without this gate,
      // anyone could inject arbitrary strings into the published stats
      // and burn the daily D1 write budget with fabricated rows.
      if (hit && response.status === 200) {
        ctx.waitUntil(record(env, hit).catch(() => {}));
      }
    } catch {
      // Never let counting affect the response.
    }
    return response;
  },
};

const SUITES = ["trixie", "testing", "unstable"];

// /pool/main/z/zola/zola_0.23.3-3~haus13+1_amd64.deb -> download row
// /dists/trixie/InRelease                            -> heartbeat row
//
// The path arrives percent-decoded: apt requests pool files with '~' and
// '+' encoded (%7e/%2b), the same spellings purge-cache.sh has to cover.
// Charsets are the Debian-legal ones with length caps, and heartbeats
// accept only the three real suites; the 200-status gate in fetch() is
// the primary defense, these anchors are the belt to its braces.
function parse(path) {
  const deb = path.match(
    /^\/pool\/main\/[a-z0-9]{1,8}\/[a-z0-9][a-z0-9+.-]{0,63}\/([a-z0-9][a-z0-9+.-]{0,63})_([A-Za-z0-9.+~-]{1,64})_([a-z0-9]{1,16})\.deb$/,
  );
  if (deb) {
    const [, pkg, version, arch] = deb;
    return { kind: "download", pkg, version, arch, suite: suiteOf(version) };
  }
  const rel = path.match(/^\/dists\/([a-z]{1,16})\/InRelease$/);
  if (rel && SUITES.includes(rel[1])) {
    return { kind: "heartbeat", suite: rel[1] };
  }
  return null;
}

// The version qualifier carries the suite; that is the point of the
// qualifier scheme (~haus < ~testing < plain).
function suiteOf(version) {
  if (version.includes("~haus")) return "trixie";
  if (version.includes("~testing")) return "testing";
  return "unstable";
}

async function record(env, hit) {
  const day = new Date().toISOString().slice(0, 10);
  if (hit.kind === "download") {
    await env.DB.prepare(
      `INSERT INTO downloads (day, package, version, suite, arch, count)
       VALUES (?1, ?2, ?3, ?4, ?5, 1)
       ON CONFLICT (day, package, version, suite, arch)
       DO UPDATE SET count = count + 1`,
    )
      .bind(day, hit.pkg, hit.version, hit.suite, hit.arch)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO heartbeats (day, suite, count)
       VALUES (?1, ?2, 1)
       ON CONFLICT (day, suite) DO UPDATE SET count = count + 1`,
    )
      .bind(day, hit.suite)
      .run();
  }
}

async function stats(request, env, ctx, path) {
  // Canonical cache key: query strings must not bust the edge cache,
  // or ?x=1..N variants would hit D1 on every request.
  const cacheKey = new Request(`https://apt.pkg.haus${path}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const [byPackage, bySuite, byDay, heartbeats] = await Promise.all([
    env.DB.prepare(
      `SELECT package, SUM(count) AS downloads FROM downloads
       GROUP BY package ORDER BY downloads DESC, package`,
    ).all(),
    env.DB.prepare(
      `SELECT suite, SUM(count) AS downloads FROM downloads
       GROUP BY suite ORDER BY suite`,
    ).all(),
    // Both day-indexed sections are windowed HERE, once, so the page
    // and /stats.json can never disagree. D1 still keeps every day
    // forever (nothing in this worker or schema.sql prunes); this is
    // only what gets served.
    env.DB.prepare(
      `SELECT day, SUM(count) AS downloads FROM downloads
       GROUP BY day ORDER BY day DESC LIMIT ?`,
    )
      .bind(DISPLAY_DAYS)
      .all(),
    // Windowed by DAY, not by row. The old LIMIT 90 capped long-format
    // (day, suite) rows, so the number of days served moved with how
    // many suites were active that day -- 90 days at one suite, 30 at
    // three. The subquery picks the most recent days that have data,
    // matching the by-day query above.
    env.DB.prepare(
      `SELECT day, suite, count FROM heartbeats
       WHERE day IN (SELECT day FROM heartbeats
                     GROUP BY day ORDER BY day DESC LIMIT ?)
       ORDER BY day DESC, suite`,
    )
      .bind(DISPLAY_DAYS)
      .all(),
  ]);

  const data = {
    since: COUNTING_SINCE,
    generated: new Date().toISOString(),
    what_is_counted:
      "GET requests at the edge: pool .deb fetches and per-suite InRelease " +
      "fetches (update checks). Mirrors, CI containers and re-downloads all " +
      "count; this is request volume, not an install base. No per-client " +
      "data is stored. Package and suite totals are all-time; the " +
      `day-indexed sections cover the last ${DISPLAY_DAYS} days, the same ` +
      "window the page shows.",
    downloads_by_package: byPackage.results,
    downloads_by_suite: bySuite.results,
    downloads_by_day: byDay.results,
    update_checks: heartbeats.results,
  };

  // The page interpolates only esc()-escaped strings, and this CSP is
  // the second wall: no scripts, no remote loads, inline styles only.
  const security = {
    "content-security-policy":
      "default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };

  const response =
    path === "/stats.json"
      ? new Response(JSON.stringify(data, null, 2), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": `public, max-age=${STATS_CACHE_SECONDS}`,
            ...security,
          },
        })
      : new Response(page(data), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": `public, max-age=${STATS_CACHE_SECONDS}`,
            ...security,
          },
        });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// The <time> element's no-JS fallback, same shape as the listings' footer:
// 2026-08-16 08:14:08 UTC. The inline script rewrites it into the
// visitor's own timezone at view time, so edge-cached copies stay honest.
function utcStamp(iso) {
  return iso.slice(0, 10) + " " + iso.slice(11, 19) + " UTC";
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[c]);
}

function rows(items, cols) {
  return items
    .map(
      (r) =>
        `<tr>${cols.map((c) => `<td>${esc(r[c] ?? "")}</td>`).join("")}</tr>`,
    )
    .join("\n");
}

// Heartbeats arrive long-format, one row per (day, suite), so a day
// with two active suites prints its date twice and reads as duplicate
// rows. Pivot to one row per day with the suites as fixed columns --
// the suite set is closed at three, so the table can never widen -- and
// draw the day's total as a stacked bar. An idle suite now shows as an
// explicit 0 instead of being omitted, which is information the long
// format threw away. /stats.json keeps the long format: it is the
// better shape for a consumer, and changing it would break parsers.
function updateCheckRows(items) {
  const byDay = new Map();
  for (const r of items) {
    if (!SUITES.includes(r.suite)) continue;
    const day = byDay.get(r.day) ?? { day: r.day, total: 0 };
    day[r.suite] = (day[r.suite] ?? 0) + (Number(r.count) || 0);
    day.total += Number(r.count) || 0;
    byDay.set(r.day, day);
  }

  const days = [...byDay.values()];
  // Bars scale against the busiest day in the window, so the column
  // reads as a trend across what you can see rather than against a peak
  // that scrolled out of it.
  const peak = days.reduce((n, d) => Math.max(n, d.total), 0) || 1;

  return days
    .map((d) => {
      const cells = SUITES.map((s) => {
        const n = d[s] ?? 0;
        return `<td class="n${n ? "" : " zero"}">${n}</td>`;
      }).join("");

      const segs = d.total
        ? SUITES.map((s, i) => {
            const n = d[s] ?? 0;
            if (!n) return "";
            const share = (n / d.total) * 100;
            const unit = n === 1 ? "fetch" : "fetches";
            return (
              `<b class="s${i + 1}" style="width:${share.toFixed(1)}%"` +
              ` tabindex="0" data-tip="${esc(s)} &middot; ${n} ${unit}` +
              ` &middot; ${Math.round(share)}%"></b>`
            );
          }).join("")
        : "";

      return (
        `<tr><td class="day">${esc(d.day)}</td>${cells}` +
        `<td class="n tot">${d.total}</td>` +
        `<td class="shape"><div class="bar" style="width:${((d.total / peak) * 100).toFixed(1)}%">${segs}</div></td></tr>`
      );
    })
    .join("\n");
}

function updateChecksSection(items) {
  const keys = SUITES.map(
    (s, i) => `<span><i class="s${i + 1}"></i>${esc(s)}</span>`,
  ).join("");
  const heads = SUITES.map((s) => `<th class="n">${esc(s)}</th>`).join("");
  return `<h2>Update checks (InRelease fetches, last ${DISPLAY_DAYS} days)</h2>
<p class="legend">${keys}</p>
<div class="tablewrap pivot"><table><thead><tr><th>day</th>${heads}<th class="n tot">total</th><th class="shape"></th></tr></thead>
<tbody data-pager="days">
${updateCheckRows(items)}
</tbody></table></div>`;
}

// The visual language of apt.pkg.haus (scripts/render-index.sh in
// pkghaus/apt) and pkg.haus itself: same tokens in both themes, mono
// headings, dashed table rules, and the parcel mark (the small cut of
// the brand's size ladder, a copy as on every public surface).
const STYLE = `<style>
  :root {
    --paper: #FFFFFF; --ink: #141414; --muted: #6B6B66;
    --line: #E4E4DF; --accent: #E0421B;
    /* Brand red is 4.23:1 on white: fine for the mark, dots and the big
       total (large text, 3:1) and short of the 4.5:1 small text needs.
       Small text takes a darker step. Dark passes at 5.92:1. */
    --accent-text: #CC3B18;
    /* Suites are ordinal (stable -> testing -> unstable), so the update
       bars take a single-hue sequential ramp, not three arbitrary hues.
       Checked for colour-blind separation: worst adjacent pair dE 19.0
       (deutan), 21.0 normal vision, lightness monotonic. */
    --s1: #F7C7B5; --s2: #E5714F; --s3: #9E2C0C;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #0E0E0E; --ink: #F0F0EC; --muted: #8F8F88;
      --line: #2A2A27; --accent: #F0603C;
      --accent-text: #F0603C;
      /* Re-stepped against the dark surface rather than flipped: the
         ordinal direction holds (unstable stays most prominent).
         dE 20.5 protan, 21.7 normal. */
      --s1: #8C3418; --s2: #E06B44; --s3: #FAD0BA;
    }
  }
  * { box-sizing: border-box; }
  body {
    background: var(--paper); color: var(--ink);
    font-family: system-ui, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    line-height: 1.55; margin: 0; padding: 0 1.25rem 4rem;
  }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; }
  main { max-width: 46rem; margin: 0 auto; }
  header {
    display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
    padding: 2.25rem 0 1.25rem; border-bottom: 3px solid var(--ink);
  }
  h1 {
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: clamp(1.9rem, 6vw, 2.6rem); letter-spacing: -.03em;
    margin: 0; line-height: 1.15; min-width: 0;
  }
  h1 .dot, h1 .sep { color: var(--accent); }
  h1 .path { font-size: .65em; }
  h1 a { color: inherit; text-decoration: none; }
  h1 a:hover { color: var(--accent); }
  h2 {
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: .78rem; font-weight: 600; letter-spacing: .16em;
    text-transform: uppercase; color: var(--muted); margin: 2.25rem 0 0;
  }
  h2::before { content: "~ "; color: var(--accent-text); }
  p.tagline { flex-basis: 100%; color: var(--muted); margin: .75rem 0 0; max-width: 38rem; }
  p.body { margin: .75rem 0 0; max-width: 38rem; }
  /* Like the landing page's shell tints: keywords are bold ink; the
     accent stays reserved for what the reader acts on. */
  code.kw { font-weight: 600; }
  .tablewrap { overflow-x: auto; padding: .5rem 0 0; }
  table { border-collapse: collapse; width: 100%; font-size: .92rem; }
  th, td { text-align: left; padding: .5rem .75rem .5rem 0; border-bottom: 1px dashed var(--line); }
  th {
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: .7rem; letter-spacing: .12em; text-transform: uppercase;
    color: var(--muted); font-weight: 600;
  }
  td { font-variant-numeric: tabular-nums; }
  td:last-child, th:last-child { text-align: right; }

  /* ---- pager (built by the inline script; absent without JS) ---- */
  .pager {
    display: flex; gap: .35rem; align-items: center; flex-wrap: wrap;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: .78rem; margin: .7rem 0 0;
  }
  .pager .lbl { color: var(--muted); margin-right: .35rem; }
  .pager .gap { color: var(--muted); }
  .pager button {
    font: inherit; color: var(--muted); background: none;
    border: 1px solid var(--line); padding: .1rem .5rem; cursor: pointer;
  }
  .pager button:hover:not(:disabled) { color: var(--accent-text); border-color: var(--accent); }
  .pager button[aria-current="true"] {
    color: var(--paper); background: var(--ink); border-color: var(--ink);
  }
  .pager button:disabled { opacity: .4; cursor: default; }

  /* ---- update-check pivot: one row per day, suites as columns ---- */
  /* Headroom for the top row's tooltip. The wrapper is overflow-x:auto
     and CSS computes the other axis to auto with it, so anything
     escaping upward is clipped, not scrolled to. */
  .pivot { padding-top: 2.5rem; }
  .pivot td.n, .pivot th.n { text-align: right; }
  .pivot td.day { color: var(--muted); white-space: nowrap; }
  .pivot td.zero { color: var(--muted); }
  .pivot td.tot, .pivot th.tot { font-weight: 600; }
  .pivot td.shape, .pivot th.shape { width: 38%; min-width: 8rem; padding-right: 0; text-align: left; }
  .legend {
    display: flex; gap: 1.25rem; flex-wrap: wrap; align-items: center;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: .72rem; color: var(--muted); margin: .75rem 0 0;
  }
  .legend span { display: inline-flex; align-items: center; gap: .4rem; }
  .legend i { width: 10px; height: 10px; border-radius: 1px; display: block; }
  /* The bar is the positioned ancestor: every tooltip anchors to its
     LEFT edge. Centring on the segment runs the right-hand ones off the
     wrapper, where they get clipped. */
  .bar { display: flex; gap: 2px; height: 10px; position: relative; align-items: center; }
  /* Transparent borders grow the hit box to 28px while background-clip
     keeps the paint on the 10px strip, so a 3%-wide sliver stays
     catchable. */
  .bar b {
    display: block; border-radius: 1px; height: 28px; margin: -9px 0;
    border-top: 9px solid transparent; border-bottom: 9px solid transparent;
    background-clip: content-box;
  }
  .s1 { background: var(--s1); }
  .s2 { background: var(--s2); }
  .s3 { background: var(--s3); }
  .bar b::after {
    content: attr(data-tip);
    position: absolute; left: 0; bottom: calc(100% + 8px);
    background: var(--ink); color: var(--paper);
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: .72rem; line-height: 1.5; padding: .3rem .55rem;
    white-space: nowrap; opacity: 0; pointer-events: none; z-index: 6;
    transition: opacity .12s ease;
  }
  .bar b:hover::after, .bar b:focus-visible::after { opacity: 1; }
  .bar:hover b { opacity: .35; transition: opacity .12s ease; }
  .bar:hover b:hover { opacity: 1; }
  @media (prefers-reduced-motion: reduce) {
    .bar b::after, .bar:hover b { transition: none; }
  }
  .big {
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: clamp(1.9rem, 6vw, 2.6rem); color: var(--accent);
    margin: .5rem 0 0; line-height: 1;
  }
  footer {
    border-top: 3px solid var(--ink); margin-top: 3rem;
    padding-top: 1.5rem; display: flex; gap: 1.5rem; flex-wrap: wrap;
    font-size: .85rem; color: var(--muted);
  }
  footer a { color: inherit; }
  footer a:hover { color: var(--accent-text); }
  a { color: var(--accent-text); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>`;

// The mark at 80 px, primary cut (fine strokes, serrated tape), exactly
// as the apt listings render it above 48 px per the brand's size ladder.
const LOGO = `<svg width="80" height="80" viewBox="0 0 64 64" role="img" aria-label="pkg.haus - a taped parcel with a haus stenciled on its face">
  <path d="M32 8 L54 19 V45 L32 56 L10 45 V19 Z" fill="var(--paper)"/>
  <g stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" fill="none">
    <path d="M10 19 L32 30 L54 19"/>
    <path d="M32 30 V56"/>
    <path d="M32 8 L54 19 V45 L32 56 L10 45 V19 Z"/>
  </g>
  <path d="M17 15.5 L25 11.5 L47 22.5 L47 28.5 L45.7 27.2 L44.3 29.8 L43 28.5 L41.7 31.2 L40.3 29.8 L39 32.5 L39 26.5 Z" fill="var(--accent)"/>
  <path d="M21 20 L27 26 V33 H15 V26 Z" fill="currentColor" transform="matrix(1,0.5,0,1,0,0)"/>
</svg>`;

// `pager` names the row unit ("packages", "days") for a table long
// enough to page; omitted, the table renders whole.
function section(title, head, body, pager) {
  const tag = pager ? `<tbody data-pager="${pager}">` : "<tbody>";
  return `<h2>${title}</h2>
<div class="tablewrap"><table><thead><tr>${head}</tr></thead>
${tag}
${body}
</tbody></table></div>`;
}

function page(data) {
  const totals = data.downloads_by_package.reduce(
    (n, r) => n + Number(r.downloads),
    0,
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Aggregate download statistics for the apt.pkg.haus archive.">
<title>apt.pkg.haus/stats</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<script defer src="/zk/js/script.js"></script>
<script>
  window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};
  plausible.init({ endpoint: "/zk/api/event" })
</script>
${STYLE}
</head>
<body>
<main>
<header>
${LOGO}
<h1><a href="https://apt.pkg.haus">apt<span class="dot">.</span>pkg<span class="dot">.</span>haus</a><span class="path"><span class="sep">/</span>stats</span></h1>
<p class="tagline">Aggregate download statistics for the archive, counted
at the edge since ${esc(data.since)}.</p>
</header>
<p class="body"><code class="kw">GET</code> requests at the edge:
<code>pool/&hellip;.deb</code> fetches and per-suite <code>InRelease</code>
fetches (update checks). Mirrors, CI containers and re-downloads all count;
this is request volume, not an install base. No per-client data is stored.
Refreshes every ${STATS_CACHE_SECONDS / 60} minutes; machine-readable as
<a href="/stats.json"><code>stats.json</code></a>.</p>

<h2>Total downloads</h2>
<p class="big">${totals}</p>

${section(
    "Downloads by package",
    "<th>package</th><th>downloads</th>",
    rows(data.downloads_by_package, ["package", "downloads"]),
    "packages",
  )}

${section(
    "Downloads by suite",
    "<th>suite</th><th>downloads</th>",
    rows(data.downloads_by_suite, ["suite", "downloads"]),
  )}

${section(
    `Downloads by day (last ${DISPLAY_DAYS} days)`,
    "<th>day</th><th>downloads</th>",
    rows(data.downloads_by_day, ["day", "downloads"]),
    "days",
  )}

${updateChecksSection(data.update_checks)}

<footer>
  <a href="https://pkg.haus">pkg.haus</a>
  <a href="https://github.com/pkghaus/stats">github.com/pkghaus/stats</a>
  <span>counted at the edge
  <time datetime="${esc(data.generated)}">${esc(utcStamp(data.generated))}</time></span>
  <span>Apache-2.0</span>
</footer>
</main>
<script>
  document.querySelectorAll("time[datetime]").forEach(function (t) {
    t.textContent = new Date(t.getAttribute("datetime")).toLocaleString([], {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false, timeZoneName: "short"
    });
  });

  // Pages any tbody carrying data-pager, whose value names the row unit.
  // Progressive enhancement on purpose: the rows ship visible, so
  // without this script every table simply renders whole -- nothing is
  // reachable only by clicking. /stats.json stays the complete source.
  (function () {
    var PER = 15, SPAN = 2;
    document.querySelectorAll("tbody[data-pager]").forEach(function (body) {
      var rows = Array.prototype.slice.call(body.rows);
      var pages = Math.ceil(rows.length / PER);
      if (pages < 2) return;

      var unit = body.getAttribute("data-pager");
      var wrap = body.closest(".tablewrap");
      var nav = document.createElement("p");
      nav.className = "pager";
      nav.setAttribute("role", "navigation");
      nav.setAttribute("aria-label", unit + " pages");
      wrap.insertAdjacentElement("afterend", nav);

      var cur = 1;

      function button(text, enabled, go, current) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        if (!enabled) b.disabled = true;
        if (current) b.setAttribute("aria-current", "true");
        b.addEventListener("click", function () { cur = go; draw(); });
        nav.appendChild(b);
      }

      function draw() {
        rows.forEach(function (tr, i) {
          tr.style.display =
            i >= (cur - 1) * PER && i < cur * PER ? "" : "none";
        });

        nav.textContent = "";
        var lbl = document.createElement("span");
        lbl.className = "lbl";
        lbl.textContent = rows.length + " " + unit;
        nav.appendChild(lbl);

        button("prev", cur > 1, cur - 1);
        // Windowed: first, last, and current +/- SPAN, with an ellipsis
        // wherever the run skips. An unwindowed row would print two
        // dozen buttons once a year of history is in.
        var last = 0;
        for (var p = 1; p <= pages; p++) {
          if (p !== 1 && p !== pages && Math.abs(p - cur) > SPAN) continue;
          if (last && p - last > 1) {
            var gap = document.createElement("span");
            gap.className = "gap";
            gap.textContent = "…";
            nav.appendChild(gap);
          }
          button(String(p), true, p, p === cur);
          last = p;
        }
        button("next", cur < pages, cur + 1);
      }

      draw();

      // The last page is usually short (24 packages = 15 + 9), so the
      // table would shrink on the way to it and drag everything below
      // up the screen. Page 1 is always full -- pages >= 2 guarantees
      // it -- so its height is the tallest any page gets: freeze it as
      // a floor. Re-measured on resize, where wrapping changes row
      // heights; the floor is cleared first so it can shrink again.
      function freezeHeight() {
        wrap.style.minHeight = "";
        var was = cur;
        cur = 1;
        draw();
        var full = wrap.offsetHeight;
        cur = was;
        draw();
        wrap.style.minHeight = full + "px";
      }

      freezeHeight();

      var resizeTimer;
      addEventListener("resize", function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(freezeHeight, 150);
      });
    });
  })();
</script>
</body>
</html>`;
}
