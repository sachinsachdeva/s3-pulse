use std::{path::PathBuf, str::FromStr, time::Duration};

use clap::{Args, Parser, Subcommand};

pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(30);
pub const DEFAULT_HISTORY_LIMIT: usize = 10_000;
pub const MAX_HISTORY_LIMIT: usize = 100_000;

#[derive(Debug, Parser)]
#[command(
    name = "s3pulse",
    version,
    about = "Monitor S3 data feeds and their arrival cadence",
    propagate_version = true
)]
pub struct Cli {
    /// AWS named profile. Uses the normal AWS credential chain when omitted.
    #[arg(long, global = true, env = "AWS_PROFILE")]
    pub profile: Option<String>,

    /// AWS region override. Uses the normal AWS region chain when omitted.
    #[arg(long, global = true, env = "AWS_REGION")]
    pub region: Option<String>,

    /// Emit machine-readable JSON instead of human-readable text.
    #[arg(long, global = true)]
    pub json: bool,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Continuously watch a bucket prefix for newly arrived objects.
    Watch(WatchArgs),
    /// Show bounded recent object-arrival history.
    History(HistoryArgs),
    /// Calculate arrival-frequency statistics.
    Stats(QueryArgs),
    /// List objects under a bucket or prefix.
    List(QueryArgs),
    /// Download one S3 object to disk.
    Download(DownloadArgs),
    /// Run the persistent JSON-RPC backend.
    Serve(ServeArgs),
}

#[derive(Debug, Args)]
pub struct WatchArgs {
    /// S3 bucket or prefix URI, for example s3://bucket/feed/.
    pub target: String,

    /// Polling interval, for example 5s, 30s, or 1m.
    #[arg(long, default_value = "30s", value_parser = parse_duration)]
    pub interval: Duration,

    /// Expected feed interval used for health evaluation.
    #[arg(long, value_parser = parse_duration)]
    pub expected_interval: Option<Duration>,

    /// Maximum number of objects retained in memory.
    #[arg(
        long,
        default_value_t = DEFAULT_HISTORY_LIMIT,
        value_parser = parse_history_limit
    )]
    pub history_limit: usize,
}

#[derive(Debug, Args)]
pub struct HistoryArgs {
    /// S3 bucket or prefix URI.
    pub target: String,

    /// Only include objects modified during this recent window.
    #[arg(long, default_value = "24h", value_parser = parse_duration)]
    pub last: Duration,

    /// Maximum objects to print.
    #[arg(
        long,
        default_value_t = DEFAULT_HISTORY_LIMIT,
        value_parser = parse_history_limit
    )]
    pub limit: usize,
}

#[derive(Debug, Args)]
pub struct QueryArgs {
    /// S3 bucket or prefix URI.
    pub target: String,

    /// Maximum objects to retrieve and retain.
    #[arg(
        long,
        default_value_t = DEFAULT_HISTORY_LIMIT,
        value_parser = parse_history_limit
    )]
    pub limit: usize,
}

#[derive(Debug, Args)]
pub struct DownloadArgs {
    /// Full S3 object URI.
    pub target: String,

    /// Local destination path. Defaults to the object's file name.
    pub destination: Option<PathBuf>,

    /// Replace an existing destination file.
    #[arg(long)]
    pub overwrite: bool,
}

#[derive(Debug, Args)]
pub struct ServeArgs {
    /// Use newline-delimited JSON-RPC 2.0 over stdin/stdout.
    #[arg(long, required = true)]
    pub stdio: bool,
}

pub fn parse_duration(input: &str) -> Result<Duration, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("duration cannot be empty".to_owned());
    }

    let split = input
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(input.len());
    let (number, unit) = input.split_at(split);
    let value = u64::from_str(number).map_err(|_| format!("invalid duration: {input}"))?;
    let multiplier = match unit.to_ascii_lowercase().as_str() {
        "" | "s" | "sec" | "secs" | "second" | "seconds" => 1,
        "m" | "min" | "mins" | "minute" | "minutes" => 60,
        "h" | "hr" | "hrs" | "hour" | "hours" => 60 * 60,
        "d" | "day" | "days" => 24 * 60 * 60,
        _ => return Err(format!("unsupported duration unit in {input}")),
    };
    let seconds = value
        .checked_mul(multiplier)
        .ok_or_else(|| format!("duration is too large: {input}"))?;
    if seconds == 0 {
        return Err("duration must be greater than zero".to_owned());
    }
    Ok(Duration::from_secs(seconds))
}

fn parse_history_limit(input: &str) -> Result<usize, String> {
    let limit = usize::from_str(input).map_err(|_| format!("invalid history limit: {input}"))?;
    if !(1..=MAX_HISTORY_LIMIT).contains(&limit) {
        return Err(format!(
            "history limit must be between 1 and {MAX_HISTORY_LIMIT}"
        ));
    }
    Ok(limit)
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::*;

    #[test]
    fn parses_duration_units() {
        assert_eq!(parse_duration("30").unwrap(), Duration::from_secs(30));
        assert_eq!(parse_duration("5m").unwrap(), Duration::from_secs(300));
        assert_eq!(parse_duration("24h").unwrap(), Duration::from_secs(86_400));
        assert_eq!(
            parse_duration("2days").unwrap(),
            Duration::from_secs(172_800)
        );
    }

    #[test]
    fn rejects_zero_and_unknown_units() {
        assert!(parse_duration("0s").is_err());
        assert!(parse_duration("10ms").is_err());
        assert!(parse_duration("").is_err());
    }

    #[test]
    fn bounds_history_limits() {
        assert_eq!(parse_history_limit("1").unwrap(), 1);
        assert_eq!(
            parse_history_limit(&MAX_HISTORY_LIMIT.to_string()).unwrap(),
            MAX_HISTORY_LIMIT
        );
        assert!(parse_history_limit("0").is_err());
        assert!(parse_history_limit(&(MAX_HISTORY_LIMIT + 1).to_string()).is_err());
    }

    #[test]
    fn watch_uses_operational_defaults() {
        let cli = Cli::try_parse_from(["s3pulse", "watch", "s3://bucket/feed/"]).unwrap();
        let Command::Watch(args) = cli.command else {
            panic!("expected watch command");
        };
        assert_eq!(args.interval, DEFAULT_POLL_INTERVAL);
        assert_eq!(args.history_limit, DEFAULT_HISTORY_LIMIT);
    }

    #[test]
    fn global_flags_work_after_subcommand() {
        let cli = Cli::try_parse_from([
            "s3pulse",
            "stats",
            "s3://bucket/feed/",
            "--profile",
            "prod",
            "--json",
        ])
        .unwrap();
        assert_eq!(cli.profile.as_deref(), Some("prod"));
        assert!(cli.json);
    }

    #[test]
    fn serve_requires_explicit_stdio_transport() {
        assert!(Cli::try_parse_from(["s3pulse", "serve"]).is_err());
        assert!(Cli::try_parse_from(["s3pulse", "serve", "--stdio"]).is_ok());
    }
}
