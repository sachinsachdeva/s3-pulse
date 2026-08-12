import { worstSeverity } from './adapters';
import type { FeedHealth, HealthSeverity, WatchState } from './model';

// Alert policy, kept free of any vscode import so it is unit-testable.
//
// The split is deliberate: the backend owns the health *fact* (is this feed
// late, is this file the wrong size), and this owns the *policy* — what is
// worth interrupting someone for, and how often. Suppression state lives here
// rather than in Rust because backend.ts restarts the backend process on
// failure and replays every active watcher, so anything remembered on that side
// would forget itself after a crash and alert all over again.

export interface FeedSnapshot {
  readonly watcherId: string;
  readonly name: string;
  readonly state: WatchState;
  readonly health?: FeedHealth;
  readonly error?: string;
}

export interface AlertPolicy {
  /** Consecutive late observations before alerting, to ride out a single blip. */
  readonly confirmObservations: number;
  /** Minimum gap between alerts for one feed, in milliseconds. */
  readonly cooldownMs: number;
  readonly alertOnLate: boolean;
  readonly alertOnSizeAnomaly: boolean;
  readonly alertOnError: boolean;
  readonly alertOnRecovery: boolean;
}

export const DEFAULT_ALERT_POLICY: AlertPolicy = {
  confirmObservations: 2,
  cooldownMs: 900_000,
  alertOnLate: true,
  alertOnSizeAnomaly: true,
  alertOnError: true,
  alertOnRecovery: false
};

export type AlertKind = 'late' | 'size' | 'error' | 'recovered';

export interface Alert {
  readonly watcherId: string;
  readonly name: string;
  readonly kind: AlertKind;
  readonly severity: HealthSeverity;
  readonly message: string;
}

interface FeedMemory {
  /** Identity of the episode last alerted on, so one outage alerts once. */
  notifiedEpisode?: string;
  lastAlertAt?: number;
  consecutive: number;
  pendingEpisode?: string;
  everAlerted: boolean;
  severity: HealthSeverity;
}

/**
 * Identity for one continuous problem.
 *
 * `lateSince` is the backend's derivation of `lastArrival + lateAfterSeconds`,
 * so it does not move while a feed stays late and is recomputed identically
 * after a backend restart. That makes it a durable key: a feed late for six
 * hours produces one alert, not one per poll.
 */
function episodeOf(snapshot: FeedSnapshot): string | undefined {
  if (snapshot.state === 'error') {
    return `error:${snapshot.error ?? 'unknown'}`;
  }
  const health = snapshot.health;
  if (!health) {
    return undefined;
  }
  if (health.status === 'late') {
    return `late:${health.lateSince ?? 'unknown'}`;
  }
  if (health.sizeStatus === 'empty' || health.sizeStatus === 'small' || health.sizeStatus === 'large') {
    return `size:${health.sizeStatus}:${health.currentGapSeconds ?? 0}`;
  }
  return undefined;
}

function kindOf(snapshot: FeedSnapshot): AlertKind | undefined {
  if (snapshot.state === 'error') {
    return 'error';
  }
  const health = snapshot.health;
  if (!health) {
    return undefined;
  }
  if (health.status === 'late') {
    return 'late';
  }
  return health.sizeStatus === 'normal' || health.sizeStatus === 'unknown' ? undefined : 'size';
}

function describe(snapshot: FeedSnapshot, kind: AlertKind): string {
  const health = snapshot.health;
  switch (kind) {
    case 'error':
      return `${snapshot.name} stopped: ${snapshot.error ?? 'the backend reported an error'}`;
    case 'late': {
      const overdue = health?.overdueSeconds;
      const late = overdue !== undefined && Number.isFinite(overdue)
        ? ` — ${formatDuration(overdue)} past due`
        : '';
      return `${snapshot.name} is late${late}`;
    }
    case 'size':
      return health?.sizeStatus === 'empty'
        ? `${snapshot.name} arrived empty — the latest object is 0 bytes`
        : `${snapshot.name} arrived an unusual size (${health?.sizeStatus})`;
    case 'recovered':
      return `${snapshot.name} recovered`;
  }
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) {
    return `${total}s`;
  }
  if (total < 3600) {
    return `${Math.floor(total / 60)}m`;
  }
  if (total < 86_400) {
    return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
  }
  return `${Math.floor(total / 86_400)}d ${Math.floor((total % 86_400) / 3600)}h`;
}

/**
 * Decides which feed observations are worth interrupting someone about.
 *
 * Pure apart from the clock, which is injected so tests do not sleep.
 */
export class AlertEngine {
  readonly #memory = new Map<string, FeedMemory>();
  #policy: AlertPolicy;

  public constructor(policy: AlertPolicy = DEFAULT_ALERT_POLICY, private readonly now: () => number = Date.now) {
    this.#policy = policy;
  }

  public setPolicy(policy: AlertPolicy): void {
    this.#policy = policy;
  }

  public forget(watcherId: string): void {
    this.#memory.delete(watcherId);
  }

  /** Severity of every feed seen so far, worst first. */
  public worst(): HealthSeverity {
    return worstSeverity([...this.#memory.values()].map((entry) => entry.severity));
  }

  public severityOf(watcherId: string): HealthSeverity {
    return this.#memory.get(watcherId)?.severity ?? 'unknown';
  }

  /** Feeds source the engine has seen; used to size the status bar summary. */
  public counts(): Record<HealthSeverity, number> {
    const counts: Record<HealthSeverity, number> = { unknown: 0, ok: 0, warning: 0, critical: 0 };
    for (const entry of this.#memory.values()) {
      counts[entry.severity] += 1;
    }
    return counts;
  }

  /**
   * Feeds one observation in and returns an alert only when policy says this is
   * new, confirmed, and outside the cooldown.
   */
  public observe(snapshot: FeedSnapshot): Alert | undefined {
    const entry = this.#memory.get(snapshot.watcherId) ?? { consecutive: 0, everAlerted: false, severity: 'unknown' as HealthSeverity };
    const kind = kindOf(snapshot);
    const episode = episodeOf(snapshot);

    entry.severity = snapshot.state === 'error'
      ? 'critical'
      : snapshot.health?.severity ?? 'unknown';

    if (!kind || !episode) {
      const recovered = entry.everAlerted && entry.notifiedEpisode !== undefined;
      entry.consecutive = 0;
      entry.pendingEpisode = undefined;
      entry.notifiedEpisode = undefined;
      this.#memory.set(snapshot.watcherId, entry);
      if (recovered && this.#policy.alertOnRecovery) {
        entry.everAlerted = false;
        return { watcherId: snapshot.watcherId, name: snapshot.name, kind: 'recovered', severity: 'ok', message: describe(snapshot, 'recovered') };
      }
      return undefined;
    }

    if (!this.#enabled(kind)) {
      this.#memory.set(snapshot.watcherId, entry);
      return undefined;
    }

    // A new episode restarts confirmation; the same one accumulates.
    entry.consecutive = entry.pendingEpisode === episode ? entry.consecutive + 1 : 1;
    entry.pendingEpisode = episode;

    const alreadyNotified = entry.notifiedEpisode === episode;
    const confirmed = entry.consecutive >= Math.max(1, this.#policy.confirmObservations);
    const at = this.now();
    const cooledDown = entry.lastAlertAt === undefined || at - entry.lastAlertAt >= this.#policy.cooldownMs;

    if (alreadyNotified || !confirmed || !cooledDown) {
      this.#memory.set(snapshot.watcherId, entry);
      return undefined;
    }

    entry.notifiedEpisode = episode;
    entry.lastAlertAt = at;
    entry.everAlerted = true;
    this.#memory.set(snapshot.watcherId, entry);
    return {
      watcherId: snapshot.watcherId,
      name: snapshot.name,
      kind,
      severity: entry.severity,
      message: describe(snapshot, kind)
    };
  }

  #enabled(kind: AlertKind): boolean {
    switch (kind) {
      case 'late': return this.#policy.alertOnLate;
      case 'size': return this.#policy.alertOnSizeAnomaly;
      case 'error': return this.#policy.alertOnError;
      case 'recovered': return this.#policy.alertOnRecovery;
    }
  }
}
