# Baseline Cloud Workflow Contracts

- Identity: `baseline-cloud project init --slug <repo-slug>`; the committed file is `.baseline/project.json`. Credentials stay in `~/.baseline/cloud.json`.
- Executable timing: `baseline-cloud sdd phase run --phase <phase> --change <change> --project <project> -- <command>`; preserve the child exit code.
- Agent-native timing: run `baseline-cloud sdd phase start --phase <phase> --change <change> --project <project>` immediately before work and `baseline-cloud sdd phase complete --phase <phase> --change <change> --project <project>` immediately after it. Attempt completion on success, failure, or interruption when possible.
- Delivery: `baseline-cloud telemetry sync`; it is safe to repeat and leaves undelivered events queued.

Install this skill in the repository's `.claude/skills/baseline-cloud-workflow/` or `.opencode/skills/baseline-cloud-workflow/` directory. Kiro receives the same rules through its managed steering block. Keep existing user files and append only missing managed content.
