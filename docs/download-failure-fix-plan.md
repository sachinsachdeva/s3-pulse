# S3 Pulse download failure — validation and fix plan

Date: 2026-09-13
Status: findings validated against `07ffd38`; implemented as planned and
released in 0.2.6. Companion to `download-failure-findings.md`.

## 1. Validation of the findings

Every code reference in the findings was re-read and both probes were re-run
today against the current `target/debug/s3pulse` (no source file is newer than
the binary). Results are unchanged: `R1` and `R2e` fail in the protocol probe,
`A1` and `B1` fail in the TypeScript probe, all controls pass.

| Finding | Verdict | Notes |
| --- | --- | --- |
| §2 copy-link is local string formatting | Confirmed | `objectUri` in `adapters.ts`; the `copyUri` case in `dashboard.ts` only writes to the clipboard. |
| #1 templated-target prefix guard | Confirmed, reproduced | `object_download` compares the key with `session.target.prefix`, which still holds the raw `{yyyy}/{MM}/` text. See §2.1 for a caveat on how much it explains. |
| #2 credentials / region / SSO | Plausible, not testable here | The store is created per watcher from `profile`/`region` and credentials resolve lazily, so a bad profile fails at the first S3 call, not at `watch.start`. |
| #3 IAM List vs Get, KMS, Requester Pays | Plausible, not testable here | Nothing in the code narrows this. |
| #4 destination filesystem | Confirmed by reading | `GetObject` is sent before the temp file is opened; the temp file is `.<name>.s3pulse-<uuid>.part` beside the destination; the extension always sends `overwrite: true`. |
| #5 cancellation / dead backend | Confirmed, generic | Both messages exist as described. Not download-specific. |
| Bug A: failure notification dropped by the parser | Confirmed, impact overstated | `normalizeDownloadProgress` requires `bytesTransferred`; the failure notification omits it. But the *response* to `object.download` still carries the error and the dashboard catch shows it. See §2.3. |
| Bug B: error kind stripped | Confirmed, impact overstated | `remoteErrorMessage` only reads `data.detail`. But `StoreError::aws` already formats the message as `GetObject failed: <AwsCode>: <detail>`, so `AccessDenied` and `ExpiredToken` do not "look identical" in practice. See §2.4. |
| §5 probes | Confirmed | Re-run today; same four failures. |
| §7 fix 1 as written ("resolve the template before comparing") | Rejected | Would reject legitimately listed objects. See §2.2. |
| §7 fixes 2 and 3 | Sound | Refined in §3. |

## 2. Corrections and additions

### 2.1 The guard bug is not machine-specific

The prefix guard fails on every machine for every templated feed. If the same
feed downloads fine on the first machine, the guard is not what is failing on
the second one and the credentials/IAM causes move to the top. The report
should therefore be read as two independent questions:

1. Does the failing feed's target contain `{…}`? If yes, the guard bug is
   present regardless of anything else and the error reads
   `Invalid params: key is outside the watcher's prefix`.
2. Does the staged backend CLI download the same key? The CLI `download`
   command has no prefix guard (it takes a full object URI), so
   `bin/<platform>/s3pulse --profile <p> download s3://bucket/key --json`
   succeeding while the extension fails points at the guard; both failing
   points at credentials, region, IAM or KMS.

### 2.2 "Resolve then compare" is the wrong fix for the guard

Resolving the template at download time and comparing the key against those
prefixes uses the current clock and the current lookback window. The dashboard
keeps objects the watcher listed earlier: an object listed under yesterday's
prefix with `lookbackPeriods: 1` is still on screen the day after tomorrow,
when resolution yields only today and yesterday. That download would be
rejected with the same message the user is seeing now.

The guard has to ask "could this key have been produced by this template?",
which is structural: literal segments must match exactly and each placeholder
must be digits of the right width. That never changes with time, time zone or
lookback, and it still rejects keys from unrelated prefixes.

Membership in the watcher's history snapshot was considered and rejected: the
history is bounded, the dashboard's list is bounded separately, and the two can
evict differently, so a visible object could be absent from the snapshot.

### 2.3 What Bug A actually costs

The failure path is: backend sends `download.progress {done, error}`, then
answers the request with an error. The extension drops the notification, but
the request rejects, `withProgress` closes, and the shared catch in
`#handleWebviewMessage` shows both a webview toast (auto-hides after nine
seconds) and a VS Code error notification with a "Show Output" button.

So the user does see a message. What is lost is diagnostics: the Output
channel gets nothing beyond `[dashboard] "name" sent download`, so "Show
Output" shows nothing relevant, and the bytes written before the failure are
not reported anywhere.

### 2.4 What Bug B actually costs

Because the backend message already embeds the AWS error code, the loss is not
that categories are indistinguishable. It is that:

- the `kind` and `retryable` fields the 0.2.5 release added so the user knows
  "whose problem it is" are not used for downloads, so a `serviceUnavailable`
  reads like a credential problem;
- there is no kind-specific hint (sign in again, check `s3:GetObject`/KMS,
  check network and region, check the destination folder);
- the probe's `B1` assertion looks for the literal string `AccessDenied`,
  which the real message would contain anyway. After the fix the assertion
  should check for the hint text instead.

### 2.5 Gaps the findings do not mention

- `docs/json-rpc.md` documents `download.progress` with `bytesTransferred`
  only; the error-bearing shape is undocumented, so the extension had no
  contract to parse it against.
- `rpcClient.ts` imports `vscode`, so `remoteErrorMessage` cannot be tested by
  `node --test`. The message builder must move to a `vscode`-free module.
- Tests in `extension/test` that need `dashboard.ts` behaviour read the source
  text (see `startRouting.test.ts`); the same pattern applies here.

## 3. Fix plan

Three changes, one pull request, two commits (backend first so the protocol
change lands with its docs). Rust owns the guard and the wire shape; TypeScript
owns parsing and presentation.

### 3.1 Core: structural key matching for `DateTemplate`

File: `crates/s3pulse-core/src/template.rs`.

Add a public method on `DateTemplate`:

```rust
/// Whether `key` lies under some rendering of this template.
///
/// Structural, not temporal: any digits of the right width are accepted, so
/// an object listed under a lookback period that has since left the window
/// is still recognised as this watcher's. Everything after the last segment
/// is the object's own name and is not inspected.
pub fn matches(&self, key: &str) -> bool
```

Implementation sketch: recurse over `segments` with the remaining key.

- `Segment::Literal(text)`: `rest.strip_prefix(text)` must succeed.
- `Segment::Field(field)`: try each width in `field.widths()`; the next
  `width` bytes must all be ASCII digits (check on `as_bytes()` first so the
  slice is always on a char boundary), then recurse on the rest.
- `Field::widths`: `Year4 → [4]`; `Year2 | Month2 | Day2 | Hour2 → [2]`;
  `Month1 | Day1 | Hour1 → [2, 1]` (two digits first, then one, so
  `{M}{dd}` still matches `1201`).
- No segments left: `true`.

Add `pub fn template(&self) -> Option<&DateTemplate>` to `PollingWatcher` in
`watcher.rs` so the runtime reuses the template already parsed and validated
at construction rather than parsing twice.

Tests (`template.rs`, next to the existing `mod tests`):

- hive layout `trades/{yyyy}/{MM}/{dd}/` matches `trades/2026/09/13/x.parquet`
  and `trades/2019/01/01/x.parquet` (older than any lookback);
- rejects `other/2026/09/13/x`, `trades/2026/9/13/x` (`{MM}` needs two
  digits), and the raw text `trades/{yyyy}/{MM}/{dd}/x`;
- compact `trades/{yyyy}{MM}{dd}/` matches `trades/20260913/x`;
- `{M}` accepts `9` and `12`; `{M}{dd}` matches `1201`;
- escaped braces match literally: `a{{b}}/{yyyy}/` matches `a{b}/2026/x`.

### 3.2 Backend runtime: template-aware guard and a complete failure notification

File: `crates/s3pulse-cli/src/rpc/runtime.rs`.

Guard:

- Add `template: Option<DateTemplate>` to `WatchSession`, cloned from
  `watcher.template()` in `watch_start` right after `PollingWatcher::new`.
- Replace the `starts_with` check in `object_download` with a small helper,
  unit-testable on its own:

```rust
fn key_within_target(target: &S3Uri, template: Option<&DateTemplate>, key: &str) -> bool {
    match template {
        Some(template) => template.matches(key),
        None => target.prefix.is_empty() || key.starts_with(&target.prefix),
    }
}
```

- Make the rejection say what was expected:
  `key "<key>" is outside the watcher's target <target_display>`. It stays an
  `invalid_params` error (`-32602`), which is what the extension already
  renders as `Invalid params: <detail>`.

Failure notification:

- Track the last `bytes_transferred` seen in the progress arm of the
  `tokio::select!` loop and include it as `bytesTransferred` in the
  `done: true` + `error` notification. This is additive: old clients that
  require the field now parse it, new clients tolerate its absence.

Tests (`runtime.rs` `mod tests`; the existing `FakeStore`/`FakeFactory` and
`CapturingNotifier` are enough for the guard, and a second fake store whose
`download_object` sends one progress sample then returns
`StoreError::new(AccessDenied, "GetObject failed: AccessDenied: Access Denied", false)`
covers the failure shape):

- templated feed `s3://bucket/feed/{yyyy}/{MM}/` accepts
  `feed/2026/09/object.parquet` and returns the fake's 42 bytes;
- the same feed accepts `feed/2019/01/object.parquet` (pins the structural
  decision from §2.2);
- the same feed rejects `elsewhere/2026/09/object.parquet` and the raw
  `feed/{yyyy}/{MM}/object.parquet` with `INVALID_PARAMS` and a detail
  containing the target;
- a plain feed still rejects `other/object.parquet`;
- a failing download yields an error response with
  `data.kind == "accessDenied"`, and a `download.progress` notification with
  `done: true`, `bytesTransferred`, and `error.kind`/`error.message`/
  `error.retryable`.

### 3.3 Protocol documentation

File: `docs/json-rpc.md`.

- `object.download`: state that `key` must lie under the watcher's target;
  for a templated target any rendering of the placeholders is accepted.
  State that on failure the request errors with
  `data: {kind, message, retryable}` and that a final `download.progress`
  notification precedes it.
- Notifications: extend the `download.progress` bullet: on failure it carries
  `done: true`, `bytesTransferred` (bytes written before the failure), and an
  `error` object with the same `kind`/`message`/`retryable` fields as
  `watch.error`. The response remains authoritative; the notification is for
  progress UIs and logs.

### 3.4 Extension: parse the failure, name the kind, log the detail

`extension/src/model.ts`

- Add `BackendErrorInfo { kind?: string; message: string; retryable?: boolean }`.
- Add `error?: BackendErrorInfo` to `DownloadProgress`.

`extension/src/adapters.ts`

- Add `normalizeBackendError(value: unknown): BackendErrorInfo | undefined`
  that accepts either a string or an object with `message`, optional `kind`,
  optional boolean `retryable`. The `watch.error` handler in `dashboard.ts`
  and `readError`/`readRetryable` in `alerts.ts` can adopt it later; not
  required for this fix.
- `normalizeDownloadProgress`: accept the sample when `watcherId` is present
  and either `bytesTransferred` is numeric or `error` parses. Default
  `bytesTransferred` to `0` and `done` to `true` when only `error` is present.
  Return `undefined` otherwise, as now.

`extension/src/rpcProtocol.ts` (already `vscode`-free and tested)

- Move `remoteErrorMessage` here as `describeRemoteError(message, data)` and
  extend it. Order of precedence:
  1. `data.detail` string that differs from `message`: `"<message>: <detail>"`
     (unchanged behaviour, covers `-32602` and `backend()` errors);
  2. `data.kind` string: `"<message> (<hint>)"` using the table below, with
     `", retrying is worth a try"` appended when `retryable === true`;
  3. otherwise `message`.

| `kind` | hint |
| --- | --- |
| `authentication` | AWS credentials are missing or expired; sign in again |
| `accessDenied` | access denied; check `s3:GetObject` on this key and any KMS key policy |
| `notFound` | the object or bucket was not found |
| `network` | the request did not reach S3; check network and region |
| `serviceUnavailable` | S3 reported a server-side failure; not a problem on your side |
| `io` | could not write the destination file; try another folder |
| `cancelled` | cancelled |
| anything else | the raw `kind` text |

`extension/src/rpcClient.ts`

- Import `describeRemoteError` from `rpcProtocol.ts`; delete the local copy.
  `RpcRemoteError` keeps `code` and `data` as public fields.

`extension/src/dashboard.ts`

- `#handleWebviewMessage` catch: before showing the toasts, append one Output
  line: `[dashboard] "<name>" <type> failed: <message>` plus
  ` (code <n>, data <json>)` when the error is an `RpcRemoteError`. This
  covers every dashboard action, not only downloads, and makes "Show Output"
  useful.
- `#reportDownload`: when `progress.error` is set, append
  `[download] "<name>" <key> failed after <bytes>: <kind> <message> (retryable: …)`
  and `continue` without touching the progress increment. Do not show a
  second toast; the response path is the single UI surface.

Tests

- `extension/test/adapters.test.ts`: the exact failure shape from the wire
  capture (no `bytesTransferred`) parses with `error.kind === 'network'`,
  `bytesTransferred === 0`, `done === true`; a normal sample is unchanged; a
  sample with neither bytes nor error is still rejected;
  `normalizeBackendError` handles string and object forms.
- `extension/test/rpcProtocol.test.ts`: `describeRemoteError` keeps the
  `detail` path, names each kind, appends the retry note, ignores non-object
  data, and does not repeat a detail equal to the message.
- New `extension/test/downloadFailure.test.ts` in the source-reading style of
  `startRouting.test.ts`: the webview catch calls `output.appendLine`;
  `#reportDownload` branches on `progress.error`; `rpcClient.ts` imports
  `describeRemoteError` rather than defining its own.

### 3.5 Changelog and version

`extension/CHANGELOG.md`, under `[Unreleased]` → `### Fixed`:

- Downloading from a feed whose target uses date placeholders failed with
  "key is outside the watcher's prefix" because the guard compared against the
  unresolved template.
- A failed download now says what kind of failure it was and whether it is
  worth retrying, and the full error is written to Output → S3 Pulse.
- The backend's failure notification for a download now carries the bytes
  written before the failure.

Bump `version` in `Cargo.toml` (`workspace.package`) and
`extension/package.json` together to `0.2.6` when releasing, as the 0.2.5
commit did.

### 3.6 Verification

Definition of done from `CLAUDE.md`:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
cargo deny check advisories licenses bans sources
npm --prefix extension run check
npm --prefix extension test
npm --prefix extension run compile
```

Then rebuild and re-run the two probes:

```bash
cargo build
node /tmp/s3pulse-repro/rust-protocol/repro-protocol.mjs
cd /tmp/s3pulse-repro/ts && node repro.js   # re-bundle repro-entry.ts first
```

Expected changes in the probes, which were written to demonstrate the bug and
need two assertions updated once it is fixed:

- `R1` passes only up to the S3 call (the guard no longer rejects); with no
  region the error becomes the same `network` failure the control case shows.
- `R1b` inverts: the raw-template key is now rejected by the guard, which is
  the intended behaviour, so its assertion must expect
  `outside the watcher's target`.
- `R2e` passes (`bytesTransferred` present).
- `A1` passes; `B1` must look for the hint text rather than `AccessDenied`.

### 3.7 Order of work and risks

1. §3.1 core matcher and tests (self-contained, no behaviour change).
2. §3.2 runtime guard and failure notification, §3.3 docs, tests.
3. §3.4 extension parsing, message, logging, tests.
4. §3.5 changelog; §3.6 checks and probes.

Risks and how they are contained:

- Loosening the guard: for non-templated targets the check is byte-for-byte
  what it was. For templated targets it accepts any rendering, which is the
  set of keys the watcher could ever list.
- Single-digit placeholders followed directly by another digit field are
  inherently ambiguous; the two-then-one width order handles the common case
  and the guard is a sanity check, not a security boundary, since
  `s3:GetObject` is read-only and the client is the bundled extension.
- Double reporting: the notification is logged, the response is shown. No
  toast is added on the notification path.
- Protocol: both wire changes are additive. The extension bundles its backend,
  so a version skew between the two does not occur in practice.

### 3.8 Still needed from the other machine

Section 6 of the findings stands. Add the two discriminators from §2.1: whether
the feed target contains braces, and whether the staged backend's CLI
`download` succeeds for the same key with the same profile. With the fixes in
§3.4 the Output channel will carry the code, kind and data of the next failure,
which removes the need to ask the user to copy toast text.
