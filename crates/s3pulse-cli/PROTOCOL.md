# S3 Pulse stdio protocol

`s3pulse serve --stdio` speaks JSON-RPC 2.0 over newline-delimited UTF-8 JSON.
Each request, response, or notification occupies one line. The server reserves
stdout for protocol messages and writes diagnostics to stderr. Requests run
concurrently, so clients must correlate potentially out-of-order responses by
their `id`.

## Methods

- `system.version {}`
- `watch.start {"watcher":{"id"?,"name"?,"target","profile"?,"region"?,"pollIntervalSeconds"?,"expectedIntervalSeconds"?,"historyLimit"?}}`
- `watch.stop {"watcherId"}`
- `watch.status {"watcherId"?}`
- `objects.list {"watcherId","limit"?}`
- `statistics.frequency {"watcherId"}`
- `statistics.history {"watcherId","limit"?}`
- `object.download {"watcherId","downloadId"?,"key","destination","overwrite"?}`

Long-running requests may be cancelled with the standard notification:

```json
{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":7}}
```

A watcher itself outlives its `watch.start` request and is cancelled with
`watch.stop`.

## Server notifications

- `objects.added`
- `watch.statusChanged`
- `statistics.updated`
- `download.progress`
- `watch.error`

Every watcher notification includes `watcherId`. Download progress also
includes `downloadId`, allowing multiple concurrent downloads for one watcher.
