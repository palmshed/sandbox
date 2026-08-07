#!/bin/bash
set -euo pipefail

# Reproducible consumer test:
#   1. Build the TypeScript SDK (production build)
#   2. Pack the SDK into a .tgz artifact
#   3. Install the .tgz into an isolated consumer project
#   4. Run the consumer test suite against the packed artifact (NOT the workspace source)
#
# Usage: ./run.sh
#
# This simulates an external consumer installing @palmshed/sandbox from npm.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SDK_DIR="$ROOT/sdk/typescript"
CONSUMER_DIR="$ROOT/examples/consumer-test"

echo "=== 1. Building TypeScript SDK ==="
(cd "$SDK_DIR" && npm run build)

echo "=== 2. Packing SDK artifact ==="
(cd "$SDK_DIR" && npm pack)

echo "=== 3. Installing packed artifact into consumer project ==="
(cd "$CONSUMER_DIR" && rm -rf node_modules package-lock.json && npm install)

echo "=== 4. Running consumer test ==="
(cd "$CONSUMER_DIR" && npm test)

echo "=== Consumer test passed ==="
