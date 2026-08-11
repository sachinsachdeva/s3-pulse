# S3 Pulse for VS Code

S3 Pulse answers **“Is my S3 data feed arriving when it should?”** It monitors saved S3 prefixes, visualizes arrival cadence, reports backend-computed feed health, and downloads individual objects without handling AWS credentials in TypeScript.

## Requirements

- Desktop VS Code or a desktop/remote extension host. Web-only VS Code cannot run the native backend.
- AWS credentials available through the normal AWS SDK credential chain (environment, profile, SSO, role, or instance/container credentials).
- Read access for the watched location: normally `s3:ListBucket` and `s3:GetObject`.

S3 Pulse does not create, upload, delete, or modify S3 resources.

## Use

1. Open the S3 Pulse activity-bar view.
2. Choose **Add Feed**, then enter an `s3://bucket/prefix/` URI and polling settings.
3. Start the feed and open its dashboard.
4. Select a row to download it or copy its S3 URI/key.

Feed definitions are persisted in VS Code global state. AWS credentials are never stored there.

## Backend discovery

The extension launches one persistent `s3pulse serve --stdio` process in the extension host. It checks:

1. `s3Pulse.backendPath`, if configured; then
2. `bin/<platform>-<architecture>/s3pulse[.exe]` inside the installed extension.

The configured path supports `${extensionPath}`, `${workspaceFolder}`, and `${env:NAME}` substitutions. Backend stdout is reserved for newline-delimited JSON-RPC; stderr appears in **Output → S3 Pulse**.

## Build and test

```bash
cd extension
npm ci
npm run check
npm test
npm run compile
```

Unit tests cover the streaming JSON-line decoder and tolerant data normalization. `esbuild` produces `dist/extension.js` with no runtime npm dependencies.

## Package platform VSIX files

Build the Rust backend in release mode, copy it to the matching path listed in [`bin/README.md`](bin/README.md), and preserve executable permissions. Then run:

```bash
npm run package -- --target darwin-arm64
```

Use the corresponding VS Code target (`darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`, or `win32-arm64`) for each artifact. Do not put binaries for unrelated platforms into a platform VSIX.

For backend development, set `s3Pulse.backendPath` to a local release/debug executable instead of copying it into `bin/`.
