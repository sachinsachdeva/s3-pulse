use chrono::{DateTime, Utc};
use s3pulse_core::S3Object;
use serde::Serialize;
use serde_json::Value;

pub fn print_json<T: Serialize>(value: &T, pretty: bool) -> Result<(), serde_json::Error> {
    if pretty {
        println!("{}", serde_json::to_string_pretty(value)?);
    } else {
        println!("{}", serde_json::to_string(value)?);
    }
    Ok(())
}

pub fn print_objects(objects: &[S3Object]) {
    if objects.is_empty() {
        println!("No objects found.");
        return;
    }

    println!("{:<24} {:>10}  KEY", "LAST MODIFIED (UTC)", "SIZE");
    for object in objects {
        println!(
            "{:<24} {:>10}  {}",
            object.last_modified.format("%Y-%m-%d %H:%M:%S"),
            format_bytes(object.size),
            terminal_text(&object.key)
        );
    }
}

pub fn print_arrival(object: &S3Object, previous: Option<DateTime<Utc>>) {
    let delta = previous.map(|previous| {
        let seconds = (object.last_modified - previous).num_milliseconds() as f64 / 1_000.0;
        format!("  Δ {}", format_duration(seconds.max(0.0)))
    });
    println!(
        "{}  {:>10}  {}{}",
        object.last_modified.format("%H:%M:%S"),
        format_bytes(object.size),
        terminal_text(&object.key),
        delta.as_deref().unwrap_or("")
    );
}

pub fn print_statistics(statistics: &Value) {
    println!(
        "Objects          {}",
        lookup(statistics, &["objectCount", "object_count", "count"])
            .and_then(Value::as_u64)
            .map(|value| value.to_string())
            .unwrap_or_else(|| "0".to_owned())
    );
    println!(
        "Last arrival     {}",
        lookup(statistics, &["lastArrival", "last_arrival"])
            .and_then(Value::as_str)
            .unwrap_or("—")
    );
    print_interval(
        "Mean interval",
        statistics,
        &["meanIntervalSeconds", "mean_interval_seconds"],
    );
    print_interval(
        "Median interval",
        statistics,
        &["medianIntervalSeconds", "median_interval_seconds"],
    );
    print_interval(
        "P95 interval",
        statistics,
        &["p95IntervalSeconds", "p95_interval_seconds"],
    );
    print_interval(
        "Largest gap",
        statistics,
        &["largestGapSeconds", "largest_gap_seconds"],
    );
    print_interval(
        "Current gap",
        statistics,
        &["currentGapSeconds", "current_gap_seconds"],
    );
    if let Some(health) = lookup(statistics, &["health"]) {
        let status = lookup(health, &["status"])
            .and_then(Value::as_str)
            .map(title_case)
            .unwrap_or_else(|| "Unknown".to_owned());
        println!("Health           {status}");
        if let Some(expected) = lookup(
            health,
            &["expectedIntervalSeconds", "expected_interval_seconds"],
        )
        .and_then(Value::as_f64)
        {
            let source = lookup(health, &["cadenceSource", "cadence_source"])
                .and_then(Value::as_str)
                .map(|source| format!(" ({})", title_case(source)))
                .unwrap_or_default();
            println!("Expected cadence {}{source}", format_duration(expected));
        }
    }
}

fn print_interval(label: &str, statistics: &Value, fields: &[&str]) {
    let value = lookup(statistics, fields)
        .and_then(Value::as_f64)
        .map(format_duration)
        .unwrap_or_else(|| "—".to_owned());
    println!("{label:<17}{value}");
}

fn lookup<'a>(value: &'a Value, fields: &[&str]) -> Option<&'a Value> {
    fields.iter().find_map(|field| value.get(field))
}

fn title_case(value: &str) -> String {
    let mut characters = value.chars();
    characters
        .next()
        .map(|first| first.to_uppercase().collect::<String>() + characters.as_str())
        .unwrap_or_default()
}

fn terminal_text(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_control() {
            output.extend(character.escape_default());
        } else {
            output.push(character);
        }
    }
    output
}

pub fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

pub fn format_duration(seconds: f64) -> String {
    if seconds < 60.0 {
        format!("{seconds:.1}s")
    } else if seconds < 3_600.0 {
        let minutes = (seconds / 60.0).floor();
        let remaining = seconds - minutes * 60.0;
        format!("{minutes:.0}m {remaining:.0}s")
    } else {
        let hours = (seconds / 3_600.0).floor();
        let minutes = ((seconds - hours * 3_600.0) / 60.0).floor();
        format!("{hours:.0}h {minutes:.0}m")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_bytes_for_terminal_output() {
        assert_eq!(format_bytes(999), "999 B");
        assert_eq!(format_bytes(1_048_576), "1.0 MiB");
    }

    #[test]
    fn formats_operational_durations() {
        assert_eq!(format_duration(15.2), "15.2s");
        assert_eq!(format_duration(905.0), "15m 5s");
        assert_eq!(format_duration(7_500.0), "2h 5m");
    }

    #[test]
    fn escapes_terminal_control_characters_in_object_keys() {
        assert_eq!(
            terminal_text("feed/ok\n\u{1b}[31m"),
            "feed/ok\\n\\u{1b}[31m"
        );
    }
}
