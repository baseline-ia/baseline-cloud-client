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
