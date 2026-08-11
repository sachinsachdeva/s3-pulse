import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  downloadFileName,
  estimateCost,
  formatCost,
  normalizeRequestCounts,
  projectedMonthlyCost,
  mergeObjects,
  normalizeHistory,
  normalizeObjects,
  normalizeStatistics,
  normalizeTarget,
  normalizeWatchStatuses
} from '../src/adapters';

test('normalizes canonical and legacy object response shapes', () => {
  const result = normalizeObjects({ objects: [
    { key: 'feed/a.parquet', lastModified: '2025-01-01T00:00:00Z', size: 42 },
    { Key: 'feed/b.parquet', last_modified: '2025-01-01T00:15:00Z', Size: '43' }
  ] }, 's3://bucket/feed/');
  assert.equal(result.length, 2);
  assert.equal(result[1]?.size, 43);
  assert.equal(result[1]?.uri, 's3://bucket/feed/b.parquet');
});

test('merges incremental objects by key, sorts newest first, and bounds history', () => {
  const objects = mergeObjects(
    [{ key: 'a', lastModified: '2025-01-01T00:00:00Z', size: 1 }],
    [
      { key: 'a', lastModified: '2025-01-01T00:30:00Z', size: 2 },
      { key: 'b', lastModified: '2025-01-01T00:15:00Z', size: 3 }
    ],
    1
  );
  assert.deepEqual(objects, [{ key: 'a', lastModified: '2025-01-01T00:30:00Z', size: 2 }]);
});

test('normalizes backend statistics without inventing health', () => {
  assert.deepEqual(normalizeStatistics({ statistics: {
    median_interval_seconds: 900,
    currentGapSeconds: 120,
    status: 'healthy'
  } }), {
    objectCount: undefined,
    lastArrival: undefined,
    currentGapSeconds: 120,
    meanIntervalSeconds: undefined,
    medianIntervalSeconds: 900,
    p95IntervalSeconds: undefined,
    largestGapSeconds: undefined,
    filesPerHour: undefined,
    filesPerDay: undefined,
    expectedIntervalSeconds: undefined,
    health: 'healthy'
  });
});

test('normalizes structured backend feed health', () => {
  const statistics = normalizeStatistics({ statistics: {
    health: { status: 'late', expectedIntervalSeconds: 900 }
  } });
  assert.equal(statistics.health, 'late');
  assert.equal(statistics.expectedIntervalSeconds, 900);
});

test('normalizes history and watcher envelopes', () => {
  assert.deepEqual(normalizeHistory({ samples: [
    { key: 'b', lastModified: '2025-01-01T00:15:00Z', intervalSeconds: 900 },
    { key: 'a', lastModified: '2025-01-01T00:00:00Z' }
  ] }).map((sample) => sample.key), ['a', 'b']);
  assert.equal(normalizeWatchStatuses({ watchers: [
    { watcherId: 'one', status: 'running' }
  ] })[0]?.status, 'running');
});

test('validates and canonicalizes S3 targets', () => {
  assert.equal(normalizeTarget(' s3://data-bucket/feed/daily/ '), 's3://data-bucket/feed/daily/');
  assert.equal(normalizeTarget('s3://data-bucket//leading-slash'), 's3://data-bucket//leading-slash');
  assert.equal(normalizeTarget('https://example.com'), undefined);
  assert.equal(normalizeTarget('s3:///missing-bucket'), undefined);
});

test('proposes a save-dialog name for every object key', () => {
  assert.equal(downloadFileName('trades/trades_0057.csv'), 'trades_0057.csv');
  assert.equal(downloadFileName('trades_0057.csv'), 'trades_0057.csv');

  // Names the platform would reject, and keys that have no usable basename,
  // still have to produce something the dialog can show.
  assert.equal(downloadFileName('feed/a:b*c?.csv'), 'a_b_c_.csv');
  assert.equal(downloadFileName('feed/tab\u0001name.csv'), 'tab_name.csv');
  assert.equal(downloadFileName('feed/'), 'feed');
  assert.equal(downloadFileName(''), 's3-object');
  assert.equal(downloadFileName('feed/..'), 's3-object');

  // Hyphens, spaces and dots are legal and must survive.
  assert.equal(downloadFileName('feed/my report-2026.01.csv'), 'my report-2026.01.csv');
  assert.equal(downloadFileName('feed/' + 'x'.repeat(300) + '.csv').length, 240);
});

const RATES = { listPer1000: 0.005, getPer1000: 0.0004, currency: 'USD', enabled: true };

test('normalizes request counts and tolerates partial or absent payloads', () => {
  assert.deepEqual(normalizeRequestCounts({ listRequests: 12, getRequests: 3 }), { listRequests: 12, getRequests: 3 });
  // A backend that only reports one of the two must not zero the other away.
  assert.deepEqual(normalizeRequestCounts({ listRequests: 12 }), { listRequests: 12, getRequests: 0 });
  assert.deepEqual(normalizeRequestCounts({ list_requests: 4 }), { listRequests: 4, getRequests: 0 });
  assert.equal(normalizeRequestCounts(undefined), undefined);
  assert.equal(normalizeRequestCounts({}), undefined, 'an empty object is not a count');
});

test('prices requests from counts and projects monthly polling spend', () => {
  // 2,000 LIST at $0.005/1,000 plus 1,000 GET at $0.0004/1,000.
  assert.equal(estimateCost({ listRequests: 2000, getRequests: 1000 }, RATES), 0.0104);
  assert.equal(estimateCost(undefined, RATES), undefined);
  assert.equal(estimateCost({ listRequests: 1, getRequests: 0 }, { ...RATES, enabled: false }), undefined,
    'disabling the estimate suppresses it entirely');

  // A 30s poll is 86,400 LIST requests over 30 days.
  const monthly = projectedMonthlyCost(30, RATES);
  assert.ok(monthly !== undefined && Math.abs(monthly - 0.432) < 1e-9, 'monthly projection matches the request count');
  assert.ok((projectedMonthlyCost(5, RATES) ?? 0) > (projectedMonthlyCost(300, RATES) ?? 0),
    'polling faster costs more');
  assert.equal(projectedMonthlyCost(0, RATES), undefined, 'a zero interval has no projection');
  assert.equal(projectedMonthlyCost(30, { ...RATES, enabled: false }), undefined);
});

test('formats estimates without collapsing small amounts to zero', () => {
  assert.equal(formatCost(0.432, 'USD'), '$0.43');
  assert.equal(formatCost(0, 'USD'), '$0.00');
  assert.equal(formatCost(0.0004, 'USD'), '<$0.01', 'sub-cent spend stays visible');
  assert.equal(formatCost(1234.5, 'USD'), '$1235');
  assert.equal(formatCost(2.5, 'EUR'), '2.50 EUR', 'unknown currencies are labelled, not symbolised');
  assert.equal(formatCost(undefined, 'USD'), undefined);
});
