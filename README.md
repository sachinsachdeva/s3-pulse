# S3 Pulse

[![CI](https://github.com/sachinsachdeva/s3-pulse/actions/workflows/ci.yml/badge.svg)](https://github.com/sachinsachdeva/s3-pulse/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Rust 1.94.1+](https://img.shields.io/badge/rust-1.94.1%2B-b7410e.svg?logo=rust&logoColor=white)](rust-toolchain.toml)
[![VS Code 1.90+](https://img.shields.io/badge/VS%20Code-1.90%2B-0078d4.svg?logo=visualstudiocode&logoColor=white)](extension/package.json)

**Live S3 feed monitoring for VS Code and the terminal.**

S3 Pulse watches an Amazon S3 bucket prefix, keeps a bounded arrival history,
visualizes cadence, highlights unusual gaps, and downloads individual objects.
It is built to answer **“Is my data feed arriving when it should?”**, rather
than act as another general-purpose S3 browser.

## What it provides

- Independent concurrent watchers for precise `s3://bucket/prefix/` targets
- Date-templated targets such as `s3://bucket/trades/{yyyy}{MM}{dd}/` for
  partitioned feeds
- Configurable polling with a conservative 30-second default
- Rolling mean, median, p95, largest-gap, and current-gap statistics
- Billable S3 request counts per feed, with an optional cost estimate
- Status-bar health roll-up and de-duplicated alerts for late, empty, or failing
  feeds
- Auto-learned or explicitly configured expected cadence and feed health
- A live VS Code graph and searchable object grid backed by the same history
- A standalone Rust CLI and a persistent JSON-RPC backend for the extension
- Streamed, cancellable object downloads with progress
- Normal AWS profile, SSO, role, environment, and instance credential discovery
- Read-only S3 behavior and bounded per-watcher memory

## CLI

Build the Rust workspace with Rust 1.94.1 or newer (the current AWS SDK MSRV):

```bash
cargo build --release -p s3pulse-cli
```

The binary is `target/release/s3pulse`:

```bash
# Watch continuously; Ctrl-C stops the watcher.
s3pulse watch s3://my-bucket/trades/ --interval 30s

# Inspect current arrival statistics or recent history.
s3pulse stats s3://my-bucket/trades/
s3pulse history s3://my-bucket/trades/ --last 24h
s3pulse list s3://my-bucket/trades/ --json

# Use a named profile and download one object.
s3pulse --profile prod download \
  s3://my-bucket/trades/file.parquet ./file.parquet

# Start the backend used by VS Code.
s3pulse serve --stdio
```

Global `--profile`, `--region`, and `--json` flags work with the query commands.
No AWS credentials are passed to or stored by the VS Code extension.

## VS Code extension

The extension is in [`extension/`](extension/README.md). During development:

```bash
npm --prefix extension ci
npm --prefix extension run check
npm --prefix extension test
npm --prefix extension run compile
```

Launch the extension development host, open the **S3 Pulse** activity-bar view,
add a feed, and open its dashboard. The pre-launch task stages a freshly built
backend into `extension/bin/<platform>-<architecture>/`, which is where the
extension looks when `s3Pulse.backendPath` is unset, so pressing **F5** always
runs current code with nothing to configure.

## Using the bundled CLI

Each VSIX bundles the complete `s3pulse` binary, not a cut-down server, so the
installed extension already carries the CLI. **S3 Pulse: Copy Backend (CLI)
Path** puts its location on the clipboard, or find it directly:

```bash
ls -d ~/.vscode/extensions/*.s3-pulse-*/bin/*/s3pulse
```

The path contains the extension version, so it moves on every update — a symlink
into it will break silently. For regular terminal use, build the CLI separately
with `cargo build --release -p s3pulse-cli` and put that on your `PATH`.

## Release packaging

VS Code resolves platform-specific extensions at install time, so a release is
one VSIX per platform, each bundling a single native backend. End users do not
need Rust.

[`.github/workflows/release.yml`](.github/workflows/release.yml) builds all six
on a tag push. Each target is built on a runner of its own architecture rather
than with a cross toolchain, because the backend depends on `aws-lc-sys` — a C
library that is awkward to cross-compile — and because a native build is the
only one that can be smoke-tested on the runner that produced it.

To produce one locally, stage exactly one backend and package for that target:

```bash
cargo build --release -p s3pulse-cli
npm --prefix extension run stage-backend -- --release
npm --prefix extension run package -- --target darwin-arm64
```

`stage-backend` takes `--target` and `--from` so CI can place a binary built
elsewhere. Staging more than one backend would ship every platform's binary in
every VSIX, so the packaging step runs against a clean `bin/` directory.

## AWS access

S3 Pulse uses the AWS SDK's standard credential and region provider chains.
For normal operation it needs only:

- `s3:ListBucket`, preferably constrained to the monitored prefix
- `s3:GetObject` for objects users may download

It does not upload, delete, or configure bucket notifications. Start from the
scoped [`IAM policy example`](docs/iam-policy.example.json) and replace its
placeholders for your environment.

## Running locally without AWS

[`scripts/local-s3.sh`](scripts/local-s3.sh) runs a throwaway MinIO server in
Docker and keeps objects arriving on a cadence, so the CLI and the extension can
be exercised end to end without an AWS account. Docker is the only host
requirement — the MinIO image bundles the `mc` client the script uses. The
credentials it prints are local and disposable.

```bash
./scripts/local-s3.sh up          # start MinIO and seed s3://feed/trades/
./scripts/local-s3.sh feed -s 5   # one object every 5s until Ctrl-C
./scripts/local-s3.sh down        # remove the container and its data
```

`up` accepts `-n` for the number of seeded objects and `-s` for the seconds
between them. Because S3 stamps `LastModified` at upload time, the cadence has
to be created by spacing uploads rather than by backdating objects.

`run` invokes the built CLI with the endpoint and keys already applied, which is
the reliable way to drive it:

```bash
./scripts/local-s3.sh run stats s3://feed/trades/
./scripts/local-s3.sh run watch s3://feed/trades/ --interval 5s
```

It uses `target/release/s3pulse`, falling back to the debug build; override with
`S3PULSE_BIN`. To call the binary directly instead, export the same values first
— and note this applies only to the shell you run it in:

```bash
eval "$(./scripts/local-s3.sh env)"
./target/release/s3pulse stats s3://feed/trades/
```

Without those variables the SDK finds no endpoint or credentials, falls through
to EC2 instance metadata, and reports `dispatch failure` after a timeout.

For the extension there is nothing to configure. Start the server, then press
**F5** and choose *Run S3 Pulse Extension*. The launch configuration in
[`.vscode/launch.json`](.vscode/launch.json) already carries this server's
endpoint and keys, and its pre-launch task builds the backend and stages it at
`extension/bin/<platform>-<arch>/s3pulse`, which is where the extension looks
when `s3Pulse.backendPath` is unset. In the development host, open the **S3
Pulse** view, add the feed `s3://feed/trades/`, and open its dashboard.

The credentials in the launch configuration must match the running server; a
mismatch surfaces as `InvalidAccessKeyId`.

To reach this server from a normally installed extension instead, give it a
named profile — the backend inherits VS Code's environment rather than your
shell's, so exported variables will not reach it. Append the printed blocks to
`~/.aws/config` and `~/.aws/credentials`, then set the feed's profile to
`s3pulse-local`:

```bash
./scripts/local-s3.sh profile
```

The endpoint is `http://127.0.0.1:9000` rather than `http://localhost:9000` on
purpose. The AWS SDK exposes no environment variable to force path-style
addressing, but it selects path style automatically for an IP-literal endpoint.
A hostname produces virtual-host requests to `feed.localhost:9000` instead,
which most S3-compatible servers reject. Any such server works here as long as
the endpoint is given as an IP address.

## How it fits together

```text
VS Code extension (TypeScript)
        │  JSON-RPC 2.0 / stdio
        ▼
s3pulse CLI/server (Rust)
        ▼
s3pulse-core (Rust) ──► Amazon S3 (LIST and GET only)
```

Business behavior stays in Rust; TypeScript supervises the process, persists
watcher definitions, and renders the UI. See the detailed
[`architecture`](docs/architecture.md) and [`JSON-RPC protocol`](docs/json-rpc.md).

## Development

The default test suite uses fake object stores and protocol fixtures, not live
AWS resources:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full checks and repository
boundaries.

## V1 scope and next steps

V1 uses polling so adoption requires no S3 infrastructure changes. Event-driven
S3-to-SQS ingestion, adaptive polling, durable SQLite history, and export are
natural follow-ups, but are not required for the core monitoring workflow.

Licensed under the [MIT License](LICENSE).
