# Selective Facts cycle plan

Authority: the assignment for swxtchio/gbrain#2, absorbing #8, on 2026-10-17. Scope is source-local Facts discovery and the cycle off switch.

- Select live pages in the resolved source using current Facts markers in compiled truth or timeline, or existing fence-owned index rows. Return identifiers before fetching bodies; retain the page fields consumed by reconciliation, quarantine, canonical-cache freshness and revision checks.
- Preserve the unfenced-row adoption, phantom redirection and deleted-page expiry passes. Repair-produced pages join the same run, including explicit empty-list runs. Keep incremental drains and failed-sync protection.
- Add the supported `cycle.extract_facts.enabled` setting with absent configuration enabled. Gate cycle dispatch before phase work, report a disabled reason and enable hint, and permit only an extract_facts-specific one-shot bypass without changing configuration.
- Exercise real runExtractFacts and runCycle boundaries with persisted synthetic pages, source collisions, fence removal, malformed/misplaced and markers-only fences, rewrites and repair-produced work. Instrument reads by delegating to the real engine. Demonstrate bounded failures with each changed selection/gate behavior removed, then restore green; run affected preservation tests on isolated fixtures and the PostgreSQL owner lane.
- Update operator guidance, manually merge any refreshed swxtch ancestry, and publish the clean branch to its existing draft for firstmate's final review and suite gate.
