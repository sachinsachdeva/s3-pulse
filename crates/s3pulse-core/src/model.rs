use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{ConfigError, S3Uri, StoreError};

pub const DEFAULT_POLL_INTERVAL_SECONDS: u64 = 30;
pub const DEFAULT_HISTORY_CAPACITY: usize = 10_000;
pub const DEFAULT_LATE_MULTIPLIER: f64 = 1.5;

fn default_poll_interval_seconds() -> u64 {
    DEFAULT_POLL_INTERVAL_SECONDS
}

fn default_history_capacity() -> usize {
    DEFAULT_HISTORY_CAPACITY
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherConfig {
    pub id: String,
    pub name: String,
    pub target: S3Uri,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(default = "default_poll_interval_seconds")]
    pub poll_interval_seconds: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_interval_seconds: Option<u64>,
    #[serde(default = "default_history_capacity")]
    pub max_history: usize,
    /// Earlier periods to also watch when the target carries date placeholders.
    ///
    /// A rollover is not clean — files for yesterday can still land after
    /// midnight — and this doubles as slack for a feed partitioned in a zone
    /// other than UTC. Ignored for a target without placeholders.
    #[serde(default = "default_lookback_periods")]
    pub lookback_periods: u32,
    /// IANA zone the date placeholders resolve in, for example
    /// `Australia/Sydney`. Defaults to UTC.
    ///
    /// This is not cosmetic: a feed partitioned by Sydney date writes to
    /// `20260812/` while UTC is still on the 11th, so resolving in the wrong
    /// zone watches a prefix nothing is writing to for hours at a time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
}

fn default_lookback_periods() -> u32 {
    1
}

impl WatcherConfig {
    pub fn new(id: impl Into<String>, name: impl Into<String>, target: S3Uri) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            target,
            profile: None,
            region: None,
            poll_interval_seconds: DEFAULT_POLL_INTERVAL_SECONDS,
            expected_interval_seconds: None,
            max_history: DEFAULT_HISTORY_CAPACITY,
            lookback_periods: default_lookback_periods(),
            time_zone: None,
        }
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.id.trim().is_empty() {
            return Err(ConfigError::EmptyId);
        }
        if self.name.trim().is_empty() {
            return Err(ConfigError::EmptyName);
        }
        if self.poll_interval_seconds == 0 {
            return Err(ConfigError::ZeroPollInterval);
        }
        if self.expected_interval_seconds == Some(0) {
            return Err(ConfigError::ZeroExpectedInterval);
        }
        if self.max_history == 0 {
            return Err(ConfigError::ZeroHistoryCapacity);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Object {
    pub key: String,
    pub last_modified: DateTime<Utc>,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_class: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ObjectChangeKind {
    Added,
    Updated,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectChange {
    pub kind: ObjectChangeKind,
    pub object: S3Object,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<S3Object>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryUpdate {
    pub changes: Vec<ObjectChange>,
    pub evicted: Vec<S3Object>,
}

impl HistoryUpdate {
    pub fn added(&self) -> impl Iterator<Item = &S3Object> {
        self.changes
            .iter()
            .filter(|change| change.kind == ObjectChangeKind::Added)
            .map(|change| &change.object)
    }

    pub fn updated(&self) -> impl Iterator<Item = &S3Object> {
        self.changes
            .iter()
            .filter(|change| change.kind == ObjectChangeKind::Updated)
            .map(|change| &change.object)
    }

    pub fn is_empty(&self) -> bool {
        self.changes.is_empty() && self.evicted.is_empty()
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrivalInterval {
    pub previous_key: String,
    pub key: String,
    pub previous_arrival: DateTime<Utc>,
    pub arrival: DateTime<Utc>,
    pub seconds: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CadenceSource {
    Configured,
    Learned,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FeedHealthStatus {
    #[default]
    Unknown,
    Healthy,
    Late,
}

/// How an arrival's size compares with the feed's recent norm.
///
/// A second, orthogonal axis to [`FeedHealthStatus`]: a feed can arrive exactly
/// on time and still be broken. Kept separate so timing health keeps its
/// existing meaning for clients.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SizeStatus {
    /// Too few observations to judge, or no reference size.
    #[default]
    Unknown,
    Normal,
    /// Zero bytes where the feed normally carries content.
    Empty,
    Small,
    Large,
}

/// One rollup across both health axes, so every frontend ranks feeds the same
/// way instead of each inventing its own precedence.
///
/// Ordered worst-last, so the worst feed in a set is `max()`.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HealthSeverity {
    #[default]
    Unknown,
    Ok,
    Warning,
    Critical,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedHealth {
    pub status: FeedHealthStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cadence_source: Option<CadenceSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_interval_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub late_after_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_gap_seconds: Option<f64>,
    /// The instant the feed became late: `lastArrival + lateAfterSeconds`.
    ///
    /// Present only while late. This is a pure derivation rather than recorded
    /// state, so it is stable for the whole episode and identical after a
    /// backend restart, which makes it usable as a durable identity for
    /// de-duplicating alerts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub late_since: Option<DateTime<Utc>>,
    /// How far past the lateness threshold the feed is. Present only while late.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overdue_seconds: Option<f64>,
    #[serde(default)]
    pub size_status: SizeStatus,
    #[serde(default)]
    pub severity: HealthSeverity,
}

/// Thresholds for size-outlier detection. Public so tests and docs cite one
/// source, and so revisiting them against real feeds is a one-line change.
pub const SIZE_OUTLIER_SCORE: f64 = 3.5;
pub const MIN_SIZE_RELATIVE_SCALE: f64 = 0.10;
pub const MIN_SIZE_OBSERVATIONS: usize = 8;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrivalStatistics {
    pub as_of: DateTime<Utc>,
    pub object_count: usize,
    pub interval_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_arrival: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_arrival: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mean_interval_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub median_interval_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p95_interval_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub largest_gap_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_gap_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_per_hour: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_per_day: Option<f64>,
    pub health: FeedHealth,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySnapshot {
    /// Newest arrivals first; equal timestamps are ordered by key.
    pub objects: Vec<S3Object>,
    /// Oldest interval first, suitable for plotting directly.
    pub intervals: Vec<ArrivalInterval>,
    pub statistics: ArrivalStatistics,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsS3Options {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
}

/// Billable S3 requests a store has issued since it was created.
///
/// These are counts, not money. Request pricing varies by region, storage class
/// and over time, so converting to a currency amount is left to the frontend,
/// which can carry a user-configurable rate.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestCounts {
    /// ListObjectsV2 calls, counted once per page rather than once per poll,
    /// because each page is separately billable.
    pub list_requests: u64,
    /// GetObject calls issued for downloads.
    pub get_requests: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub source: S3Uri,
    pub destination: PathBuf,
    #[serde(default)]
    pub overwrite: bool,
}

impl DownloadRequest {
    pub fn new(source: S3Uri, destination: impl Into<PathBuf>) -> Self {
        Self {
            source,
            destination: destination.into(),
            overwrite: false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub bytes_transferred: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    pub done: bool,
}

impl DownloadProgress {
    pub fn new(bytes_transferred: u64, total_bytes: Option<u64>, done: bool) -> Self {
        let percent = match (total_bytes, done) {
            (Some(0), true) => Some(100.0),
            (Some(0), false) => None,
            (Some(total), _) => {
                Some(((bytes_transferred as f64 / total as f64) * 100.0).clamp(0.0, 100.0))
            }
            (None, _) => None,
        };
        Self {
            bytes_transferred,
            total_bytes,
            percent,
            done,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub source: S3Uri,
    pub destination: PathBuf,
    pub bytes_transferred: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollResult {
    pub polled_at: DateTime<Utc>,
    /// Objects retained from the listing after applying the watcher limit;
    /// this is not the bucket's total key count when a prefix exceeds it.
    pub listed_object_count: usize,
    pub update: HistoryUpdate,
    pub snapshot: HistorySnapshot,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WatcherEvent {
    Started {
        watcher_id: String,
        at: DateTime<Utc>,
    },
    PollCompleted {
        watcher_id: String,
        result: Box<PollResult>,
    },
    PollFailed {
        watcher_id: String,
        at: DateTime<Utc>,
        error: StoreError,
    },
    Stopped {
        watcher_id: String,
        at: DateTime<Utc>,
    },
}
