# Selective Facts cycle plan

Authority: the assignment for swxtchio/gbrain#2, absorbing #8, on 2026-10-17. Scope is source-local Facts discovery and the cycle off switch.

- Select live pages in the resolved source using current Facts markers in compiled truth or timeline, or existing fence-owned index rows. Return identifiers before fetching bodies; retain the page fields consumed by reconciliation, quarantine, canonical-cache freshness and revision checks.
- Preserve the unfenced-row adoption, phantom redirection and deleted-page expiry passes. Repair-produced pages join the same run, including explicit empty-list runs. Keep incremental drains and failed-sync protection.
- Add the supported `cycle.extract_facts.enabled` setting with absent configuration enabled. Gate cycle dispatch before phase work, report a disabled reason and enable hint, and permit only an extract_facts-specific one-shot bypass without changing configuration.
- Exercise real runExtractFacts and runCycle boundaries with persisted synthetic pages, source collisions, fence removal, malformed/misplaced and markers-only fences, rewrites and repair-produced work. Instrument reads by delegating to the real engine. Demonstrate bounded failures with each changed selection/gate behavior removed, then restore green; run affected preservation tests on isolated fixtures and the PostgreSQL owner lane.
- Update operator guidance, manually merge any refreshed swxtch ancestry, and publish the clean branch to its existing draft for firstmate's final review and suite gate.

## Review round 1 repair plan

Authority: firstmate's adjudicated fix order on 2026-10-17, against review pin `b8f47096b6184b98f66e8b53fe299578c27b6889`.

- Restore canonical withdrawal and purge semantics on the narrow page read, using the shared canonical overlay with source/subject-scoped ledger state. Both planning and the transactional reread continue to use that same helper.
- Exercise a production `recordFactWithdrawal` that leaves the physical fence intact, checking canonical read parity, preserved expiry/identity and convergence across repeated full walks on both engines. Remove the restored overlay to demonstrate a bounded red regression, then restore green.
- Extract the default-on, config-read-failure-tolerant `cycleExtractFactsEnabled` helper and cover that failure fallback through cycle dispatch. Clarify that the serve-resident sweep has its own reconciliation path outside the cycle switch.
- Run focused Facts preservation suites, keep the existing draft and manual-merge integration policy, and return the new reviewed pin to firstmate. Unchanged-page optimization remains follow-up scope.
