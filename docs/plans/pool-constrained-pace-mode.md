# Pool-constrained Pace Mode diagnostics

Authority: [swxtchio/gbrain#9](https://github.com/swxtchio/gbrain/issues/9). Preserve operator connection capacity, the existing embedding concurrency policies, fail-open pacing and queued-job precedence. This repair makes a binding pool observable; it does not tune throughput.

## Implementation plan

- Read actual engine capacity through optional, fail-open pool diagnostics; keep configured worker fallback separate from known capacity.
- Resolve single-pool paced embedding admission once, diagnose a binding pool with the resolved mode and requested/attainable ceilings, and propagate that same worker decision through both bulk loops and `EmbedResult.pacing`.
- Diagnose the separate paced backfill-handler admission while retaining its existing explicit paced worker count. Keep sync's multi-pool permit topology intact.
- Extend the owning resolver, embedding producer and backfill-handler regressions using synthetic provider transport. Demonstrate bounded failures with each diagnostic/telemetry behavior removed, restore it, and run the focused preservation tests.
- Reconcile the pacing guide and key-file pointers, merge the refreshed fork default without rebasing, verify the committed merge runner, and publish the focused evidence to the existing draft for firstmate review.
