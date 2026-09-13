# Changelog

All notable changes to the S3 Pulse extension are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.2.6] - 2026-09-13

### Fixed

- Downloading from a feed whose target carries date placeholders failed with
  "key is outside the watcher's prefix". The guard compared the object's key
  with the unrendered template, so every real key was rejected. It now
  recognises any rendering of the template, including a period that has left
  the lookback window but whose objects are still on screen.
- A failed download says what kind of failure it was and whether a retry is
  worth trying, using the same categories the feed itself reports, and the
  full error with its code and data is written to Output → S3 Pulse, where
  the toast's "Show Output" button lands. Before, the channel had nothing to
  show.
- The backend's final `download.progress` notification for a failed download
  now carries the bytes written before the failure, and the extension no
  longer drops that notification for lacking one.

## [0.2.5] - 2026-09-05

### Fixed

- A failure on the service's side was reported as though it were yours. An S3
  `InternalError`, `ServiceUnavailable` or `SlowDown` fell through to the
  catch-all category, so the feed went red and read "stopped" — sending you
  through your own credentials and bucket policy for something you cannot fix
  and that usually clears by itself. These now have their own
  `serviceUnavailable` category, classified after network failures so a real
  transport problem keeps its more specific label.
- Starting a feed no longer fails on a failure the backend intends to retry.
  The watcher is registered and still polling, and one server-side error says
  nothing about the next request, so failing the start turned a momentary blip
  into a feed you had to notice and restart by hand. It is reported instead,
  and the dashboard says it is retrying.
- A retryable failure alerts as a warning rather than critical, and is worded
  "retrying" rather than "stopped", so a blip does not outrank a real outage in
  the status bar.

### Changed

- `docs/json-rpc.md` now matches the error enum. It had listed a `credentials`
  kind that has never been serialised, omitted four real ones, and never
  documented the `retryable` flag that says whether a watcher is still polling.
- Releases publish one package per platform at a time, with retries. The
  Marketplace throttles consecutive publishes, and a single invocation for all
  six abandoned the rest on the first timeout — which left different platforms
  offered different versions until someone noticed.

## [0.2.4] - 2026-08-29

### Fixed

- The dashboard was completely inert: no metric ever populated and no button
  did anything. The page is built inside a template literal, where a backslash
  is an escape the literal consumes, so the regex `/\/+$/` used to trim a
  trailing slash from an object key shipped as `//+$/` — a line comment. That
  broke the statement, the whole 28KB script failed to parse, and nothing in
  the page ran. Trimming now uses `split('/')`, which needs no escape.
- Starting an already-running feed reported it instead of silently doing
  nothing, and starting a feed whose watcher the backend still holds now
  retries rather than failing with "Watcher already exists". The dashboard's
  Start button and the tree's both take this path; previously only the tree's
  did.
- A dashboard tab restored after a window reload stayed dead. The extension
  registered no `WebviewPanelSerializer`, so it never received the restored
  panel, and lacked the `onWebviewPanel` activation event needed to be woken
  by one. Panels saved before feed ids were persisted are recovered by title
  rather than discarded.
- Editing a feed the backend refused to release now restarts it instead of
  failing to start it.

### Added

- The dashboard header shows the extension and backend versions, which can
  legitimately differ, and flags a mismatch.
- A dashboard that never reports itself ready is now called out in the output
  channel instead of looking merely idle.
- Every feed command records when it resolves to no feed, so a click can no
  longer produce an empty log.
- Tests render the page the way the extension does and boot the resulting
  script against a stub DOM, plus an integration suite that drives a real
  extension host. The parse failure above was invisible to tests that read the
  source rather than the rendered output.

## [0.2.1] - 2026-08-15

### Fixed

- Starting a feed appeared to do nothing for several seconds. With no region
  configured the AWS SDK queries the EC2 metadata endpoint, which never answers
  off EC2, and each attempt logged a timeout warning that read like a failure.
  Those warnings are now quiet by default; `RUST_LOG` still shows them.
- The feed wizard never asked for a region, so the field existed on the model
  and was sent to the backend but could not be set from the UI. Setting one
  avoids the metadata lookup entirely.
- Starting a feed now logs the target, interval, profile and region, so the wait
  while credentials resolve is visible rather than silent.

## [0.2.0] - 2026-08-12

### Added

- Hover detail on the arrival-cadence graph: file name, timestamp, size, and
  the interval since the previous arrival. Points can also be stepped through
  with the arrow keys once the graph has focus.
- Per-feed bucket width for the "files per interval" graph, chosen when adding
  or editing a feed and stored with the feed rather than the window.
- Billable S3 request counts per feed, reported by the backend and shown on the
  dashboard with an optional cost estimate. Rates are configurable through
  `s3Pulse.listRequestCostPer1000` and `s3Pulse.getRequestCostPer1000`; the
  polling step of the feed wizard shows the projected monthly cost of each
  interval.
- `npm run stage-backend` places a built backend where the extension looks for
  it, so the Extension Development Host runs current code with no settings to
  configure.

- Date-templated targets: `s3://bucket/trades/{yyyy}{MM}{dd}/` resolves to the
  current period at every poll, so a date-partitioned feed no longer needs a new
  definition every day. Also watches earlier periods, one by default, because a
  rollover is not clean. Placeholders resolve in the feed's own IANA time zone
  (default UTC), which matters because a feed partitioned by Sydney date is
  writing tomorrow's prefix while UTC is still on today. `s3Pulse.defaultTimeZone`
  seeds the choice for new feeds; each feed still stores its own.
- **S3 Pulse: Copy Backend (CLI) Path** command. The bundled backend is the
  complete `s3pulse` CLI, and nothing previously revealed where it lives.
- Alerting: a status-bar indicator summarising the health of every watched feed,
  and notifications when one goes late, arrives the wrong size, or stops with an
  error. Health is tracked whether or not a dashboard is open. A single ongoing
  outage notifies once rather than once per poll, and a problem must persist for
  two consecutive polls before it interrupts anyone. Controlled by the
  `s3Pulse.alerts.*` settings and `s3Pulse.showStatusBar`.
- Size-anomaly detection: an arrival that is empty, or far smaller or larger
  than the feed's recent norm, is reported alongside timing health. Judged from
  sizes already held in history, so it costs no extra S3 requests.
- Feed health now carries `severity`, `sizeStatus`, `lateSince` and
  `overdueSeconds`, and is reported on `watch.status` as well as on statistics.

### Changed

- Row actions in the object grid are compact icon buttons instead of text
  buttons. The previous wording is retained as the accessible name.

### Security

- Dropped the legacy `rustls` feature from the AWS SDK dependency. It is an
  alias for `legacy-rustls-ring` and pulled rustls 0.21 and hyper-rustls 0.24 in
  alongside the modern TLS stack, carrying RUSTSEC-2026-0098. HTTPS now goes
  solely through the current client. `cargo-deny` runs in CI so the advisory
  database and licence allow-list are actually enforced.

### Fixed

- The download dialog proposed "Untitled" instead of the object's file name
  whenever no workspace folder was open, which is the default state of the
  Extension Development Host.
- Hovering the graph while a new object arrived could leave the tooltip
  describing a different arrival than the one under the cursor.
- Setting `hidden` on the graph canvas did not hide it, because an author
  `display` rule outranks the user-agent rule for `[hidden]`.
- Object keys ending in `/` produced an empty tooltip heading.
- Every S3 service failure was reported as "service error" and treated as
  retryable, because the AWS SDK's own message is only a short variant label.
  Expired or wrong credentials, denied access, and missing buckets are now named
  and categorised distinctly, so `accessDenied`, `credentials` and `notFound`
  reach clients as documented.

## [0.1.1]

### Added

- Initial release: saved feeds, live cadence graph, searchable object grid,
  streamed downloads with progress, and a bundled native backend per platform.
