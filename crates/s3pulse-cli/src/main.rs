use std::process::ExitCode;

use clap::Parser;
use s3pulse_cli::{app, cli::Cli};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    init_diagnostics();
    match app::run(cli).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("s3pulse: {error}");
            ExitCode::FAILURE
        }
    }
}

fn init_diagnostics() {
    // The SDK looks for a region on the EC2 metadata endpoint when none is
    // configured. Off EC2 that address never answers, so it warns once per
    // attempt about a timeout that is entirely expected. Those lines are
    // surfaced verbatim in the extension's output channel, where they read as
    // failures and bury the real cause, so they are quietened by default.
    // RUST_LOG or S3PULSE_LOG still overrides this.
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("warn,aws_config::imds=error"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .try_init();
}
