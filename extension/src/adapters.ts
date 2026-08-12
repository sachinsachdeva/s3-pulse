import type {
  CostModel,
  FeedHealth,
  FeedHealthStatus,
  HealthSeverity,
  SizeStatus,
  DownloadProgress,
  FrequencyStatistics,
  HistorySample,
  ObjectRecord,
  RequestCounts,
  WatchState,
  WatchStatus,
  WatcherDefinition
} from './model';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function valueAt(source: UnknownRecord | undefined, ...names: readonly string[]): unknown {
  for (const name of names) {
    const value = source?.[name];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function stringAt(source: UnknownRecord | undefined, ...names: readonly string[]): string | undefined {
  const value = valueAt(source, ...names);
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  return undefined;
}

function numberAt(source: UnknownRecord | undefined, ...names: readonly string[]): number | undefined {
  const value = valueAt(source, ...names);
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanAt(source: UnknownRecord | undefined, ...names: readonly string[]): boolean | undefined {
  const value = valueAt(source, ...names);
  return typeof value === 'boolean' ? value : undefined;
}

function envelope(value: unknown, ...keys: readonly string[]): unknown {
  const source = record(value);
  for (const key of keys) {
    if (source?.[key] !== undefined) {
      return source[key];
    }
  }
  return value;
}

export function normalizeTarget(input: string): string | undefined {
  const value = input.trim();
  const match = /^s3:\/\/([^/\s]+)(?:\/(.*))?$/i.exec(value);
  if (!match?.[1]) {
    return undefined;
  }
  const prefix = match[2] ?? '';
  return `s3://${match[1]}/${prefix}`;
}

export function targetBucket(target: string): string | undefined {
  return /^s3:\/\/([^/]+)/i.exec(target)?.[1];
}

export function objectUri(target: string, key: string): string {
  const bucket = targetBucket(target);
  return bucket ? `s3://${bucket}/${key.replace(/^\/+/, '')}` : target;
}

// Derives the name a save dialog should propose for an object key. Always
// returns a usable name, so the dialog never falls back to "Untitled".
export function downloadFileName(key: string): string {
  const base = key.replace(/\/+$/, '').split('/').pop() ?? '';
  const safe = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 240);
  return safe && safe !== '.' && safe !== '..' ? safe : 's3-object';
}

const SIZE_STATUSES: readonly SizeStatus[] = ['unknown', 'normal', 'empty', 'small', 'large'];
const SEVERITIES: readonly HealthSeverity[] = ['unknown', 'ok', 'warning', 'critical'];
const HEALTH_STATUSES: readonly FeedHealthStatus[] = ['unknown', 'healthy', 'late'];

/**
 * Reads the backend's health verdict. Unknown values from a newer backend
 * degrade to 'unknown' rather than being guessed at, and nothing here invents a
 * verdict the backend did not give.
 */
export function normalizeHealth(value: unknown): FeedHealth | undefined {
  const source = record(envelope(value, 'health'));
  if (!source) {
    return undefined;
  }
  const status = stringAt(source, 'status');
  if (status === undefined) {
    return undefined;
  }
  const oneOf = <T extends string>(allowed: readonly T[], raw: string | undefined, fallback: T): T =>
    allowed.includes(raw as T) ? (raw as T) : fallback;
  return {
    status: oneOf(HEALTH_STATUSES, status, 'unknown'),
    severity: oneOf(SEVERITIES, stringAt(source, 'severity'), 'unknown'),
    sizeStatus: oneOf(SIZE_STATUSES, stringAt(source, 'sizeStatus', 'size_status'), 'unknown'),
    expectedIntervalSeconds: numberAt(source, 'expectedIntervalSeconds', 'expected_interval_seconds'),
    lateAfterSeconds: numberAt(source, 'lateAfterSeconds', 'late_after_seconds'),
    currentGapSeconds: numberAt(source, 'currentGapSeconds', 'current_gap_seconds'),
    overdueSeconds: numberAt(source, 'overdueSeconds', 'overdue_seconds'),
    lateSince: stringAt(source, 'lateSince', 'late_since')
  };
}

const SEVERITY_ORDER: Record<HealthSeverity, number> = { unknown: 0, ok: 1, warning: 2, critical: 3 };

/** The worst severity in a set, for a single roll-up indicator. */
export function worstSeverity(values: readonly HealthSeverity[]): HealthSeverity {
  return values.reduce<HealthSeverity>(
    (worst, value) => (SEVERITY_ORDER[value] > SEVERITY_ORDER[worst] ? value : worst),
    'unknown'
  );
}

export function normalizeRequestCounts(value: unknown): RequestCounts | undefined {
  const source = record(value);
  if (!source) {
    return undefined;
  }
  const listRequests = numberAt(source, 'listRequests', 'list_requests');
  const getRequests = numberAt(source, 'getRequests', 'get_requests');
  if (listRequests === undefined && getRequests === undefined) {
    return undefined;
  }
  return { listRequests: listRequests ?? 0, getRequests: getRequests ?? 0 };
}

/**
 * Estimated spend for a set of requests. Returns undefined rather than zero
 * when there is nothing to price, so callers can omit the display entirely.
 */
export function estimateCost(counts: RequestCounts | undefined, cost: CostModel): number | undefined {
  if (!counts || !cost.enabled) {
    return undefined;
  }
  const list = (counts.listRequests / 1000) * cost.listPer1000;
  const get = (counts.getRequests / 1000) * cost.getPer1000;
  return Number.isFinite(list + get) ? list + get : undefined;
}

/**
 * Projected monthly LIST spend for a poll interval, assuming one page per poll.
 * A prefix holding more than 1,000 objects pages, and so costs proportionally
 * more than this floor.
 */
export function projectedMonthlyCost(pollIntervalSeconds: number, cost: CostModel): number | undefined {
  if (!cost.enabled || !Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds <= 0) {
    return undefined;
  }
  const pollsPerMonth = (30 * 24 * 60 * 60) / pollIntervalSeconds;
  return (pollsPerMonth / 1000) * cost.listPer1000;
}

/** Formats an estimate, keeping sub-cent amounts legible rather than "$0.00". */
export function formatCost(value: number | undefined, currency: string): string | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  const symbol = currency === 'USD' ? '$' : '';
  const suffix = symbol ? '' : ' ' + currency;
  if (value > 0 && value < 0.01) {
    return '<' + symbol + '0.01' + suffix;
  }
  const digits = value < 10 ? 2 : 0;
  return symbol + value.toFixed(digits) + suffix;
}

export function normalizeObject(value: unknown, target?: string): ObjectRecord | undefined {
  const source = record(value);
  const key = stringAt(source, 'key', 'Key', 'name', 'objectKey');
  const modified = stringAt(source, 'lastModified', 'last_modified', 'modified', 'timestamp');
  if (!key || !modified) {
    return undefined;
  }

  const normalized: ObjectRecord = {
    key,
    lastModified: modified,
    size: Math.max(0, numberAt(source, 'size', 'Size', 'bytes', 'contentLength') ?? 0),
    storageClass: stringAt(source, 'storageClass', 'storage_class', 'StorageClass'),
    etag: stringAt(source, 'etag', 'eTag', 'ETag'),
    intervalSeconds: numberAt(source, 'intervalSeconds', 'interval_seconds', 'deltaSeconds', 'delta_seconds'),
    uri: stringAt(source, 'uri', 's3Uri') ?? (target ? objectUri(target, key) : undefined)
  };
  return normalized;
}

function arrayFrom(value: unknown, ...keys: readonly string[]): readonly unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  const nested = envelope(value, ...keys);
  return Array.isArray(nested) ? nested : nested === value ? [] : arrayFrom(nested, ...keys);
}

export function normalizeObjects(value: unknown, target?: string): ObjectRecord[] {
  return arrayFrom(value, 'objects', 'items', 'added')
    .map((item) => normalizeObject(item, target))
    .filter((item): item is ObjectRecord => item !== undefined);
}

export function mergeObjects(
  current: readonly ObjectRecord[],
  incoming: readonly ObjectRecord[],
  limit: number
): ObjectRecord[] {
  const objects = new Map(current.map((item) => [item.key, item]));
  for (const item of incoming) {
    objects.set(item.key, { ...objects.get(item.key), ...item });
  }
  return [...objects.values()]
    .sort((left, right) => timestamp(right.lastModified) - timestamp(left.lastModified) || left.key.localeCompare(right.key))
    .slice(0, Math.max(1, limit));
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeHistory(value: unknown): HistorySample[] {
  return arrayFrom(value, 'samples', 'history', 'items')
    .map((item): HistorySample | undefined => {
      const source = record(item);
      const key = stringAt(source, 'key', 'Key', 'name');
      const lastModified = stringAt(source, 'lastModified', 'last_modified', 'timestamp');
      if (!key || !lastModified) {
        return undefined;
      }
      return {
        key,
        lastModified,
        intervalSeconds: numberAt(source, 'intervalSeconds', 'interval_seconds', 'deltaSeconds')
      };
    })
    .filter((sample): sample is HistorySample => sample !== undefined)
    .sort((left, right) => timestamp(left.lastModified) - timestamp(right.lastModified));
}

export function normalizeStatistics(value: unknown): FrequencyStatistics {
  const source = record(envelope(value, 'statistics', 'frequency', 'stats'));
  const healthValue = valueAt(source, 'health');
  const healthSource = record(healthValue);
  return {
    objectCount: numberAt(source, 'objectCount', 'object_count', 'count'),
    lastArrival: stringAt(source, 'lastArrival', 'last_arrival', 'lastModified'),
    currentGapSeconds: numberAt(source, 'currentGapSeconds', 'current_gap_seconds', 'currentGap'),
    meanIntervalSeconds: numberAt(source, 'meanIntervalSeconds', 'mean_interval_seconds', 'meanInterval'),
    medianIntervalSeconds: numberAt(source, 'medianIntervalSeconds', 'median_interval_seconds', 'medianInterval'),
    p95IntervalSeconds: numberAt(source, 'p95IntervalSeconds', 'p95_interval_seconds', 'p95Interval'),
    largestGapSeconds: numberAt(source, 'largestGapSeconds', 'largest_gap_seconds', 'largestGap'),
    filesPerHour: numberAt(source, 'filesPerHour', 'files_per_hour'),
    filesPerDay: numberAt(source, 'filesPerDay', 'files_per_day'),
    expectedIntervalSeconds: numberAt(source, 'expectedIntervalSeconds', 'expected_interval_seconds')
      ?? numberAt(healthSource, 'expectedIntervalSeconds', 'expected_interval_seconds'),
    health: (typeof healthValue === 'string' && healthValue ? healthValue : undefined)
      ?? stringAt(healthSource, 'status', 'state')
      ?? stringAt(source, 'status', 'state')
  };
}

function watchState(value: unknown): WatchState {
  const state = typeof value === 'string' ? value.toLowerCase() : '';
  if (state === 'running' || state === 'starting' || state === 'stopped' || state === 'error') {
    return state;
  }
  return 'unknown';
}

export function normalizeWatchStatus(value: unknown, fallbackId: string): WatchStatus {
  const source = record(envelope(value, 'watcher', 'watch'));
  const errorValue = valueAt(source, 'error');
  const error = typeof errorValue === 'string'
    ? errorValue
    : stringAt(record(errorValue), 'message', 'description');
  return {
    watcherId: stringAt(source, 'watcherId', 'watcher_id', 'id') ?? fallbackId,
    name: stringAt(source, 'name'),
    target: stringAt(source, 'target', 'uri'),
    status: watchState(valueAt(source, 'status', 'state')),
    lastPollAt: stringAt(source, 'lastPollAt', 'last_poll_at'),
    objectCount: numberAt(source, 'objectCount', 'object_count'),
    requestCounts: normalizeRequestCounts(valueAt(source, 'requestCounts', 'request_counts')),
    health: normalizeHealth(valueAt(source, 'health')),
    error
  };
}

export function normalizeWatchStatuses(value: unknown): WatchStatus[] {
  return arrayFrom(value, 'watchers', 'items')
    .map((item) => normalizeWatchStatus(item, ''))
    .filter((status) => status.watcherId !== '');
}

export function normalizeDownloadProgress(value: unknown): DownloadProgress | undefined {
  const source = record(value);
  const watcherId = stringAt(source, 'watcherId', 'watcher_id');
  const bytesTransferred = numberAt(source, 'bytesTransferred', 'bytes_transferred', 'bytes');
  if (!watcherId || bytesTransferred === undefined) {
    return undefined;
  }
  return {
    watcherId,
    downloadId: stringAt(source, 'downloadId', 'download_id'),
    key: stringAt(source, 'key'),
    bytesTransferred,
    totalBytes: numberAt(source, 'totalBytes', 'total_bytes', 'size'),
    done: booleanAt(source, 'done', 'complete') ?? false
  };
}

/** Date placeholders the backend understands, for validating a target early. */
const DATE_PLACEHOLDERS = new Set(['yyyy', 'yy', 'MM', 'M', 'dd', 'd', 'HH', 'H']);

/**
 * Reports the first unusable date placeholder in a target, or undefined when it
 * is fine. Mirrors the backend's grammar so a typo is caught in the wizard
 * rather than becoming a feed that silently watches a prefix nothing writes to.
 */
export function templateProblem(target: string): string | undefined {
  const withoutEscapes = target.replace(/\{\{|\}\}/g, '');
  for (const match of withoutEscapes.matchAll(/\{([^}]*)\}/g)) {
    const name = match[1] ?? '';
    if (DATE_PLACEHOLDERS.has(name)) {
      continue;
    }
    return name === 'mm' || name === 'm'
      ? '{mm} means minutes, not months; use {MM} for a zero-padded month'
      : `Unknown date placeholder {${name}}; use yyyy, yy, MM, M, dd, d, HH or H`;
  }
  if (/\{[^}]*$/.test(withoutEscapes)) {
    return 'A date placeholder is missing its closing brace';
  }
  return undefined;
}

/**
 * Validates an IANA zone name using the platform's own database, so the wizard
 * rejects a typo rather than letting it become a feed that watches the wrong
 * prefix for hours a day.
 */
export function timeZoneProblem(value: string): string | undefined {
  const name = value.trim();
  if (!name) {
    return undefined;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return undefined;
  } catch {
    return `Unknown time zone "${name}"; use an IANA name such as Australia/Sydney`;
  }
}

/** Whether a target carries any date placeholder at all. */
export function hasDateTemplate(target: string): boolean {
  return /\{(yyyy|yy|MM|M|dd|d|HH|H)\}/.test(target.replace(/\{\{|\}\}/g, ''));
}

export function serializeWatcher(watcher: WatcherDefinition): UnknownRecord {
  return {
    id: watcher.id,
    name: watcher.name,
    target: watcher.target,
    profile: watcher.profile,
    region: watcher.region,
    pollIntervalSeconds: watcher.pollIntervalSeconds,
    expectedIntervalSeconds: watcher.expectedIntervalSeconds,
    historyLimit: watcher.historyLimit,
    lookbackPeriods: watcher.lookbackPeriods,
    timeZone: watcher.timeZone
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';
}
