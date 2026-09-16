# S3 Pulse download failure — investigation findings

Date: 2026-09-13
Status: Reproduced with automated probes. Fixed in 0.2.6; see
`download-failure-fix-plan.md` for the validation and what changed.

## 1. Reported symptom

On a second machine with the plugin installed:

1. The **copy-link** option builds the `s3://bucket/key` URI correctly.
2. **Download fails** for the same object.
3. The **exact error is not visible** on failure.

## 2. Why copy-link working proves almost nothing

Copy-link is pure local string formatting with zero S3 or backend involvement:

- `extension/src/adapters.ts:78` — `objectUri(target, key)` returns
  `` `s3://${bucket}/${key}` ``.
- `extension/src/dashboard.ts:431` — the `copyUri` handler only writes that
  string to the clipboard.

Download, in contrast, travels from the webview through JSON-RPC to the Rust
backend, which resolves the session, checks a prefix guard, and issues a real
`GetObject`:

- `extension/src/dashboard.ts:491` — `object.download`
  `{ watcherId, downloadId, key, destination, overwrite: true }`
- `crates/s3pulse-cli/src/rpc/runtime.rs:425` — `object_download`:
  session lookup → prefix guard → `for_object(key)` → store download.
- `crates/s3pulse-core/src/store.rs:117` — `GetObject` via the AWS SDK.

So a working copy-link only proves the bucket/key string parses. Every cause
below is consistent with that observation.

## 3. Root causes (ranked)

### #1 Templated-target prefix guard — REPRODUCED

A feed whose target contains date placeholders (e.g.
`s3://bucket/feed/{yyyy}/{MM}/`) lists objects under **resolved** prefixes
(`feed/2026/09/…`), but the download guard compares the key against the
**raw, unresolved** template stored on the session:

- `crates/s3pulse-core/src/watcher.rs:64` — `resolve_targets()` expands
  `{yyyy}/{MM}/…` for listing.
- `crates/s3pulse-cli/src/rpc/runtime.rs:153` — the session stores the raw
  `definition.target` (braces included).
- `crates/s3pulse-cli/src/rpc/runtime.rs:431` —
  `if !key.starts_with(&session.target.prefix)` rejects every real key with
  `"key is outside the watcher's prefix"` (Invalid params, `-32602`).

Probe evidence (real `s3pulse serve --stdio` binary, no AWS account):

```text
PASS R0 templated watch.start accepted
FAIL R1 resolved key downloads on templated feed
     actual={"code":-32602,"message":"Invalid params",
             "data":{"detail":"key is outside the watcher's prefix"}}
PASS R1b raw-template key gets past the prefix guard
     (key `feed/{yyyy}/{MM}/object.parquet` fails later at S3 instead,
      proving the guard compared against the unresolved template)
```

If the failing feed's target contains `{…}` placeholders, this is almost
certainly the bug on the other machine. Non-templated feeds are unaffected.

### #2 Credentials / region / SSO on the other machine

The store is created per watcher from the watcher's `profile`/`region` or the
backend defaults (`runtime.rs:161`). A feed can look healthy (list works, or
data is stale) while `GetObject` fails because the second machine has
different `~/.aws` files, an expired SSO token, different `AWS_*` environment
in VS Code, or a wrong/missing region. "Feed looks ok" only narrows the fault
to the Get path; it does not clear credentials.

### #3 IAM: List vs Get (+ KMS / Requester Pays)

Listing (`store.rs:199`) succeeding does not imply `s3:GetObject` on the exact
key, nor KMS decrypt rights nor Requester Pays acceptance. Same outward
symptom: feed fine, download fails.

### #4 Destination filesystem

`GetObject` runs before the temp file is created (`store.rs:106`); the temp
file is `.<name>.s3pulse-<uuid>.part` next to the destination. Read-only
directories, full disks, or synced-folder paths fail at install time. The
extension always sends `overwrite: true`, so AlreadyExists is unreachable
through the dashboard.

### #5 Silent cancellation / dead backend

`Request cancelled` (`protocol.rs:105`) and the generic
`Backend exited unexpectedly` (`extension/src/rpcClient.ts:68`) both surface
without the underlying S3 detail.

## 4. Why the exact error is invisible — REPRODUCED (two bugs)

### Bug A: failure notification is dropped by the TS parser

On download failure the backend emits a `download.progress` notification with
`done: true` plus an `error` object — but **no** `bytesTransferred`:

- `crates/s3pulse-cli/src/rpc/runtime.rs:481` — error notification shape.

The frontend requires `bytesTransferred` and returns `undefined` otherwise:

- `extension/src/adapters.ts:313` — `normalizeDownloadProgress`.
- `extension/src/dashboard.ts:560` — the `undefined` result is ignored.

Wire capture from the probe (note the absent `bytesTransferred`):

```json
{"done":true,"downloadId":"bc170d15-…","error":{"kind":"network","message":"GetObject failed: …","retryable":true},"key":"feed/object.parquet","watcherId":"plain"}
```

Probe verdict: `FAIL R2e` (backend shape) + `FAIL A1` (TS parser returns
`undefined` for that exact shape).

### Bug B: error kind is stripped from the user-facing message

The backend sends a machine-readable kind
(`protocol.rs:114`, `ErrorObject::store` → `data: {kind, message, retryable}`),
but the frontend only appends `data.detail`:

- `extension/src/rpcClient.ts:37` — `remoteErrorMessage` ignores
  `kind`/`retryable`.

Probe verdict: `FAIL B1` — `RpcRemoteError` built with
`data: {kind: 'AccessDenied', …}` produces a message without `AccessDenied`,
so AccessDenied vs expired credentials vs network failure all look identical.

Contributing factor: the download catch (`dashboard.ts:446`) shows a
dismissible toast plus a panel error but never `output.appendLine`s the full
error; stderr only appears as `[backend]` lines (`rpcClient.ts:74`). On the
other machine the toast is easily missed entirely.

## 5. Automated reproduction

Both probes exercise the **real** code with **no live AWS account** and **no
repo modifications** (working tree verified clean). They live outside the repo
for re-running:

- `/tmp/s3pulse-repro/ts/repro-entry.ts` → bundled with the project's esbuild
  (`--alias:vscode=…stub`, since `rpcClient.ts` imports `vscode`):
  `node /tmp/s3pulse-repro/ts/repro.js`
- `/tmp/s3pulse-repro/rust-protocol/repro-protocol.mjs` — drives
  `target/debug/s3pulse serve --stdio` with `AWS_EC2_METADATA_DISABLED=true`
  and a nonexistent profile/bucket, so every failure is local or hermetic:
  `node /tmp/s3pulse-repro/rust-protocol/repro-protocol.mjs`

Results: 2 TS checks fail (A1, B1), 2 protocol checks fail (R1, R2e); all
controls pass (normal progress parses, copy-link formats, legacy `{detail}`
shape works, watchers register, error responses carry `kind` on the wire).

## 6. Diagnostics to run on the other machine

1. Open **Output → S3 Pulse**, reproduce the download, and copy the toast
   text, the panel error, and any `[backend]` / `[rpc]` lines.
2. Note the watcher's exact target (template braces?), profile, region, the
   object key, and the chosen destination. Retry into `/tmp` or the home
   directory to rule out filesystem causes.
3. In a terminal with the same environment as VS Code:
   `aws sts get-caller-identity` and
   `aws s3api head-object --bucket <b> --key <k>`; compare with the
   extension's staged backend `list` / `download --json` (path via the
   "copy backend path" command).
4. Check `~/.aws/config` + `credentials`, SSO login state, `AWS_*` in the
   VS Code environment, that `bin/<platform>/s3pulse` is executable, the
   extension/backend versions, and IAM `GetObject` (+ KMS) on the exact key.

## 7. Proposed fixes (not yet implemented)

1. **Prefix guard**: resolve the watcher's template (or skip the literal
   prefix check when the target is a template) before comparing in
   `object_download`.
2. **Progress parser**: accept error-bearing `download.progress`
   notifications in `normalizeDownloadProgress` (don't require
   `bytesTransferred` when `error`/`done` is present) and route them to the
   panel and Output channel.
3. **Error message**: include `kind` (and `retryable`) in
   `remoteErrorMessage`, and `output.appendLine` the full error + code + data
   in the download catch.

Each fix should ship with a committed regression test in the repo's existing
harnesses (`cargo test` fake-store/protocol tests, `node --test` extension
tests) mirroring the probes above.

## 8. Still needed from the user

- Exact toast + Output text from the failing machine.
- Whether the failing feed's target uses date-template braces.
- Profile / region / SSO setup on that machine.
- IAM Get (+ KMS) rights on the exact key; `/tmp` retry result.
- CLI `head-object` vs extension parity.
