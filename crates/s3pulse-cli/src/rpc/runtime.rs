use std::{collections::HashMap, sync::Arc, time::Duration};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use s3pulse_core::{
    AwsS3Options, AwsS3Store, DownloadRequest, HistorySnapshot, ObjectStore, PollingWatcher, S3Uri,
    WatcherConfig,
};
use serde_json::{json, Map, Value};
use tokio::{
    sync::{mpsc, Mutex, RwLock},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const MAX_CONCURRENT_WATCHERS: usize = 32;
const NOTIFICATION_BATCH_OBJECTS: usize = 250;

use super::{
    protocol::ErrorObject,
    service::{
        DownloadResult, ObjectDownloadParams, ObjectsListResult, ServiceRuntime,
        StatisticsHistoryResult, StatisticsResult, WatchDefinition, WatchStartResult, WatchState,
        WatchStatusResult, WatcherStatus,
    },
    transport::RequestContext,
};

#[async_trait]
pub trait StoreFactory: Send + Sync + 'static {
    async fn create(
        &self,
        profile: Option<String>,
        region: Option<String>,
    ) -> Result<Arc<dyn ObjectStore>, String>;
}

#[derive(Default)]
pub struct AwsStoreFactory;

#[async_trait]
impl StoreFactory for AwsStoreFactory {
    async fn create(
        &self,
        profile: Option<String>,
        region: Option<String>,
    ) -> Result<Arc<dyn ObjectStore>, String> {
        let store = AwsS3Store::new(AwsS3Options { profile, region })
            .await
            .map_err(|error| error.to_string())?;
        Ok(Arc::new(store))
    }
}

#[derive(Debug)]
struct StatusData {
    state: WatchState,
    last_poll_at: Option<DateTime<Utc>>,
    error: Option<String>,
}

struct WatchSession {
    id: String,
    name: String,
    target: S3Uri,
    target_display: String,
    store: Arc<dyn ObjectStore>,
    snapshot: RwLock<Option<HistorySnapshot>>,
    cancellation: CancellationToken,
    status: RwLock<StatusData>,
    task: Mutex<Option<JoinHandle<()>>>,
    context: RequestContext,
}

pub struct CoreRuntime<F = AwsStoreFactory> {
    watchers: RwLock<HashMap<String, Arc<WatchSession>>>,
    factory: Arc<F>,
    default_profile: Option<String>,
    default_region: Option<String>,
}

impl CoreRuntime<AwsStoreFactory> {
    pub fn new(default_profile: Option<String>, default_region: Option<String>) -> Self {
        Self::with_factory(Arc::new(AwsStoreFactory), default_profile, default_region)
    }
}

impl<F> CoreRuntime<F>
where
    F: StoreFactory,
{
    pub fn with_factory(
        factory: Arc<F>,
        default_profile: Option<String>,
        default_region: Option<String>,
    ) -> Self {
        Self {
            watchers: RwLock::new(HashMap::new()),
            factory,
            default_profile,
            default_region,
        }
    }

    async fn session(&self, watcher_id: &str) -> Result<Arc<WatchSession>, ErrorObject> {
        self.watchers
            .read()
            .await
            .get(watcher_id)
            .cloned()
            .ok_or_else(|| {
                ErrorObject::new(
                    ErrorObject::WATCHER_NOT_FOUND,
                    format!("Watcher not found: {watcher_id}"),
                )
            })
    }
}

#[async_trait]
impl<F> ServiceRuntime for CoreRuntime<F>
where
    F: StoreFactory,
{
    async fn watch_start(
        &self,
        definition: WatchDefinition,
        context: RequestContext,
    ) -> Result<WatchStartResult, ErrorObject> {
        if context.cancellation.is_cancelled() {
            return Err(ErrorObject::cancelled());
        }
        let watcher_id = definition
            .id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let watchers = self.watchers.read().await;
        if watchers.contains_key(&watcher_id) {
            return Err(ErrorObject::new(
                ErrorObject::WATCHER_ALREADY_EXISTS,
                format!("Watcher already exists: {watcher_id}"),
            ));
        }
        if watchers.len() >= MAX_CONCURRENT_WATCHERS {
            return Err(ErrorObject::new(
                ErrorObject::RESOURCE_LIMIT,
                format!("Watcher limit reached ({MAX_CONCURRENT_WATCHERS})"),
            ));
        }
        drop(watchers);

        let target: S3Uri = definition
            .target
            .parse()
            .map_err(ErrorObject::invalid_params)?;
        let name = definition
            .name
            .clone()
            .unwrap_or_else(|| target.to_string());
        let profile = definition
            .profile
            .clone()
            .or_else(|| self.default_profile.clone());
        let region = definition
            .region
            .clone()
            .or_else(|| self.default_region.clone());
        let store = self
            .factory
            .create(profile.clone(), region.clone())
            .await
            .map_err(ErrorObject::backend)?;
        if context.cancellation.is_cancelled() {
            return Err(ErrorObject::cancelled());
        }
        let config = WatcherConfig {
            id: watcher_id.clone(),
            name: name.clone(),
            target: target.clone(),
            profile,
            region,
            poll_interval_seconds: definition.poll_interval_seconds,
            expected_interval_seconds: definition.expected_interval_seconds,
            max_history: definition.history_limit,
            lookback_periods: definition.lookback_periods,
            time_zone: definition.time_zone.clone(),
        };
        let mut watcher =
            PollingWatcher::new(config, Arc::clone(&store)).map_err(ErrorObject::invalid_params)?;
        let cancellation = CancellationToken::new();
        let session = Arc::new(WatchSession {
            id: watcher_id.clone(),
            name,
            target_display: target.to_string(),
            target,
            store,
            snapshot: RwLock::new(None),
            cancellation: cancellation.clone(),
            status: RwLock::new(StatusData {
                state: WatchState::Running,
                last_poll_at: None,
                error: None,
            }),
            task: Mutex::new(None),
            context: context.clone(),
        });

        {
            let mut watchers = self.watchers.write().await;
            if watchers.contains_key(&watcher_id) {
                return Err(ErrorObject::new(
                    ErrorObject::WATCHER_ALREADY_EXISTS,
                    format!("Watcher already exists: {watcher_id}"),
                ));
            }
            if watchers.len() >= MAX_CONCURRENT_WATCHERS {
                return Err(ErrorObject::new(
                    ErrorObject::RESOURCE_LIMIT,
                    format!("Watcher limit reached ({MAX_CONCURRENT_WATCHERS})"),
                ));
            }
            watchers.insert(watcher_id.clone(), Arc::clone(&session));
        }

        let task_session = Arc::clone(&session);
        let task = tokio::spawn(async move {
            run_watcher(&mut watcher, task_session, definition.poll_interval_seconds).await;
        });
        *session.task.lock().await = Some(task);
        if context.cancellation.is_cancelled() {
            session.cancellation.cancel();
            if let Some(task) = session.task.lock().await.take() {
                let _ = task.await;
            }
            let mut watchers = self.watchers.write().await;
            if watchers
                .get(&watcher_id)
                .is_some_and(|current| Arc::ptr_eq(current, &session))
            {
                watchers.remove(&watcher_id);
            }
            return Err(ErrorObject::cancelled());
        }
        let _ = context
            .notify(
                "watch.statusChanged",
                json!({ "watcherId": watcher_id, "status": "running" }),
            )
            .await;

        Ok(WatchStartResult {
            watcher_id,
            status: WatchState::Running,
        })
    }

    async fn watch_stop(&self, watcher_id: String) -> Result<WatchStartResult, ErrorObject> {
        let session = self.session(&watcher_id).await?;
        session.cancellation.cancel();
        let task = session.task.lock().await.take();
        if let Some(task) = task {
            if let Err(error) = task.await {
                tracing::debug!(%error, %watcher_id, "watcher task failed while stopping");
            }
        }
        {
            let mut status = session.status.write().await;
            status.state = WatchState::Stopped;
        }
        let _ = session
            .context
            .notify(
                "watch.statusChanged",
                json!({ "watcherId": watcher_id, "status": "stopped" }),
            )
            .await;
        let mut watchers = self.watchers.write().await;
        if watchers
            .get(&watcher_id)
            .is_some_and(|current| Arc::ptr_eq(current, &session))
        {
            watchers.remove(&watcher_id);
        }
        Ok(WatchStartResult {
            watcher_id,
            status: WatchState::Stopped,
        })
    }

    async fn watch_status(
        &self,
        watcher_id: Option<String>,
    ) -> Result<WatchStatusResult, ErrorObject> {
        let sessions = if let Some(watcher_id) = watcher_id {
            vec![self.session(&watcher_id).await?]
        } else {
            self.watchers.read().await.values().cloned().collect()
        };
        let mut watchers = Vec::with_capacity(sessions.len());
        for session in sessions {
            let status = session.status.read().await;
            let (object_count, health) =
                session
                    .snapshot
                    .read()
                    .await
                    .as_ref()
                    .map_or((0, None), |snapshot| {
                        (
                            snapshot.objects.len(),
                            Some(snapshot.statistics.health.clone()),
                        )
                    });
            watchers.push(WatcherStatus {
                watcher_id: session.id.clone(),
                name: session.name.clone(),
                target: session.target_display.clone(),
                status: status.state,
                object_count,
                request_counts: session.store.request_counts(),
                health,
                last_poll_at: status.last_poll_at.map(|value| value.to_rfc3339()),
                error: status.error.clone(),
            });
        }
        watchers.sort_by(|left, right| left.watcher_id.cmp(&right.watcher_id));
        Ok(WatchStatusResult { watchers })
    }

    async fn objects_list(
        &self,
        watcher_id: String,
        limit: Option<usize>,
    ) -> Result<ObjectsListResult, ErrorObject> {
        let session = self.session(&watcher_id).await?;
        let mut objects = session
            .snapshot
            .read()
            .await
            .as_ref()
            .map(|snapshot| snapshot.objects.clone())
            .unwrap_or_default();
        objects.sort_by(|left, right| {
            right
                .last_modified
                .cmp(&left.last_modified)
                .then_with(|| left.key.cmp(&right.key))
        });
        objects.truncate(limit.unwrap_or(objects.len()));
        let objects = objects
            .into_iter()
            .map(|object| serde_json::to_value(object).map_err(ErrorObject::internal))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ObjectsListResult {
            watcher_id,
            objects,
        })
    }

    async fn statistics_frequency(
        &self,
        watcher_id: String,
    ) -> Result<StatisticsResult, ErrorObject> {
        let session = self.session(&watcher_id).await?;
        let statistics = session
            .snapshot
            .read()
            .await
            .as_ref()
            .map(|snapshot| serde_json::to_value(&snapshot.statistics))
            .transpose()
            .map_err(ErrorObject::internal)?
            .unwrap_or_else(|| json!({}));
        Ok(StatisticsResult {
            watcher_id,
            statistics,
            request_counts: session.store.request_counts(),
        })
    }

    async fn statistics_history(
        &self,
        watcher_id: String,
        limit: Option<usize>,
    ) -> Result<StatisticsHistoryResult, ErrorObject> {
        let session = self.session(&watcher_id).await?;
        let mut objects = session
            .snapshot
            .read()
            .await
            .as_ref()
            .map(|snapshot| snapshot.objects.clone())
            .unwrap_or_default();
        objects.sort_by(|left, right| {
            left.last_modified
                .cmp(&right.last_modified)
                .then_with(|| left.key.cmp(&right.key))
        });
        if let Some(limit) = limit {
            let remove = objects.len().saturating_sub(limit);
            objects.drain(..remove);
        }
        let mut previous = None;
        let samples = objects
            .into_iter()
            .map(|object| {
                let interval_seconds = previous.map(|last_modified: DateTime<Utc>| {
                    (object.last_modified - last_modified).num_milliseconds() as f64 / 1_000.0
                });
                previous = Some(object.last_modified);
                json!({
                    "key": object.key,
                    "lastModified": object.last_modified,
                    "intervalSeconds": interval_seconds
                })
            })
            .collect();
        Ok(StatisticsHistoryResult {
            watcher_id,
            samples,
        })
    }

    async fn object_download(
        &self,
        params: ObjectDownloadParams,
        context: RequestContext,
    ) -> Result<DownloadResult, ErrorObject> {
        let session = self.session(&params.watcher_id).await?;
        if !session.target.prefix.is_empty() && !params.key.starts_with(&session.target.prefix) {
            return Err(ErrorObject::invalid_params(
                "key is outside the watcher's prefix",
            ));
        }
        let source = session
            .target
            .for_object(params.key.clone())
            .map_err(ErrorObject::invalid_params)?;
        let download_id = params
            .download_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let request = DownloadRequest {
            source,
            destination: params.destination.clone(),
            overwrite: params.overwrite,
        };
        let (progress_tx, mut progress_rx) = mpsc::channel(32);
        let download =
            session
                .store
                .download_object(request, Some(progress_tx), context.cancellation.clone());
        tokio::pin!(download);
        let mut progress_open = true;
        let result = loop {
            tokio::select! {
                result = &mut download => break result,
                progress = progress_rx.recv(), if progress_open => {
                    match progress {
                        Some(progress) => {
                            let notification = augment_progress(
                                progress,
                                &params.watcher_id,
                                &download_id,
                                &params.key,
                                false,
                            );
                            let _ = context.notify("download.progress", notification).await;
                        }
                        None => progress_open = false,
                    }
                }
            }
        };
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                let error_data = serde_json::to_value(&error)
                    .unwrap_or_else(|_| json!({ "message": error.to_string() }));
                let _ = context
                    .notify(
                        "download.progress",
                        json!({
                            "watcherId": params.watcher_id,
                            "downloadId": download_id,
                            "key": params.key,
                            "done": true,
                            "error": error_data
                        }),
                    )
                    .await;
                return Err(ErrorObject::store(&error));
            }
        };
        let bytes = result.bytes_transferred;
        let _ = context
            .notify(
                "download.progress",
                json!({
                    "watcherId": params.watcher_id,
                    "downloadId": download_id,
                    "key": params.key,
                    "bytesTransferred": bytes,
                    "done": true
                }),
            )
            .await;
        Ok(DownloadResult {
            watcher_id: params.watcher_id,
            download_id,
            destination: params.destination,
            bytes,
        })
    }
}

async fn run_watcher(
    watcher: &mut PollingWatcher,
    session: Arc<WatchSession>,
    poll_interval_seconds: u64,
) {
    loop {
        let poll_result = tokio::select! {
            _ = session.cancellation.cancelled() => break,
            result = watcher.poll_once() => result,
        };
        match poll_result {
            Ok(result) => {
                let polled_at = result.polled_at;
                let changes = result.update.changes;
                let statistics = result.snapshot.statistics.clone();
                *session.snapshot.write().await = Some(result.snapshot);
                let recovered = {
                    let mut status = session.status.write().await;
                    let recovered = status.state == WatchState::Error;
                    status.state = WatchState::Running;
                    status.last_poll_at = Some(polled_at);
                    status.error = None;
                    recovered
                };
                if recovered {
                    let _ = session
                        .context
                        .notify(
                            "watch.statusChanged",
                            json!({ "watcherId": session.id, "status": "running" }),
                        )
                        .await;
                }
                for batch in changes.chunks(NOTIFICATION_BATCH_OBJECTS) {
                    let objects = batch
                        .iter()
                        .map(|change| change.object.clone())
                        .collect::<Vec<_>>();
                    let _ = session
                        .context
                        .notify(
                            "objects.added",
                            json!({
                                "watcherId": session.id,
                                "objects": objects,
                                "changes": batch
                            }),
                        )
                        .await;
                }
                let _ = session
                    .context
                    .notify(
                        "statistics.updated",
                        json!({
                            "watcherId": session.id,
                            "statistics": statistics,
                            "requestCounts": session.store.request_counts()
                        }),
                    )
                    .await;
            }
            Err(error) => {
                let message = error.to_string();
                let error_data =
                    serde_json::to_value(&error).unwrap_or_else(|_| json!({ "message": message }));
                {
                    let mut status = session.status.write().await;
                    status.state = WatchState::Error;
                    status.error = Some(message.clone());
                }
                let _ = session
                    .context
                    .notify(
                        "watch.error",
                        json!({
                            "watcherId": session.id,
                            "error": error_data
                        }),
                    )
                    .await;
                let _ = session
                    .context
                    .notify(
                        "watch.statusChanged",
                        json!({ "watcherId": session.id, "status": "error" }),
                    )
                    .await;
            }
        }

        tokio::select! {
            _ = session.cancellation.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_secs(poll_interval_seconds)) => {}
        }
    }

    {
        let mut status = session.status.write().await;
        status.state = WatchState::Stopped;
    }
}

fn augment_progress<T: serde::Serialize>(
    progress: T,
    watcher_id: &str,
    download_id: &str,
    key: &str,
    done: bool,
) -> Value {
    let mut fields = match serde_json::to_value(progress) {
        Ok(Value::Object(fields)) => fields,
        Ok(value) => {
            let mut fields = Map::new();
            fields.insert("progress".to_owned(), value);
            fields
        }
        Err(error) => {
            let mut fields = Map::new();
            fields.insert("error".to_owned(), Value::String(error.to_string()));
            fields
        }
    };
    fields.insert("watcherId".to_owned(), Value::String(watcher_id.to_owned()));
    fields.insert(
        "downloadId".to_owned(),
        Value::String(download_id.to_owned()),
    );
    fields.insert("key".to_owned(), Value::String(key.to_owned()));
    fields.insert("done".to_owned(), Value::Bool(done));
    Value::Object(fields)
}

#[cfg(test)]
mod tests {
    use std::{path::PathBuf, sync::Mutex as StdMutex};

    use chrono::TimeZone;
    use s3pulse_core::{
        DownloadProgress, DownloadResult as CoreDownloadResult, RequestCounts, S3Object, StoreError,
    };

    use super::*;
    use crate::rpc::transport::NotificationSink;

    #[derive(Default)]
    struct CapturingNotifier {
        messages: StdMutex<Vec<(String, Value)>>,
    }

    #[async_trait]
    impl NotificationSink for CapturingNotifier {
        async fn notify_value(&self, method: &str, params: Value) -> std::io::Result<()> {
            self.messages
                .lock()
                .unwrap()
                .push((method.to_owned(), params));
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeStore;

    #[async_trait]
    impl ObjectStore for FakeStore {
        async fn list_objects(
            &self,
            _target: &S3Uri,
            max_objects: usize,
        ) -> Result<Vec<S3Object>, StoreError> {
            let mut objects = vec![S3Object {
                key: "feed/object.parquet".to_owned(),
                last_modified: Utc.timestamp_opt(1_700_000_000, 0).single().unwrap(),
                size: 42,
                etag: Some("etag".to_owned()),
                storage_class: Some("STANDARD".to_owned()),
            }];
            objects.truncate(max_objects);
            Ok(objects)
        }

        async fn download_object(
            &self,
            request: DownloadRequest,
            progress: Option<mpsc::Sender<DownloadProgress>>,
            cancellation: CancellationToken,
        ) -> Result<CoreDownloadResult, StoreError> {
            if cancellation.is_cancelled() {
                return Err(StoreError::cancelled());
            }
            if let Some(progress) = progress {
                let _ = progress
                    .send(DownloadProgress::new(42, Some(42), true))
                    .await;
            }
            Ok(CoreDownloadResult {
                source: request.source,
                destination: request.destination,
                bytes_transferred: 42,
                etag: Some("etag".to_owned()),
            })
        }

        // A fixed, recognisable pair so a test can prove these specific numbers
        // travel from the store all the way onto the wire.
        fn request_counts(&self) -> RequestCounts {
            RequestCounts {
                list_requests: 11,
                get_requests: 3,
            }
        }
    }

    struct FakeFactory;

    #[async_trait]
    impl StoreFactory for FakeFactory {
        async fn create(
            &self,
            _profile: Option<String>,
            _region: Option<String>,
        ) -> Result<Arc<dyn ObjectStore>, String> {
            Ok(Arc::new(FakeStore))
        }
    }

    fn definition() -> WatchDefinition {
        WatchDefinition {
            id: Some("feed".to_owned()),
            name: Some("Feed".to_owned()),
            target: "s3://bucket/feed/".to_owned(),
            profile: None,
            region: None,
            poll_interval_seconds: 3_600,
            lookback_periods: 1,
            time_zone: None,
            expected_interval_seconds: None,
            history_limit: 10,
        }
    }

    fn context(notifier: Arc<CapturingNotifier>) -> RequestContext {
        RequestContext::new(CancellationToken::new(), notifier)
    }

    async fn wait_for_initial_poll(runtime: &CoreRuntime<FakeFactory>) {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let result = runtime.watch_status(Some("feed".to_owned())).await.unwrap();
                if result.watchers[0].object_count == 1 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[test]
    fn progress_is_augmented_with_correlation_fields() {
        let value = augment_progress(
            json!({ "bytesTransferred": 3 }),
            "watcher",
            "download",
            "feed/object",
            false,
        );
        assert_eq!(value["watcherId"], "watcher");
        assert_eq!(value["downloadId"], "download");
        assert_eq!(value["done"], false);
    }

    #[tokio::test]
    async fn watcher_seeds_history_emits_objects_and_can_restart_with_same_id() {
        let runtime = CoreRuntime::with_factory(Arc::new(FakeFactory), None, None);
        let notifier = Arc::new(CapturingNotifier::default());

        runtime
            .watch_start(definition(), context(Arc::clone(&notifier)))
            .await
            .unwrap();
        wait_for_initial_poll(&runtime).await;
        let objects = runtime.objects_list("feed".to_owned(), None).await.unwrap();
        assert_eq!(objects.objects.len(), 1);
        assert!(notifier
            .messages
            .lock()
            .unwrap()
            .iter()
            .any(|(method, params)| method == "objects.added"
                && params["objects"]
                    .as_array()
                    .is_some_and(|objects| objects.len() == 1)));

        runtime.watch_stop("feed".to_owned()).await.unwrap();
        runtime
            .watch_start(definition(), context(Arc::clone(&notifier)))
            .await
            .unwrap();
        runtime.watch_stop("feed".to_owned()).await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_watch_start_does_not_register_a_watcher() {
        let runtime = CoreRuntime::with_factory(Arc::new(FakeFactory), None, None);
        let notifier = Arc::new(CapturingNotifier::default());
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let error = runtime
            .watch_start(definition(), RequestContext::new(cancellation, notifier))
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorObject::REQUEST_CANCELLED);
        assert!(runtime
            .watch_status(None)
            .await
            .unwrap()
            .watchers
            .is_empty());
    }

    #[tokio::test]
    async fn request_counts_reach_status_and_statistics_as_camel_case() {
        let runtime = CoreRuntime::with_factory(Arc::new(FakeFactory), None, None);
        let notifier = Arc::new(CapturingNotifier::default());
        runtime
            .watch_start(definition(), context(Arc::clone(&notifier)))
            .await
            .unwrap();

        let status = runtime.watch_status(None).await.unwrap();
        assert_eq!(status.watchers[0].request_counts.list_requests, 11);
        assert_eq!(status.watchers[0].request_counts.get_requests, 3);

        let statistics = runtime
            .statistics_frequency("feed".to_owned())
            .await
            .unwrap();
        assert_eq!(statistics.request_counts.list_requests, 11);

        // Clients read these over JSON, so the field spelling is part of the
        // contract, not an implementation detail.
        let encoded = serde_json::to_value(&status).unwrap();
        assert_eq!(encoded["watchers"][0]["requestCounts"]["listRequests"], 11);
        assert_eq!(encoded["watchers"][0]["requestCounts"]["getRequests"], 3);
    }

    #[tokio::test]
    async fn download_relays_progress_and_returns_authoritative_bytes() {
        let runtime = CoreRuntime::with_factory(Arc::new(FakeFactory), None, None);
        let notifier = Arc::new(CapturingNotifier::default());
        runtime
            .watch_start(definition(), context(Arc::clone(&notifier)))
            .await
            .unwrap();

        let result = runtime
            .object_download(
                ObjectDownloadParams {
                    watcher_id: "feed".to_owned(),
                    download_id: Some("client-download".to_owned()),
                    key: "feed/object.parquet".to_owned(),
                    destination: PathBuf::from("object.parquet"),
                    overwrite: false,
                },
                context(Arc::clone(&notifier)),
            )
            .await
            .unwrap();
        assert_eq!(result.bytes, 42);
        assert_eq!(result.download_id, "client-download");
        assert!(notifier
            .messages
            .lock()
            .unwrap()
            .iter()
            .any(|(method, params)| method == "download.progress"
                && params["bytesTransferred"] == 42));

        runtime.watch_stop("feed".to_owned()).await.unwrap();
    }
}
