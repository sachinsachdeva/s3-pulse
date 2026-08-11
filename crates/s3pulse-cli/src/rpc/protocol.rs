use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const JSONRPC_VERSION: &str = "2.0";

/// A JSON-RPC identifier. Null identifiers are reserved for errors where the
/// request identifier cannot be recovered.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(i64),
    String(String),
    Null,
}

impl fmt::Display for RequestId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Number(value) => write!(formatter, "number:{value}"),
            Self::String(value) => write!(formatter, "string:{value}"),
            Self::Null => formatter.write_str("null"),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct Request {
    pub jsonrpc: String,
    #[serde(default, deserialize_with = "deserialize_optional_id")]
    pub id: Option<RequestId>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

fn deserialize_optional_id<'de, D>(deserializer: D) -> Result<Option<RequestId>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    RequestId::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ErrorObject {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl ErrorObject {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
    pub const REQUEST_CANCELLED: i32 = -32800;
    pub const SERVER_BUSY: i32 = -32000;
    pub const WATCHER_NOT_FOUND: i32 = -32001;
    pub const WATCHER_ALREADY_EXISTS: i32 = -32002;
    pub const RESOURCE_LIMIT: i32 = -32003;
    pub const BACKEND_ERROR: i32 = -32010;

    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    pub fn parse_error(error: impl fmt::Display) -> Self {
        Self::new(Self::PARSE_ERROR, "Parse error")
            .with_data(serde_json::json!({ "detail": error.to_string() }))
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(Self::INVALID_REQUEST, message)
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(
            Self::METHOD_NOT_FOUND,
            format!("Method not found: {method}"),
        )
    }

    pub fn invalid_params(error: impl fmt::Display) -> Self {
        Self::new(Self::INVALID_PARAMS, "Invalid params")
            .with_data(serde_json::json!({ "detail": error.to_string() }))
    }

    pub fn internal(error: impl fmt::Display) -> Self {
        Self::new(Self::INTERNAL_ERROR, "Internal error")
            .with_data(serde_json::json!({ "detail": error.to_string() }))
    }

    pub fn cancelled() -> Self {
        Self::new(Self::REQUEST_CANCELLED, "Request cancelled")
    }

    pub fn backend(error: impl fmt::Display) -> Self {
        Self::new(Self::BACKEND_ERROR, "S3 operation failed")
            .with_data(serde_json::json!({ "detail": error.to_string() }))
    }

    pub fn store(error: &s3pulse_core::StoreError) -> Self {
        Self::new(Self::BACKEND_ERROR, error.message.clone()).with_data(serde_json::json!({
            "kind": error.kind,
            "message": error.message,
            "retryable": error.retryable
        }))
    }
}

#[derive(Debug, Serialize)]
pub struct SuccessResponse<'a> {
    pub jsonrpc: &'static str,
    pub id: &'a RequestId,
    pub result: Value,
}

impl<'a> SuccessResponse<'a> {
    pub fn new(id: &'a RequestId, result: Value) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION,
            id,
            result,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse<'a> {
    pub jsonrpc: &'static str,
    pub id: &'a RequestId,
    pub error: ErrorObject,
}

impl<'a> ErrorResponse<'a> {
    pub fn new(id: &'a RequestId, error: ErrorObject) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION,
            id,
            error,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Notification<'a, T: Serialize> {
    pub jsonrpc: &'static str,
    pub method: &'a str,
    pub params: T,
}

impl<'a, T: Serialize> Notification<'a, T> {
    pub fn new(method: &'a str, params: T) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION,
            method,
            params,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_preserve_number_and_string_types() {
        let number: RequestId = serde_json::from_str("7").unwrap();
        let string: RequestId = serde_json::from_str(r#""7""#).unwrap();

        assert_ne!(number, string);
        assert_eq!(number.to_string(), "number:7");
        assert_eq!(string.to_string(), "string:7");
    }

    #[test]
    fn error_data_is_omitted_when_absent() {
        let response = ErrorResponse::new(
            &RequestId::Number(1),
            ErrorObject::new(ErrorObject::METHOD_NOT_FOUND, "missing"),
        );
        let value = serde_json::to_value(response).unwrap();

        assert!(value["error"].get("data").is_none());
    }

    #[test]
    fn explicit_null_id_is_not_treated_as_a_notification() {
        let request: Request =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":null,"method":"system.version"}"#)
                .unwrap();

        assert_eq!(request.id, Some(RequestId::Null));
    }
}
