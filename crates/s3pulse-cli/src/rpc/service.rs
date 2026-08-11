use std::{path::PathBuf, sync::Arc};

use async_trait::async_trait;
use s3pulse_core::RequestCounts;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};

use super::{protocol::ErrorObject, transport::RequestContext, RpcHandler};

pub const PROTOCOL_VERSION: u32 = 1;
pub const DEFAULT_POLL_INTERVAL_SECONDS: u64 = 30;
pub const DEFAULT_HISTORY_LIMIT: usize = 10_000;
pub const MAX_HISTORY_LIMIT: usize = 10_000;
pub const MAX_RESPONSE_OBJECTS: usize = 1_000;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStartParams {
    pub watcher: WatchDefinition,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchDefinition {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    pub target: String,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default = "default_poll_interval")]
    pub poll_interval_seconds: u64,
    #[serde(default)]
    pub expected_interval_seconds: Option<u64>,
    #[serde(default = "default_history_limit")]
    pub history_limit: usize,
}

fn default_poll_interval() -> u64 {
    DEFAULT_POLL_INTERVAL_SECONDS
}

fn default_history_limit() -> usize {
    DEFAULT_HISTORY_LIMIT
}

impl WatchDefinition {
    fn validate(&self) -> Result<(), ErrorObject> {
        if self.target.trim().is_empty() {
            return Err(ErrorObject::invalid_params(
                "watcher.target cannot be empty",
            ));
        }
        if self.poll_interval_seconds == 0 {
            return Err(ErrorObject::invalid_params(
                "watcher.pollIntervalSeconds must be greater than zero",
            ));
        }
        if self.history_limit == 0 {
            return Err(ErrorObject::invalid_params(
                "watcher.historyLimit must be greater than zero",
            ));
        }
        if self.history_limit > MAX_HISTORY_LIMIT {
            return Err(ErrorObject::invalid_params(format!(
                "watcher.historyLimit cannot exceed {MAX_HISTORY_LIMIT}"
            )));
        }
        if self.id.as_ref().is_some_and(|id| id.trim().is_empty()) {
            return Err(ErrorObject::invalid_params("watcher.id cannot be empty"));
        }
        if self
            .expected_interval_seconds
            .is_some_and(|seconds| seconds == 0)
        {
            return Err(ErrorObject::invalid_params(
                "watcher.expectedIntervalSeconds must be greater than zero",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherIdParams {
    pub watcher_id: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatusParams {
    #[serde(default)]
    pub watcher_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectsListParams {
    pub watcher_id: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticsHistoryParams {
    pub watcher_id: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDownloadParams {
    pub watcher_id: String,
    #[serde(default)]
    pub download_id: Option<String>,
    pub key: String,
    pub destination: PathBuf,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStartResult {
    pub watcher_id: String,
    pub status: WatchState,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WatchState {
    Starting,
    Running,
    Stopping,
    Stopped,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherStatus {
    pub watcher_id: String,
    pub name: String,
    pub target: String,
    pub status: WatchState,
    pub object_count: usize,
    pub request_counts: RequestCounts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_poll_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatusResult {
    pub watchers: Vec<WatcherStatus>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectsListResult {
    pub watcher_id: String,
    pub objects: Vec<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticsResult {
    pub watcher_id: String,
    pub statistics: Value,
    pub request_counts: RequestCounts,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatisticsHistoryResult {
    pub watcher_id: String,
    pub samples: Vec<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub watcher_id: String,
    pub download_id: String,
    pub destination: PathBuf,
    pub bytes: u64,
}

#[async_trait]
pub trait ServiceRuntime: Send + Sync + 'static {
    async fn watch_start(
        &self,
        definition: WatchDefinition,
        context: RequestContext,
    ) -> Result<WatchStartResult, ErrorObject>;

    async fn watch_stop(&self, watcher_id: String) -> Result<WatchStartResult, ErrorObject>;

    async fn watch_status(
        &self,
        watcher_id: Option<String>,
    ) -> Result<WatchStatusResult, ErrorObject>;

    async fn objects_list(
        &self,
        watcher_id: String,
        limit: Option<usize>,
    ) -> Result<ObjectsListResult, ErrorObject>;

    async fn statistics_frequency(
        &self,
        watcher_id: String,
    ) -> Result<StatisticsResult, ErrorObject>;

    async fn statistics_history(
        &self,
        watcher_id: String,
        limit: Option<usize>,
    ) -> Result<StatisticsHistoryResult, ErrorObject>;

    async fn object_download(
        &self,
        params: ObjectDownloadParams,
        context: RequestContext,
    ) -> Result<DownloadResult, ErrorObject>;
}

pub struct S3PulseRpc<R> {
    runtime: Arc<R>,
}

impl<R> S3PulseRpc<R> {
    pub fn new(runtime: Arc<R>) -> Self {
        Self { runtime }
    }
}

#[async_trait]
impl<R> RpcHandler for S3PulseRpc<R>
where
    R: ServiceRuntime,
{
    async fn handle(
        &self,
        method: &str,
        params: Value,
        context: RequestContext,
    ) -> Result<Value, ErrorObject> {
        match method {
            "system.version" => Ok(json!({
                "name": "s3pulse",
                "version": env!("CARGO_PKG_VERSION"),
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {
                    "methods": [
                        "system.version",
                        "watch.start",
                        "watch.stop",
                        "watch.status",
                        "objects.list",
                        "statistics.frequency",
                        "statistics.history",
                        "object.download"
                    ],
                    "notifications": [
                        "objects.added",
                        "watch.statusChanged",
                        "statistics.updated",
                        "download.progress",
                        "watch.error"
                    ],
                    "cancellation": true
                }
            })),
            "watch.start" => {
                let params: WatchStartParams = parse_params(params)?;
                params.watcher.validate()?;
                to_value(self.runtime.watch_start(params.watcher, context).await?)
            }
            "watch.stop" => {
                let params: WatcherIdParams = parse_params(params)?;
                validate_watcher_id(&params.watcher_id)?;
                to_value(self.runtime.watch_stop(params.watcher_id).await?)
            }
            "watch.status" => {
                let params: WatchStatusParams = parse_params_or_default(params)?;
                if let Some(watcher_id) = &params.watcher_id {
                    validate_watcher_id(watcher_id)?;
                }
                to_value(self.runtime.watch_status(params.watcher_id).await?)
            }
            "objects.list" => {
                let params: ObjectsListParams = parse_params(params)?;
                validate_watcher_id(&params.watcher_id)?;
                let limit = params.limit.unwrap_or(MAX_RESPONSE_OBJECTS);
                validate_limit(limit)?;
                to_value(
                    self.runtime
                        .objects_list(params.watcher_id, Some(limit))
                        .await?,
                )
            }
            "statistics.frequency" => {
                let params: WatcherIdParams = parse_params(params)?;
                validate_watcher_id(&params.watcher_id)?;
                to_value(self.runtime.statistics_frequency(params.watcher_id).await?)
            }
            "statistics.history" => {
                let params: StatisticsHistoryParams = parse_params(params)?;
                validate_watcher_id(&params.watcher_id)?;
                let limit = params.limit.unwrap_or(MAX_RESPONSE_OBJECTS);
                validate_limit(limit)?;
                to_value(
                    self.runtime
                        .statistics_history(params.watcher_id, Some(limit))
                        .await?,
                )
            }
            "object.download" => {
                let params: ObjectDownloadParams = parse_params(params)?;
                validate_watcher_id(&params.watcher_id)?;
                if params.key.trim().is_empty() {
                    return Err(ErrorObject::invalid_params("key cannot be empty"));
                }
                if params
                    .download_id
                    .as_ref()
                    .is_some_and(|download_id| download_id.trim().is_empty())
                {
                    return Err(ErrorObject::invalid_params("downloadId cannot be empty"));
                }
                if params.destination.as_os_str().is_empty() {
                    return Err(ErrorObject::invalid_params("destination cannot be empty"));
                }
                to_value(self.runtime.object_download(params, context).await?)
            }
            _ => Err(ErrorObject::method_not_found(method)),
        }
    }
}

fn parse_params<T: DeserializeOwned>(params: Value) -> Result<T, ErrorObject> {
    serde_json::from_value(params).map_err(ErrorObject::invalid_params)
}

fn parse_params_or_default<T>(params: Value) -> Result<T, ErrorObject>
where
    T: DeserializeOwned + Default,
{
    if params.is_null() {
        Ok(T::default())
    } else {
        parse_params(params)
    }
}

fn to_value<T: Serialize>(value: T) -> Result<Value, ErrorObject> {
    serde_json::to_value(value).map_err(ErrorObject::internal)
}

fn validate_watcher_id(watcher_id: &str) -> Result<(), ErrorObject> {
    if watcher_id.trim().is_empty() {
        Err(ErrorObject::invalid_params("watcherId cannot be empty"))
    } else {
        Ok(())
    }
}

fn validate_limit(limit: usize) -> Result<(), ErrorObject> {
    if limit == 0 {
        return Err(ErrorObject::invalid_params(
            "limit must be greater than zero",
        ));
    }
    if limit > MAX_RESPONSE_OBJECTS {
        return Err(ErrorObject::invalid_params(format!(
            "limit cannot exceed {MAX_RESPONSE_OBJECTS}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::rpc::transport::NotificationSink;

    struct NullNotifier;

    #[async_trait]
    impl NotificationSink for NullNotifier {
        async fn notify_value(&self, _method: &str, _params: Value) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct StubRuntime;

    #[async_trait]
    impl ServiceRuntime for StubRuntime {
        async fn watch_start(
            &self,
            definition: WatchDefinition,
            _context: RequestContext,
        ) -> Result<WatchStartResult, ErrorObject> {
            Ok(WatchStartResult {
                watcher_id: definition.id.unwrap_or_else(|| "generated".to_owned()),
                status: WatchState::Running,
            })
        }

        async fn watch_stop(&self, watcher_id: String) -> Result<WatchStartResult, ErrorObject> {
            Ok(WatchStartResult {
                watcher_id,
                status: WatchState::Stopped,
            })
        }

        async fn watch_status(
            &self,
            _watcher_id: Option<String>,
        ) -> Result<WatchStatusResult, ErrorObject> {
            Ok(WatchStatusResult { watchers: vec![] })
        }

        async fn objects_list(
            &self,
            watcher_id: String,
            _limit: Option<usize>,
        ) -> Result<ObjectsListResult, ErrorObject> {
            Ok(ObjectsListResult {
                watcher_id,
                objects: vec![],
            })
        }

        async fn statistics_frequency(
            &self,
            watcher_id: String,
        ) -> Result<StatisticsResult, ErrorObject> {
            Ok(StatisticsResult {
                watcher_id,
                statistics: json!({}),
                request_counts: RequestCounts::default(),
            })
        }

        async fn statistics_history(
            &self,
            watcher_id: String,
            _limit: Option<usize>,
        ) -> Result<StatisticsHistoryResult, ErrorObject> {
            Ok(StatisticsHistoryResult {
                watcher_id,
                samples: vec![],
            })
        }

        async fn object_download(
            &self,
            params: ObjectDownloadParams,
            _context: RequestContext,
        ) -> Result<DownloadResult, ErrorObject> {
            Ok(DownloadResult {
                watcher_id: params.watcher_id,
                download_id: "download".to_owned(),
                destination: params.destination,
                bytes: 0,
            })
        }
    }

    fn context() -> RequestContext {
        RequestContext::new(CancellationToken::new(), Arc::new(NullNotifier))
    }

    #[tokio::test]
    async fn system_version_advertises_protocol_capabilities() {
        let rpc = S3PulseRpc::new(Arc::new(StubRuntime));
        let result = rpc
            .handle("system.version", Value::Null, context())
            .await
            .unwrap();

        assert_eq!(result["name"], "s3pulse");
        assert_eq!(result["protocolVersion"], PROTOCOL_VERSION);
        assert!(result["capabilities"]["cancellation"].as_bool().unwrap());
    }

    #[tokio::test]
    async fn watch_start_applies_defaults() {
        let rpc = S3PulseRpc::new(Arc::new(StubRuntime));
        let result = rpc
            .handle(
                "watch.start",
                json!({ "watcher": { "target": "s3://bucket/feed/" } }),
                context(),
            )
            .await
            .unwrap();

        assert_eq!(result["watcherId"], "generated");
        assert_eq!(result["status"], "running");
    }

    #[tokio::test]
    async fn rejects_zero_poll_interval_before_runtime_call() {
        let rpc = S3PulseRpc::new(Arc::new(StubRuntime));
        let error = rpc
            .handle(
                "watch.start",
                json!({
                    "watcher": {
                        "target": "s3://bucket/feed/",
                        "pollIntervalSeconds": 0
                    }
                }),
                context(),
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, ErrorObject::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn bounds_object_response_lines_with_a_hard_item_limit() {
        let rpc = S3PulseRpc::new(Arc::new(StubRuntime));
        let error = rpc
            .handle(
                "objects.list",
                json!({
                    "watcherId": "feed",
                    "limit": MAX_RESPONSE_OBJECTS + 1
                }),
                context(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorObject::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn unknown_method_returns_standard_error() {
        let rpc = S3PulseRpc::new(Arc::new(StubRuntime));
        let error = rpc
            .handle("missing.method", Value::Null, context())
            .await
            .unwrap_err();

        assert_eq!(error.code, ErrorObject::METHOD_NOT_FOUND);
    }
}
