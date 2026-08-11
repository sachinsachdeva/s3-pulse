use std::{collections::HashMap, io, sync::Arc};

use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{Mutex, Semaphore},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

use super::protocol::{
    ErrorObject, ErrorResponse, Notification, Request, RequestId, SuccessResponse, JSONRPC_VERSION,
};

const DEFAULT_MAX_CONCURRENT_REQUESTS: usize = 64;
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
const CANCELLATION_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

enum ProtocolLine {
    Eof,
    Complete,
    TooLarge,
}

/// Reads one newline-delimited message without ever retaining more than the
/// configured line limit. Oversized input is consumed through its newline so
/// the next request starts at a clean protocol boundary.
async fn read_protocol_line<R>(reader: &mut R, line: &mut Vec<u8>) -> io::Result<ProtocolLine>
where
    R: AsyncBufRead + Unpin,
{
    line.clear();
    let mut too_large = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return if too_large {
                Ok(ProtocolLine::TooLarge)
            } else if line.is_empty() {
                Ok(ProtocolLine::Eof)
            } else {
                Ok(ProtocolLine::Complete)
            };
        }

        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |position| position + 1);
        if !too_large {
            if line.len().saturating_add(consumed) > MAX_LINE_BYTES {
                too_large = true;
                line.clear();
            } else {
                line.extend_from_slice(&available[..consumed]);
            }
        }
        reader.consume(consumed);

        if newline.is_some() {
            return Ok(if too_large {
                ProtocolLine::TooLarge
            } else {
                ProtocolLine::Complete
            });
        }
    }
}

#[async_trait]
pub trait NotificationSink: Send + Sync {
    async fn notify_value(&self, method: &str, params: Value) -> io::Result<()>;
}

#[derive(Clone)]
pub struct RequestContext {
    pub cancellation: CancellationToken,
    notifier: Arc<dyn NotificationSink>,
}

impl RequestContext {
    pub(crate) fn new(
        cancellation: CancellationToken,
        notifier: Arc<dyn NotificationSink>,
    ) -> Self {
        Self {
            cancellation,
            notifier,
        }
    }

    pub async fn notify<T: Serialize + Send>(
        &self,
        method: &str,
        params: T,
    ) -> Result<(), ErrorObject> {
        let value = serde_json::to_value(params).map_err(ErrorObject::internal)?;
        self.notifier
            .notify_value(method, value)
            .await
            .map_err(ErrorObject::internal)
    }
}

#[async_trait]
pub trait RpcHandler: Send + Sync + 'static {
    async fn handle(
        &self,
        method: &str,
        params: Value,
        context: RequestContext,
    ) -> Result<Value, ErrorObject>;
}

struct ProtocolWriter<W> {
    writer: Arc<Mutex<W>>,
}

impl<W> Clone for ProtocolWriter<W> {
    fn clone(&self) -> Self {
        Self {
            writer: Arc::clone(&self.writer),
        }
    }
}

impl<W> ProtocolWriter<W>
where
    W: AsyncWrite + Unpin + Send,
{
    fn new(writer: W) -> Self {
        Self {
            writer: Arc::new(Mutex::new(writer)),
        }
    }

    async fn write<T: Serialize + Sync>(&self, message: &T) -> io::Result<()> {
        let mut bytes = serde_json::to_vec(message).map_err(io::Error::other)?;
        bytes.push(b'\n');

        let mut writer = self.writer.lock().await;
        writer.write_all(&bytes).await?;
        writer.flush().await
    }

    async fn success(&self, id: &RequestId, result: Value) -> io::Result<()> {
        self.write(&SuccessResponse::new(id, result)).await
    }

    async fn error(&self, id: &RequestId, error: ErrorObject) -> io::Result<()> {
        self.write(&ErrorResponse::new(id, error)).await
    }
}

#[async_trait]
impl<W> NotificationSink for ProtocolWriter<W>
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    async fn notify_value(&self, method: &str, params: Value) -> io::Result<()> {
        self.write(&Notification::new(method, params)).await
    }
}

/// Serve newline-delimited JSON-RPC 2.0 until the input reaches EOF.
///
/// Each request runs in its own task, so responses are intentionally allowed
/// to arrive out of order. Writes are serialized to keep every protocol line
/// intact. A `$/cancelRequest` notification cancels the matching in-flight
/// request.
pub async fn serve<R, W, H>(reader: R, writer: W, handler: Arc<H>) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
    H: RpcHandler,
{
    serve_with_limit(reader, writer, handler, DEFAULT_MAX_CONCURRENT_REQUESTS).await
}

pub async fn serve_with_limit<R, W, H>(
    mut reader: R,
    writer: W,
    handler: Arc<H>,
    max_concurrent_requests: usize,
) -> io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
    H: RpcHandler,
{
    let writer = ProtocolWriter::new(writer);
    let notifier: Arc<dyn NotificationSink> = Arc::new(writer.clone());
    let in_flight = Arc::new(Mutex::new(HashMap::<RequestId, CancellationToken>::new()));
    let connection_cancellation = CancellationToken::new();
    let semaphore = Arc::new(Semaphore::new(max_concurrent_requests.max(1)));
    let mut tasks = JoinSet::new();
    let mut line = Vec::new();

    loop {
        match read_protocol_line(&mut reader, &mut line).await? {
            ProtocolLine::Eof => break,
            ProtocolLine::Complete => {}
            ProtocolLine::TooLarge => {
                writer
                    .error(
                        &RequestId::Null,
                        ErrorObject::invalid_request("Request exceeds maximum line length"),
                    )
                    .await?;
                continue;
            }
        }

        let value = match serde_json::from_slice::<Value>(&line) {
            Ok(value) => value,
            Err(error) => {
                writer
                    .error(&RequestId::Null, ErrorObject::parse_error(error))
                    .await?;
                continue;
            }
        };
        let request = match serde_json::from_value::<Request>(value) {
            Ok(request) => request,
            Err(error) => {
                writer
                    .error(
                        &RequestId::Null,
                        ErrorObject::invalid_request("Invalid JSON-RPC request")
                            .with_data(serde_json::json!({ "detail": error.to_string() })),
                    )
                    .await?;
                continue;
            }
        };

        if request.jsonrpc != JSONRPC_VERSION || request.method.is_empty() {
            writer
                .error(
                    request.id.as_ref().unwrap_or(&RequestId::Null),
                    ErrorObject::invalid_request("Expected a JSON-RPC 2.0 request"),
                )
                .await?;
            continue;
        }

        if request.method == "$/cancelRequest" {
            cancel_request(&in_flight, request.params).await;
            continue;
        }

        let id = request.id;
        let method = request.method;
        let params = request.params;
        let cancellation = connection_cancellation.child_token();
        let permit = match Arc::clone(&semaphore).try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                if let Some(id) = &id {
                    writer
                        .error(
                            id,
                            ErrorObject::new(
                                ErrorObject::SERVER_BUSY,
                                "Too many concurrent requests",
                            ),
                        )
                        .await?;
                }
                continue;
            }
        };

        if let Some(id) = &id {
            let mut requests = in_flight.lock().await;
            if requests.contains_key(id) {
                drop(requests);
                writer
                    .error(
                        id,
                        ErrorObject::invalid_request("Request ID is already in flight"),
                    )
                    .await?;
                continue;
            }
            requests.insert(id.clone(), cancellation.clone());
        }

        let task_writer = writer.clone();
        let task_handler = Arc::clone(&handler);
        let task_notifier = Arc::clone(&notifier);
        let task_in_flight = Arc::clone(&in_flight);
        tasks.spawn(async move {
            let context = RequestContext::new(cancellation.clone(), task_notifier);
            let operation = task_handler.handle(&method, params, context);
            tokio::pin!(operation);
            let result = tokio::select! {
                biased;
                result = &mut operation => result,
                _ = cancellation.cancelled() => {
                    // Give cancellation-aware handlers (notably downloads) a
                    // chance to remove temporary files before their future is
                    // dropped. The client still receives the standard
                    // cancellation error regardless of the cleanup result.
                    match tokio::time::timeout(CANCELLATION_GRACE, &mut operation).await {
                        Ok(Ok(result)) => Ok(result),
                        Ok(Err(_)) | Err(_) => Err(ErrorObject::cancelled()),
                    }
                },
            };
            drop(permit);

            if let Some(id) = id {
                let write_result = match result {
                    Ok(result) => task_writer.success(&id, result).await,
                    Err(error) => task_writer.error(&id, error).await,
                };
                if let Err(error) = write_result {
                    tracing::debug!(%error, "failed to write JSON-RPC response");
                }
                task_in_flight.lock().await.remove(&id);
            }
        });

        while tasks.try_join_next().is_some() {}
    }

    // EOF commonly follows a one-shot piped request. Let already admitted
    // work finish briefly so its response is not spuriously cancelled, then
    // cancel genuinely long-running operations from a disconnected client.
    let shutdown_grace = tokio::time::sleep(CANCELLATION_GRACE);
    tokio::pin!(shutdown_grace);
    while !tasks.is_empty() {
        tokio::select! {
            _ = &mut shutdown_grace => break,
            _ = tasks.join_next() => {}
        }
    }
    connection_cancellation.cancel();
    while tasks.join_next().await.is_some() {}
    Ok(())
}

async fn cancel_request(in_flight: &Mutex<HashMap<RequestId, CancellationToken>>, params: Value) {
    #[derive(serde::Deserialize)]
    struct CancelParams {
        id: RequestId,
    }

    if let Ok(params) = serde_json::from_value::<CancelParams>(params) {
        if let Some(token) = in_flight.lock().await.get(&params.id) {
            token.cancel();
        }
    }
}

pub async fn serve_stdio<H>(handler: Arc<H>) -> io::Result<()>
where
    H: RpcHandler,
{
    let reader = BufReader::new(tokio::io::stdin());
    serve(reader, tokio::io::stdout(), handler).await
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;
    use tokio::io::{duplex, split, AsyncBufReadExt, AsyncWriteExt};

    use super::*;

    struct TestHandler;

    #[async_trait]
    impl RpcHandler for TestHandler {
        async fn handle(
            &self,
            method: &str,
            params: Value,
            context: RequestContext,
        ) -> Result<Value, ErrorObject> {
            match method {
                "echo" => Ok(params),
                "delay" => {
                    let delay = params["milliseconds"].as_u64().unwrap();
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    Ok(json!({ "delay": delay }))
                }
                "notify" => {
                    context.notify("test.event", params).await?;
                    Ok(json!({ "sent": true }))
                }
                "wait" => {
                    context.cancellation.cancelled().await;
                    Err(ErrorObject::cancelled())
                }
                _ => Err(ErrorObject::method_not_found(method)),
            }
        }
    }

    async fn start_server() -> (
        tokio::io::WriteHalf<tokio::io::DuplexStream>,
        tokio::io::BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>,
    ) {
        let (client, server) = duplex(64 * 1024);
        let (client_read, client_write) = split(client);
        let (server_read, server_write) = split(server);
        tokio::spawn(serve(
            BufReader::new(server_read),
            server_write,
            Arc::new(TestHandler),
        ));
        (client_write, BufReader::new(client_read))
    }

    async fn start_server_with_limit(
        limit: usize,
    ) -> (
        tokio::io::WriteHalf<tokio::io::DuplexStream>,
        tokio::io::BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>,
    ) {
        let (client, server) = duplex(64 * 1024);
        let (client_read, client_write) = split(client);
        let (server_read, server_write) = split(server);
        tokio::spawn(serve_with_limit(
            BufReader::new(server_read),
            server_write,
            Arc::new(TestHandler),
            limit,
        ));
        (client_write, BufReader::new(client_read))
    }

    async fn read_json(reader: &mut (impl AsyncBufRead + Unpin)) -> serde_json::Value {
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        serde_json::from_str(&line).unwrap()
    }

    #[tokio::test]
    async fn responds_to_requests_and_not_notifications() {
        let (mut input, mut output) = start_server().await;
        input
            .write_all(
                b"{\"jsonrpc\":\"2.0\",\"method\":\"echo\",\"params\":{\"quiet\":true}}\n\
                  {\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"echo\",\"params\":{\"ok\":true}}\n",
            )
            .await
            .unwrap();

        let response = read_json(&mut output).await;
        assert_eq!(response["id"], 1);
        assert_eq!(response["result"], json!({ "ok": true }));
    }

    #[tokio::test]
    async fn eof_allows_an_admitted_one_shot_request_to_finish() {
        let (mut input, mut output) = start_server().await;
        input
            .write_all(
                b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"echo\",\"params\":{\"ok\":true}}\n",
            )
            .await
            .unwrap();
        drop(input);

        let response = read_json(&mut output).await;
        assert_eq!(response["id"], 1);
        assert_eq!(response["result"], json!({ "ok": true }));
    }

    #[tokio::test]
    async fn responses_can_arrive_out_of_order() {
        let (mut input, mut output) = start_server().await;
        input
            .write_all(
                b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"delay\",\"params\":{\"milliseconds\":40}}\n\
                  {\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"delay\",\"params\":{\"milliseconds\":1}}\n",
            )
            .await
            .unwrap();

        assert_eq!(read_json(&mut output).await["id"], 2);
        assert_eq!(read_json(&mut output).await["id"], 1);
    }

    #[tokio::test]
    async fn rejects_work_above_the_concurrency_limit_without_queuing_tasks() {
        let (mut input, mut output) = start_server_with_limit(1).await;
        input
            .write_all(
                b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"delay\",\"params\":{\"milliseconds\":40}}\n\
                  {\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"echo\",\"params\":{}}\n",
            )
            .await
            .unwrap();

        let busy = read_json(&mut output).await;
        assert_eq!(busy["id"], 2);
        assert_eq!(busy["error"]["code"], ErrorObject::SERVER_BUSY);
        assert_eq!(read_json(&mut output).await["id"], 1);
    }

    #[tokio::test]
    async fn oversized_lines_are_discarded_at_a_clean_boundary() {
        let mut input = vec![b'x'; MAX_LINE_BYTES + 1];
        input.extend_from_slice(b"\n{}\n");
        let mut reader = BufReader::new(input.as_slice());
        let mut line = Vec::new();

        assert!(matches!(
            read_protocol_line(&mut reader, &mut line).await.unwrap(),
            ProtocolLine::TooLarge
        ));
        assert!(matches!(
            read_protocol_line(&mut reader, &mut line).await.unwrap(),
            ProtocolLine::Complete
        ));
        assert_eq!(line, b"{}\n");
    }

    #[tokio::test]
    async fn cancel_notification_cancels_matching_request() {
        let (mut input, mut output) = start_server().await;
        input
            .write_all(
                b"{\"jsonrpc\":\"2.0\",\"id\":\"slow\",\"method\":\"wait\"}\n\
                  {\"jsonrpc\":\"2.0\",\"method\":\"$/cancelRequest\",\"params\":{\"id\":\"slow\"}}\n",
            )
            .await
            .unwrap();

        let response = read_json(&mut output).await;
        assert_eq!(response["id"], "slow");
        assert_eq!(response["error"]["code"], ErrorObject::REQUEST_CANCELLED);
    }

    #[tokio::test]
    async fn handler_can_send_notifications() {
        let (mut input, mut output) = start_server().await;
        input
            .write_all(
                b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"notify\",\"params\":{\"value\":3}}\n",
            )
            .await
            .unwrap();

        let notification = read_json(&mut output).await;
        let response = read_json(&mut output).await;
        assert_eq!(notification["method"], "test.event");
        assert_eq!(notification["params"], json!({ "value": 3 }));
        assert_eq!(response["id"], 1);
    }

    #[tokio::test]
    async fn malformed_json_returns_parse_error() {
        let (mut input, mut output) = start_server().await;
        input.write_all(b"not-json\n").await.unwrap();

        let response = read_json(&mut output).await;
        assert!(response["id"].is_null());
        assert_eq!(response["error"]["code"], ErrorObject::PARSE_ERROR);
    }

    #[tokio::test]
    async fn valid_json_with_wrong_shape_returns_invalid_request() {
        let (mut input, mut output) = start_server().await;
        input.write_all(b"[]\n").await.unwrap();

        let response = read_json(&mut output).await;
        assert_eq!(response["error"]["code"], ErrorObject::INVALID_REQUEST);
    }
}
