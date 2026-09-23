#!/usr/bin/env bash
set -euo pipefail
test "$#" -eq 1
diff -u "$(dirname "$0")/expected.txt" "$1"
