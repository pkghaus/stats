#!/bin/sh
# Test suite for contrib/apt-stats.
#
# Runs the tool under every shell and awk pair present on the machine and
# asserts one full golden render plus per-case properties. Every input is a
# frozen fixture: nothing here touches the network, so a run is deterministic
# and the published numbers moving does not break it.
#
# Renders are pinned to TZ=UTC and width 80. The footer stamp is shown in the
# reader timezone, so an unpinned golden would only match on the machine that
# generated it.
#
# Usage: tests/run.sh [--update-golden]
#
# --update-golden rewrites the golden from the current render. Use it when a
# layout change is intended, and read the diff before keeping it.

set -u

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
TOOL=$here/../apt-stats
FIX=$here/fixtures
GOLDEN=$here/golden/live-80col.txt
UPDATE=0

case "${1-}" in
'') ;;
--update-golden) UPDATE=1 ;;
*)
	printf 'usage: %s [--update-golden]\n' "$0" >&2
	exit 2
	;;
esac

[ -x "$TOOL" ] || {
	printf 'not executable: %s\n' "$TOOL" >&2
	exit 2
}

tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
ORIG_PATH=$PATH
pass=0
fail=0
first=1

ok() {
	pass=$((pass + 1))
	printf '  ok   %s\n' "$1"
}
no() {
	fail=$((fail + 1))
	printf '  FAIL %s\n' "$1"
	[ $# -lt 2 ] || printf '       %s\n' "$2"
}
assert_grep() {
	if grep -q -- "$2" "$3"; then ok "$1"; else no "$1" "no match for: $2"; fi
}
assert_ngrep() {
	if grep -q -- "$2" "$3"; then no "$1" "unexpected match: $2"; else ok "$1"; fi
}
assert_status() {
	if [ "$2" = "$3" ]; then ok "$1"; else no "$1" "expected exit $2, got $3"; fi
}

# Fixtures are named on the command line from inside their own directory, so
# the source path in the footer stays short and machine-independent.
run() {
	f=$1
	shift
	(cd "$FIX" && TZ=UTC "$SHELLBIN" "$TOOL" -f "$f" -w 80 --color never "$@") \
		>"$tmp/out.txt" 2>"$tmp/err.txt"
	echo $?
}
runc() { # same, in the C locale, where one glyph is one byte
	f=$1
	shift
	(cd "$FIX" && LC_ALL=C LANG=C TZ=UTC "$SHELLBIN" "$TOOL" -f "$f" --color never "$@") \
		>"$tmp/c.txt" 2>"$tmp/err.txt"
	echo $?
}

for SHELLBIN in dash bash sh ksh; do
	command -v "$SHELLBIN" >/dev/null 2>&1 || continue
	for AWKBIN in mawk gawk busybox_awk original-awk; do
		if [ "$AWKBIN" = busybox_awk ]; then
			command -v busybox >/dev/null 2>&1 || continue
			busybox awk 'BEGIN{}' </dev/null >/dev/null 2>&1 || continue
			mkdir -p "$tmp/awk"
			printf '#!/bin/sh\nexec busybox awk "$@"\n' >"$tmp/awk/awk"
			chmod +x "$tmp/awk/awk"
		else
			command -v "$AWKBIN" >/dev/null 2>&1 || continue
			mkdir -p "$tmp/awk"
			ln -sf "$(command -v "$AWKBIN")" "$tmp/awk/awk"
		fi
		PATH="$tmp/awk:$ORIG_PATH"
		export PATH
		printf '\n== %s + %s ==\n' "$SHELLBIN" "$AWKBIN"

		# ---- the full render -------------------------------------------
		assert_status "live: exit 0" 0 "$(run live.json)"
		if [ "$UPDATE" = 1 ] && [ "$first" = 1 ]; then
			mkdir -p "$here/golden"
			cp "$tmp/out.txt" "$GOLDEN"
			ok "live: golden written"
		elif [ ! -f "$GOLDEN" ]; then
			no "live: golden exists" "missing $GOLDEN (run with --update-golden)"
		elif diff -u "$GOLDEN" "$tmp/out.txt" >"$tmp/diff.txt"; then
			ok "live: matches golden"
		else
			no "live: matches golden" "$(head -20 "$tmp/diff.txt")"
		fi
		first=0
		cp "$tmp/out.txt" "$tmp/live.txt"

		# ---- the JSON parser -------------------------------------------
		# Whitespace carries no meaning: the compacted endpoint renders the
		# same, bar the source name in the footer.
		run compact.json >/dev/null
		sed 's/compact.json/live.json/' "$tmp/out.txt" >"$tmp/compact.txt"
		if diff -q "$tmp/live.txt" "$tmp/compact.txt" >/dev/null; then
			ok "compact JSON renders as pretty JSON"
		else
			no "compact JSON renders as pretty JSON" \
				"$(diff -u "$tmp/live.txt" "$tmp/compact.txt" | head -10)"
		fi

		st=$( (cd "$FIX" && TZ=UTC "$SHELLBIN" "$TOOL" -f - -w 80 --color never <live.json) \
			>"$tmp/out.txt" 2>"$tmp/err.txt"; echo $?)
		assert_status "stdin: exit 0" 0 "$st"
		assert_grep "stdin: renders the total" '^355$' "$tmp/out.txt"

		run escaped-strings.json >/dev/null
		assert_grep "escapes: quote inside a package name" 'pkg-with-"quote"' "$tmp/out.txt"
		assert_grep "escapes: prose unescaped" 'backslash \\ slash /' "$tmp/out.txt"

		# Counts are printed as the endpoint sent them: awk must not reformat
		# a seven-digit number through CONVFMT.
		run large-counts.json >/dev/null
		assert_grep "large counts: package verbatim" '^huge  *1234567$' "$tmp/out.txt"
		assert_grep "large counts: day verbatim" '^2026-08-19  *98765432$' "$tmp/out.txt"
		assert_grep "large counts: summed total verbatim" '^1234569$' "$tmp/out.txt"
		assert_ngrep "large counts: no scientific notation" 'e+0' "$tmp/out.txt"

		# ---- what the page shows, in the page order --------------------
		run live.json >/dev/null
		grep '^~ ' "$tmp/out.txt" >"$tmp/heads.txt"
		cat >"$tmp/want-heads.txt" <<'EOF'
~ TOTAL DOWNLOADS
~ DOWNLOADS BY PACKAGE · 24 packages
~ DOWNLOADS BY SUITE
~ DOWNLOADS BY DAY · 4 days
~ UPDATE CHECKS (INRELEASE FETCHES) · 4 days
EOF
		if diff -q "$tmp/want-heads.txt" "$tmp/heads.txt" >/dev/null; then
			ok "section order"
		else
			no "section order" "$(diff -u "$tmp/want-heads.txt" "$tmp/heads.txt" | head -12)"
		fi

		assert_grep "package row: croc 40" '^croc  *40$' "$tmp/out.txt"
		assert_grep "package row: keyring 10" '^pkghaus-archive-keyring  *10$' "$tmp/out.txt"
		assert_grep "suite row: trixie 141" '^trixie  *141$' "$tmp/out.txt"
		assert_grep "day row: 2026-08-17 167" '^2026-08-17  *167$' "$tmp/out.txt"
		assert_grep "total is the package sum" '^355$' "$tmp/out.txt"

		# ---- one width for every table --------------------------------
		runc live.json -w 80 >/dev/null
		distinct=$(awk '/^-----/ { print length($0) }' "$tmp/c.txt" | sort -u | wc -l)
		rulew=$(awk '/^-----/ { print length($0); exit }' "$tmp/c.txt")
		if [ "$distinct" = 1 ] && [ "$rulew" = 80 ]; then
			ok "one rule width for every table ($rulew)"
		else
			no "one rule width for every table" "distinct=$distinct first=$rulew"
		fi
		rowlens=$(awk '/^(croc|trixie|2026-08-17) / { print length($0) }' "$tmp/c.txt" |
			sort -u | tr '\n' ' ')
		if [ "$rowlens" = "80 " ]; then
			ok "package, suite and peak pivot rows all reach the width"
		else
			no "package, suite and peak pivot rows all reach the width" "lengths: $rowlens"
		fi

		# ---- the update-check pivot -----------------------------------
		assert_grep "pivot header" '^DAY  *TRIXIE  *TESTING  *UNSTABLE  *TOTAL$' "$tmp/out.txt"
		assert_grep "pivot: idle suites show an explicit 0" '^2026-08-19  *9  *0  *0  *9  ' "$tmp/out.txt"
		assert_grep "pivot: peak day totals 37" '^2026-08-17  *28  *2  *7  *37  ' "$tmp/out.txt"
		sed -n '/^~ UPDATE CHECKS/,$p' "$tmp/c.txt" >"$tmp/pivot.txt"
		peak=$(awk '/^2026-08-17 / { n = split($0, a, "  "); print length(a[n]) }' "$tmp/pivot.txt")
		other=$(awk '/^2026-08-19 / { n = split($0, a, "  "); print length(a[n]) }' "$tmp/pivot.txt")
		if [ "$peak" -gt "$other" ] && [ "$peak" -le 36 ]; then
			ok "bars scale against the peak day ($other < $peak)"
		else
			no "bars scale against the peak day" "peak=$peak other=$other"
		fi

		run zero-day.json >/dev/null
		assert_grep "zero day: all-zero row, no bar" '^2026-08-19  *0  *0  *0  *0 *$' "$tmp/out.txt"

		# A 1-of-302 share still gets a cell, the way the page keeps a 3%
		# sliver catchable.
		run sliver.json >/dev/null
		assert_grep "sliver: testing segment drawn" '▓' "$tmp/out.txt"
		assert_grep "sliver: unstable segment drawn" '█' "$tmp/out.txt"

		# The suite set is closed at three, as it is in the worker.
		run unknown-suite.json >/dev/null
		assert_ngrep "unknown suite dropped" 'bookworm' "$tmp/out.txt"
		assert_grep "unknown suite: the day survives" '^2026-08-19  *4  *0  *0  *4  ' "$tmp/out.txt"
		sed -n '/^~ UPDATE CHECKS/,$p' "$tmp/out.txt" >"$tmp/pivot.txt"
		assert_ngrep "day of only unknown suites dropped" '^2026-08-18' "$tmp/pivot.txt"

		# ---- degenerate and malformed input ---------------------------
		assert_status "empty sections: exit 0" 0 "$(run empty-sections.json)"
		assert_grep "empty sections: total 0" '^0$' "$tmp/out.txt"
		n=$(grep -c 'nothing recorded yet' "$tmp/out.txt")
		if [ "$n" = 4 ]; then ok "empty sections: all four say so"; else
			no "empty sections: all four say so" "$n found"
		fi

		assert_status "no since or prose: exit 0" 0 "$(run no-since-no-prose.json)"
		assert_grep "no since: tagline without a date" 'counted at the edge\.$' "$tmp/out.txt"

		assert_status "missing array: exit 2" 2 "$(run missing-array.json)"
		assert_grep "missing array: names the key" 'no downloads_by_day array' "$tmp/err.txt"
		assert_status "truncated JSON: exit 2" 2 "$(run truncated.json)"
		assert_grep "truncated JSON: diagnosed" 'apt-stats: ' "$tmp/err.txt"
		assert_status "HTML error body: exit 2" 2 "$(run html-error-body.json)"
		assert_grep "HTML error body: diagnosed" 'apt-stats: ' "$tmp/err.txt"

		# ---- the command line -----------------------------------------
		st=$("$SHELLBIN" "$TOOL" --nope >"$tmp/out.txt" 2>"$tmp/err.txt"; echo $?)
		assert_status "unknown option: exit 2" 2 "$st"
		st=$("$SHELLBIN" "$TOOL" -w abc -f "$FIX/live.json" >"$tmp/out.txt" 2>"$tmp/err.txt"; echo $?)
		assert_status "non-numeric width: exit 2" 2 "$st"
		st=$("$SHELLBIN" "$TOOL" --color pink -f "$FIX/live.json" >"$tmp/out.txt" 2>"$tmp/err.txt"; echo $?)
		assert_status "bad colour word: exit 2" 2 "$st"
		st=$("$SHELLBIN" "$TOOL" -f /nonexistent >"$tmp/out.txt" 2>"$tmp/err.txt"; echo $?)
		assert_status "unreadable file: exit 1" 1 "$st"
		st=$("$SHELLBIN" "$TOOL" --help >"$tmp/out.txt" 2>"$tmp/err.txt"; echo $?)
		assert_status "help: exit 0" 0 "$st"
		assert_grep "help: usage line" '^Usage: apt-stats' "$tmp/out.txt"

		# ---- width behaviour ------------------------------------------
		runc live.json -w 20 >/dev/null
		cp "$tmp/c.txt" "$tmp/narrow.txt"
		if [ "$(awk '{ if (length($0) > 46) n++ } END { print n + 0 }' "$tmp/narrow.txt")" = 0 ]; then
			ok "narrow: nothing exceeds the 46-column floor"
		else
			no "narrow: nothing exceeds the 46-column floor" \
				"$(awk 'length($0) > 46' "$tmp/narrow.txt" | head -3)"
		fi
		sed -n '/^~ UPDATE CHECKS/,$p' "$tmp/narrow.txt" | sed -n '/^DAY  /,$p' >"$tmp/np.txt"
		assert_ngrep "narrow: bar column dropped" '#' "$tmp/np.txt"
		assert_grep "narrow: footer wraps" '^counted at the edge ' "$tmp/narrow.txt"

		runc live.json -w 200 >/dev/null
		if [ "$(awk '{ if (length($0) > 90) n++ } END { print n + 0 }' "$tmp/c.txt")" = 0 ]; then
			ok "wide: bar column capped"
		else
			no "wide: bar column capped" "$(awk 'length($0) > 90' "$tmp/c.txt" | head -3)"
		fi

		# ---- colour is additive only ----------------------------------
		(cd "$FIX" && TZ=UTC "$SHELLBIN" "$TOOL" -f live.json -w 80 --color always) \
			>"$tmp/colour.txt" 2>"$tmp/err.txt"
		assert_grep "colour: escapes present" "$(printf '\033')" "$tmp/colour.txt"
		sed "s/$(printf '\033')\[[0-9;]*m//g" "$tmp/colour.txt" >"$tmp/stripped.txt"
		if diff -q "$tmp/live.txt" "$tmp/stripped.txt" >/dev/null; then
			ok "colour: alignment unchanged"
		else
			no "colour: alignment unchanged" \
				"$(diff -u "$tmp/live.txt" "$tmp/stripped.txt" | head -10)"
		fi

		(cd "$FIX" && NO_COLOR=1 TZ=UTC "$SHELLBIN" "$TOOL" -f live.json -w 80 --color auto) \
			>"$tmp/nc.txt" 2>"$tmp/err.txt"
		assert_ngrep "NO_COLOR: no escapes" "$(printf '\033')" "$tmp/nc.txt"
		(cd "$FIX" && TZ=UTC "$SHELLBIN" "$TOOL" -f live.json -w 80) >"$tmp/pipe.txt" 2>"$tmp/err.txt"
		assert_ngrep "piped stdout: no escapes" "$(printf '\033')" "$tmp/pipe.txt"

		# ---- non-UTF-8 locale -----------------------------------------
		assert_ngrep "C locale: no box drawing" '─' "$tmp/c.txt"
		assert_grep "C locale: ascii rule" '^-----' "$tmp/c.txt"
		assert_grep "C locale: ascii bars" '^2026-08-17 .*###' "$tmp/c.txt"

		# ---- the footer stamp -----------------------------------------
		assert_grep "TZ=UTC: footer in UTC" 'counted at the edge 2026-08-19 13:45:02 UTC' "$tmp/live.txt"
		if [ -f /usr/share/zoneinfo/Europe/Luxembourg ]; then
			(cd "$FIX" && TZ=Europe/Luxembourg "$SHELLBIN" "$TOOL" -f live.json -w 80 --color never) \
				>"$tmp/tz.txt" 2>"$tmp/err.txt"
			assert_grep "date(1) converts to the reader timezone" \
				'counted at the edge 2026-08-19 15:45:02 CEST' "$tmp/tz.txt"
		else
			ok "date(1) timezone conversion (skipped: no tzdata)"
		fi
		# Without a date(1) that can parse ISO-8601, awk formats the value it
		# parsed. That path is the only one on a non-GNU userland.
		mkdir -p "$tmp/stub"
		printf '#!/bin/sh\nexit 1\n' >"$tmp/stub/date"
		chmod +x "$tmp/stub/date"
		(cd "$FIX" && PATH="$tmp/stub:$PATH" "$SHELLBIN" "$TOOL" -f live.json -w 80 --color never) \
			>"$tmp/nodate.txt" 2>"$tmp/err.txt"
		assert_grep "no usable date(1): endpoint UTC stamp" \
			'counted at the edge 2026-08-19 13:45:02 UTC' "$tmp/nodate.txt"
	done
done

PATH=$ORIG_PATH
export PATH

# ---- linters -----------------------------------------------------------
# Only the shell half of the tool is visible to shellcheck: the awk program is
# a single-quoted string to it. gawk --lint reads that half, so both linters
# run, or most of the file goes unchecked.
printf '\n== linters ==\n'

if command -v shellcheck >/dev/null 2>&1; then
	for f in "$TOOL" "$here/run.sh"; do
		if shellcheck -s sh "$f" >"$tmp/sc.txt" 2>&1; then
			ok "shellcheck: $(basename "$f")"
		else
			no "shellcheck: $(basename "$f")" "$(head -12 "$tmp/sc.txt")"
		fi
	done
else
	ok "shellcheck (skipped: not installed)"
fi

if command -v gawk >/dev/null 2>&1; then
	mkdir -p "$tmp/lintawk"
	printf '#!/bin/sh\nexec gawk --lint "$@"\n' >"$tmp/lintawk/awk"
	chmod +x "$tmp/lintawk/awk"
	lintfail=0
	for f in "$FIX"/*.json; do
		(cd "$FIX" && PATH="$tmp/lintawk:$ORIG_PATH" "$TOOL" -f "$(basename "$f")" \
			-w 80 --color never) 2>&1 >/dev/null | grep '^gawk:' >>"$tmp/lint.txt" || true
	done
	if [ -s "$tmp/lint.txt" ]; then
		lintfail=1
	fi
	if [ "$lintfail" = 0 ]; then
		ok "gawk --lint: the awk program is clean on every fixture"
	else
		no "gawk --lint: the awk program is clean on every fixture" \
			"$(sort -u "$tmp/lint.txt" | head -8)"
	fi
else
	ok "gawk --lint (skipped: gawk not installed)"
fi

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
