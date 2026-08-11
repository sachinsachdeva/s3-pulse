use std::{
    cmp::Reverse,
    collections::BTreeMap,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use aws_config::BehaviorVersion;
use aws_sdk_s3::{config::Region, error::ProvideErrorMetadata, Client};
use chrono::{TimeZone, Utc};
use tokio::{
    fs::{self, OpenOptions},
    io::{AsyncReadExt, AsyncWriteExt},
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    AwsS3Options, DownloadProgress, DownloadRequest, DownloadResult, RequestCounts, S3Object,
    S3Uri, StoreError, StoreErrorKind,
};

const DOWNLOAD_BUFFER_BYTES: usize = 128 * 1024;
type RankedObjects = BTreeMap<(chrono::DateTime<Utc>, Reverse<String>), S3Object>;

/// Read-only object-store operations needed by the watcher and frontends.
///
/// Keeping this interface independent of AWS SDK response types makes cadence
/// and protocol behavior testable without credentials or a live bucket.
#[async_trait]
pub trait ObjectStore: Send + Sync {
    /// Lists the newest `max_objects` under the target prefix while keeping
    /// transient listing memory bounded in proportion to that limit.
    async fn list_objects(
        &self,
        target: &S3Uri,
        max_objects: usize,
    ) -> Result<Vec<S3Object>, StoreError>;

    async fn download_object(
        &self,
        request: DownloadRequest,
        progress: Option<mpsc::Sender<DownloadProgress>>,
        cancellation: CancellationToken,
    ) -> Result<DownloadResult, StoreError>;

    /// Billable requests this store has issued so far. Implementations that do
    /// not talk to a metered service can leave this at zero.
    fn request_counts(&self) -> RequestCounts {
        RequestCounts::default()
    }
}

#[derive(Clone, Debug, Default)]
struct RequestMeter {
    list_requests: Arc<AtomicU64>,
    get_requests: Arc<AtomicU64>,
}

impl RequestMeter {
    fn counts(&self) -> RequestCounts {
        RequestCounts {
            list_requests: self.list_requests.load(Ordering::Relaxed),
            get_requests: self.get_requests.load(Ordering::Relaxed),
        }
    }
}

#[derive(Clone)]
pub struct AwsS3Store {
    client: Client,
    meter: RequestMeter,
}

impl AwsS3Store {
    pub async fn new(options: AwsS3Options) -> Result<Self, StoreError> {
        let mut loader = aws_config::defaults(BehaviorVersion::latest());
        if let Some(profile) = options.profile {
            loader = loader.profile_name(profile);
        }
        if let Some(region) = options.region {
            loader = loader.region(Region::new(region));
        }

        // Credential resolution is intentionally lazy in the AWS SDK. Errors
        // such as an expired SSO session are categorized when LIST/GET runs.
        let sdk_config = loader.load().await;
        Ok(Self {
            client: Client::new(&sdk_config),
            meter: RequestMeter::default(),
        })
    }

    pub fn from_client(client: Client) -> Self {
        Self {
            client,
            meter: RequestMeter::default(),
        }
    }

    async fn stream_download(
        &self,
        request: &DownloadRequest,
        temporary_path: &Path,
        progress: Option<&mpsc::Sender<DownloadProgress>>,
        cancellation: &CancellationToken,
    ) -> Result<(u64, Option<String>), StoreError> {
        if cancellation.is_cancelled() {
            return Err(StoreError::cancelled());
        }

        self.meter.get_requests.fetch_add(1, Ordering::Relaxed);
        let operation = self
            .client
            .get_object()
            .bucket(&request.source.bucket)
            .key(&request.source.prefix)
            .send();
        let output = tokio::select! {
            _ = cancellation.cancelled() => return Err(StoreError::cancelled()),
            result = operation => result.map_err(|error| StoreError::aws("GetObject", error.code(), error.message(), &error))?,
        };

        let total_bytes = output
            .content_length()
            .filter(|value| *value >= 0)
            .map(|value| value as u64);
        let etag = output.e_tag().map(ToOwned::to_owned);
        let mut reader = output.body.into_async_read();
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        let open = options.open(temporary_path);
        let mut file = tokio::select! {
            _ = cancellation.cancelled() => return Err(StoreError::cancelled()),
            result = open => result.map_err(|error| StoreError::io("create temporary download", error))?,
        };
        let mut buffer = vec![0_u8; DOWNLOAD_BUFFER_BYTES];
        let mut bytes_transferred = 0_u64;

        loop {
            let read = tokio::select! {
                _ = cancellation.cancelled() => return Err(StoreError::cancelled()),
                result = reader.read(&mut buffer) => {
                    result.map_err(|error| StoreError::io("read S3 response", error))?
                }
            };
            if read == 0 {
                break;
            }

            tokio::select! {
                _ = cancellation.cancelled() => return Err(StoreError::cancelled()),
                result = file.write_all(&buffer[..read]) => {
                    result.map_err(|error| StoreError::io("write download", error))?;
                }
            }
            bytes_transferred = bytes_transferred.saturating_add(read as u64);
            send_progress(
                progress,
                DownloadProgress::new(bytes_transferred, total_bytes, false),
            );
        }

        tokio::select! {
            _ = cancellation.cancelled() => return Err(StoreError::cancelled()),
            result = file.flush() => {
                result.map_err(|error| StoreError::io("flush download", error))?;
            }
        }
        tokio::select! {
            _ = cancellation.cancelled() => return Err(StoreError::cancelled()),
            result = file.sync_all() => {
                result.map_err(|error| StoreError::io("sync download", error))?;
            }
        }
        drop(file);

        if let Some(expected) = total_bytes {
            if bytes_transferred != expected {
                return Err(StoreError::new(
                    StoreErrorKind::InvalidResponse,
                    format!("GetObject returned {bytes_transferred} bytes but declared {expected}"),
                    true,
                ));
            }
        }

        Ok((bytes_transferred, etag))
    }
}

#[async_trait]
impl ObjectStore for AwsS3Store {
    async fn list_objects(
        &self,
        target: &S3Uri,
        max_objects: usize,
    ) -> Result<Vec<S3Object>, StoreError> {
        if max_objects == 0 {
            return Err(StoreError::new(
                StoreErrorKind::Other,
                "object listing limit must be greater than zero",
                false,
            ));
        }

        // LIST is key-ordered, not LastModified-ordered, so visit every page
        // but retain only the newest N observations. Reverse<String> makes a
        // lexically larger key the first eviction when timestamps tie.
        let mut newest = RankedObjects::new();
        let mut continuation_token: Option<String> = None;

        loop {
            let mut request = self
                .client
                .list_objects_v2()
                .bucket(&target.bucket)
                .prefix(&target.prefix);
            if let Some(token) = continuation_token.as_deref() {
                request = request.continuation_token(token);
            }

            // Counted before dispatch: a request that fails after reaching S3 is
            // still billable, and over-reporting cost is safer than under.
            self.meter.list_requests.fetch_add(1, Ordering::Relaxed);
            let output = request.send().await.map_err(|error| {
                StoreError::aws("ListObjectsV2", error.code(), error.message(), &error)
            })?;

            for object in output.contents() {
                let key = object.key().ok_or_else(|| {
                    StoreError::new(
                        StoreErrorKind::InvalidResponse,
                        "ListObjectsV2 returned an object without a key",
                        true,
                    )
                })?;
                let modified = object.last_modified().ok_or_else(|| {
                    StoreError::new(
                        StoreErrorKind::InvalidResponse,
                        format!("ListObjectsV2 returned {key} without LastModified"),
                        true,
                    )
                })?;
                let last_modified = Utc
                    .timestamp_opt(modified.secs(), modified.subsec_nanos())
                    .single()
                    .ok_or_else(|| {
                        StoreError::new(
                            StoreErrorKind::InvalidResponse,
                            format!("invalid LastModified for {key}"),
                            false,
                        )
                    })?;
                let size = object.size().unwrap_or_default();
                if size < 0 {
                    return Err(StoreError::new(
                        StoreErrorKind::InvalidResponse,
                        format!("ListObjectsV2 returned a negative size for {key}"),
                        false,
                    ));
                }
                let object = S3Object {
                    key: key.to_owned(),
                    last_modified,
                    size: size as u64,
                    etag: object.e_tag().map(ToOwned::to_owned),
                    storage_class: object
                        .storage_class()
                        .map(|value| value.as_str().to_owned()),
                };
                retain_newest(&mut newest, object, max_objects);
            }

            if !output.is_truncated().unwrap_or(false) {
                break;
            }
            continuation_token = output.next_continuation_token().map(ToOwned::to_owned);
            if continuation_token.is_none() {
                return Err(StoreError::new(
                    StoreErrorKind::InvalidResponse,
                    "ListObjectsV2 was truncated but returned no continuation token",
                    true,
                ));
            }
        }

        Ok(finish_newest(newest))
    }

    async fn download_object(
        &self,
        request: DownloadRequest,
        progress: Option<mpsc::Sender<DownloadProgress>>,
        cancellation: CancellationToken,
    ) -> Result<DownloadResult, StoreError> {
        if request.source.prefix.is_empty() {
            return Err(StoreError::new(
                StoreErrorKind::NotFound,
                "download requires a full S3 object URI",
                false,
            ));
        }

        if !request.overwrite && path_exists(&request.destination).await? {
            return Err(StoreError::new(
                StoreErrorKind::AlreadyExists,
                format!(
                    "destination already exists: {}",
                    request.destination.display()
                ),
                false,
            ));
        }

        // This guard performs synchronous cleanup when an RPC cancellation
        // drops the async handler after its grace period.
        let temporary = TemporaryDownload::new(temporary_path(&request.destination));
        let streamed = self
            .stream_download(&request, temporary.path(), progress.as_ref(), &cancellation)
            .await;
        let (bytes_transferred, etag) = match streamed {
            Ok(result) => result,
            Err(error) => return Err(error),
        };

        let install_result = if request.overwrite {
            replace_file(temporary.path(), &request.destination).await
        } else {
            install_without_overwrite(temporary.path(), &request.destination).await
        };
        install_result?;
        send_progress(
            progress.as_ref(),
            DownloadProgress::new(bytes_transferred, Some(bytes_transferred), true),
        );

        Ok(DownloadResult {
            source: request.source,
            destination: request.destination,
            bytes_transferred,
            etag,
        })
    }

    fn request_counts(&self) -> RequestCounts {
        self.meter.counts()
    }
}

fn send_progress(sender: Option<&mpsc::Sender<DownloadProgress>>, progress: DownloadProgress) {
    if let Some(sender) = sender {
        // Progress must never apply backpressure to object I/O. The final result
        // still carries the authoritative byte count if intermediate samples
        // are dropped by a slow client.
        let _ = sender.try_send(progress);
    }
}

fn retain_newest(newest: &mut RankedObjects, object: S3Object, max_objects: usize) {
    newest.insert((object.last_modified, Reverse(object.key.clone())), object);
    if newest.len() > max_objects {
        newest.pop_first();
    }
}

fn finish_newest(newest: RankedObjects) -> Vec<S3Object> {
    let mut objects: Vec<_> = newest.into_values().collect();
    objects.sort_by(|left, right| {
        right
            .last_modified
            .cmp(&left.last_modified)
            .then_with(|| left.key.cmp(&right.key))
    });
    objects
}

async fn path_exists(path: &Path) -> Result<bool, StoreError> {
    match fs::metadata(path).await {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(StoreError::io("inspect download destination", error)),
    }
}

fn temporary_path(destination: &Path) -> std::path::PathBuf {
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    destination.with_file_name(format!(".{file_name}.s3pulse-{}.part", Uuid::new_v4()))
}

struct TemporaryDownload {
    path: std::path::PathBuf,
}

impl TemporaryDownload {
    fn new(path: std::path::PathBuf) -> Self {
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TemporaryDownload {
    fn drop(&mut self) {
        match std::fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => tracing::warn!(
                path = %self.path.display(),
                %error,
                "could not remove temporary download"
            ),
        }
    }
}

async fn install_without_overwrite(temporary: &Path, destination: &Path) -> Result<(), StoreError> {
    // A hard link is an atomic no-clobber install when the temporary file is in
    // the destination directory. It closes the race between the initial
    // existence check and publishing the completed object.
    fs::hard_link(temporary, destination)
        .await
        .map_err(|error| StoreError::io("install completed download", error))?;
    fs::remove_file(temporary)
        .await
        .map_err(|error| StoreError::io("remove temporary download", error))
}

async fn replace_file(temporary: &Path, destination: &Path) -> Result<(), StoreError> {
    match fs::rename(temporary, destination).await {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::PermissionDenied
            ) && path_exists(destination).await? =>
        {
            // Windows does not replace an existing destination with rename.
            fs::remove_file(destination)
                .await
                .map_err(|error| StoreError::io("replace existing download", error))?;
            fs::rename(temporary, destination)
                .await
                .map_err(|error| StoreError::io("install completed download", error))
        }
        Err(error) => Err(StoreError::io("install completed download", error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(key: &str, seconds: i64) -> S3Object {
        S3Object {
            key: key.to_owned(),
            last_modified: Utc.timestamp_opt(seconds, 0).single().unwrap(),
            size: 1,
            etag: None,
            storage_class: None,
        }
    }

    #[test]
    fn paginated_retention_keeps_only_newest_with_deterministic_ties() {
        let mut newest = RankedObjects::new();
        for value in [
            object("z", 20),
            object("old", 10),
            object("a", 20),
            object("new", 30),
        ] {
            retain_newest(&mut newest, value, 2);
            assert!(newest.len() <= 2);
        }
        let keys: Vec<_> = finish_newest(newest)
            .into_iter()
            .map(|value| value.key)
            .collect();
        assert_eq!(keys, ["new", "a"]);
    }

    #[test]
    fn the_meter_counts_list_pages_and_gets_independently() {
        let meter = RequestMeter::default();
        assert_eq!(meter.counts(), RequestCounts::default());

        // A paginated listing bills per page, not per poll.
        meter.list_requests.fetch_add(1, Ordering::Relaxed);
        meter.list_requests.fetch_add(1, Ordering::Relaxed);
        meter.get_requests.fetch_add(1, Ordering::Relaxed);
        assert_eq!(
            meter.counts(),
            RequestCounts {
                list_requests: 2,
                get_requests: 1,
            }
        );

        // Clones share the underlying counters, so a cloned store keeps
        // reporting the same totals as the original.
        let clone = meter.clone();
        clone.list_requests.fetch_add(1, Ordering::Relaxed);
        assert_eq!(meter.counts().list_requests, 3);
    }

    #[test]
    fn request_counts_use_camel_case_on_the_wire() {
        let json = serde_json::to_string(&RequestCounts {
            list_requests: 7,
            get_requests: 2,
        })
        .unwrap();
        assert_eq!(json, r#"{"listRequests":7,"getRequests":2}"#);
    }

    #[test]
    fn temporary_download_stays_next_to_destination() {
        let destination = Path::new("/tmp/feed/object.parquet");
        let temporary = temporary_path(destination);
        assert_eq!(temporary.parent(), destination.parent());
        assert!(temporary
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".object.parquet.s3pulse-"));
    }

    #[tokio::test]
    async fn temporary_guard_removes_a_partial_file_when_dropped() {
        let path = std::env::temp_dir().join(format!("s3pulse-partial-{}", Uuid::new_v4()));
        fs::write(&path, b"partial").await.unwrap();
        {
            let guard = TemporaryDownload::new(path.clone());
            assert_eq!(guard.path(), path);
        }
        assert!(!path_exists(&path).await.unwrap());
    }

    #[tokio::test]
    async fn no_clobber_install_rejects_an_existing_destination() {
        let directory = std::env::temp_dir().join(format!("s3pulse-{}", Uuid::new_v4()));
        fs::create_dir(&directory).await.unwrap();
        let temporary = directory.join("temporary");
        let destination = directory.join("destination");
        fs::write(&temporary, b"new").await.unwrap();
        fs::write(&destination, b"old").await.unwrap();

        let error = install_without_overwrite(&temporary, &destination)
            .await
            .unwrap_err();
        assert_eq!(error.kind, StoreErrorKind::AlreadyExists);
        assert_eq!(fs::read(&destination).await.unwrap(), b"old");

        fs::remove_dir_all(directory).await.unwrap();
    }
}
