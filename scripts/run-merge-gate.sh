#!/usr/bin/env bash
# gbrain merge-gate suite (swxtchio/gbrain#38 context): the full npm-test suite has no
# green baseline on any host (base dcaf5c1cf fails on vm14-001 and locally in disjoint
# classes), so the merge gate runs these maintained focused lanes instead. Every lane is
# green at base and is the coverage the retention (#34) and extract-facts (#39) merges
# were proved against. Extend a lane when the changed area gains a maintained boundary.
set -uo pipefail
cd "$(dirname "$0")/.."

LANES=(
  test/minions.test.ts
  test/cycle-job-retention.serial.test.ts
  test/migrations-v128.test.ts
  test/extract-facts-phase.test.ts
  test/extract-facts-discovery.test.ts
  test/extract-facts-stable-identity.test.ts
  test/extract-facts-unfenced-rows.test.ts
  test/extract-facts-reconcile-drain.test.ts
  test/cycle-synthesize-daily-cap.test.ts
  test/reconcile-watermark.test.ts
)

rc=0
for lane in "${LANES[@]}"; do
  if [ ! -f "$lane" ]; then
    echo "merge-gate: lane file missing: $lane" >&2
    rc=1
    continue
  fi
  echo "merge-gate: bun test $lane"
  bun --no-env-file test --timeout=60000 "$lane" || rc=1
done

for check in check:function-size check:module-size check:source-config-leak; do
  echo "merge-gate: bun run $check"
  bun run "$check" || rc=1
done

if [ "$rc" -ne 0 ]; then
  echo "merge-gate: FAILED" >&2
  exit 1
fi
echo "merge-gate: all lanes green"
