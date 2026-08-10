# @baseline-ia/baseline-cloud-client

Optional client and CLI for connecting a Baseline CLI to a self-hosted baseline-cloud server. It provides token authentication, telemetry, OpenSpec lifecycle tracking, post-commit hooks, and integrations for supported AI tools.

## Requirements

- Node.js 18 or newer
- A self-hosted baseline-cloud server for cloud features

## Install

Install the CLI globally:

```bash
npm install --global @baseline-ia/baseline-cloud-client
```

Or install it in a project:

```bash
npm install @baseline-ia/baseline-cloud-client
```

The package exports a programmatic plugin API and the `baseline-cloud` executable.

### Install from the repository

Until the package is published to npm, install the CLI from a local checkout:

```bash
git clone https://github.com/baseline-ia/baseline-cloud-client.git
cd baseline-cloud-client
npm install
npm install --global .
```

Verify the installation with:

```bash
baseline-cloud --help
```

## CLI Usage

Authenticate interactively:

```bash
baseline-cloud cloud login
```

The interactive command asks whether to use username/password or an existing API token. The token option prompts for the server URL and token, then stores the credentials with owner-only file permissions.

Use an existing bearer token instead of username and password:

```bash
baseline-cloud cloud login --server https://cloud.example.com --token <raw-token>
```

For CI, provide `BASELINE_CLOUD_URL`, `BASELINE_CLOUD_USERNAME`, and `BASELINE_CLOUD_PASSWORD`, then run:

```bash
baseline-cloud cloud login --no-input
```

The token is stored in `~/.baseline/cloud.json` with owner-only permissions. To inspect the connection or remove the local and server-side token:

```bash
baseline-cloud cloud status
baseline-cloud cloud logout
```

## Setup Integrations

Detect supported tools and install their telemetry integrations:

```bash
baseline-cloud setup
```

Setup currently supports Claude Code, OpenCode, Kiro IDE, Kiro CLI, and CommandCode. It can install hooks, steering instructions, or the OpenCode plugin where the tool is detected.

### Update the CLI

When an installed CLI is stale or does not include a requested command, update the global npm package and refresh detected integrations in one step:

```bash
baseline-cloud update
```

The command runs `npm install --global @baseline-ia/baseline-cloud-client@latest`, then invokes setup from the freshly installed package. Setup is idempotent and does not replace existing user skill files or integration content. A failed install or setup returns a non-zero status. Credentials in `~/.baseline/cloud.json` and the project identity in `.baseline/project.json` remain unchanged.

### Conversational AI skill

`baseline-cloud setup` installs the reusable `baseline-cloud-workflow` skill into the detected project's `.claude/skills` and `.opencode/skills` locations without replacing existing files. Kiro receives the same guidance in its managed steering block, which is appended only when missing. The skill teaches supported agents to resolve `.baseline/project.json`, wrap SDD timing, and sync queued telemetry without interrupting user work. Re-running setup is safe and idempotent.

### Corporate skills

Corporate skills are assigned to an enrolled project by baseline-cloud and can be synchronized locally:

```bash
baseline-cloud skills sync
baseline-cloud skills status
baseline-cloud skills verify
baseline-cloud skills verify --project /path/to/project
```

`skills sync` requires cloud credentials and the stable project identity from `.baseline/project.json` (or the project option). It calls the corporate-skills APIs, verifies each SHA-256 hash before writing, and stores canonical files at `~/.baseline/skills/<slug>/<version>/SKILL.md` with a generated `manifest.json`. The lock is `~/.baseline/skills/lock.json`; its `skills` object is keyed by slug and records the skill id, version, hash, installation time, fail-closed policy, and logical canonical path.

Canonical files and copies under `.claude/skills/<slug>/` and `.opencode/skills/<slug>/` are read-only (`0444`). Corporate copies take precedence over editable local copies at those managed paths. `setup` warns when they already exist, and a later `skills sync` may replace them atomically only as part of a verified update; manual edits are not a supported override.

`skills verify` checks the local content and manifest against the lock and is suitable for CI. Skills with `fail_closed: true` also require online verification; use `BASELINE_CLOUD_URL` and `BASELINE_CLOUD_TOKEN` in CI or a saved cloud login. The server must provide `GET /api/v1/skills?project=<slug>`, `GET /api/v1/skills/<slug>/verify?project=<slug>`, and project enrollment responses with `assigned_skills` for automatic post-enrollment sync.

## Telemetry

Telemetry is sent only when cloud credentials are available. Opt out for a process or CI job with:

```bash
BASELINE_TELEMETRY=0 baseline-cloud cloud status
```

Host applications can also disable telemetry with their own `--no-telemetry` option when supported. Disabling telemetry clears queued events and prevents new events from being sent.

### Project identity

Project-scoped telemetry uses one stable slug resolver. The precedence is:

1. An explicit simple name passed with `--project`, such as `--project baseline-cloud-client`.
2. The nearest `.baseline/project.json` found from the requested directory (or cwd) upward.
3. The repository name from the directory's Git `remote.origin.url` when it is a GitHub or Bitbucket HTTPS, SSH, or SCP URL.
4. The current directory basename when no valid supported Git origin exists.

The result is lowercased, unsupported characters become `-`, and the slug is limited to 128 characters. For example, `https://github.com/baseline-ia/baseline-cloud-client.git` becomes `baseline-cloud-client`; `--project client-a` always remains the explicit `client-a` identity.

To configure a stable identity for a repository, commit this normal JSON file at `.baseline/project.json`:

```json
{
  "slug": "baseline-cloud-client"
}
```

Initialize it from the repository root, or target another directory with `--path`:

```bash
baseline-cloud project init --slug baseline-cloud-client
baseline-cloud project init --slug client-a --path /path/to/project
```

The command refuses to overwrite an existing file unless `--force` is provided. Commit `.baseline/project.json` with the project so every checkout uses the same identity. Never put credentials or tokens in this file; tokens remain in `~/.baseline/cloud.json`.

## SDD Phase Timing

Record actual elapsed time for each SDD phase with the explicit commands below:

```bash
baseline-cloud sdd phase start --phase design --change add-feature [--project /path/to/project]
baseline-cloud sdd phase complete --phase design --change add-feature [--project /path/to/project]
baseline-cloud sdd phase run --phase design --change add-feature [--project /path/to/project] -- npm run build
baseline-cloud telemetry sync
```

Supported phases are `explore`, `propose`, `spec`, `design`, `tasks`, `apply`, `verify`, and `archive`. Start state is stored in `~/.baseline/sdd-phase-state.json` with owner-only permissions. Completion emits the measured `durationSeconds` and removes the matching state only after the event receives a confirmed 2xx response.

`phase run` starts timing, runs the command with inherited stdio, records `completed` or `failed`, and returns the child exit code. A signal or non-zero child exit still records a failed completion. If the wrapper process itself is interrupted, the active phase is retained and no completion is invented.

Start and completion events are written to the durable state file before network delivery. Logout removes only credentials; it does not remove timing state. Missing credentials, disabled telemetry, network errors, and 401/403/5xx responses leave pending events in place. After logging in, run `baseline-cloud telemetry sync`; only confirmed 2xx deliveries are removed, so repeating the command is safe. The wrapper does not launch another `baseline-cloud` process, so uninstalling the global CLI while it is already running does not prevent its in-memory completion path or later recovery.

An SDD orchestrator using separate commands must invoke `start` immediately before each phase begins and `complete` immediately after it ends. The CLI does not infer phase boundaries from `sdd init`, filesystem changes, or skill events.

## OpenCode Plugin

Run `baseline-cloud setup` with OpenCode installed to copy and register the bundled plugin automatically. The plugin tracks skill invocations and session token usage through the `baseline-cloud` CLI.

For a host that loads plugins programmatically, import the package and register it with the host plugin context:

```js
const { default: register } = await import('@baseline-ia/baseline-cloud-client')
await register(pluginContext)
```

The package also exposes named helpers such as `login`, `logout`, `track`, and `flush`.

## License

MIT
