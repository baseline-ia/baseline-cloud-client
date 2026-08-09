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

## Telemetry

Telemetry is sent only when cloud credentials are available. Opt out for a process or CI job with:

```bash
BASELINE_TELEMETRY=0 baseline-cloud cloud status
```

Host applications can also disable telemetry with their own `--no-telemetry` option when supported. Disabling telemetry clears queued events and prevents new events from being sent.

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
