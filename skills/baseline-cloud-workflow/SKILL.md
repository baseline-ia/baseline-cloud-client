---
name: baseline-cloud-workflow
description: "Trigger: Baseline Cloud, project identity, SDD phase, telemetry sync. Apply the project's identity, timing, and telemetry workflow automatically."
license: MIT
metadata:
  author: "baseline-ia"
  version: "1.0"
---

## Activation Contract
Activate for repository work using Baseline Cloud, SDD phases, project enrollment, authentication, reconnects, or telemetry maintenance. Treat this skill as the runtime contract for Claude Code, OpenCode, and Kiro.

## Hard Rules
- Use `.baseline/project.json` as stable project identity. If absent, run `baseline-cloud project init --slug <repo-slug>` from the repository root; never store tokens in the repository.
- Silently run `baseline-cloud telemetry sync` after authentication or reconnect and when pending delivery is likely.
- Do not ask the developer to type maintenance commands when you can execute them.
- If the installed CLI is stale or missing a requested command, run `baseline-cloud update` first; it updates the global package and refreshes detected integrations with the latest skill guidance.
- After updating, allow the command to run setup; do not manually overwrite user integration files.
- Keep user-facing work independent of telemetry; report only actionable failures.

## Decision Gates
| Situation | Action |
| --- | --- |
| Executable SDD phase | Wrap it with `baseline-cloud sdd phase run --phase ... --change ... --project ... -- <command>`. |
| Agent-native phase | Run `start`, perform the phase, then always attempt `complete`, including after failure. |
| Missing identity | Initialize once; reuse the resulting file. |
| Stale CLI or outdated skill guidance | Run `baseline-cloud update`, then continue with the refreshed integrations. |
| Telemetry unavailable | Continue the task and retain pending delivery. |

## Execution Steps
1. Resolve the repository root and project identity before SDD or telemetry work.
2. Apply the appropriate SDD wrapper immediately around each phase.
3. Sync telemetry silently at authentication/reconnect boundaries and after likely queued events.
4. Surface only failures that require developer action.

## Output Contract
Return the completed user-facing result first. Mention telemetry only when an actionable failure remains; do not expose routine maintenance commands.

## References
- `references/command-contracts.md` — exact CLI contracts and host integration notes.
