# Existing-source remote repair

Authority: [swxtchio/gbrain#10](https://github.com/swxtchio/gbrain/issues/10), Proposed fix, and the assigned CLI repair invariants.

- Add `sources set-remote <id> <url>` to source-management dispatch and help. Validate through `parseRemoteUrl`, show the previous value before writing, and patch only `remote_url` through the shared atomic `updateSourceConfig` writer. Refuse missing operands, invalid URLs, missing sources, and unsuccessful updates.
- Exercise the real CLI against persisted sources: assignment and rotation, preserved data/config/checkout, historical config normalization, concurrent keys, failure and output ordering, and the existing automatic-pull decision. Keep clone ownership and pull confinement unchanged.
- Update the source command reference and operator guide, regenerate affected artifacts, and retain focused green/red/restored-green evidence. Run the crew lint and identity gates, publish only this task branch to its draft PR, and leave integration and the final suite to firstmate.
