# apt-stats

Prints the archive statistics from a terminal. It reads
[`/stats.json`](https://apt.pkg.haus/stats.json) and renders the same sections,
in the same order, with the same numbers as
[apt.pkg.haus/stats](https://apt.pkg.haus/stats): total downloads, downloads by
package, by suite, by day, and the update-check pivot with its stacked bar.

Offered as a convenience. The Worker in `src/` is what this repository is for.

## Install

Copy the script anywhere on `PATH` and make it executable:

```sh
install -m 755 contrib/apt-stats/apt-stats ~/bin/apt-stats
```

It needs a POSIX shell, `awk` (mawk, gawk and BusyBox awk all work) and either
`curl` or `wget`. No jq.

## Use

```sh
apt-stats                          # read https://apt.pkg.haus/stats.json
apt-stats -f stats.json            # read a file, or "-" for stdin
apt-stats -w 100                   # render for a given width
apt-stats --color never            # or set NO_COLOR
```

Colour is used when stdout is a terminal and `NO_COLOR` is unset. It picks
24-bit, 256-colour or 8-colour output from `COLORTERM` and `tput colors`, and
the suite bars carry a shade ramp as well as a colour ramp, so they still read
without either. A locale that is not UTF-8 falls back to ASCII glyphs.

Exit status is 0 on success, 1 on a fetch or input failure, 2 on a usage error
or malformed JSON.

## Tests

```sh
contrib/apt-stats/tests/run.sh
```

Every input is a frozen fixture, so a run is deterministic and offline: the
published numbers moving does not break it. The suite repeats itself under each
shell and awk on the machine, which is how the awk program stays portable
across mawk and gawk.

The suite ends with both linters: `shellcheck -s sh` over the two shell files,
and `gawk --lint` over the awk program on every fixture. Only about 250 of the
tool's 660 lines are shell, so shellcheck alone leaves the majority of the file
unchecked. Both are skipped with a passing note when not installed.

Renders are pinned to `TZ=UTC` and 80 columns because the footer stamp is shown
in the reader timezone and the layout is width-dependent. When a layout change
is intended, `tests/run.sh --update-golden` rewrites
`tests/golden/live-80col.txt`; read the diff before keeping it.

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
