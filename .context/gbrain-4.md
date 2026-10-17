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

### Changed-behavior proofs (2026-10-17)

Regression baseline pin: `68b4a17ff52c689fdf3dd11ba9e7f52dbcdd9997`. Repaired producer and complete test pin: `22594705182afc18dc6a2b3d032941a059f48f29`, reachable through draft `swxtchio/gbrain#43`. Each mutation below was applied alone to that repair pin, executed, and restored before the next mutation. The committed patch files capture the exact removed behavior. Every listed command exited 1 from a terminating test failure; no run required its external tool timeout. Outputs and numeric exit-status files are retained beside this ledger.

All commands use this prefix from the repository root: `HOME="$PWD/.context/test-host" TMPDIR="$PWD/.context" bun --no-env-file test`. To reproduce a row, apply its patch to the repair pin and append the file/filter shown below to that prefix.

| Mutation patch | Test file and filter | Failed behavior | Output/status stem |
| --- | --- | --- | --- |
| `gbrain-4-remove-marker.patch` | `test/autopilot-self-disable-and-status.test.ts -t 'recorded disable'` | Recorded disable triggers another missing-repo action | `gbrain-4-red-marker-unit` |
| `gbrain-4-remove-marker.patch` | `test/autopilot-install-wrapper.test.ts -t 'self-disabled wrapper dispatch boundary'` | All four marked dispatch cases and the recovery precondition fail; restored repo reaches baked/fallback CLI | `gbrain-4-red-marker-wrapper` |
| `gbrain-4-remove-marker.patch` | `test/e2e/autopilot-linux-lifecycle.serial.test.ts -t 'systemd self-disable'` | Later installed-wrapper invocation repeats the disabling action | `gbrain-4-red-marker-linux` |
| `gbrain-4-delete-threshold-strikes.patch` | `test/autopilot-self-disable-and-status.test.ts -t 'consecutive misses retain'` | Threshold strike record is deleted | `gbrain-4-red-strikes-unit` |
| `gbrain-4-delete-threshold-strikes.patch` | `test/autopilot-install-wrapper.test.ts -t 'deliberate reinstall'` | Full-wrapper threshold history is deleted | `gbrain-4-red-strikes-wrapper` |
| `gbrain-4-delete-threshold-strikes.patch` | `test/e2e/autopilot-linux-lifecycle.serial.test.ts -t 'systemd self-disable'` | Installed-wrapper threshold history is deleted | `gbrain-4-red-strikes-linux` |
| `gbrain-4-remove-probe-reset.patch` | `test/autopilot-self-disable-and-status.test.ts -t 'successful probe resets'` | Unmarked successful probe leaves old strikes | `gbrain-4-red-reset-unit` |
| `gbrain-4-require-git-directory.patch` | `test/autopilot-self-disable-and-status.test.ts -t 'healthy checkout directories'` | Healthy directory with a `.git` file is rejected | `gbrain-4-red-directory-unit` |
| `gbrain-4-remove-reinstall-clear.patch` | `test/autopilot-install-wrapper.test.ts -t 'deliberate reinstall'` | Production installer leaves the disable marker | `gbrain-4-red-reinstall-wrapper` |
| `gbrain-4-remove-reinstall-clear.patch` | `test/e2e/autopilot-linux-lifecycle.serial.test.ts -t 'systemd self-disable'` | Production Linux reinstall leaves the disable marker | `gbrain-4-red-reinstall-linux` |

### Restored green and preservation (2026-10-17)

After all mutations, `git diff --exit-code HEAD -- src/commands/autopilot.ts` confirmed the producer exactly matched `22594705182afc18dc6a2b3d032941a059f48f29`. Commands below use the same isolated HOME/TMPDIR prefix and Bun 1.4.2:

| Command after `bun --no-env-file` | Result | Output/status stem |
| --- | --- | --- |
| `test test/autopilot-self-disable-and-status.test.ts test/autopilot-install-wrapper.test.ts` | Exit 0; 35 passed | `gbrain-4-final-unit-wrapper` |
| `test test/e2e/autopilot-linux-lifecycle.serial.test.ts` | Exit 0; 8 passed | `gbrain-4-final-linux` |
| `test test/autopilot-launchd-lifecycle.serial.test.ts` | Exit 0; 11 passed; 5 native macOS cases skipped on Linux | `gbrain-4-final-launchd` |
| `test test/autopilot-self-upgrade.test.ts test/autopilot-reconnect-classifier.test.ts` | Exit 0; 29 passed | `gbrain-4-restart-preservation` |
| `run check:function-size` | Exit 0 | `gbrain-4-function-size` |
| `run check:test-isolation` | Exit 0 | `gbrain-4-test-isolation` |

The unit fixture executes the real emitted guard with both successful and failing systemd/launchd recorder responses, a minted suffixed job, apostrophes in the captured paths, and an untouched second home's marker/counter. Its healthy-directory and successful-probe cases execute bash rather than asserting source layout. Full-wrapper fixtures control both CLI dispatch paths; the recovery case calls the production installer with a consent-only engine fixture and executes its output. The Linux lifecycle uses real CLI install/status/reinstall subprocesses and isolated PGLite, with supervisor and daemon-dispatch recorders. Its explicit `init --git` gives the synthetic content tree its own repository when scratch is inside a worktree. Native launchd/systemd service state was not exercised, and the daemon itself was never launched.

### Existing baseline checks and handoff boundaries

- `bun --no-env-file run typecheck` fails identically on repair pin `22594705182afc18dc6a2b3d032941a059f48f29` and a clean detached baseline `777b45fd528c13a64707657b77c9e7478ea49eb4` with the same frozen-lockfile dependencies: undeclared `postgres` import and its two consequent implicit-any errors in `deploy/supabase/role-settings.ts`. Full outputs/statuses: `gbrain-4-typecheck{,-baseline}.{log,status}`. Already tracked in `swxtchio/gbrain#35`; this comparison was added to that issue.
- `fm-ensure-agents-md.sh .` was run and refused the project's existing distinct real `AGENTS.md` and `CLAUDE.md`; it wrote nothing. The project protocol intentionally reads both files. No project-memory edit was needed for this repair.
- No `bin/fm-lint.sh` exists in this repository. The autopilot module-size ceiling is raised by the guard's net growth in the reviewer-visible TSV row. `check:module-size` exits 1 identically on the baseline and repair trees for the existing jobs, serve-http, cycle, link-extraction, and code-chunker ceilings; it reports no autopilot violation. Outputs/statuses: `gbrain-4-module-size{,-baseline}.{log,status}`. These baseline findings remain tracked in `swxtchio/gbrain#35`.
- Firstmate retains ownership of the final suite gate, including the committed `scripts/run-merge-gate.sh` runner and the full-suite backlog in `swxtchio/gbrain#38`. This crew did not run another review or final suite gate.
