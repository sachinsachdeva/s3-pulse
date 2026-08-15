# Changelog

All notable changes to the S3 Pulse extension are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

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
