//! The read-only S3 access, bounded history, cadence analytics, and polling
//! engine used by every S3 Pulse frontend.

mod error;
mod history;
mod model;
mod store;
mod template;
mod uri;
mod watcher;

pub use error::{
    ConfigError, StoreError, StoreErrorKind, TemplateError, UriParseError, WatcherError,
};
pub use history::RollingHistory;
pub use model::{
    ArrivalInterval, ArrivalStatistics, AwsS3Options, CadenceSource, DownloadProgress,
    DownloadRequest, DownloadResult, FeedHealth, FeedHealthStatus, HealthSeverity, HistorySnapshot,
    HistoryUpdate, ObjectChange, ObjectChangeKind, PollResult, RequestCounts, S3Object, SizeStatus,
    WatcherConfig, WatcherEvent, DEFAULT_HISTORY_CAPACITY, DEFAULT_LATE_MULTIPLIER,
    DEFAULT_POLL_INTERVAL_SECONDS, MIN_SIZE_OBSERVATIONS, MIN_SIZE_RELATIVE_SCALE,
    SIZE_OUTLIER_SCORE,
};
pub use store::{AwsS3Store, ObjectStore};
pub use template::{DateTemplate, Granularity};
pub use uri::S3Uri;
pub use watcher::{PollingWatcher, SharedHistory};
