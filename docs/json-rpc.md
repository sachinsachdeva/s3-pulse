# S3 Pulse JSON-RPC protocol

S3 Pulse uses JSON-RPC 2.0 over newline-delimited UTF-8 JSON on stdin/stdout.
Every protocol value occupies one line. In `serve --stdio` mode stdout is reserved
for protocol traffic; logs and diagnostics are written to stderr.

The protocol version documented here is `1`.

## Common values

A watcher definition uses camel-case JSON fields:

```json
{
  "id": "production-trades",
  "name": "Production Trades",
  "target": "s3://prod-data/trades/",
  "profile": "prod",
  "region": "ap-southeast-2",
  "pollIntervalSeconds": 30,
  "expectedIntervalSeconds": 900,
  "historyLimit": 5000
}
```

Only `target` is required. The server generates an ID and derives a name when
they are not
provided. `profile`, `region`, and `expectedIntervalSeconds` may be omitted.

Objects are represented as:

```json
{
  "key": "trades/trades_0015.parquet",
  "lastModified": "2026-08-11T00:15:04Z",
  "size": 42991616,
  "etag": "\"abc123\"",
  "storageClass": "STANDARD"
}
```

Feed health is reported as:

```json
{
  "status": "late",
  "severity": "warning",
  "sizeStatus": "normal",
  "cadenceSource": "configured",
  "expectedIntervalSeconds": 900,
  "lateAfterSeconds": 1350,
  "currentGapSeconds": 4911,
  "overdueSeconds": 3561,
  "lateSince": "2026-08-12T03:31:41Z"
}
```

`status` covers timing only. `sizeStatus` is a second, independent axis —
`unknown`, `normal`, `empty`, `small` or `large` — because a feed can arrive
exactly on time and still be broken; it is judged from the sizes already held in
history, at no extra request cost. `severity` (`unknown`, `ok`, `warning`,
`critical`) is the worst of the two, so every frontend ranks feeds identically.

`lateSince` is `lastArrival + lateAfterSeconds` and appears only while late.
Being derived rather than recorded, it does not move during an outage and is
recomputed identically after a backend restart, so clients may use it as a
durable identity for one lateness episode — for example to alert once per outage
rather than once per poll. Clients must tolerate unknown values in any of these
enumerations.

Durations in structured responses are numeric seconds. Timestamps are RFC 3339
UTC strings. Optional values are either omitted or `null`; clients must accept
both during protocol evolution.

Billable request counters are reported as:

```json
{"listRequests": 1440, "getRequests": 3}
```

`listRequests` counts `ListObjectsV2` calls once per **page**, not once per
poll, because S3 bills each page separately; a prefix holding more than 1,000
objects therefore advances the counter by more than one per poll. Counters are
cumulative for the life of the watcher process and reset when the backend
restarts. They are counts only: request pricing varies by region and over time,
so converting them to a currency amount is the client's responsibility.

## Requests

### `system.version`

Parameters may be omitted. Result:

```json
{"version":"0.1.0","protocolVersion":1}
```

### `watch.start`

```json
{"watcher":{"name":"Production Trades","target":"s3://prod-data/trades/","pollIntervalSeconds":30}}
```

Result:

```json
{"watcherId":"production-trades","status":"running"}
```

Starting an already running watcher ID is an error. A successful response means
the task was created, not that the first S3 request succeeded.

### `watch.stop`

Parameters: `{"watcherId":"production-trades"}`.

Result: `{"watcherId":"production-trades","status":"stopped"}`.

### `watch.status`

Parameters may contain `watcherId`; omitting it returns all watchers. Result
contains a `watchers` array whose entries include `watcherId`, `name`, `target`,
`status`, optional `lastPollAt`, `objectCount`, `requestCounts`, optional
`health`, and optional `error`. `health` appears once the watcher has completed
a poll and has the same shape as the `health` object inside statistics, so a
client can rank every feed from one request.

### `objects.list`

Parameters: `{"watcherId":"production-trades","limit":1000}`. Result:

```json
{"watcherId":"production-trades","objects":[]}
```

Objects are newest first. The bounded server-side history means this is not a
complete bucket listing after a watcher has been running longer than its
retention limit. Response methods cap `limit` at 1,000 so a single protocol
line remains bounded; initial object notifications are sent in smaller batches.

### `statistics.frequency`

Parameters: `{"watcherId":"production-trades"}`. Result contains `watcherId`,
the current `statistics` snapshot — including object count, interval aggregates,
current gap, and health — and `requestCounts`.

### `statistics.history`

Parameters: `{"watcherId":"production-trades","limit":500}`. Result contains
`watcherId` and chronological `samples` with `key`, `lastModified`, and optional
`intervalSeconds`, suitable for timeline, bucketed-frequency, or inter-arrival
views.

### `object.download`

```json
{
  "watcherId": "production-trades",
  "downloadId": "client-generated-uuid",
  "key": "trades/trades_0015.parquet",
  "destination": "/Users/me/Downloads/trades_0015.parquet"
}
```

`downloadId` is optional for compatibility but clients should generate it so
progress can be correlated before the final response. The result is returned
after the download succeeds and includes `watcherId`, `downloadId`,
`destination`, and `bytes`. Partial temporary files are removed on failure or
cancellation.

### Cancellation

Clients cancel a request with the standard notification:

```json
{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":42}}
```

Cancellation is best effort. It is primarily useful for downloads and other
long-running calls.

## Notifications

Every watcher-scoped notification includes `watcherId` in `params`.

- `objects.added`: contains an `objects` array with only new or changed objects.
- `watch.statusChanged`: contains `status` and optional `error`.
- `statistics.updated`: contains the latest `statistics` snapshot and the
  watcher's cumulative `requestCounts`.
- `download.progress`: contains `downloadId`, `key`, `bytesTransferred`,
  optional `totalBytes`, and `done`.
- `watch.error`: contains a stable `code`, user-facing `message`, and optional
  retry information.

Clients must ignore unknown notification methods and unknown result fields.

## Errors

Standard JSON-RPC codes are used for parse, invalid request, method-not-found,
and invalid-params failures. S3 Pulse application errors use the range
`-32000..-32099`. Error `data` may contain a stable `kind` such as
`watcherNotFound`, `accessDenied`, `credentials`, `network`, `cancelled`, or
`io`.
