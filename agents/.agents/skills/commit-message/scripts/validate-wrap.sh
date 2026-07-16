#!/bin/sh
# Reject nonblank commit-message lines after the subject that exceed 72 bytes.
awk '
  NR > 1 && length($0) > 72 {
    printf "line %d is %d characters: %s\n", NR, length($0), $0 > "/dev/stderr"
    invalid = 1
  }
  END { exit invalid }
'
