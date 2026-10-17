# Autopilot self-disable repair (swxtchio/gbrain#4)

## Plan

- Baseline: `314d32e5e05f62ad174aca9a921ba987e3b623f6` on `origin/swxtch`, inspected on 2026-10-17. `generateSelfDisableGuard` already requests supervisor removal; `showStatus` already reads the disabled reason. Reproduce the missing marker read and threshold strike deletion through generated bash before editing production.
- Add producer-driven unit regressions in `test/autopilot-self-disable-and-status.test.ts` for terminal marker behavior and consecutive-miss history. Exercise isolated filesystem state and supervisor success/failure shims, including a custom brain and suffixed job.
- Repair `generateSelfDisableGuard` by honoring the recorded disable before repo probing and preserving the disabling strike record. Retain reset after an unmarked successful directory probe and the current supervisor restart/removal contracts.
- Exercise full-wrapper dispatch boundaries in `test/autopilot-install-wrapper.test.ts` and the Linux install/status/reinstall lifecycle in its existing subprocess suite. Measure baseline and single-behavior-removal failures for every new or rewritten regression, then focused green.
- Merge refreshed `origin/swxtch`, preserve the committed merge-gate runner, run required focused/mechanical checks, and push only `fm/gbrain-4` to its single draft PR. Firstmate owns review and the final suite gate.

## Evidence

Pending generated-shell reproduction and changed-behavior proofs. Supervisor shims establish emitted requests; they do not establish native service-manager state.
