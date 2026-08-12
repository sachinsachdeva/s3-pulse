import * as vscode from 'vscode';
import { errorMessage, normalizeHealth, normalizeWatchStatus } from './adapters';
import type { BackendService } from './backend';
import { AlertEngine, DEFAULT_ALERT_POLICY, formatDuration, type Alert, type AlertPolicy } from './health';
import type { FeedHealth, HealthSeverity } from './model';
import type { JsonRpcNotification } from './rpcProtocol';
import type { WatcherStore } from './watcherStore';

// The vscode-facing half of alerting. All of the "should this interrupt
// someone" reasoning lives in health.ts, which imports no vscode and is unit
// tested; this file only subscribes, renders and notifies.
//
// It listens to the backend's notification stream directly rather than going
// through DashboardManager, because dashboards route statistics to a panel and
// drop them when none is open. Subscribing here means a feed's health is
// tracked whether or not you happen to be looking at it.

interface FeedFacts {
  readonly name: string;
  health?: FeedHealth;
  state: 'running' | 'error' | 'other';
  error?: string;
}

export class AlertController implements vscode.Disposable {
  readonly #engine: AlertEngine;
  readonly #statusBar: vscode.StatusBarItem;
  readonly #subscriptions: vscode.Disposable[] = [];
  readonly #feeds = new Map<string, FeedFacts>();
  #disposed = false;

  public constructor(
    backend: BackendService,
    private readonly store: WatcherStore,
    private readonly output: vscode.OutputChannel
  ) {
    this.#engine = new AlertEngine(readPolicy());
    this.#statusBar = vscode.window.createStatusBarItem('s3Pulse.health', vscode.StatusBarAlignment.Right, 100);
    this.#statusBar.name = 'S3 Pulse';
    this.#statusBar.command = 's3Pulse.openDashboard';

    this.#subscriptions.push(
      this.#statusBar,
      backend.onNotification((notification) => this.#handle(notification)),
      store.onDidChange(() => this.#pruneRemovedFeeds()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('s3Pulse.alerts') || event.affectsConfiguration('s3Pulse.showStatusBar')) {
          this.#engine.setPolicy(readPolicy());
          this.#render();
        }
      })
    );
    this.#render();
  }

  /** Stops tracking a feed, so a stopped or removed one leaves the roll-up. */
  public forget(watcherId: string): void {
    this.#engine.forget(watcherId);
    this.#feeds.delete(watcherId);
    this.#render();
  }

  public dispose(): void {
    this.#disposed = true;
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
  }

  #handle(notification: JsonRpcNotification): void {
    if (this.#disposed) {
      return;
    }
    const params = notification.params as Record<string, unknown> | undefined;
    const watcherId = typeof params?.watcherId === 'string' ? params.watcherId : undefined;
    if (!watcherId) {
      return;
    }

    const facts = this.#feeds.get(watcherId) ?? { name: this.#nameOf(watcherId), state: 'other' as const };
    switch (notification.method) {
      case 'statistics.updated': {
        const health = normalizeHealth(params?.statistics);
        if (!health) {
          return;
        }
        facts.health = health;
        facts.state = 'running';
        facts.error = undefined;
        break;
      }
      case 'watch.statusChanged': {
        const status = normalizeWatchStatus(notification.params, watcherId);
        if (status.status === 'stopped') {
          this.forget(watcherId);
          return;
        }
        facts.state = status.status === 'error' ? 'error' : 'running';
        facts.error = status.error;
        break;
      }
      case 'watch.error': {
        facts.state = 'error';
        facts.error = readError(params?.error);
        break;
      }
      default:
        return;
    }

    this.#feeds.set(watcherId, { ...facts, name: this.#nameOf(watcherId) });
    const alert = this.#engine.observe({
      watcherId,
      name: this.#nameOf(watcherId),
      state: facts.state === 'error' ? 'error' : 'running',
      health: facts.health,
      error: facts.error
    });
    if (alert) {
      this.#notify(alert);
    }
    this.#render();
  }

  #nameOf(watcherId: string): string {
    return this.store.get(watcherId)?.name ?? this.#feeds.get(watcherId)?.name ?? watcherId;
  }

  #pruneRemovedFeeds(): void {
    const known = new Set(this.store.list().map((watcher) => watcher.id));
    for (const watcherId of [...this.#feeds.keys()]) {
      if (!known.has(watcherId)) {
        this.forget(watcherId);
      }
    }
  }

  #notify(alert: Alert): void {
    if (!vscode.workspace.getConfiguration('s3Pulse').get<boolean>('alerts.enabled', true)) {
      return;
    }
    this.output.appendLine(`[alert] ${alert.severity}: ${alert.message}`);
    const show = alert.severity === 'critical'
      ? vscode.window.showErrorMessage
      : vscode.window.showWarningMessage;
    void show(`S3 Pulse: ${alert.message}`, 'Open Dashboard').then((choice) => {
      if (choice === 'Open Dashboard') {
        const watcher = this.store.get(alert.watcherId);
        if (watcher) {
          void vscode.commands.executeCommand('s3Pulse.openDashboard', watcher.id);
        }
      }
    }, (error: unknown) => {
      this.output.appendLine(`[alert] Could not show notification: ${errorMessage(error)}`);
    });
  }

  #render(): void {
    if (this.#disposed) {
      return;
    }
    const visible = vscode.workspace.getConfiguration('s3Pulse').get<boolean>('showStatusBar', true);
    // Nothing is being watched, so an indicator would be claiming knowledge it
    // does not have.
    if (!visible || this.#feeds.size === 0) {
      this.#statusBar.hide();
      return;
    }

    const worst = this.#engine.worst();
    const counts = this.#engine.counts();
    const watched = this.#feeds.size;
    this.#statusBar.text = `${iconFor(worst)} ${summaryFor(worst, counts, watched)}`;
    this.#statusBar.tooltip = this.#tooltip(watched);
    this.#statusBar.backgroundColor = worst === 'critical'
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : worst === 'warning'
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
    this.#statusBar.show();
  }

  #tooltip(watched: number): vscode.MarkdownString {
    const lines = [`**S3 Pulse** — ${watched} feed${watched === 1 ? '' : 's'} watched\n`];
    for (const [watcherId, facts] of this.#feeds) {
      lines.push(`- ${describeFeed(this.#nameOf(watcherId), facts)}`);
    }
    const tooltip = new vscode.MarkdownString(lines.join('\n'));
    tooltip.isTrusted = false;
    return tooltip;
  }
}

function describeFeed(name: string, facts: FeedFacts): string {
  if (facts.state === 'error') {
    return `$(error) ${name} — ${facts.error ?? 'error'}`;
  }
  const health = facts.health;
  if (!health) {
    return `$(question) ${name} — no data yet`;
  }
  const parts: string[] = [];
  if (health.status === 'late') {
    parts.push(health.overdueSeconds !== undefined
      ? `late by ${formatDuration(health.overdueSeconds)}`
      : 'late');
  }
  if (health.sizeStatus === 'empty') {
    parts.push('latest object is empty');
  } else if (health.sizeStatus === 'small' || health.sizeStatus === 'large') {
    parts.push(`unusual size (${health.sizeStatus})`);
  }
  return `${iconFor(health.severity)} ${name}${parts.length ? ` — ${parts.join(', ')}` : ' — on time'}`;
}

function iconFor(severity: HealthSeverity): string {
  switch (severity) {
    case 'critical': return '$(error)';
    case 'warning': return '$(warning)';
    case 'ok': return '$(pulse)';
    default: return '$(question)';
  }
}

function summaryFor(worst: HealthSeverity, counts: Record<HealthSeverity, number>, watched: number): string {
  if (worst === 'critical' || worst === 'warning') {
    const affected = counts.critical + counts.warning;
    return `${affected} feed${affected === 1 ? '' : 's'} need attention`;
  }
  return `${watched} feed${watched === 1 ? '' : 's'} on time`;
}

function readError(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  const message = (value as Record<string, unknown> | undefined)?.message;
  return typeof message === 'string' ? message : undefined;
}

function readPolicy(): AlertPolicy {
  const configuration = vscode.workspace.getConfiguration('s3Pulse');
  const bounded = (name: string, fallback: number, minimum: number, maximum: number): number => {
    const value = configuration.get<number>(name, fallback);
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.min(maximum, Math.max(minimum, Math.round(value)))
      : fallback;
  };
  return {
    confirmObservations: bounded('alerts.confirmObservations', DEFAULT_ALERT_POLICY.confirmObservations, 1, 10),
    cooldownMs: bounded('alerts.cooldownSeconds', DEFAULT_ALERT_POLICY.cooldownMs / 1000, 0, 86_400) * 1000,
    alertOnLate: configuration.get<boolean>('alerts.onLate', true) !== false,
    alertOnSizeAnomaly: configuration.get<boolean>('alerts.onSizeAnomaly', true) !== false,
    alertOnError: configuration.get<boolean>('alerts.onError', true) !== false,
    alertOnRecovery: configuration.get<boolean>('alerts.onRecovery', false) === true
  };
}
