#!/usr/bin/env bash
# git clean filter: strip the ex-plugin managed block (and any trailing blank
# lines it leaves) from worktrunk config.toml so only personal settings are
# committed. The live working-tree file keeps the block — it's injected by the
# ex plugin's contrib/worktrunk/install.sh and read by `wt`. Reads stdin, writes
# stdout. Registered via .gitattributes + `git config filter.ex-strip.clean`.
set -euo pipefail
awk '
  /^# >>> ex-plugin worktrunk \(managed\) >>>$/ {inblock=1; next}
  /^# <<< ex-plugin worktrunk \(managed\) <<<$/ {inblock=0; next}
  !inblock {print}
' | sed -e :a -e '/^\n*$/{$d;N;ba}'
