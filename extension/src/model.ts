export interface WatcherDefinition {
  readonly id: string;
  readonly name: string;
  readonly target: string;
  readonly profile?: string;
  readonly region?: string;
  readonly pollIntervalSeconds: number;
  readonly expectedIntervalSeconds?: number;
  readonly historyLimit: number;
  /** Bucket width in minutes for the "files per interval" graph. */
  readonly bucketMinutes: number;
  /**
   * Earlier periods to also watch when the target carries date placeholders.
   * Ignored for a plain target.
   */
  readonly lookbackPeriods: number;
}

/** Cumulative billable S3 requests reported by the backend for one watcher. */
export interface RequestCounts {
  readonly listRequests: number;
  readonly getRequests: number;
}

export type WatchState = 'running' | 'starting' | 'stopped' | 'error' | 'unknown';

export interface WatchStatus {
  readonly watcherId: string;
  readonly name?: string;
  readonly target?: string;
  readonly status: WatchState;
  readonly lastPollAt?: string;
  readonly objectCount?: number;
  readonly requestCounts?: RequestCounts;
  readonly health?: FeedHealth;
  readonly error?: string;
}

export interface ObjectRecord {
  readonly key: string;
  readonly lastModified: string;
  readonly size: number;
  readonly storageClass?: string;
  readonly etag?: string;
  readonly intervalSeconds?: number;
  readonly uri?: string;
}

export interface HistorySample {
  readonly key: string;
  readonly lastModified: string;
  readonly intervalSeconds?: number;
}

export type SizeStatus = 'unknown' | 'normal' | 'empty' | 'small' | 'large';
export type HealthSeverity = 'unknown' | 'ok' | 'warning' | 'critical';
export type FeedHealthStatus = 'unknown' | 'healthy' | 'late';

/** The backend's health verdict for one feed. Never derived in TypeScript. */
export interface FeedHealth {
  readonly status: FeedHealthStatus;
  readonly severity: HealthSeverity;
  readonly sizeStatus: SizeStatus;
  readonly expectedIntervalSeconds?: number;
  readonly lateAfterSeconds?: number;
  readonly currentGapSeconds?: number;
  readonly overdueSeconds?: number;
  /**
   * The instant this lateness episode began. Stable for its whole duration and
   * across backend restarts, which makes it the identity an alert is
   * de-duplicated on.
   */
  readonly lateSince?: string;
}

export interface FrequencyStatistics {
  readonly objectCount?: number;
  readonly lastArrival?: string;
  readonly currentGapSeconds?: number;
  readonly meanIntervalSeconds?: number;
  readonly medianIntervalSeconds?: number;
  readonly p95IntervalSeconds?: number;
  readonly largestGapSeconds?: number;
  readonly filesPerHour?: number;
  readonly filesPerDay?: number;
  readonly expectedIntervalSeconds?: number;
  readonly health?: string;
}

export interface DashboardSnapshot {
  readonly feed: WatcherDefinition;
  readonly status: WatchStatus;
  readonly objects: readonly ObjectRecord[];
  readonly history: readonly HistorySample[];
  readonly statistics: FrequencyStatistics;
  readonly defaultGraph: 'inter-arrival' | 'files-per-bucket';
  readonly requestCounts?: RequestCounts;
  readonly cost: CostModel;
}

/**
 * Per-1,000-request prices used to turn request counts into an estimate.
 * Sourced from user settings because S3 pricing varies by region and changes.
 */
export interface CostModel {
  readonly listPer1000: number;
  readonly getPer1000: number;
  readonly currency: string;
  readonly enabled: boolean;
}

export interface DownloadProgress {
  readonly watcherId: string;
  readonly downloadId?: string;
  readonly key?: string;
  readonly bytesTransferred: number;
  readonly totalBytes?: number;
  readonly done: boolean;
}
