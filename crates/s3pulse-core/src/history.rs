use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};

use crate::{
    ArrivalInterval, ArrivalStatistics, CadenceSource, ConfigError, FeedHealth, FeedHealthStatus,
    HistorySnapshot, HistoryUpdate, ObjectChange, ObjectChangeKind, S3Object,
    DEFAULT_LATE_MULTIPLIER,
};

const MIN_INTERVALS_TO_LEARN_CADENCE: usize = 2;

/// In-memory arrival history bounded by object count.
///
/// Object keys are identities. A second observation with changed metadata is
/// an update, while an identical observation is ignored. Retention always
/// keeps the newest arrivals; ties are resolved by key so results do not
/// depend on S3 pagination or input order.
#[derive(Clone, Debug)]
pub struct RollingHistory {
    capacity: usize,
    expected_interval_seconds: Option<u64>,
    by_key: BTreeMap<String, S3Object>,
}

impl RollingHistory {
    pub fn new(capacity: usize) -> Result<Self, ConfigError> {
        Self::with_expected_interval(capacity, None)
    }

    pub fn with_expected_interval(
        capacity: usize,
        expected_interval_seconds: Option<u64>,
    ) -> Result<Self, ConfigError> {
        if capacity == 0 {
            return Err(ConfigError::ZeroHistoryCapacity);
        }
        if expected_interval_seconds == Some(0) {
            return Err(ConfigError::ZeroExpectedInterval);
        }
        Ok(Self {
            capacity,
            expected_interval_seconds,
            by_key: BTreeMap::new(),
        })
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn expected_interval_seconds(&self) -> Option<u64> {
        self.expected_interval_seconds
    }

    pub fn set_expected_interval_seconds(
        &mut self,
        expected_interval_seconds: Option<u64>,
    ) -> Result<(), ConfigError> {
        if expected_interval_seconds == Some(0) {
            return Err(ConfigError::ZeroExpectedInterval);
        }
        self.expected_interval_seconds = expected_interval_seconds;
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.by_key.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_key.is_empty()
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.by_key.contains_key(key)
    }

    pub fn get(&self, key: &str) -> Option<&S3Object> {
        self.by_key.get(key)
    }

    /// Returns owned objects newest first, with key-ascending tie breaking.
    pub fn objects(&self) -> Vec<S3Object> {
        let mut objects: Vec<_> = self.by_key.values().cloned().collect();
        objects.sort_by(newest_first);
        objects
    }

    pub fn upsert(&mut self, object: S3Object) -> HistoryUpdate {
        self.upsert_many(std::iter::once(object))
    }

    /// Atomically applies a listing and enforces the configured capacity.
    /// Duplicate keys within the input use the final observation.
    pub fn upsert_many<I>(&mut self, objects: I) -> HistoryUpdate
    where
        I: IntoIterator<Item = S3Object>,
    {
        let old_keys: BTreeSet<_> = self.by_key.keys().cloned().collect();
        let mut incoming = BTreeMap::new();
        for object in objects {
            incoming.insert(object.key.clone(), object);
        }

        let mut changes = Vec::new();
        for (key, object) in incoming {
            match self.by_key.get(&key) {
                None => changes.push(ObjectChange {
                    kind: ObjectChangeKind::Added,
                    object: object.clone(),
                    previous: None,
                }),
                Some(previous) if previous != &object => changes.push(ObjectChange {
                    kind: ObjectChangeKind::Updated,
                    object: object.clone(),
                    previous: Some(previous.clone()),
                }),
                Some(_) => {}
            }
            self.by_key.insert(key, object);
        }

        let mut ranked: Vec<_> = self.by_key.values().cloned().collect();
        ranked.sort_by(newest_first);
        let retained_keys: BTreeSet<_> = ranked
            .iter()
            .take(self.capacity)
            .map(|object| object.key.clone())
            .collect();

        // Do not report over-capacity objects from a full S3 listing as
        // repeatedly evicted on every poll. Only previously retained entries
        // are eviction events.
        let mut evicted: Vec<_> = self
            .by_key
            .values()
            .filter(|object| !retained_keys.contains(&object.key) && old_keys.contains(&object.key))
            .cloned()
            .collect();
        self.by_key
            .retain(|key, _object| retained_keys.contains(key));

        changes.retain(|change| retained_keys.contains(&change.object.key));
        changes.sort_by(|left, right| newest_first(&left.object, &right.object));
        evicted.sort_by(oldest_first);

        HistoryUpdate { changes, evicted }
    }

    pub fn intervals(&self) -> Vec<ArrivalInterval> {
        intervals_for(&self.by_key)
    }

    /// Calculates statistics as a value for every history size. Metrics that
    /// require more observations are `None` rather than making the whole
    /// result optional.
    pub fn statistics_at(
        &self,
        as_of: DateTime<Utc>,
        expected_interval_seconds: Option<u64>,
    ) -> ArrivalStatistics {
        statistics_for(
            &self.by_key,
            as_of,
            expected_interval_seconds.or(self.expected_interval_seconds),
        )
    }

    pub fn statistics(&self, expected_interval_seconds: Option<u64>) -> ArrivalStatistics {
        self.statistics_at(Utc::now(), expected_interval_seconds)
    }

    pub fn snapshot_at(
        &self,
        as_of: DateTime<Utc>,
        expected_interval_seconds: Option<u64>,
    ) -> HistorySnapshot {
        HistorySnapshot {
            objects: self.objects(),
            intervals: self.intervals(),
            statistics: self.statistics_at(as_of, expected_interval_seconds),
        }
    }

    pub fn snapshot(&self, expected_interval_seconds: Option<u64>) -> HistorySnapshot {
        self.snapshot_at(Utc::now(), expected_interval_seconds)
    }
}

fn newest_first(left: &S3Object, right: &S3Object) -> Ordering {
    right
        .last_modified
        .cmp(&left.last_modified)
        .then_with(|| left.key.cmp(&right.key))
}

fn oldest_first(left: &S3Object, right: &S3Object) -> Ordering {
    left.last_modified
        .cmp(&right.last_modified)
        .then_with(|| left.key.cmp(&right.key))
}

fn chronological_objects(by_key: &BTreeMap<String, S3Object>) -> Vec<&S3Object> {
    let mut objects: Vec<_> = by_key.values().collect();
    objects.sort_by(|left, right| {
        left.last_modified
            .cmp(&right.last_modified)
            .then_with(|| left.key.cmp(&right.key))
    });
    objects
}

fn intervals_for(by_key: &BTreeMap<String, S3Object>) -> Vec<ArrivalInterval> {
    chronological_objects(by_key)
        .windows(2)
        .map(|pair| {
            let previous = pair[0];
            let current = pair[1];
            ArrivalInterval {
                previous_key: previous.key.clone(),
                key: current.key.clone(),
                previous_arrival: previous.last_modified,
                arrival: current.last_modified,
                seconds: seconds_between(previous.last_modified, current.last_modified),
            }
        })
        .collect()
}

fn statistics_for(
    by_key: &BTreeMap<String, S3Object>,
    as_of: DateTime<Utc>,
    configured_expected_seconds: Option<u64>,
) -> ArrivalStatistics {
    let objects = chronological_objects(by_key);
    let first_arrival = objects.first().map(|object| object.last_modified);
    let last_arrival = objects.last().map(|object| object.last_modified);
    let mut interval_values: Vec<_> = objects
        .windows(2)
        .map(|pair| seconds_between(pair[0].last_modified, pair[1].last_modified))
        .collect();
    interval_values.sort_by(f64::total_cmp);

    let mean = (!interval_values.is_empty())
        .then(|| interval_values.iter().sum::<f64>() / interval_values.len() as f64);
    let median = median(&interval_values);
    let p95 = percentile_nearest_rank(&interval_values, 0.95);
    let largest = interval_values.last().copied();
    let current_gap = last_arrival.map(|last| seconds_between(last.min(as_of), as_of));

    let observed_span = match (first_arrival, last_arrival) {
        (Some(first), Some(last)) => seconds_between(first, last),
        _ => 0.0,
    };
    let files_per_hour =
        (observed_span > 0.0).then(|| interval_values.len() as f64 * 3_600.0 / observed_span);
    let files_per_day = files_per_hour.map(|per_hour| per_hour * 24.0);

    let configured = configured_expected_seconds.filter(|seconds| *seconds > 0);
    let learned = (interval_values.len() >= MIN_INTERVALS_TO_LEARN_CADENCE)
        .then_some(median)
        .flatten()
        .filter(|seconds| *seconds > 0.0);
    let (expected, source) = if let Some(seconds) = configured {
        (Some(seconds as f64), Some(CadenceSource::Configured))
    } else if let Some(seconds) = learned {
        (Some(seconds), Some(CadenceSource::Learned))
    } else {
        (None, None)
    };
    let late_after = expected.map(|seconds| seconds * DEFAULT_LATE_MULTIPLIER);
    let status = match (current_gap, late_after) {
        (Some(gap), Some(threshold)) if gap > threshold => FeedHealthStatus::Late,
        (Some(_), Some(_)) => FeedHealthStatus::Healthy,
        _ => FeedHealthStatus::Unknown,
    };
    let health = FeedHealth {
        status,
        cadence_source: source,
        expected_interval_seconds: expected,
        late_after_seconds: late_after,
        current_gap_seconds: current_gap,
    };

    ArrivalStatistics {
        as_of,
        object_count: objects.len(),
        interval_count: interval_values.len(),
        first_arrival,
        last_arrival,
        mean_interval_seconds: mean,
        median_interval_seconds: median,
        p95_interval_seconds: p95,
        largest_gap_seconds: largest,
        current_gap_seconds: current_gap,
        files_per_hour,
        files_per_day,
        health,
    }
}

fn seconds_between(earlier: DateTime<Utc>, later: DateTime<Utc>) -> f64 {
    (later - earlier).num_milliseconds().max(0) as f64 / 1_000.0
}

fn median(sorted: &[f64]) -> Option<f64> {
    match sorted.len() {
        0 => None,
        length if length % 2 == 1 => Some(sorted[length / 2]),
        length => Some((sorted[length / 2 - 1] + sorted[length / 2]) / 2.0),
    }
}

fn percentile_nearest_rank(sorted: &[f64], percentile: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = (percentile * sorted.len() as f64).ceil() as usize;
    Some(sorted[rank.saturating_sub(1).min(sorted.len() - 1)])
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn at(seconds: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(seconds, 0).single().unwrap()
    }

    fn object(key: &str, seconds: i64, size: u64) -> S3Object {
        S3Object {
            key: key.to_owned(),
            last_modified: at(seconds),
            size,
            etag: Some(format!("etag-{key}-{size}")),
            storage_class: Some("STANDARD".to_owned()),
        }
    }

    #[test]
    fn rejects_zero_capacity() {
        assert_eq!(
            RollingHistory::new(0).unwrap_err(),
            ConfigError::ZeroHistoryCapacity
        );
        assert_eq!(
            RollingHistory::with_expected_interval(1, Some(0)).unwrap_err(),
            ConfigError::ZeroExpectedInterval
        );
    }

    #[test]
    fn stored_cadence_is_used_and_can_be_reconfigured() {
        let mut history = RollingHistory::with_expected_interval(2, Some(10)).unwrap();
        history.upsert(object("a", 0, 1));
        assert_eq!(
            history.statistics_at(at(20), None).health.status,
            FeedHealthStatus::Late
        );
        history.set_expected_interval_seconds(Some(20)).unwrap();
        assert_eq!(
            history.statistics_at(at(20), None).health.status,
            FeedHealthStatus::Healthy
        );
        assert_eq!(
            history.set_expected_interval_seconds(Some(0)),
            Err(ConfigError::ZeroExpectedInterval)
        );
    }

    #[test]
    fn additions_updates_and_identical_observations_are_distinguished() {
        let mut history = RollingHistory::new(4).unwrap();
        let added = history.upsert(object("a", 10, 1));
        assert_eq!(added.changes[0].kind, ObjectChangeKind::Added);
        assert!(added.changes[0].previous.is_none());

        assert!(history.upsert(object("a", 10, 1)).is_empty());

        let updated = history.upsert(object("a", 10, 2));
        assert_eq!(updated.changes[0].kind, ObjectChangeKind::Updated);
        assert_eq!(updated.changes[0].previous.as_ref().unwrap().size, 1);
        assert_eq!(history.get("a").unwrap().size, 2);
    }

    #[test]
    fn retention_and_output_order_are_deterministic() {
        let mut first = RollingHistory::new(3).unwrap();
        let mut second = RollingHistory::new(3).unwrap();
        let values = vec![
            object("z", 20, 1),
            object("a", 20, 1),
            object("middle", 15, 1),
            object("old", 5, 1),
        ];
        first.upsert_many(values.clone());
        second.upsert_many(values.into_iter().rev());

        let keys = |history: &RollingHistory| {
            history
                .objects()
                .into_iter()
                .map(|value| value.key)
                .collect::<Vec<_>>()
        };
        assert_eq!(keys(&first), vec!["a", "z", "middle"]);
        assert_eq!(keys(&first), keys(&second));
        assert!(!first.contains_key("old"));
    }

    #[test]
    fn older_full_listing_entries_do_not_emit_repeated_evictions() {
        let mut history = RollingHistory::new(2).unwrap();
        history.upsert_many([object("a", 30, 1), object("b", 20, 1)]);
        let update =
            history.upsert_many([object("a", 30, 1), object("b", 20, 1), object("old", 10, 1)]);
        assert!(update.is_empty());
    }

    #[test]
    fn a_new_arrival_evicts_the_oldest_retained_object() {
        let mut history = RollingHistory::new(2).unwrap();
        history.upsert_many([object("old", 10, 1), object("middle", 20, 1)]);
        let update = history.upsert(object("new", 30, 1));
        assert_eq!(
            update
                .added()
                .map(|value| value.key.as_str())
                .collect::<Vec<_>>(),
            vec!["new"]
        );
        assert_eq!(update.evicted[0].key, "old");
    }

    #[test]
    fn calculates_mean_median_nearest_rank_p95_and_rates() {
        let mut history = RollingHistory::new(10).unwrap();
        history.upsert_many([
            object("a", 0, 1),
            object("b", 10, 1),
            object("c", 30, 1),
            object("d", 60, 1),
            object("e", 160, 1),
        ]);
        let stats = history.statistics_at(at(310), Some(30));
        assert_eq!(stats.object_count, 5);
        assert_eq!(stats.interval_count, 4);
        assert_eq!(stats.mean_interval_seconds, Some(40.0));
        assert_eq!(stats.median_interval_seconds, Some(25.0));
        assert_eq!(stats.p95_interval_seconds, Some(100.0));
        assert_eq!(stats.largest_gap_seconds, Some(100.0));
        assert_eq!(stats.current_gap_seconds, Some(150.0));
        assert_eq!(stats.files_per_hour, Some(90.0));
        assert_eq!(stats.files_per_day, Some(2_160.0));
        assert_eq!(stats.health.status, FeedHealthStatus::Late);
        assert_eq!(stats.health.cadence_source, Some(CadenceSource::Configured));
        assert_eq!(stats.health.late_after_seconds, Some(45.0));
    }

    #[test]
    fn learns_median_cadence_only_after_two_intervals() {
        let mut history = RollingHistory::new(10).unwrap();
        history.upsert_many([object("a", 0, 1), object("b", 10, 1), object("c", 30, 1)]);
        let stats = history.statistics_at(at(35), None);
        assert_eq!(stats.health.cadence_source, Some(CadenceSource::Learned));
        assert_eq!(stats.health.expected_interval_seconds, Some(15.0));
        assert_eq!(stats.health.status, FeedHealthStatus::Healthy);
    }

    #[test]
    fn configured_cadence_works_with_one_arrival_and_future_arrivals_clamp_gap() {
        let mut history = RollingHistory::new(2).unwrap();
        history.upsert(object("future", 100, 1));
        let stats = history.statistics_at(at(50), Some(10));
        assert_eq!(stats.current_gap_seconds, Some(0.0));
        assert_eq!(stats.health.status, FeedHealthStatus::Healthy);
    }

    #[test]
    fn empty_history_returns_a_complete_value_with_optional_metrics() {
        let history = RollingHistory::new(2).unwrap();
        let stats = history.statistics_at(at(10), None);
        assert_eq!(stats.object_count, 0);
        assert_eq!(stats.mean_interval_seconds, None);
        assert_eq!(stats.current_gap_seconds, None);
        assert_eq!(stats.health.status, FeedHealthStatus::Unknown);
        assert!(history.snapshot_at(at(10), None).objects.is_empty());
    }
}
