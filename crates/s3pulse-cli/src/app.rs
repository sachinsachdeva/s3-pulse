use std::{path::PathBuf, sync::Arc};

use chrono::Utc;
use s3pulse_core::{
    AwsS3Options, AwsS3Store, DateTemplate, DownloadRequest, ObjectChangeKind, ObjectStore,
    PollingWatcher, S3Object, S3Uri, WatcherConfig,
};
use serde_json::json;
use thiserror::Error;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{
    cli::{Cli, Command, DownloadArgs, HistoryArgs, QueryArgs, WatchArgs},
    output,
    rpc::{serve_stdio, CoreRuntime, S3PulseRpc},
};

#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub async fn run(cli: Cli) -> Result<(), AppError> {
    let profile = cli.profile.clone();
    let region = cli.region.clone();
    match cli.command {
        Command::Watch(args) => watch(args, profile, region, cli.json).await,
        Command::History(args) => history(args, profile, region, cli.json).await,
        Command::Stats(args) => stats(args, profile, region, cli.json).await,
        Command::List(args) => list(args, profile, region, cli.json).await,
        Command::Download(args) => download(args, profile, region, cli.json).await,
        Command::Serve(_) => {
            let runtime = Arc::new(CoreRuntime::new(profile, region));
            serve_stdio(Arc::new(S3PulseRpc::new(runtime))).await?;
            Ok(())
        }
    }
}

async fn create_store(
    profile: Option<String>,
    region: Option<String>,
) -> Result<Arc<dyn ObjectStore>, AppError> {
    let store = AwsS3Store::new(AwsS3Options { profile, region })
        .await
        .map_err(message)?;
    Ok(Arc::new(store))
}

fn parse_target(target: &str) -> Result<S3Uri, AppError> {
    target.parse().map_err(message)
}

/// Resolves date placeholders, if any, to the concrete prefixes to read.
fn resolve_targets(target: &S3Uri, lookback: u32) -> Result<Vec<S3Uri>, AppError> {
    match DateTemplate::parse(&target.prefix).map_err(message)? {
        None => Ok(vec![target.clone()]),
        Some(template) => Ok(template
            .resolve(Utc::now(), lookback)
            .into_iter()
            .map(|prefix| S3Uri {
                bucket: target.bucket.clone(),
                prefix,
            })
            .collect()),
    }
}

async fn list_resolved(
    store: &Arc<dyn ObjectStore>,
    target: &S3Uri,
    lookback: u32,
    limit: usize,
) -> Result<Vec<S3Object>, AppError> {
    let mut objects = Vec::new();
    for resolved in resolve_targets(target, lookback)? {
        objects.extend(
            store
                .list_objects(&resolved, limit)
                .await
                .map_err(message)?,
        );
    }
    Ok(objects)
}

async fn list(
    args: QueryArgs,
    profile: Option<String>,
    region: Option<String>,
    json_output: bool,
) -> Result<(), AppError> {
    let target = parse_target(&args.target)?;
    let store = create_store(profile, region).await?;
    let mut objects = list_resolved(&store, &target, args.lookback, args.limit).await?;
    sort_recent(&mut objects);
    objects.truncate(args.limit);
    if json_output {
        output::print_json(&json!({ "target": target, "objects": objects }), true)?;
    } else {
        println!("{target}");
        output::print_objects(&objects);
    }
    Ok(())
}

async fn history(
    args: HistoryArgs,
    profile: Option<String>,
    region: Option<String>,
    json_output: bool,
) -> Result<(), AppError> {
    let target = parse_target(&args.target)?;
    let store = create_store(profile, region).await?;
    let cutoff = Utc::now()
        - chrono::Duration::from_std(args.last)
            .map_err(|error| AppError::Message(error.to_string()))?;
    let mut objects = list_resolved(&store, &target, args.lookback, args.limit).await?;
    objects.retain(|object| object.last_modified >= cutoff);
    sort_recent(&mut objects);
    objects.truncate(args.limit);
    if json_output {
        output::print_json(
            &json!({
                "target": target,
                "windowSeconds": args.last.as_secs(),
                "objects": objects
            }),
            true,
        )?;
    } else {
        println!(
            "{target} — last {}",
            output::format_duration(args.last.as_secs_f64())
        );
        output::print_objects(&objects);
    }
    Ok(())
}

async fn stats(
    args: QueryArgs,
    profile: Option<String>,
    region: Option<String>,
    json_output: bool,
) -> Result<(), AppError> {
    let target = parse_target(&args.target)?;
    let store = create_store(profile.clone(), region.clone()).await?;
    let config = WatcherConfig {
        id: "stats".to_owned(),
        name: target.to_string(),
        target: target.clone(),
        profile,
        region,
        poll_interval_seconds: 30,
        expected_interval_seconds: None,
        max_history: args.limit,
        lookback_periods: args.lookback,
    };
    let mut watcher = PollingWatcher::new(config, store).map_err(message)?;
    let statistics = watcher
        .poll_once()
        .await
        .map_err(message)?
        .snapshot
        .statistics;
    if json_output {
        output::print_json(&json!({ "target": target, "statistics": statistics }), true)?;
    } else {
        println!("{target}");
        output::print_statistics(&serde_json::to_value(statistics)?);
    }
    Ok(())
}

async fn watch(
    args: WatchArgs,
    profile: Option<String>,
    region: Option<String>,
    json_output: bool,
) -> Result<(), AppError> {
    let target = parse_target(&args.target)?;
    let store = create_store(profile.clone(), region.clone()).await?;
    let config = WatcherConfig {
        id: "cli".to_owned(),
        name: target.to_string(),
        target: target.clone(),
        profile,
        region,
        poll_interval_seconds: args.interval.as_secs(),
        expected_interval_seconds: args.expected_interval.map(|value| value.as_secs()),
        max_history: args.history_limit,
        lookback_periods: args.lookback,
    };
    let mut watcher = PollingWatcher::new(config, store).map_err(message)?;
    let mut previous_arrival = None;

    if !json_output {
        eprintln!(
            "Watching {target} every {:?}. Press Ctrl-C to stop.",
            args.interval
        );
    }
    loop {
        let result = tokio::select! {
            signal = tokio::signal::ctrl_c() => {
                signal?;
                break;
            }
            result = watcher.poll_once() => result,
        };
        match result {
            Ok(result) => {
                let mut changes = result.update.changes;
                changes.sort_by(|left, right| {
                    left.object.last_modified.cmp(&right.object.last_modified)
                });
                for change in changes {
                    let object = change.object;
                    if json_output {
                        let event = if change.kind == ObjectChangeKind::Added {
                            "object.added"
                        } else {
                            "object.updated"
                        };
                        output::print_json(&json!({ "event": event, "object": object }), false)?;
                    } else {
                        output::print_arrival(&object, previous_arrival);
                    }
                    previous_arrival = Some(object.last_modified);
                }
            }
            Err(error) => {
                if json_output {
                    output::print_json(
                        &json!({ "event": "watch.error", "error": error.to_string() }),
                        false,
                    )?;
                } else {
                    eprintln!("watch error: {error}");
                }
            }
        }

        tokio::select! {
            signal = tokio::signal::ctrl_c() => {
                signal?;
                break;
            }
            _ = tokio::time::sleep(args.interval) => {}
        }
    }
    Ok(())
}

async fn download(
    args: DownloadArgs,
    profile: Option<String>,
    region: Option<String>,
    json_output: bool,
) -> Result<(), AppError> {
    let source = parse_target(&args.target)?;
    let destination = match args.destination {
        Some(destination) => destination,
        None => default_destination(&source)?,
    };
    let store = create_store(profile, region).await?;
    let request = DownloadRequest {
        source: source.clone(),
        destination: destination.clone(),
        overwrite: args.overwrite,
    };
    let cancellation = CancellationToken::new();
    let (progress_tx, mut progress_rx) = mpsc::channel(32);
    let operation = store.download_object(request, Some(progress_tx), cancellation.clone());
    tokio::pin!(operation);
    let mut progress_open = true;
    let mut cancelled = false;
    let result = loop {
        tokio::select! {
            result = &mut operation => break result,
            signal = tokio::signal::ctrl_c(), if !cancelled => {
                signal?;
                cancelled = true;
                cancellation.cancel();
            }
            progress = progress_rx.recv(), if progress_open => {
                match progress {
                    Some(progress) if !json_output => {
                        eprint!(
                            "\rDownloaded {}",
                            output::format_bytes(progress.bytes_transferred)
                        );
                    }
                    Some(_) => {}
                    None => progress_open = false,
                }
            }
        }
    };
    if !json_output {
        eprintln!();
    }
    let result = result.map_err(message)?;
    if cancelled {
        return Err(AppError::Message("download cancelled".to_owned()));
    }
    if json_output {
        output::print_json(
            &json!({
                "source": source,
                "destination": destination,
                "result": result
            }),
            true,
        )?;
    } else {
        let suffix = format!(" ({})", output::format_bytes(result.bytes_transferred));
        println!("Downloaded {source} to {}{suffix}", destination.display());
    }
    Ok(())
}

fn default_destination(source: &S3Uri) -> Result<PathBuf, AppError> {
    let file_name = source
        .prefix
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| AppError::Message("download requires a full S3 object URI".to_owned()))?;
    if !is_portable_file_name(file_name) {
        return Err(AppError::Message(
            "object name is unsafe as a default path; provide an explicit destination".to_owned(),
        ));
    }
    Ok(PathBuf::from(file_name))
}

fn is_portable_file_name(value: &str) -> bool {
    if matches!(value, "." | "..")
        || value.ends_with([' ', '.'])
        || value
            .chars()
            .any(|character| character.is_control() || r#"<>:"/\|?*"#.contains(character))
    {
        return false;
    }
    let stem = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_uppercase();
    !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

fn sort_recent(objects: &mut [S3Object]) {
    objects.sort_by(|left, right| {
        right
            .last_modified
            .cmp(&left.last_modified)
            .then_with(|| left.key.cmp(&right.key))
    });
}

fn message(error: impl std::fmt::Display) -> AppError {
    AppError::Message(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_default_destination_from_object_key() {
        let uri: S3Uri = "s3://bucket/feed/file.parquet".parse().unwrap();
        assert_eq!(
            default_destination(&uri).unwrap(),
            PathBuf::from("file.parquet")
        );
    }

    #[test]
    fn bucket_root_is_not_a_download_target() {
        let uri: S3Uri = "s3://bucket".parse().unwrap();
        assert!(default_destination(&uri).is_err());
    }

    #[test]
    fn unsafe_cross_platform_default_names_require_an_explicit_destination() {
        for target in [
            "s3://bucket/feed/..\\outside",
            "s3://bucket/feed/C:outside",
            "s3://bucket/feed/CON.txt",
            "s3://bucket/feed/trailing.",
        ] {
            assert!(
                default_destination(&target.parse().unwrap()).is_err(),
                "{target}"
            );
        }
    }
}
