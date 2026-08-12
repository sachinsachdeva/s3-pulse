use std::{sync::Arc, time::Duration};

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use tokio::sync::{mpsc, RwLock};
use tokio_util::sync::CancellationToken;

use crate::{
    parse_time_zone, DateTemplate, ObjectStore, PollResult, RollingHistory, S3Uri, StoreError,
    WatcherConfig, WatcherError, WatcherEvent,
};

pub type SharedHistory = Arc<RwLock<RollingHistory>>;

/// A single independently cancellable polling loop.
///
/// The watcher owns no global registry and performs no persistence, which lets
/// the CLI, JSON-RPC server, and tests supervise multiple instances without
/// coupling them to one frontend lifecycle.
pub struct PollingWatcher {
    config: WatcherConfig,
    store: Arc<dyn ObjectStore>,
    history: SharedHistory,
    /// Parsed once at construction; `None` for an ordinary target, which then
    /// behaves exactly as it did before templates existed.
    template: Option<DateTemplate>,
    zone: Tz,
}

impl PollingWatcher {
    pub fn new(config: WatcherConfig, store: Arc<dyn ObjectStore>) -> Result<Self, WatcherError> {
        config.validate()?;
        let history = RollingHistory::with_expected_interval(
            config.max_history,
            config.expected_interval_seconds,
        )?;
        let template =
            DateTemplate::parse(&config.target.prefix).map_err(WatcherError::InvalidTemplate)?;
        let zone = match config.time_zone.as_deref() {
            Some(name) => parse_time_zone(name).map_err(WatcherError::InvalidTemplate)?,
            None => Tz::UTC,
        };
        Ok(Self {
            config,
            store,
            history: Arc::new(RwLock::new(history)),
            template,
            zone,
        })
    }

    pub fn config(&self) -> &WatcherConfig {
        &self.config
    }

    pub fn history(&self) -> SharedHistory {
        Arc::clone(&self.history)
    }

    /// The concrete prefixes this poll will list.
    ///
    /// One entry for an ordinary target; for a templated one, the current
    /// period plus `lookback_periods` earlier ones.
    pub fn resolve_targets(&self, at: DateTime<Utc>) -> Vec<S3Uri> {
        match &self.template {
            None => vec![self.config.target.clone()],
            Some(template) => template
                .resolve(at, self.config.lookback_periods, self.zone)
                .into_iter()
                .map(|prefix| S3Uri {
                    bucket: self.config.target.bucket.clone(),
                    prefix,
                })
                .collect(),
        }
    }

    /// Performs one complete paginated LIST/reconcile operation.
    ///
    /// A templated target lists every resolved prefix and feeds them all into
    /// the one history, which merges them because it is keyed by object key.
    pub async fn poll_once(&mut self) -> Result<PollResult, StoreError> {
        let polled_at_start = Utc::now();
        let targets = self.resolve_targets(polled_at_start);
        let mut objects = Vec::new();
        for target in &targets {
            objects.extend(
                self.store
                    .list_objects(target, self.config.max_history)
                    .await?,
            );
        }
        let listed_object_count = objects.len();
        let polled_at = Utc::now();
        let mut history = self.history.write().await;
        let update = history.upsert_many(objects);
        let snapshot = history.snapshot_at(polled_at, None);
        Ok(PollResult {
            polled_at,
            listed_object_count,
            update,
            snapshot,
        })
    }

    /// Polls immediately and then at the configured interval until cancelled.
    /// Store failures are events rather than terminal errors so transient S3 or
    /// credential failures can recover without recreating the watcher.
    pub async fn run(
        &mut self,
        cancellation: CancellationToken,
        events: mpsc::Sender<WatcherEvent>,
    ) -> Result<(), WatcherError> {
        send_event(
            &events,
            WatcherEvent::Started {
                watcher_id: self.config.id.clone(),
                at: Utc::now(),
            },
        )
        .await?;

        if cancellation.is_cancelled() {
            return send_event(
                &events,
                WatcherEvent::Stopped {
                    watcher_id: self.config.id.clone(),
                    at: Utc::now(),
                },
            )
            .await;
        }

        loop {
            let event = tokio::select! {
                _ = cancellation.cancelled() => break,
                result = self.poll_once() => match result {
                    Ok(result) => WatcherEvent::PollCompleted {
                        watcher_id: self.config.id.clone(),
                        result: Box::new(result),
                    },
                    Err(error) => WatcherEvent::PollFailed {
                        watcher_id: self.config.id.clone(),
                        at: Utc::now(),
                        error,
                    },
                }
            };
            send_event(&events, event).await?;

            tokio::select! {
                _ = cancellation.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_secs(self.config.poll_interval_seconds)) => {}
            }
        }

        send_event(
            &events,
            WatcherEvent::Stopped {
                watcher_id: self.config.id.clone(),
                at: Utc::now(),
            },
        )
        .await
    }
}

async fn send_event(
    events: &mpsc::Sender<WatcherEvent>,
    event: WatcherEvent,
) -> Result<(), WatcherError> {
    events
        .send(event)
        .await
        .map_err(|_| WatcherError::EventChannelClosed)
}

#[cfg(test)]
mod tests {
    use std::{path::PathBuf, sync::Mutex};

    use async_trait::async_trait;
    use chrono::{TimeZone, Utc};

    use super::*;
    use crate::{
        DownloadProgress, DownloadRequest, DownloadResult, FeedHealthStatus, S3Object, S3Uri,
    };

    struct FakeStore {
        listings: Mutex<Vec<Vec<S3Object>>>,
    }

    impl FakeStore {
        fn new(listings: Vec<Vec<S3Object>>) -> Self {
            Self {
                listings: Mutex::new(listings.into_iter().rev().collect()),
            }
        }
    }

    #[async_trait]
    impl ObjectStore for FakeStore {
        async fn list_objects(
            &self,
            _target: &S3Uri,
            max_objects: usize,
        ) -> Result<Vec<S3Object>, StoreError> {
            let mut objects = self.listings.lock().unwrap().pop().unwrap_or_default();
            objects.sort_by(|left, right| {
                right
                    .last_modified
                    .cmp(&left.last_modified)
                    .then_with(|| left.key.cmp(&right.key))
            });
            objects.truncate(max_objects);
            Ok(objects)
        }

        async fn download_object(
            &self,
            request: DownloadRequest,
            _progress: Option<mpsc::Sender<DownloadProgress>>,
            _cancellation: CancellationToken,
        ) -> Result<DownloadResult, StoreError> {
            Ok(DownloadResult {
                source: request.source,
                destination: PathBuf::from("unused"),
                bytes_transferred: 0,
                etag: None,
            })
        }
    }

    fn object(key: &str, timestamp: i64) -> S3Object {
        S3Object {
            key: key.to_owned(),
            last_modified: Utc.timestamp_opt(timestamp, 0).single().unwrap(),
            size: 1,
            etag: Some(format!("etag-{key}")),
            storage_class: Some("STANDARD".to_owned()),
        }
    }

    fn config() -> WatcherConfig {
        WatcherConfig {
            id: "feed".to_owned(),
            name: "Feed".to_owned(),
            target: S3Uri::parse("s3://bucket/feed/").unwrap(),
            profile: None,
            region: None,
            poll_interval_seconds: 30,
            expected_interval_seconds: Some(10),
            lookback_periods: 1,
            time_zone: None,
            max_history: 2,
        }
    }

    #[tokio::test]
    async fn poll_once_reconciles_changes_and_respects_retention() {
        let store = Arc::new(FakeStore::new(vec![vec![
            object("feed/old", 10),
            object("feed/middle", 20),
            object("feed/new", 30),
        ]]));
        let mut watcher = PollingWatcher::new(config(), store).unwrap();

        let result = watcher.poll_once().await.unwrap();
        assert_eq!(result.listed_object_count, 2);
        assert_eq!(result.snapshot.objects.len(), 2);
        assert_eq!(result.snapshot.objects[0].key, "feed/new");
        assert_eq!(result.update.changes.len(), 2);
        assert_eq!(
            result.snapshot.statistics.health.status,
            FeedHealthStatus::Late
        );
    }

    #[tokio::test]
    async fn run_emits_lifecycle_and_stops_on_cancellation() {
        let store = Arc::new(FakeStore::new(vec![vec![object("feed/a", 10)]]));
        let mut watcher = PollingWatcher::new(config(), store).unwrap();
        let cancellation = CancellationToken::new();
        let (events_tx, mut events_rx) = mpsc::channel(8);
        cancellation.cancel();

        watcher.run(cancellation, events_tx).await.unwrap();
        assert!(matches!(
            events_rx.recv().await,
            Some(WatcherEvent::Started { .. })
        ));
        assert!(matches!(
            events_rx.recv().await,
            Some(WatcherEvent::Stopped { .. })
        ));
    }

    #[test]
    fn constructor_rejects_invalid_configuration() {
        let mut invalid = config();
        invalid.max_history = 0;
        let store = Arc::new(FakeStore::new(vec![]));
        assert!(PollingWatcher::new(invalid, store).is_err());
    }
}

#[cfg(test)]
mod template_tests {
    use super::*;
    use crate::{DownloadProgress, DownloadRequest, DownloadResult, S3Uri};

    /// Lists nothing; these tests only exercise target resolution.
    struct EmptyStore;

    #[async_trait::async_trait]
    impl ObjectStore for EmptyStore {
        async fn list_objects(
            &self,
            _target: &S3Uri,
            _max_objects: usize,
        ) -> Result<Vec<crate::S3Object>, StoreError> {
            Ok(vec![])
        }

        async fn download_object(
            &self,
            _request: DownloadRequest,
            _progress: Option<tokio::sync::mpsc::Sender<DownloadProgress>>,
            _cancellation: CancellationToken,
        ) -> Result<DownloadResult, StoreError> {
            unreachable!("these tests never download")
        }
    }

    fn config(target: &str, lookback: u32) -> WatcherConfig {
        WatcherConfig {
            id: "feed".to_owned(),
            name: "Feed".to_owned(),
            target: target.parse::<S3Uri>().unwrap(),
            profile: None,
            region: None,
            poll_interval_seconds: 30,
            expected_interval_seconds: None,
            max_history: 100,
            lookback_periods: lookback,
            time_zone: None,
        }
    }

    fn watcher(target: &str, lookback: u32) -> PollingWatcher {
        PollingWatcher::new(config(target, lookback), Arc::new(EmptyStore)).unwrap()
    }

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn an_ordinary_target_resolves_to_itself_and_lists_once() {
        let watcher = watcher("s3://bucket/trades/", 3);
        let targets = watcher.resolve_targets(at("2026-08-12T09:00:00Z"));
        assert_eq!(
            targets.len(),
            1,
            "lookback is irrelevant without placeholders"
        );
        assert_eq!(targets[0].prefix, "trades/");
        assert_eq!(targets[0].bucket, "bucket");
    }

    #[test]
    fn a_templated_target_resolves_the_period_and_its_lookback() {
        let watcher = watcher("s3://bucket/trades/{yyyy}{MM}{dd}/", 1);
        let targets = watcher.resolve_targets(at("2026-08-12T00:05:00Z"));
        let prefixes: Vec<&str> = targets.iter().map(|t| t.prefix.as_str()).collect();
        assert_eq!(prefixes, ["trades/20260812/", "trades/20260811/"]);
        // The bucket is never templated.
        assert!(targets.iter().all(|target| target.bucket == "bucket"));
    }

    #[test]
    fn a_malformed_template_is_rejected_when_the_watcher_is_built() {
        let error = match PollingWatcher::new(
            config("s3://bucket/trades/{mm}/", 1),
            Arc::new(EmptyStore),
        ) {
            Err(error) => error,
            Ok(_) => panic!("a malformed template must not build a watcher"),
        };
        // Failing at construction means a typo surfaces immediately rather than
        // as a feed that silently watches a prefix nothing writes to.
        assert!(error.to_string().contains("minutes"), "{error}");
    }
}
