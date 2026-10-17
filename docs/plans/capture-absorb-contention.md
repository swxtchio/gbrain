# Capture and absorb contention

Refs swxtchio/gbrain#26. Scope: let a revision-checked client update finish under demonstrated absorb contention while preserving genuine competing edits, canonical facts, and durable replay.

## Investigation and verification

- Pin the pickup baseline and trace capture admission through the actual absorb producer and publication target.
- Execute a bounded isolated schedule in the owning persistence/facts-backstop test boundary, observing receipts, canonical read-back, and file-backed state when exercised.
- If the baseline already meets the requested behavior, retain executed evidence and request a firstmate decision instead of manufacturing a fix.
- Otherwise repair the demonstrated race, prove each changed-behavior assertion red without the repair, and run the focused preservation owners.
- Keep fork merge ancestry current and hand the existing draft to firstmate for review and the final merge gate.
