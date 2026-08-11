#!/bin/sh
# Reject nonblank commit-message prose lines after the subject that
# exceed the configured width. Git trailers (e.g. "Ticket: EX-12345",
# "Change-Id: ...") are fixed-format and always allowed regardless of
# length. A line with no whitespace (an unbreakable single token, such
# as a bare URL) that exceeds the width is reported as a warning, not a
# failure, since it cannot be reflowed without breaking the token.
# Usage: validate-wrap.sh [width]
# width defaults to 72 and should come from the repo's conventions file
# when it specifies a different fixed-format width.
width=${1:-72}
case "$width" in
    ''|*[!0-9]*)
        echo "validate-wrap: width must be a positive integer, got '$width'" >&2
        exit 2
        ;;
esac
if [ "$width" -le 0 ]; then
    echo "validate-wrap: width must be a positive integer, got '$width'" >&2
    exit 2
fi

awk -v width="$width" '
  NR > 1 && length($0) > width {
    if ($0 ~ /^[A-Za-z][A-Za-z0-9-]*: /) {
      next # git trailer, fixed-format: always allowed
    }
    if ($0 !~ / /) {
      printf "warning: line %d is %d characters (limit %d), unbreakable token: %s\n", NR, length($0), width, $0 > "/dev/stderr"
      next
    }
    printf "line %d is %d characters (limit %d): %s\n", NR, length($0), width, $0 > "/dev/stderr"
    invalid = 1
  }
  END { exit invalid }
'
