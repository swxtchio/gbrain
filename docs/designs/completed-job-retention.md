# Completed-job retention plan

Authority: this plan selects the automatic policy within swxtchio/gbrain#3's suggested retention range and the captain's completed-history-only assignment.

- Baseline: `dcaf5c1cf5d33d0dde89bd65899e14036799e778`; verified `origin/swxtch` is the same commit and the fork default is `swxtch`. Integrate any later fork changes by merge, preserving upstream-merge ancestry; leave fork/upstream convergence to `scripts/gbrain-safe-update`.
- Baseline defect at `dcaf5c1cf5d33d0dde89bd65899e14036799e778`: `makeAutopilotGlobalMaintenanceHandler` runs `MAINTENANCE_PHASES` through `runCycle`, whose purge dispatch reaches `runPhasePurge`; that phase did not invoke `MinionQueue.prune`. The only production queue-prune caller was `runJobsPrune`.
- Automatic policy: `minions.completed_retention_days`, absent default 14 days, positive whole days with a representable cutoff. Purge only `completed` rows older than that cutoff, based on `finished_at` (legacy missing completion timestamps fall back to `updated_at`). Keep manual prune's default statuses and preview; share its atomic synthesis-completion archive.
- Preserve execution: keep nonterminal/retryable jobs; retain expired terminal parents/private-queue owners with outstanding nonterminal dependents. Completed children may be reclaimed because `completeJob` publishes their results to the surviving parent's inbox before completion commits; verify real aggregator readback.
- Reporting: add actual job deletion count and effective retention to the purge phase; report zero on a clean no-op, skip all history mutation on dry-run, and surface cleanup errors through the existing failed-phase contract.
- Verification: producer-driven jobs (`add` → `claim` → `completeJob`), only timestamp backdating for aging, production `runCycle` purge on real PGLite and PostgreSQL. Assert default/override, repeated/new expiry, recent completion despite old creation, live/retryable survivors, parent outcomes and synthesis eligibility, dry-run snapshots, and cleanup failure. Keep existing queue preview and synthesis-preservation tests.
- Discrimination: establish bounded baseline red for automatic cleanup, and independent mutations for any new age/dependency protection; restore repair and repeat focused green. Preserve commands, immutable pins, full logs and actual exit codes under `.context/`.
- Handoff: one draft PR on `fm/gbrain-3`, focused tests and mandatory identity/lint gates, clean committed head pushed and verified. Firstmate owns review, release numbering and the final suite of record.

## Adjudicated round-1 repair

Authority: the captain's 2026-10-17 fix order for PR #34, reviewed pin `d1fcf12d0512b8c616b8bf68c0e3db507ade2d39`.

- Contain the retention call inside `runPhasePurge`: retain an explicit failed cleanup result while unrelated sweeps continue and their counters remain reported. Reproduce malformed-policy and SQL-delete failures against producer-driven tombstones and checkpoints.
- Lock prune candidates in deterministic id order with `SELECT ... FOR UPDATE` inside an engine transaction, then delete only locked ids with the full eligibility predicate rechecked in the subsequent statement. Use real PostgreSQL `queue.add` transactions and observed lock blocking to prove newly accepted parent/private-owner dependents prevent deletion.
- Pin manual `runJobsPrune` age/fallback and live-dependent preview/deletion semantics in the existing queue prune boundary; update the operator guide. Align ordinary completion aging with the timestamps emitted by `completeJob`, retaining a separately explicit recent diagnostic touch where completion-age coverage needs it.
- Demonstrate bounded round-1 red and restored green for every new or rewritten regression, including independent removal of the lock and eligibility recheck. Preserve logs and statuses under `.context/retention-round1`, then update the same draft PR and report its new head.

## Adjudicated round-2 repair

Authority: the captain's 2026-10-17 fix order for PR #34, reviewed pin `98efdf8d9ab7f544982560693ecb59a260221c30`; residual work is owned by issue #36.

- Lock every row referencing a locked prune candidate through either owner foreign key, including terminal rows that `retryJob` may return to waiting. Run the final DELETE eligibility check only after candidate and dependent lock waits have resolved, in the same transaction.
- Reproduce the real `retryJob` publication under a held transaction through `runCycle` on PostgreSQL for both parent and private-queue owner fixtures, each linked through both foreign-key fields. Obtain positive database evidence that purge is blocked before releasing the retry to commit.
- Remove only the new dependent serialization to prove bounded regression failure, restore it and rerun the focused cycle, native race and manual-prune boundaries green. Keep the accepted failure-isolation and queue.add repairs; update the same draft and preserve proof under `.context/retention-round2`.
