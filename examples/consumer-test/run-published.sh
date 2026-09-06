#!/bin/bash
set -euo pipefail

# Published-package consumer test:
#   1. Download the published @palmshed/sandbox tarball from the npm registry
#   2. Install it into a clean temporary consumer project (never the checkout)
#   3. Run the shared consumer suite (src/verify.ts) against the installed
#      package, exactly like an external consumer would
#
# Usage: ./run-published.sh [--package SPEC] [--evidence PATH] [--keep]
#
#   --package SPEC   npm spec to download, default @palmshed/sandbox@latest
#                    (what an external consumer installs). Accepts a version
#                    or dist-tag spec, for example @palmshed/sandbox@beta.
#   --evidence PATH  where to write the machine-readable evidence JSON,
#                    default is evidence.json inside the temp project.
#   --keep           leave the temp consumer project in place for inspection.
#
# Sibling run.sh covers the packed-artifact provenance (workspace build).
# Both scripts exercise the same scenarios in src/verify.ts; only the
# provenance changes. Requires network access (npm registry).

SPEC="@palmshed/sandbox@latest"
EVIDENCE=""
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --package) SPEC="$2"; shift 2 ;;
    --evidence) EVIDENCE="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help)
      echo "Usage: $0 [--package SPEC] [--evidence PATH] [--keep]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--package SPEC] [--evidence PATH] [--keep]" >&2
      exit 2
      ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUITE_DIR="$ROOT/examples/consumer-test"

# Resolve a relative evidence path against the invocation directory now: the
# suite runs inside the temp consumer project, so a relative path would land
# there instead of where the caller expects it.
case "$EVIDENCE" in
  ""|/*|[A-Za-z]:*) ;;
  *) EVIDENCE="$PWD/$EVIDENCE" ;;
esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/palmshed-published-consumer.XXXXXX")"
cleanup() {
  if [ "$KEEP" -eq 0 ]; then
    rm -rf "$WORK"
  else
    echo "Kept temp consumer project: $WORK"
  fi
}
trap cleanup EXIT

if [ -z "$EVIDENCE" ]; then
  EVIDENCE="$WORK/evidence.json"
fi

echo "=== 1. Downloading published package $SPEC ==="
TGZ="$(cd "$WORK" && npm pack "$SPEC" 2>/dev/null | tail -1)"
echo "Downloaded artifact: $TGZ"

echo "=== 2. Installing published artifact into a clean consumer project ==="
(
  cd "$WORK" && npm init -y > /dev/null
  # Match the fixture module kind so the shared suite compiles identically.
  node -e "const fs = require('fs'); const p = 'package.json'; const pkg = JSON.parse(fs.readFileSync(p, 'utf-8')); pkg.type = 'module'; fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');"
  npm install "./$TGZ" --no-audit --no-fund
  npm install --no-save typescript@^5.3.3 @types/node@^20.11.0 --no-audit --no-fund
)

echo "=== 3. Running the shared consumer suite ==="
mkdir -p "$WORK/consumer/src"
cp "$SUITE_DIR/src/verify.ts" "$WORK/consumer/src/verify.ts"
cp "$SUITE_DIR/tsconfig.json" "$WORK/consumer/tsconfig.json"
(
  cd "$WORK/consumer"
  CONSUMER_PROVENANCE=npm CONSUMER_PACKAGE_SPEC="$SPEC" CONSUMER_EVIDENCE="$EVIDENCE" npx tsc
  CONSUMER_PROVENANCE=npm CONSUMER_PACKAGE_SPEC="$SPEC" CONSUMER_EVIDENCE="$EVIDENCE" node dist/verify.js
)

echo "=== Published consumer suite passed; evidence: $EVIDENCE ==="
