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
