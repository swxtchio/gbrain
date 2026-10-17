# Autopilot self-disable repair (swxtchio/gbrain#4)

## Plan

- Baseline: `314d32e5e05f62ad174aca9a921ba987e3b623f6` on `origin/swxtch`, inspected on 2026-10-17. `generateSelfDisableGuard` already requests supervisor removal; `showStatus` already reads the disabled reason. Reproduce the missing marker read and threshold strike deletion through generated bash before editing production.
- Add producer-driven unit regressions in `test/autopilot-self-disable-and-status.test.ts` for terminal marker behavior and consecutive-miss history. Exercise isolated filesystem state and supervisor success/failure shims, including a custom brain and suffixed job.
- Repair `generateSelfDisableGuard` by honoring the recorded disable before repo probing and preserving the disabling strike record. Retain reset after an unmarked successful directory probe and the current supervisor restart/removal contracts.
- Exercise full-wrapper dispatch boundaries in `test/autopilot-install-wrapper.test.ts` and the Linux install/status/reinstall lifecycle in its existing subprocess suite. Measure baseline and single-behavior-removal failures for every new or rewritten regression, then focused green.
- Merge refreshed `origin/swxtch`, preserve the committed merge-gate runner, run required focused/mechanical checks, and push only `fm/gbrain-4` to its single draft PR. Firstmate owns review and the final suite gate.

## Evidence

Supervisor shims establish emitted requests; they do not establish native service-manager state. All scratch and test homes for these runs are under this worktree's `.context/`; dependencies were installed with `bun --no-env-file install --frozen-lockfile --ignore-scripts --cache-dir "$PWD/.context/bun-cache"` under an isolated HOME.

### Baseline reproduction (2026-10-17)

Production tree: `777b45fd528c13a64707657b77c9e7478ea49eb4` (plan-only successor of `314d32e5e05f62ad174aca9a921ba987e3b623f6`). Tests in the following regression commit exercise `generateSelfDisableGuard` and `writeWrapperScript` through bash. Commands run from the repository root:

```sh
HOME="$PWD/.context/test-host" TMPDIR="$PWD/.context" bun --no-env-file test test/autopilot-self-disable-and-status.test.ts
HOME="$PWD/.context/test-host" TMPDIR="$PWD/.context" bun --no-env-file test test/autopilot-install-wrapper.test.ts
```

- Unit: exit 1, 23 passed / 2 failed. A recorded disable caused another `repo path gone, disabling` action; the disabling miss deleted `autopilot-disable-strikes` (ENOENT on the state assertion). Full output: `gbrain-4-red-baseline-unit.log`; exit status: `gbrain-4-red-baseline-unit.status`.
- Full wrapper: exit 1, 5 passed / 4 failed. Marked missing repos repeated the disabling action; marked restored repos dispatched both the baked and PATH-fallback CLI shims. Full output: `gbrain-4-red-baseline-wrapper.log`; exit status: `gbrain-4-red-baseline-wrapper.status`.
- Initial attempts before dependency installation failed at module import and are not behavioral red evidence; their logs remain local as `gbrain-4-baseline-*.log`.

The initial plan was automatically published to `swxtch` by the durability hook. The captain authorized leaving it there and repaired this branch's upstream to self-track `fm/gbrain-4`; later explicit pushes target only that branch. Draft creation resumes once the branch has its own diff.
