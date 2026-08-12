# Ideas

Considered but not built. Each entry records the reasoning as well as the idea,
so a future decision starts from where the last one left off rather than from
scratch.

## Auto-start saved feeds

Start previously-active feeds when the extension activates, persisting the
active set to `globalState` instead of the in-memory map in `backend.ts`.

Today a feed has three independent states — saved, running, dashboard open — and
only the first survives a window reload. So alerting only covers feeds started in
the current session, and anyone who reloads their window silently stops being
monitored.

**If built, it must be opt-in and off by default.** Every poll is a billable
`ListObjectsV2` request, so an extension that silently resumed six feeds on every
window open would spend money without being asked. This is the same reason
AWS Toolkit's CloudWatch Logs Live Tail is started deliberately per resource
rather than resumed automatically — it is explicitly a paid feature. Extensions
that *do* auto-start on activation (language servers, linters) are doing local,
free work.

Worth showing the projected monthly cost of the auto-started set at the moment
the setting is enabled, since that is when the decision is really being made.

The honest ceiling: this is still a VS Code extension, so nothing is watched when
VS Code is closed. True 24/7 monitoring is `s3pulse watch` under a scheduler, or
the event-driven path below.

## Expected-cadence schedules

Attach opening hours to a feed (IANA time zone, weekly windows, holidays) so
health is only evaluated when arrivals are actually expected. "Late" at 3am on a
Sunday is noise that teaches people to ignore the indicator.

The mechanism that makes it tractable is a single primitive — the measure of an
interval intersected with the open windows — from which the rest follows: compare
an *open-time* gap against the lateness threshold instead of wall-clock, and a
feed idle all weekend reads as minutes rather than sixty hours, with no latching
state machine.

Two things to weigh first. It needs `chrono-tz`, which compiles the tz database
into every bundled platform binary (roughly +1 MB per VSIX) and ages with the
world's DST rules. More importantly **the failure mode inverts**: today the tool
produces false alarms, and a wrong window produces false silence, which is worse
because nothing announces it.

## Adaptive polling

Treat `pollIntervalSeconds` as the *fastest* interval and sleep until the next
arrival is actually due, clamped to a ceiling. A healthy 15-minute feed polled
every 30 seconds is checked 30x more often than it can possibly change.

Safe here specifically because cadence statistics derive from each object's S3
`LastModified`, not from poll timestamps, so slower polling costs time-to-notice
and never accuracy. The invariant to hold is that the scheduler may never sleep
past `lastArrival + lateAfterSeconds`, so lateness is still declared within one
interval of the threshold.

Note before starting: `PollingWatcher::run` is dead production code — its only
caller is a test. The two real loops in `app.rs` and `rpc/runtime.rs` hand-roll
their own loop around `poll_once`, so a change made in `run` would ship
affecting nothing.


## Event-driven ingestion

Replace polling with S3 event notifications delivered through SQS. Removes the
request cost and the detection latency in one move, at the price of requiring
infrastructure changes in the account being monitored — which is exactly what
polling was chosen to avoid for v1.

## Durable history

History is in-memory and bounded per watcher, so restarting the backend loses it,
and request counters reset with it. A local SQLite store would survive restarts
and allow a much longer window than memory permits.

## Export

CSV or JSON export of arrival history for incident write-ups. Small, and the data
already exists in `statistics.history`.
