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
pub enum TemplateError {
    #[error("unknown date placeholder {{{0}}}; use yyyy, yy, MM, M, dd, d, HH or H")]
    UnknownPlaceholder(String),
    #[error("{{mm}} means minutes, not months; use {{MM}} for a zero-padded month")]
    MinutesNotMonths,
    #[error("a date placeholder is missing its closing brace")]
    UnclosedPlaceholder,
    #[error("unmatched }} in the target; write }}}} for a literal brace")]
    UnmatchedBrace,
    #[error("unknown time zone: {0}; use an IANA name such as Australia/Sydney or UTC")]
    UnknownTimeZone(String),
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

    /// Categorises an AWS SDK failure.
    ///
    /// `SdkError`'s own `Display` is only a short variant label such as
    /// "service error" or "dispatch failure". The API error code that
    /// distinguishes expired credentials from denied access from a missing
    /// bucket lives in the response metadata, and any further detail lives
    /// further down the source chain. Matching on the `Display` alone
    /// collapses every service-side failure into `Other`, so the caller passes
    /// the code and this walks the chain for the rest.
    pub(crate) fn aws(
        operation: &str,
        code: Option<&str>,
        service_message: Option<&str>,
        error: &(dyn std::error::Error + 'static),
    ) -> Self {
        let mut chain = error.to_string();
        let mut source = error.source();
        while let Some(inner) = source {
            let text = inner.to_string();
            if !chain.contains(&text) {
                chain.push_str(": ");
                chain.push_str(&text);
            }
            source = inner.source();
        }

        // Classify on everything available, but show only the concise part:
        // the raw chain carries request ids and struct debug output.
        let code = code.unwrap_or_default();
        let normalized = format!("{code} {chain}").to_ascii_lowercase();
        let (kind, retryable) = if contains_any(
            &normalized,
            &[
                "expiredtoken",
                "expired token",
                "invalidclienttokenid",
                "invalidaccesskeyid",
                "signaturedoesnotmatch",
                "tokenrefreshrequired",
                "unrecognizedclient",
                "credential",
            ],
        ) {
            (StoreErrorKind::Authentication, false)
        } else if contains_any(
            &normalized,
            &[
                "accessdenied",
                "access denied",
                "forbidden",
                "allaccessdisabled",
            ],
        ) {
            (StoreErrorKind::AccessDenied, false)
        } else if contains_any(
            &normalized,
            &[
                "nosuchbucket",
                "nosuchkey",
                "no such key",
                "not found",
                "notfound",
            ],
        ) {
            (StoreErrorKind::NotFound, false)
        } else if contains_any(
            &normalized,
            &[
                "timeout",
                "dispatch failure",
                "connection",
                "connect",
                "dns",
            ],
        ) {
            (StoreErrorKind::Network, true)
        } else {
            (StoreErrorKind::Other, true)
        };

        let detail = service_message
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&chain);
        let message = if code.is_empty() {
            format!("{operation} failed: {detail}")
        } else {
            format!("{operation} failed: {code}: {detail}")
        };
        Self::new(kind, message, retryable)
    }
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

#[derive(Debug, Error)]
pub enum WatcherError {
    #[error(transparent)]
    InvalidConfig(#[from] ConfigError),
    #[error(transparent)]
    InvalidTemplate(#[from] TemplateError),
    #[error("watcher event receiver was closed")]
    EventChannelClosed,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stands in for an SdkError: a terse outer message with the real detail
    /// nested underneath, which is the shape the AWS SDK actually presents.
    #[derive(Debug)]
    struct Layered {
        message: String,
        source: Option<Box<Layered>>,
    }

    impl Layered {
        fn new(message: &str) -> Self {
            Self {
                message: message.to_owned(),
                source: None,
            }
        }

        fn caused_by(mut self, inner: Layered) -> Self {
            self.source = Some(Box::new(inner));
            self
        }
    }

    impl std::fmt::Display for Layered {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str(&self.message)
        }
    }

    impl std::error::Error for Layered {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            self.source
                .as_deref()
                .map(|inner| inner as &(dyn std::error::Error + 'static))
        }
    }

    #[test]
    fn the_service_error_code_decides_the_category() {
        // Every one of these arrives with the same useless outer Display, so
        // the code is the only thing that separates them.
        let opaque = Layered::new("service error");
        for (code, expected) in [
            ("ExpiredToken", StoreErrorKind::Authentication),
            ("InvalidAccessKeyId", StoreErrorKind::Authentication),
            ("SignatureDoesNotMatch", StoreErrorKind::Authentication),
            ("AccessDenied", StoreErrorKind::AccessDenied),
            ("NoSuchBucket", StoreErrorKind::NotFound),
            ("NoSuchKey", StoreErrorKind::NotFound),
        ] {
            let error = StoreError::aws("ListObjectsV2", Some(code), None, &opaque);
            assert_eq!(error.kind, expected, "{code}");
            assert!(!error.retryable, "{code} is not worth retrying");
            assert!(error.message.contains(code), "{code} is named for the user");
        }
    }

    #[test]
    fn detail_is_recovered_from_the_source_chain_when_no_code_is_available() {
        let error = StoreError::aws(
            "ListObjectsV2",
            None,
            None,
            &Layered::new("service error")
                .caused_by(Layered::new("unhandled error").caused_by(Layered::new("AccessDenied"))),
        );
        assert_eq!(error.kind, StoreErrorKind::AccessDenied);
        assert!(error.message.contains("AccessDenied"));
    }

    #[test]
    fn transport_failures_stay_retryable_network_errors() {
        let error = StoreError::aws(
            "ListObjectsV2",
            None,
            None,
            &Layered::new("dispatch failure"),
        );
        assert_eq!(error.kind, StoreErrorKind::Network);
        assert!(error.retryable);
    }

    #[test]
    fn an_unrecognised_failure_is_other_and_retryable() {
        let error = StoreError::aws(
            "ListObjectsV2",
            Some("SlowDown"),
            None,
            &Layered::new("service error"),
        );
        assert_eq!(error.kind, StoreErrorKind::Other);
        assert!(error.retryable);
    }

    #[test]
    fn the_service_message_is_preferred_over_the_noisy_source_chain() {
        // The chain carries request ids and struct debug output; the service
        // message is the part worth showing a user.
        let error = StoreError::aws(
            "ListObjectsV2",
            Some("InvalidAccessKeyId"),
            Some("The Access Key Id you provided does not exist in our records."),
            &Layered::new("service error").caused_by(Layered::new(
                "Error { code: \"InvalidAccessKeyId\", aws_request_id: \"18CAE17BD40AA5AD\" }",
            )),
        );
        assert_eq!(
            error.message,
            "ListObjectsV2 failed: InvalidAccessKeyId: The Access Key Id you provided does not exist in our records."
        );
        assert!(!error.message.contains("aws_request_id"));
        assert_eq!(error.kind, StoreErrorKind::Authentication);
    }

    #[test]
    fn an_empty_service_message_falls_back_to_the_chain() {
        let error = StoreError::aws(
            "GetObject",
            Some("NoSuchKey"),
            Some("   "),
            &Layered::new("service error"),
        );
        assert_eq!(error.message, "GetObject failed: NoSuchKey: service error");
        assert_eq!(error.kind, StoreErrorKind::NotFound);
    }

    #[test]
    fn a_repeated_source_message_is_not_duplicated_into_the_detail() {
        let error = StoreError::aws(
            "GetObject",
            None,
            None,
            &Layered::new("service error").caused_by(Layered::new("service error")),
        );
        assert_eq!(error.message, "GetObject failed: service error");
    }
}
