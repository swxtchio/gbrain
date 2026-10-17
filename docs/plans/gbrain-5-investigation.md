# Autopilot queue admission investigation

Authority: swxtchio/gbrain#5 and the assigned task brief. This plan owns the investigation scope and disposition, not a new queue design.

- Verify the existing single-flight fix is an ancestor of the task baseline and inspect dispatch, transactional queue admission, lease recovery, and historical duplicate cleanup.
- Execute the owning focused tests with isolated PGLite and PostgreSQL fixtures. Preserve full output and distinguish executed assertions from skipped cases.
- If a cycle-admission or recovery defect is reproduced, repair its owning boundary and add a focused regression with a bounded failing absence proof.
- If the assigned properties already hold, report the pinned baseline, source pointers, and executed evidence to firstmate for disposition before implementation.
- Preserve fork integration ancestry by merging an advanced default branch; leave the claim PR draft for firstmate.
