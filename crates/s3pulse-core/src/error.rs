use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum UriParseError {
    #[error("S3 URI must start with s3://")]
    InvalidScheme,
    #[error("S3 URI is missing a bucket name")]
    MissingBucket,
    #[error("invalid S3 bucket name: {0}")]
    InvalidBucket(String),
    #[error("S3 object key/prefix contains a control character")]
    InvalidKey,
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum ConfigError {
    #[error("watcher id cannot be empty")]
    EmptyId,
    #[error("watcher name cannot be empty")]
    EmptyName,
    #[error("poll interval must be greater than zero")]
    ZeroPollInterval,
    #[error("expected interval must be greater than zero when configured")]
    ZeroExpectedInterval,
    #[error("history capacity must be greater than zero")]
    ZeroHistoryCapacity,
}

/// Stable error categories suitable for CLI and JSON-RPC clients.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StoreErrorKind {
    Authentication,
    AccessDenied,
    NotFound,
    Network,
    Cancelled,
    AlreadyExists,
    InvalidResponse,
    Io,
    Other,
}

#[derive(Clone, Debug, Deserialize, Error, PartialEq, Serialize)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct StoreError {
    pub kind: StoreErrorKind,
    pub message: String,
    pub retryable: bool,
}

impl StoreError {
    pub fn new(kind: StoreErrorKind, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            kind,
            message: message.into(),
            retryable,
        }
    }

    pub fn cancelled() -> Self {
        Self::new(StoreErrorKind::Cancelled, "operation cancelled", false)
    }

    pub(crate) fn io(operation: &str, error: std::io::Error) -> Self {
        let kind = if error.kind() == std::io::ErrorKind::AlreadyExists {
            StoreErrorKind::AlreadyExists
        } else {
            StoreErrorKind::Io
        };
        Self::new(kind, format!("{operation}: {error}"), false)
    }

    pub(crate) fn aws(operation: &str, error: impl std::fmt::Display) -> Self {
        let detail = error.to_string();
        let normalized = detail.to_ascii_lowercase();
        let (kind, retryable) = if normalized.contains("expiredtoken")
            || normalized.contains("expired token")
            || normalized.contains("invalidclienttokenid")
            || normalized.contains("credential")
        {
            (StoreErrorKind::Authentication, false)
        } else if normalized.contains("accessdenied")
            || normalized.contains("access denied")
            || normalized.contains("forbidden")
        {
            (StoreErrorKind::AccessDenied, false)
        } else if normalized.contains("nosuchkey")
            || normalized.contains("no such key")
            || normalized.contains("not found")
        {
            (StoreErrorKind::NotFound, false)
        } else if normalized.contains("timeout")
            || normalized.contains("dispatch failure")
            || normalized.contains("connection")
            || normalized.contains("dns")
        {
            (StoreErrorKind::Network, true)
        } else {
            (StoreErrorKind::Other, true)
        };
        Self::new(kind, format!("{operation} failed: {detail}"), retryable)
    }
}

#[derive(Debug, Error)]
pub enum WatcherError {
    #[error(transparent)]
    InvalidConfig(#[from] ConfigError),
    #[error("watcher event receiver was closed")]
    EventChannelClosed,
}
