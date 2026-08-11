# Architecture

S3 Pulse is intentionally split at a stable JSON-RPC boundary:

```text
VS Code extension (TypeScript)
  VS Code APIs, process lifecycle, persistence, webview rendering
                │
                │ JSON-RPC 2.0 over stdio
                ▼
s3pulse CLI/server (Rust)
  request routing, watcher supervision, terminal presentation
                │
                ▼
s3pulse-core (Rust)
  S3 access, polling, bounded history, statistics, downloads
```

The extension never imports AWS SDKs and does not handle object bytes. The Rust
binary can be used without VS Code and remains the single implementation of
feed behavior.

## Polling lifecycle

Each watcher owns an independent cancellable Tokio task. A poll uses paginated
`ListObjectsV2` for exactly one bucket/prefix, reconciles object fingerprints
against bounded local history, and publishes incremental events. Pagination
visits every page but retains only the newest configured N objects in memory.
One watcher, download, or slow network request must not block another.

The first successful poll seeds the dashboard from existing objects. Later
polls emit `objects.added` for new keys and replacements whose identity changed.
The default interval is 30 seconds. No bucket resources or notification
settings are changed.

## Data and retention

Object history is held in memory for V1 and capped per watcher. Statistics and
the graph derive from the same retained object set as the grid. Watcher
definitions are persisted by VS Code, but credentials are not.

## Authentication and permissions

AWS configuration uses the SDK's normal provider chain and optional named
profiles/regions. S3 Pulse only requires `s3:ListBucket` on the monitored prefix
and `s3:GetObject` for downloads. It does not upload, delete, or mutate S3
infrastructure.

## Distribution

The extension host launches a platform-specific `s3pulse` executable bundled
inside its VSIX. A development setting may point at an explicit local binary.
Browser-only VS Code is out of scope because it cannot run the native backend.
