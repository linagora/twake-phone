#!/bin/bash
# Test integration: mounts the Twake Phone widget in the Drive clone under references/.
# The same two lines go into any Twake app (or, ideally, once into cozy-bar). Idempotent.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRIVE="$ROOT/references/twake-drive"
ENTRY="$DRIVE/src/targets/browser/index.jsx"

( cd "$ROOT" && yarn workspace @twake/phone-widget build >/dev/null )
cp "$ROOT/packages/phone-widget/dist/index.js" "$DRIVE/src/lib/twakePhoneWidget.js"

if ! grep -q twakePhoneWidget "$ENTRY"; then
  python3 - "$ENTRY" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace("import setupApp from './setupAppContext'", "import setupApp from './setupAppContext'\nimport { mountPhoneWidget } from '@/lib/twakePhoneWidget'", 1)
s = s.replace("  createRoot(root).render(", "  mountPhoneWidget({ client })\n\n  createRoot(root).render(", 1)
open(p, 'w').write(s)
PY
fi
grep -n "PhoneWidget" "$ENTRY"
