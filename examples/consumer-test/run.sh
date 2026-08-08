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
# The packed artifact version is resolved dynamically from the SDK, so version
# bumps never break the consumer fixture.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SDK_DIR="$ROOT/sdk/typescript"
CONSUMER_DIR="$ROOT/examples/consumer-test"
PKG_JSON="$CONSUMER_DIR/package.json"

echo "=== 1. Building TypeScript SDK ==="
# Ensure SDK dependencies are present so the build is reproducible without a
# committed node_modules.
(cd "$SDK_DIR" && npm ci)
(cd "$SDK_DIR" && npm run build)

echo "=== 2. Packing SDK artifact ==="
TGZ="$(cd "$SDK_DIR" && npm pack --silent | tail -1)"
TGZ_ABS="$SDK_DIR/$TGZ"
echo "Packed artifact: $TGZ"

echo "=== 3. Installing packed artifact into consumer project ==="
# Point the consumer dependency at the freshly packed artifact (dynamic version).
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('$PKG_JSON', 'utf-8'));
  pkg.dependencies['@palmshed/sandbox'] = 'file:${TGZ_ABS}';
  fs.writeFileSync('$PKG_JSON', JSON.stringify(pkg, null, 2) + '\n');
"
(cd "$CONSUMER_DIR" && rm -rf node_modules package-lock.json && npm install)

echo "=== 4. Running consumer test ==="
(cd "$CONSUMER_DIR" && npm test)

echo "=== Consumer test passed ==="
