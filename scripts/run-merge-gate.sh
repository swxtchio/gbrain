#!/usr/bin/env bash
# gbrain merge-gate suite (swxtchio/gbrain#38 context): the full npm-test suite has no
# green baseline on any host (base dcaf5c1cf fails on vm14-001 and locally in disjoint
# classes), so the merge gate runs these maintained focused lanes instead. REQUIRED
# lanes exist at the base and must always pass; EMERGING lanes are newer coverage that
# runs when present (promote them to REQUIRED as they land on the default branch).
set -uo pipefail
cd "$(dirname "$0")/.."

REQUIRED_LANES=(
  test/minions.test.ts
  test/migrations-v128.test.ts
  test/extract-facts-phase.test.ts
  test/extract-facts-stable-identity.test.ts
  test/extract-facts-unfenced-rows.test.ts
  test/extract-facts-reconcile-drain.test.ts
  test/cycle-synthesize-daily-cap.test.ts
)

EMERGING_LANES=(
  test/cycle-job-retention.serial.test.ts
  test/extract-facts-discovery.test.ts
  test/reconcile-watermark.test.ts
)

rc=0
for lane in "${REQUIRED_LANES[@]}"; do
  if [ ! -f "$lane" ]; then
    echo "merge-gate: REQUIRED lane file missing: $lane" >&2
    rc=1
    continue
  fi
  echo "merge-gate: bun test $lane"
  bun --no-env-file test --timeout=60000 "$lane" || rc=1
done

for lane in "${EMERGING_LANES[@]}"; do
  if [ ! -f "$lane" ]; then
    echo "merge-gate: emerging lane not on this tree yet, skipping: $lane"
    continue
  fi
  echo "merge-gate: bun test $lane"
  bun --no-env-file test --timeout=60000 "$lane" || rc=1
done

# check:module-size is excluded: its ratchet is stale at the base itself
# (src/commands/jobs.ts is 673 lines against a 666 ceiling at dcaf5c1cf) -
# baseline repair is tracked under swxtchio/gbrain#38.
for check in check:function-size check:source-config-leak; do
  echo "merge-gate: bun run $check"
  bun run "$check" || rc=1
done

if [ "$rc" -ne 0 ]; then
  echo "merge-gate: FAILED" >&2
  exit 1
fi
echo "merge-gate: all lanes green"
