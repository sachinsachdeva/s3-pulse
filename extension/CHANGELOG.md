# Changelog

All notable changes to the S3 Pulse extension are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
