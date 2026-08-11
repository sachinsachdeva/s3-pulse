import { randomBytes, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import {
  errorMessage,
  downloadFileName,
  mergeObjects,
  normalizeDownloadProgress,
  normalizeHistory,
  normalizeObject,
  normalizeObjects,
  normalizeRequestCounts,
  normalizeStatistics,
  normalizeWatchStatus,
  objectUri,
  serializeWatcher
} from './adapters';
import type { BackendService } from './backend';
import type { FeedTreeProvider } from './feedTree';
import type { WatcherStore } from './watcherStore';
import type {
  CostModel,
  DashboardSnapshot,
  DownloadProgress,
  FrequencyStatistics,
  HistorySample,
  ObjectRecord,
  RequestCounts,
  WatchStatus,
  WatcherDefinition
} from './model';
import type { JsonRpcNotification } from './rpcProtocol';

interface DownloadReporter {
  readonly watcherId: string;
  readonly downloadId: string;
  readonly key: string;
  readonly report: (value: { message?: string; increment?: number }) => void;
  previousBytes: number;
}

type WebviewMessage =
  | { readonly type: 'ready' | 'refresh' | 'start' | 'stop' }
  | { readonly type: 'download' | 'copyUri' | 'copyKey'; readonly key: string }
  | { readonly type: 'bucketMinutes'; readonly minutes: number };

export class DashboardManager implements vscode.Disposable {
  readonly #panels = new Map<string, FeedDashboard>();
  readonly #subscriptions: vscode.Disposable[] = [];
  readonly #downloads = new Set<DownloadReporter>();

  public constructor(
    private readonly backend: BackendService,
    private readonly tree: FeedTreeProvider,
    private readonly output: vscode.OutputChannel,
    private readonly store: WatcherStore
  ) {
    this.#subscriptions.push(
      backend.onNotification((notification) => this.#handleNotification(notification)),
      backend.onDidRestart(() => {
        for (const panel of this.#panels.values()) {
          void this.refresh(panel.watcher);
        }
      })
    );
  }

  public open(watcher: WatcherDefinition): void {
    const existing = this.#panels.get(watcher.id);
    if (existing) {
      existing.reveal();
      void this.refresh(watcher);
      return;
    }
    const panel = new FeedDashboard(watcher, (message) => this.#handleWebviewMessage(watcher, message));
    this.#panels.set(watcher.id, panel);
    panel.onDidDispose(() => this.#panels.delete(watcher.id));
  }

  public async start(watcher: WatcherDefinition): Promise<void> {
    this.tree.setState(watcher.id, 'starting');
    this.#panels.get(watcher.id)?.setStatus({ watcherId: watcher.id, status: 'starting' });
    try {
      const result = await this.backend.request('watch.start', { watcher: serializeWatcher(watcher) });
      this.backend.rememberActive(watcher);
      const status = normalizeWatchStatus(result, watcher.id);
      const runningStatus: WatchStatus = {
        ...status,
        watcherId: status.watcherId || watcher.id,
        status: status.status === 'unknown' ? 'running' : status.status
      };
      this.tree.setStatus(runningStatus);
      this.#panels.get(watcher.id)?.setStatus(runningStatus);
      await this.refresh(watcher);
    } catch (error) {
      const message = errorMessage(error);
      this.tree.setState(watcher.id, 'error', message);
      this.#panels.get(watcher.id)?.showError(message);
      throw error;
    }
  }

  public async stop(watcher: WatcherDefinition): Promise<void> {
    try {
      await this.backend.request('watch.stop', { watcherId: watcher.id });
      this.backend.forgetActive(watcher.id);
      const status: WatchStatus = { watcherId: watcher.id, status: 'stopped' };
      this.tree.setStatus(status);
      this.#panels.get(watcher.id)?.setStatus(status);
    } catch (error) {
      const message = errorMessage(error);
      this.tree.setState(watcher.id, 'error', message);
      this.#panels.get(watcher.id)?.showError(message);
      throw error;
    }
  }

  public async refresh(watcher: WatcherDefinition): Promise<void> {
    const panel = this.#panels.get(watcher.id);
    if (!panel) {
      return;
    }
    const currentStatus = this.tree.stateFor(watcher.id);
    if (currentStatus.status !== 'running' && currentStatus.status !== 'starting' && currentStatus.status !== 'error') {
      panel.setSnapshot({
        feed: watcher,
        status: currentStatus,
        objects: panel.objects,
        history: panel.history,
        statistics: panel.statistics,
        defaultGraph: defaultGraph(),
        requestCounts: currentStatus.requestCounts ?? panel.requestCounts,
        cost: costModel()
      });
      return;
    }

    const revision = panel.revision;
    panel.setBusy(true);
    const [objectsResult, frequencyResult, historyResult] = await Promise.allSettled([
      this.backend.request('objects.list', { watcherId: watcher.id, limit: watcher.historyLimit }),
      this.backend.request('statistics.frequency', { watcherId: watcher.id }),
      this.backend.request('statistics.history', { watcherId: watcher.id, limit: watcher.historyLimit })
    ]);
    panel.setBusy(false);

    const failures = [objectsResult, frequencyResult, historyResult]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    for (const failure of failures) {
      this.output.appendLine(`[dashboard:${watcher.id}] Refresh failed: ${errorMessage(failure.reason)}`);
    }
    const changedDuringRefresh = panel.revision !== revision;
    const refreshedObjects = objectsResult.status === 'fulfilled'
      ? normalizeObjects(objectsResult.value, watcher.target)
      : [];
    const refreshedHistory = historyResult.status === 'fulfilled'
      ? normalizeHistory(historyResult.value)
      : [];

    const snapshot: DashboardSnapshot = {
      feed: watcher,
      status: this.tree.stateFor(watcher.id),
      objects: objectsResult.status === 'fulfilled'
        ? mergeObjects(changedDuringRefresh ? panel.objects : [], refreshedObjects, watcher.historyLimit)
        : panel.objects,
      history: historyResult.status === 'fulfilled'
        ? mergeHistorySamples(changedDuringRefresh ? panel.history : [], refreshedHistory, watcher.historyLimit)
        : panel.history,
      statistics: frequencyResult.status === 'fulfilled' && !changedDuringRefresh
        ? normalizeStatistics(frequencyResult.value)
        : panel.statistics,
      defaultGraph: defaultGraph(),
      requestCounts: frequencyResult.status === 'fulfilled'
        ? normalizeRequestCounts(asRecord(frequencyResult.value)?.requestCounts) ?? panel.requestCounts
        : panel.requestCounts,
      cost: costModel()
    };
    panel.setSnapshot(snapshot);
    if (failures.length === 3) {
      panel.showError(errorMessage(failures[0]?.reason));
    }
  }

  public isOpen(watcherId: string): boolean {
    return this.#panels.has(watcherId);
  }

  public close(watcherId: string): void {
    this.#panels.get(watcherId)?.dispose();
  }

  public dispose(): void {
    for (const panel of this.#panels.values()) {
      panel.dispose();
    }
    this.#panels.clear();
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
  }

  async #handleWebviewMessage(watcher: WatcherDefinition, message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
        case 'refresh':
          await this.refresh(watcher);
          return;
        case 'start':
          await this.start(watcher);
          return;
        case 'stop':
          await this.stop(watcher);
          return;
        case 'download':
          await this.#download(watcher, message.key);
          return;
        case 'copyUri':
          await vscode.env.clipboard.writeText(objectUri(watcher.target, message.key));
          this.#panels.get(watcher.id)?.showInfo('S3 URI copied');
          return;
        case 'bucketMinutes':
          // The graph bucket is a per-feed preference, so persist it on the
          // watcher rather than in transient webview state.
          if (message.minutes !== watcher.bucketMinutes) {
            await this.store.save({ ...watcher, bucketMinutes: message.minutes });
          }
          return;
        case 'copyKey':
          await vscode.env.clipboard.writeText(message.key);
          this.#panels.get(watcher.id)?.showInfo('Object key copied');
          return;
      }
    } catch (error) {
      if (error instanceof vscode.CancellationError) {
        return;
      }
      const text = errorMessage(error);
      this.#panels.get(watcher.id)?.showError(text);
      void vscode.window.showErrorMessage(`S3 Pulse: ${text}`, 'Show Output').then((selection) => {
        if (selection === 'Show Output') {
          this.output.show(true);
        }
      });
    }
  }

  async #download(watcher: WatcherDefinition, key: string): Promise<void> {
    const object = this.#panels.get(watcher.id)?.objects.find((item) => item.key === key);
    if (!object) {
      throw new Error('The selected object is no longer in the dashboard');
    }
    const fileName = downloadFileName(key);
    const directory = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir());
    const destination = await vscode.window.showSaveDialog({
      title: `Download ${path.posix.basename(key)}`,
      defaultUri: vscode.Uri.joinPath(directory, fileName),
      saveLabel: 'Download'
    });
    if (!destination) {
      return;
    }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Downloading ${path.posix.basename(key)}`,
      cancellable: true
    }, async (progress, token) => {
      const downloadId = randomUUID();
      const reporter: DownloadReporter = {
        watcherId: watcher.id,
        downloadId,
        key,
        report: (value) => progress.report(value),
        previousBytes: 0
      };
      this.#downloads.add(reporter);
      try {
        await this.backend.request('object.download', {
          watcherId: watcher.id,
          downloadId,
          key,
          destination: destination.fsPath,
          overwrite: true
        }, { cancellation: token, timeoutMs: 0 });
        progress.report({ message: 'Complete' });
      } finally {
        this.#downloads.delete(reporter);
      }
    });
    const action = await vscode.window.showInformationMessage(
      `Downloaded ${path.posix.basename(key)}`,
      'Reveal in File Explorer'
    );
    if (action === 'Reveal in File Explorer') {
      await vscode.commands.executeCommand('revealFileInOS', destination);
    }
  }

  #handleNotification(notification: JsonRpcNotification): void {
    const params = asRecord(notification.params);
    const watcherId = stringValue(params?.watcherId ?? params?.watcher_id);
    if (!watcherId) {
      this.output.appendLine(`[rpc] Ignored ${notification.method} notification without watcherId`);
      return;
    }
    const panel = this.#panels.get(watcherId);
    switch (notification.method) {
      case 'objects.added': {
        const watcher = panel?.watcher;
        if (!watcher) {
          return;
        }
        const objects = normalizeObjects(notification.params, watcher.target);
        if (objects.length === 0) {
          const single = normalizeObject(params?.object, watcher.target);
          if (single) {
            panel.addObjects([single]);
          }
        } else {
          panel.addObjects(objects);
        }
        return;
      }
      case 'statistics.updated':
        panel?.setStatistics(
          normalizeStatistics(notification.params),
          normalizeRequestCounts(asRecord(notification.params)?.requestCounts)
        );
        return;
      case 'watch.statusChanged': {
        const status = normalizeWatchStatus(notification.params, watcherId);
        this.tree.setStatus(status);
        panel?.setStatus(status);
        if (status.status === 'stopped') {
          this.backend.forgetActive(watcherId);
        }
        return;
      }
      case 'watch.error': {
        const nested = asRecord(params?.error);
        const message = stringValue(nested?.message ?? params?.message) ?? 'The feed watcher reported an error';
        this.tree.setState(watcherId, 'error', message);
        panel?.setStatus({ watcherId, status: 'error', error: message });
        panel?.showError(message);
        return;
      }
      case 'download.progress': {
        const progress = normalizeDownloadProgress(notification.params);
        if (progress) {
          this.#reportDownload(progress);
        }
        return;
      }
      default:
        this.output.appendLine(`[rpc] Notification: ${notification.method}`);
    }
  }

  #reportDownload(progress: DownloadProgress): void {
    for (const reporter of this.#downloads) {
      if (
        reporter.watcherId !== progress.watcherId
        || (progress.downloadId && reporter.downloadId !== progress.downloadId)
        || (!progress.downloadId && progress.key && reporter.key !== progress.key)
      ) {
        continue;
      }
      let increment: number | undefined;
      if (progress.totalBytes && progress.totalBytes > 0) {
        increment = Math.min(100, Math.max(0, ((progress.bytesTransferred - reporter.previousBytes) / progress.totalBytes) * 100));
      }
      reporter.previousBytes = progress.bytesTransferred;
      reporter.report({
        message: progress.totalBytes
          ? `${formatBytes(progress.bytesTransferred)} of ${formatBytes(progress.totalBytes)}`
          : formatBytes(progress.bytesTransferred),
        increment
      });
    }
  }
}

class FeedDashboard implements vscode.Disposable {
  readonly #panel: vscode.WebviewPanel;
  readonly #disposeEmitter = new vscode.EventEmitter<void>();
  readonly #subscriptions: vscode.Disposable[] = [];
  #objects: ObjectRecord[] = [];
  #history: HistorySample[] = [];
  #statistics: FrequencyStatistics = {};
  #requestCounts: RequestCounts | undefined;
  #revision = 0;
  #disposed = false;

  public readonly onDidDispose = this.#disposeEmitter.event;

  public constructor(
    public readonly watcher: WatcherDefinition,
    onMessage: (message: WebviewMessage) => Promise<void>
  ) {
    this.#panel = vscode.window.createWebviewPanel(
      's3Pulse.dashboard',
      `S3 Pulse — ${watcher.name}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: []
      }
    );
    this.#panel.iconPath = undefined;
    this.#panel.webview.html = dashboardHtml(this.#panel.webview);
    this.#subscriptions.push(
      this.#panel.onDidDispose(() => this.dispose()),
      this.#panel.webview.onDidReceiveMessage((value: unknown) => {
        const message = parseWebviewMessage(value);
        if (message) {
          void onMessage(message);
        }
      })
    );
  }

  public get objects(): readonly ObjectRecord[] {
    return this.#objects;
  }

  public get history(): readonly HistorySample[] {
    return this.#history;
  }

  public get statistics(): FrequencyStatistics {
    return this.#statistics;
  }

  public get requestCounts(): RequestCounts | undefined {
    return this.#requestCounts;
  }

  public setRequestCounts(counts: RequestCounts | undefined): void {
    if (counts) {
      this.#requestCounts = counts;
    }
  }

  public get revision(): number {
    return this.#revision;
  }

  public reveal(): void {
    this.#panel.reveal(undefined, true);
  }

  public setSnapshot(snapshot: DashboardSnapshot): void {
    this.#objects = [...snapshot.objects];
    this.#history = [...snapshot.history];
    this.#statistics = snapshot.statistics;
    this.setRequestCounts(snapshot.requestCounts);
    this.#revision += 1;
    this.#post({ type: 'snapshot', snapshot });
  }

  public addObjects(objects: readonly ObjectRecord[]): void {
    this.#objects = mergeObjects(this.#objects, objects, this.watcher.historyLimit);
    this.#history = mergeHistorySamples(
      this.#history,
      objects.map((object) => ({
        key: object.key,
        lastModified: object.lastModified,
        intervalSeconds: object.intervalSeconds
      })),
      this.watcher.historyLimit
    );
    this.#revision += 1;
    this.#post({ type: 'objectsAdded', objects });
  }

  public setStatistics(statistics: FrequencyStatistics, requestCounts?: RequestCounts): void {
    this.#statistics = statistics;
    this.setRequestCounts(requestCounts);
    this.#revision += 1;
    this.#post({ type: 'statistics', statistics, requestCounts: this.#requestCounts, cost: costModel() });
  }

  public setStatus(status: WatchStatus): void {
    this.#post({ type: 'status', status });
  }

  public setBusy(busy: boolean): void {
    this.#post({ type: 'busy', busy });
  }

  public showError(message: string): void {
    this.#post({ type: 'toast', level: 'error', message });
  }

  public showInfo(message: string): void {
    this.#post({ type: 'toast', level: 'info', message });
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
    this.#disposeEmitter.fire();
    this.#disposeEmitter.dispose();
    this.#panel.dispose();
  }

  #post(message: unknown): void {
    if (!this.#disposed) {
      void this.#panel.webview.postMessage(message);
    }
  }
}

function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  const source = asRecord(value);
  const type = stringValue(source?.type);
  if (type === 'ready' || type === 'refresh' || type === 'start' || type === 'stop') {
    return { type };
  }
  if (type === 'download' || type === 'copyUri' || type === 'copyKey') {
    const key = stringValue(source?.key);
    return key ? { type, key } : undefined;
  }
  if (type === 'bucketMinutes') {
    const minutes = source?.minutes;
    return typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 1 && minutes <= 1_440
      ? { type, minutes }
      : undefined;
  }
  return undefined;
}

function defaultGraph(): 'inter-arrival' | 'files-per-bucket' {
  const value = vscode.workspace.getConfiguration('s3Pulse').get<string>('defaultGraph', 'inter-arrival');
  return value === 'files-per-bucket' ? value : 'inter-arrival';
}

// Prices are settings rather than constants because S3 request pricing differs
// by region and changes over time; the defaults are US East (N. Virginia).
export function costModel(): CostModel {
  const configuration = vscode.workspace.getConfiguration('s3Pulse');
  const positive = (name: string, fallback: number): number => {
    const value = configuration.get<number>(name, fallback);
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    enabled: configuration.get<boolean>('showCostEstimate', true) !== false,
    listPer1000: positive('listRequestCostPer1000', 0.005),
    getPer1000: positive('getRequestCostPer1000', 0.0004),
    currency: configuration.get<string>('costCurrency', 'USD') || 'USD'
  };
}

function mergeHistorySamples(
  current: readonly HistorySample[],
  incoming: readonly HistorySample[],
  limit: number
): HistorySample[] {
  const samples = new Map(current.map((sample) => [sample.key, sample]));
  for (const sample of incoming) {
    samples.set(sample.key, { ...samples.get(sample.key), ...sample });
  }
  return [...samples.values()]
    .sort((left, right) => Date.parse(left.lastModified) - Date.parse(right.lastModified) || left.key.localeCompare(right.key))
    .slice(-Math.max(1, limit));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function dashboardHtml(webview: vscode.Webview): string {
  const nonce = randomBytes(24).toString('base64');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>S3 Pulse dashboard</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-weight) var(--vscode-font-size)/1.45 var(--vscode-font-family); }
    button, input, select { font: inherit; color: inherit; }
    button, select, input { border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; }
    button { padding: 5px 10px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button:focus-visible, input:focus-visible, select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button:disabled { opacity: .55; cursor: default; }
    header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 16px; }
    h1 { font-size: 1.55rem; line-height: 1.2; margin: 0 0 6px; }
    h2 { font-size: 1.05rem; margin: 0; }
    .target { color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
    .header-actions, .section-heading, .grid-tools, .graph-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .status { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 99px; text-transform: uppercase; font-size: .78rem; letter-spacing: .04em; }
    .status::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
    .status.running::before { background: var(--vscode-testing-iconPassed, #2ea043); }
    .status.starting::before { background: var(--vscode-charts-yellow, #cca700); }
    .status.error::before { background: var(--vscode-testing-iconFailed, #f85149); }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 10px; margin: 16px 0; }
    .metric { min-height: 72px; padding: 10px 12px; border: 1px solid var(--vscode-panel-border); border-radius: 5px; background: var(--vscode-sideBar-background); }
    .metric .label { display: block; color: var(--vscode-descriptionForeground); font-size: .82rem; margin-bottom: 5px; }
    .metric .value { font-size: 1.16rem; font-variant-numeric: tabular-nums; }
    .metric.health .value { text-transform: capitalize; }
    .metric .label + .value + .label { margin-top: 4px; margin-bottom: 0; font-size: .76rem; }
    #cost-metric[hidden] { display: none; }
    section { border: 1px solid var(--vscode-panel-border); border-radius: 5px; margin-top: 14px; overflow: hidden; }
    .section-heading { justify-content: space-between; padding: 10px 12px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); }
    .graph-wrap { position: relative; min-height: 270px; padding: 12px; }
    canvas { display: block; width: 100%; height: 245px; }
    /* An author display rule outranks the user-agent [hidden] rule, so hiding
       the canvas needs an explicit override, as #toast and .graph-tip have. */
    canvas[hidden] { display: none; }
    .graph-tip { position: absolute; z-index: 3; max-width: 320px; padding: 7px 9px; border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border)); border-radius: 4px; background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background)); color: var(--vscode-editorHoverWidget-foreground, var(--vscode-editor-foreground)); box-shadow: 0 2px 8px var(--vscode-widget-shadow); pointer-events: none; font-size: .85rem; line-height: 1.45; }
    .graph-tip[hidden] { display: none; }
    .graph-tip .tip-key { font-weight: 600; word-break: break-all; }
    .graph-tip .tip-row { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
    select, input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: 5px 8px; }
    label { color: var(--vscode-descriptionForeground); }
    #bucket-label.hidden { display: none; }
    .grid-tools { padding: 10px 12px; justify-content: space-between; }
    #search { min-width: min(340px, 100%); flex: 1; }
    .table-scroll { max-height: min(58vh, 720px); overflow: auto; border-top: 1px solid var(--vscode-panel-border); }
    table { width: 100%; border-collapse: collapse; white-space: nowrap; }
    th { position: sticky; top: 0; z-index: 1; background: var(--vscode-sideBar-background); text-align: left; font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border); }
    th button { width: 100%; padding: 8px 10px; border: 0; border-radius: 0; text-align: inherit; background: transparent; color: inherit; }
    th button::after { content: ''; margin-left: 5px; }
    th[aria-sort="ascending"] button::after { content: '\\2191'; }
    th[aria-sort="descending"] button::after { content: '\\2193'; }
    td { padding: 7px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    td.key { max-width: 520px; overflow: hidden; text-overflow: ellipsis; }
    td.number { text-align: right; font-variant-numeric: tabular-nums; }
    .row-actions { display: flex; gap: 3px; }
    .row-actions button { width: 24px; height: 24px; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: transparent; color: var(--vscode-foreground); border-radius: 3px; }
    .row-actions button:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .row-actions button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .row-actions svg { width: 14px; height: 14px; }
    .empty { text-align: center; color: var(--vscode-descriptionForeground); padding: 28px 12px; }
    #toast { position: fixed; right: 18px; bottom: 18px; z-index: 4; max-width: min(480px, calc(100vw - 36px)); padding: 10px 14px; border: 1px solid var(--vscode-notifications-border); border-radius: 4px; background: var(--vscode-notifications-background); color: var(--vscode-notifications-foreground); box-shadow: 0 3px 12px var(--vscode-widget-shadow); }
    #toast.error { border-left: 4px solid var(--vscode-notificationsErrorIcon-foreground); }
    #toast[hidden] { display: none; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
    @media (max-width: 720px) { body { padding: 12px; } header { flex-direction: column; } .header-actions { width: 100%; } .hide-small { display: none; } }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
  </style>
</head>
<body>
  <header>
    <div><h1 id="feed-name">S3 Pulse</h1><div class="target" id="feed-target"></div></div>
    <div class="header-actions">
      <span id="status" class="status stopped">Stopped</span>
      <button id="start" class="primary" type="button">Start</button>
      <button id="stop" type="button" hidden>Stop</button>
      <button id="refresh" type="button">Refresh</button>
    </div>
  </header>
  <main>
    <div class="summary" aria-label="Feed health summary">
      <div class="metric health"><span class="label">Health</span><span class="value" id="health">—</span></div>
      <div class="metric"><span class="label">Typical interval</span><span class="value" id="median">—</span></div>
      <div class="metric"><span class="label">Current gap</span><span class="value" id="gap">—</span></div>
      <div class="metric"><span class="label">Last arrival</span><span class="value" id="last-arrival">—</span></div>
      <div class="metric"><span class="label">Files / hour</span><span class="value" id="files-hour">—</span></div>
      <div class="metric" id="cost-metric" hidden><span class="label">S3 requests</span><span class="value" id="requests">—</span><span class="label" id="cost-note"></span></div>
    </div>
    <section aria-labelledby="graph-title">
      <div class="section-heading">
        <h2 id="graph-title">Arrival cadence</h2>
        <div class="graph-tools">
          <label for="graph-mode">View</label>
          <select id="graph-mode"><option value="inter-arrival">Inter-arrival time</option><option value="files-per-bucket">Files per interval</option></select>
          <label id="bucket-label" class="hidden" for="bucket-size">Bucket</label>
          <select id="bucket-size" hidden><option value="1">1 min</option><option value="5">5 min</option><option value="15">15 min</option><option value="30">30 min</option><option value="60">1 hour</option><option value="240">4 hours</option><option value="1440">1 day</option></select>
        </div>
      </div>
      <div class="graph-wrap"><canvas id="graph" role="img" tabindex="0" aria-label="No arrival data"></canvas><div id="graph-tip" class="graph-tip" role="tooltip" hidden></div><div id="graph-empty" class="empty">No arrival history yet.</div></div>
    </section>
    <section aria-labelledby="files-title">
      <div class="section-heading"><h2 id="files-title">Recent files</h2><span id="file-count" aria-live="polite">0 files</span></div>
      <div class="grid-tools"><label class="sr-only" for="search">Search objects</label><input id="search" type="search" placeholder="Search key, storage class, or ETag…" autocomplete="off"><span id="filter-count"></span></div>
      <div class="table-scroll">
        <table>
          <thead><tr>
            <th data-column="key" aria-sort="none"><button type="button">Key</button></th>
            <th data-column="lastModified" aria-sort="descending"><button type="button">Modified</button></th>
            <th data-column="size" aria-sort="none"><button type="button">Size</button></th>
            <th data-column="age" aria-sort="none" class="hide-small"><button type="button">Age</button></th>
            <th data-column="intervalSeconds" aria-sort="none"><button type="button">Δ previous</button></th>
            <th data-column="storageClass" aria-sort="none" class="hide-small"><button type="button">Storage class</button></th>
            <th><span class="sr-only">Actions</span></th>
          </tr></thead>
          <tbody id="rows"></tbody>
        </table>
        <div id="grid-empty" class="empty">No objects yet.</div>
      </div>
    </section>
  </main>
  <div id="toast" role="status" aria-live="polite" hidden></div>
  <script nonce="${nonce}">
    (() => {
      'use strict';
      const vscode = acquireVsCodeApi();
      const prior = vscode.getState() || {};
      const state = { feed: null, status: { status: 'stopped' }, objects: [], history: [], statistics: {}, sort: prior.sort || { column: 'lastModified', direction: 'desc' }, search: prior.search || '', graphMode: prior.graphMode || null, bucket: 15, requestCounts: null, cost: null };
      const byId = (id) => document.getElementById(id);
      const rows = byId('rows');
      const search = byId('search');
      const graph = byId('graph');
      const graphTip = byId('graph-tip');
      let toastTimer;
      let plotted = [];
      let hovered = -1;
      // The feed updates live, so a bare index would silently come to mean a
      // different arrival. Pointer hovers re-resolve from the last cursor
      // position; keyboard hovers re-resolve from the point's own identity.
      let pointer = null;
      let hoverId = null;

      search.value = state.search;
      byId('bucket-size').value = String(state.bucket);
      byId('start').addEventListener('click', () => vscode.postMessage({ type: 'start' }));
      byId('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
      byId('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
      search.addEventListener('input', () => { state.search = search.value; persist(); renderGrid(); });
      byId('graph-mode').addEventListener('change', (event) => { state.graphMode = event.target.value; persist(); renderGraph(); });
      byId('bucket-size').addEventListener('change', (event) => { state.bucket = Number(event.target.value); vscode.postMessage({ type: 'bucketMinutes', minutes: state.bucket }); renderGraph(); });
      document.querySelectorAll('th[data-column] button').forEach((button) => button.addEventListener('click', () => {
        const column = button.parentElement.dataset.column;
        state.sort = state.sort.column === column ? { column, direction: state.sort.direction === 'asc' ? 'desc' : 'asc' } : { column, direction: column === 'key' || column === 'storageClass' ? 'asc' : 'desc' };
        persist(); renderGrid();
      }));
      rows.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (button) vscode.postMessage({ type: button.dataset.action, key: button.dataset.key });
      });
      graph.addEventListener('pointermove', (event) => { pointer = { x: event.clientX, y: event.clientY }; hover(pointAt(event.clientX, event.clientY)); });
      graph.addEventListener('pointerleave', () => { pointer = null; hoverId = null; hover(-1); });
      graph.addEventListener('blur', () => { if (!pointer) { hoverId = null; hover(-1); } });
      graph.addEventListener('keydown', (event) => {
        if (!plotted.length) return;
        if (event.key === 'Escape') { hoverId = null; hover(-1); return; }
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const start = hovered < 0 ? (step > 0 ? -1 : plotted.length) : hovered;
        hover(Math.max(0, Math.min(plotted.length - 1, start + step)));
      });
      new ResizeObserver(() => renderGraph()).observe(graph);
      new MutationObserver(() => renderGraph()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
      setInterval(() => { renderSummary(); renderGrid(); }, 30000);

      window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message || typeof message.type !== 'string') return;
        if (message.type === 'snapshot') {
          const snapshot = message.snapshot;
          state.feed = snapshot.feed;
          state.status = snapshot.status;
          state.objects = Array.isArray(snapshot.objects) ? snapshot.objects : [];
          state.history = Array.isArray(snapshot.history) ? snapshot.history : [];
          state.statistics = snapshot.statistics || {};
          if (!state.graphMode) state.graphMode = snapshot.defaultGraph;
          if (Number.isFinite(snapshot.feed && snapshot.feed.bucketMinutes)) state.bucket = snapshot.feed.bucketMinutes;
          state.requestCounts = snapshot.requestCounts || state.requestCounts;
          state.cost = snapshot.cost || state.cost;
          render();
        } else if (message.type === 'objectsAdded') {
          mergeObjects(message.objects || []); render();
        } else if (message.type === 'statistics') {
          state.statistics = message.statistics || {};
          state.requestCounts = message.requestCounts || state.requestCounts;
          state.cost = message.cost || state.cost;
          renderSummary(); renderGraph();
        } else if (message.type === 'status') {
          state.status = message.status; renderStatus();
        } else if (message.type === 'busy') {
          byId('refresh').disabled = Boolean(message.busy);
          byId('refresh').textContent = message.busy ? 'Refreshing…' : 'Refresh';
        } else if (message.type === 'toast') {
          toast(message.message, message.level);
        }
      });

      function mergeObjects(incoming) {
        const map = new Map(state.objects.map((item) => [item.key, item]));
        incoming.forEach((item) => map.set(item.key, Object.assign({}, map.get(item.key), item)));
        state.objects = Array.from(map.values()).sort((a, b) => dateValue(b.lastModified) - dateValue(a.lastModified)).slice(0, state.feed ? state.feed.historyLimit : 2000);
        for (const item of incoming) {
          state.history.push({ key: item.key, lastModified: item.lastModified, intervalSeconds: item.intervalSeconds });
        }
        state.history.sort((a, b) => dateValue(a.lastModified) - dateValue(b.lastModified));
        if (state.feed) state.history = state.history.slice(-state.feed.historyLimit);
      }

      function render() {
        if (state.feed) { byId('feed-name').textContent = state.feed.name; byId('feed-target').textContent = state.feed.target; }
        renderStatus(); renderSummary(); renderGraph(); renderGrid();
      }

      function renderStatus() {
        const status = state.status && state.status.status || 'unknown';
        const badge = byId('status');
        badge.className = 'status ' + status;
        badge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
        badge.title = state.status && state.status.error || '';
        const active = status === 'running' || status === 'starting' || status === 'error';
        byId('start').hidden = active;
        byId('stop').hidden = !active;
        byId('start').disabled = status === 'starting';
      }

      function renderSummary() {
        const stats = state.statistics || {};
        byId('health').textContent = stats.health || (state.status.status === 'running' ? 'Monitoring' : '—');
        byId('median').textContent = duration(stats.medianIntervalSeconds);
        byId('gap').textContent = duration(stats.currentGapSeconds);
        byId('last-arrival').textContent = relative(stats.lastArrival);
        byId('files-hour').textContent = number(stats.filesPerHour);
        renderCost();
      }

      // Counts come from the backend; the rate is a user setting, so the money
      // figure is only ever an estimate and is labelled as one.
      function renderCost() {
        const counts = state.requestCounts, cost = state.cost;
        const metric = byId('cost-metric');
        if (!counts || !cost || cost.enabled === false) { metric.hidden = true; return; }
        metric.hidden = false;
        const list = Number(counts.listRequests) || 0, get = Number(counts.getRequests) || 0;
        byId('requests').textContent = (list + get).toLocaleString();
        const amount = (list / 1000) * Number(cost.listPer1000 || 0) + (get / 1000) * Number(cost.getPer1000 || 0);
        byId('cost-note').textContent = list.toLocaleString() + ' LIST, ' + get.toLocaleString() + ' GET - est. ' + money(amount, cost.currency);
      }

      function money(value, currency) {
        if (!Number.isFinite(value)) return '-';
        const symbol = currency === 'USD' ? '$' : '';
        const suffix = symbol ? '' : ' ' + (currency || '');
        if (value > 0 && value < 0.01) return '<' + symbol + '0.01' + suffix;
        return symbol + value.toFixed(value < 10 ? 2 : 0) + suffix;
      }

      function renderGrid() {
        const query = state.search.trim().toLocaleLowerCase();
        const data = withIntervals(state.objects).filter((item) => !query || [item.key, item.storageClass, item.etag].some((value) => String(value || '').toLocaleLowerCase().includes(query)));
        const direction = state.sort.direction === 'asc' ? 1 : -1;
        data.sort((a, b) => direction * compare(columnValue(a, state.sort.column), columnValue(b, state.sort.column)));
        rows.replaceChildren();
        const fragment = document.createDocumentFragment();
        data.forEach((item) => fragment.appendChild(fileRow(item)));
        rows.appendChild(fragment);
        byId('file-count').textContent = state.objects.length.toLocaleString() + (state.objects.length === 1 ? ' file' : ' files');
        byId('filter-count').textContent = query ? data.length.toLocaleString() + ' shown' : '';
        byId('grid-empty').hidden = data.length > 0;
        document.querySelectorAll('th[data-column]').forEach((header) => header.setAttribute('aria-sort', header.dataset.column === state.sort.column ? (state.sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'));
      }

      function fileRow(item) {
        const row = document.createElement('tr');
        cell(row, item.key, 'key', item.key);
        cell(row, dateTime(item.lastModified));
        cell(row, bytes(item.size), 'number');
        cell(row, relative(item.lastModified), 'hide-small');
        cell(row, duration(item.intervalSeconds), 'number');
        cell(row, item.storageClass || '—', 'hide-small');
        const actions = document.createElement('td');
        const group = document.createElement('div'); group.className = 'row-actions';
        action(group, 'Download', 'download', item.key, 'download');
        action(group, 'Copy URI', 'copyUri', item.key, 'link');
        action(group, 'Copy key', 'copyKey', item.key, 'copy');
        actions.appendChild(group); row.appendChild(actions);
        return row;
      }

      function cell(row, text, className, title) {
        const element = document.createElement('td');
        element.textContent = text == null ? '—' : String(text);
        if (className) element.className = className;
        if (title) element.title = title;
        row.appendChild(element);
      }

      // Square icon buttons. The glyph is inert to assistive technology; the
      // button keeps the wording that used to be the visible label.
      const ICON_PATHS = {
        download: 'M8 2v7m0 0 2.5-2.5M8 9 5.5 6.5M3 11.5v1a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1',
        link: 'M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 1 0-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 1 0 3.7 3.7l.9-.9',
        copy: 'M6 6h6.2v6.2H6zM10 6V3.8H3.8V10H6'
      };

      function icon(name) {
        const namespace = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(namespace, 'svg');
        svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
        const path = document.createElementNS(namespace, 'path');
        path.setAttribute('d', ICON_PATHS[name]); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-width', '1.3'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(path);
        return svg;
      }

      function action(parent, label, actionName, key, iconName) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.action = actionName; button.dataset.key = key;
        button.title = label; button.setAttribute('aria-label', label + ' ' + key);
        button.appendChild(icon(iconName)); parent.appendChild(button);
      }

      function withIntervals(objects) {
        const ascending = [...objects].sort((a, b) => dateValue(a.lastModified) - dateValue(b.lastModified));
        for (let index = 0; index < ascending.length; index += 1) {
          if (!Number.isFinite(ascending[index].intervalSeconds) && index > 0) ascending[index].intervalSeconds = Math.max(0, (dateValue(ascending[index].lastModified) - dateValue(ascending[index - 1].lastModified)) / 1000);
        }
        return ascending;
      }

      function columnValue(item, column) {
        if (column === 'lastModified' || column === 'age') return dateValue(item.lastModified);
        if (column === 'size' || column === 'intervalSeconds') return Number(item[column]) || 0;
        return String(item[column] || '').toLocaleLowerCase();
      }

      function compare(a, b) { return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)); }

      function renderGraph() {
        const mode = state.graphMode || 'inter-arrival';
        byId('graph-mode').value = mode;
        const bucketMode = mode === 'files-per-bucket';
        const bucketSelect = byId('bucket-size');
        bucketSelect.hidden = !bucketMode;
        if (String(state.bucket) !== bucketSelect.value) bucketSelect.value = String(state.bucket);
        byId('bucket-label').classList.toggle('hidden', !bucketMode);
        const samples = graphSamples();
        byId('graph-empty').hidden = samples.length > 0;
        graph.hidden = samples.length === 0;
        if (!samples.length) { clearHover(); return; }
        const rect = graph.getBoundingClientRect();
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        // Assigning width/height reallocates and clears the backing store, so
        // only do it on a real size change; hover repaints run every few pixels.
        const pixelWidth = Math.max(1, Math.round(rect.width * ratio)), pixelHeight = Math.max(1, Math.round(rect.height * ratio));
        if (graph.width !== pixelWidth) graph.width = pixelWidth;
        if (graph.height !== pixelHeight) graph.height = pixelHeight;
        const context = graph.getContext('2d'); context.setTransform(ratio, 0, 0, ratio, 0, 0);
        const width = rect.width, height = rect.height, pad = { left: 52, right: 14, top: 12, bottom: 28 };
        const plotWidth = width - pad.left - pad.right, plotHeight = height - pad.top - pad.bottom;
        const values = mode === 'inter-arrival' ? intervalPoints(samples) : bucketPoints(samples, state.bucket);
        if (!values.length) { byId('graph-empty').hidden = false; graph.hidden = true; clearHover(); return; }
        const maximum = Math.max(1, ...values.map((point) => point.value)) * 1.08;
        const styles = getComputedStyle(document.body);
        const foreground = styles.getPropertyValue('--vscode-descriptionForeground').trim() || '#888';
        const line = styles.getPropertyValue('--vscode-charts-blue').trim() || '#3794ff';
        const gridColor = styles.getPropertyValue('--vscode-panel-border').trim() || '#555';
        context.clearRect(0, 0, width, height); context.font = '11px ' + styles.fontFamily; context.fillStyle = foreground; context.strokeStyle = gridColor; context.lineWidth = 1;
        for (let tick = 0; tick <= 4; tick += 1) {
          const y = pad.top + plotHeight * tick / 4; context.beginPath(); context.moveTo(pad.left, y); context.lineTo(width - pad.right, y); context.stroke();
          const value = maximum * (1 - tick / 4); context.fillText(mode === 'inter-arrival' ? compactDuration(value) : String(Math.round(value)), 2, y + 4);
        }
        context.strokeStyle = line; context.fillStyle = line; context.lineWidth = 2; context.beginPath();
        values.forEach((point, index) => { const x = pad.left + (values.length === 1 ? plotWidth / 2 : index * plotWidth / (values.length - 1)); const y = pad.top + plotHeight * (1 - point.value / maximum); if (index === 0) context.moveTo(x, y); else context.lineTo(x, y); }); context.stroke();
        values.forEach((point, index) => { const x = pad.left + (values.length === 1 ? plotWidth / 2 : index * plotWidth / (values.length - 1)); const y = pad.top + plotHeight * (1 - point.value / maximum); context.beginPath(); context.arc(x, y, 2.5, 0, Math.PI * 2); context.fill(); });
        // Retained so pointer and keyboard hit-testing can map back to a point.
        plotted = values.map((point, index) => Object.assign({}, point, { mode, x: pad.left + (values.length === 1 ? plotWidth / 2 : index * plotWidth / (values.length - 1)), y: pad.top + plotHeight * (1 - point.value / maximum) }));
        resolveHover();
        if (hovered >= 0) { const point = plotted[hovered]; context.beginPath(); context.arc(point.x, point.y, 5, 0, Math.PI * 2); context.stroke(); context.strokeStyle = gridColor; context.lineWidth = 1; context.beginPath(); context.moveTo(point.x, pad.top); context.lineTo(point.x, pad.top + plotHeight); context.stroke(); context.strokeStyle = line; context.lineWidth = 2; }
        showTip();
        const first = values[0], last = values[values.length - 1]; context.fillStyle = foreground; context.fillText(shortTime(first.time), pad.left, height - 7); const end = shortTime(last.time); const measured = context.measureText(end).width; context.fillText(end, width - pad.right - measured, height - 7);
        const peak = Math.max(...values.map((point) => point.value));
        const summary = mode === 'inter-arrival' ? 'Inter-arrival graph with ' + values.length + ' points; largest interval ' + duration(peak) : 'Files per ' + state.bucket + ' minute graph with ' + values.length + ' buckets; peak ' + peak + ' files';
        // Arrow-key navigation must reach assistive technology. A role="img"
        // element exposes only its label, and nothing references the tooltip,
        // so the selected point is folded into the label itself.
        const selected = hovered >= 0 ? plotted[hovered] : undefined;
        graph.setAttribute('aria-label', selected ? summary + '. Selected: ' + tipLines(selected).map((entry) => entry.text).join(', ') : summary);
      }

      // Hovering is matched on x only: the pointer rarely lands on the exact
      // marker, and the interesting question is always "which arrival is this".
      function pointAt(clientX, clientY) {
        if (!plotted.length) return -1;
        const rect = graph.getBoundingClientRect(), x = clientX - rect.left, y = clientY - rect.top;
        if (y < 0 || y > rect.height) return -1;
        let best = -1, bestDistance = Infinity;
        plotted.forEach((point, index) => { const distance = Math.abs(point.x - x); if (distance < bestDistance) { bestDistance = distance; best = index; } });
        const span = plotted.length > 1 ? Math.abs(plotted[1].x - plotted[0].x) : 40;
        return bestDistance <= Math.max(12, span / 2) ? best : -1;
      }

      // A point's identity, stable across re-renders even as indexes shift.
      function pointId(point) { return point ? String(point.mode) + '|' + String(point.time) + '|' + String(point.key || '') : null; }

      function hover(index) {
        if (index === hovered) return;
        hovered = index;
        hoverId = pointId(plotted[index]);
        renderGraph();
      }

      // Called after every rebuild of "plotted" so the highlight stays on the
      // arrival the user is actually pointing at, not on whatever slid into
      // that index when a new file landed.
      function resolveHover() {
        if (pointer) {
          hovered = pointAt(pointer.x, pointer.y);
          hoverId = pointId(plotted[hovered]);
          return;
        }
        if (hoverId === null) { hovered = -1; return; }
        hovered = plotted.findIndex((point) => pointId(point) === hoverId);
        if (hovered < 0) hoverId = null;
      }

      function clearHover() { plotted = []; hovered = -1; hoverId = null; graphTip.hidden = true; }

      function showTip() {
        const point = hovered >= 0 ? plotted[hovered] : undefined;
        if (!point) { graphTip.hidden = true; return; }
        graphTip.replaceChildren(...tipLines(point).map((entry) => { const element = document.createElement('div'); element.className = entry.strong ? 'tip-key' : 'tip-row'; element.textContent = entry.text; return element; }));
        graphTip.hidden = false;
        // Clamp inside the plot so the tooltip never spills out of the panel.
        const wrap = graph.parentElement.getBoundingClientRect(), rect = graph.getBoundingClientRect();
        const offsetLeft = rect.left - wrap.left, offsetTop = rect.top - wrap.top;
        const width = graphTip.offsetWidth, height = graphTip.offsetHeight;
        let left = offsetLeft + point.x + 12;
        if (left + width > offsetLeft + rect.width) left = offsetLeft + point.x - 12 - width;
        graphTip.style.left = Math.max(0, Math.min(left, wrap.width - width)) + 'px';
        graphTip.style.top = Math.max(0, Math.min(offsetTop + point.y - height - 10, wrap.height - height)) + 'px';
      }

      function tipLines(point) {
        if (point.mode === 'files-per-bucket') {
          const end = point.time + (point.spanMs || 0);
          return [
            { text: point.value + (point.value === 1 ? ' file' : ' files'), strong: true },
            { text: dateTime(new Date(point.time).toISOString()) + ' to ' + shortTime(end) }
          ];
        }
        // A directory-marker key ends in '/', whose basename is empty.
        const name = point.key ? String(point.key).replace(/\/+$/, '').split('/').pop() : '';
        const lines = [{ text: name || 'Arrival', strong: true }];
        lines.push({ text: dateTime(new Date(point.time).toISOString()) + '  (' + relative(point.time) + ')' });
        const facts = [];
        if (Number.isFinite(point.size)) facts.push(bytes(point.size));
        facts.push(duration(point.value) + ' since previous');
        if (point.storageClass) facts.push(String(point.storageClass));
        lines.push({ text: facts.join('  -  ') });
        return lines;
      }

      function graphSamples() {
        const source = state.history.length ? state.history : state.objects;
        // History samples carry only key, timestamp and interval, so size and
        // storage class are joined back in from the object grid when present.
        const details = new Map(state.objects.map((item) => [item.key, item]));
        return source.map((item) => { const detail = details.get(item.key) || item; return { time: dateValue(item.lastModified), intervalSeconds: Number(item.intervalSeconds), key: item.key, size: Number(detail.size), storageClass: detail.storageClass }; }).filter((item) => Number.isFinite(item.time) && item.time > 0).sort((a, b) => a.time - b.time).slice(-240);
      }

      function intervalPoints(samples) {
        return samples.map((sample, index) => ({ time: sample.time, value: Number.isFinite(sample.intervalSeconds) ? sample.intervalSeconds : index ? Math.max(0, (sample.time - samples[index - 1].time) / 1000) : NaN, key: sample.key, size: sample.size, storageClass: sample.storageClass, previous: index ? samples[index - 1].key : undefined })).filter((point) => Number.isFinite(point.value)).slice(-96);
      }

      function bucketPoints(samples, minutes) {
        const span = Math.max(1, Number(minutes)) * 60000, buckets = new Map();
        samples.forEach((sample) => { const time = Math.floor(sample.time / span) * span; buckets.set(time, (buckets.get(time) || 0) + 1); });
        if (!buckets.size) return [];
        const starts = Array.from(buckets.keys()).sort((a, b) => a - b), result = [], end = starts[starts.length - 1], start = Math.max(starts[0], end - span * 95);
        for (let time = start; time <= end; time += span) result.push({ time, value: buckets.get(time) || 0, spanMs: span });
        return result;
      }

      function toast(message, level) {
        const element = byId('toast'); element.textContent = String(message || ''); element.className = level === 'error' ? 'error' : ''; element.setAttribute('role', level === 'error' ? 'alert' : 'status'); element.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { element.hidden = true; }, level === 'error' ? 9000 : 3000);
      }

      function persist() { vscode.setState({ sort: state.sort, search: state.search, graphMode: state.graphMode }); }
      function dateValue(value) { const result = Date.parse(value); return Number.isFinite(result) ? result : 0; }
      function dateTime(value) { const time = dateValue(value); return time ? new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' }).format(time) : '—'; }
      function shortTime(value) { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value); }
      function number(value) { return Number.isFinite(value) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value) : '—'; }
      function bytes(value) { if (!Number.isFinite(value)) return '—'; const units = ['B','KB','MB','GB','TB']; let size = Math.max(0, value), unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; } return new Intl.NumberFormat(undefined, { maximumFractionDigits: size < 10 ? 1 : 0 }).format(size) + ' ' + units[unit]; }
      function duration(value) { if (!Number.isFinite(value)) return '—'; const seconds = Math.max(0, Math.round(value)); if (seconds < 60) return seconds + 's'; if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's'; if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ' + Math.floor(seconds % 3600 / 60) + 'm'; return Math.floor(seconds / 86400) + 'd ' + Math.floor(seconds % 86400 / 3600) + 'h'; }
      function compactDuration(value) { if (value < 60) return Math.round(value) + 's'; if (value < 3600) return Math.round(value / 60) + 'm'; if (value < 86400) return (value / 3600).toFixed(value < 36000 ? 1 : 0) + 'h'; return (value / 86400).toFixed(1) + 'd'; }
      function relative(value) { const time = typeof value === 'number' ? value : dateValue(value); if (!time) return '—'; const seconds = Math.round((Date.now() - time) / 1000); if (seconds < -5) return 'in ' + duration(-seconds); if (seconds < 5) return 'just now'; return duration(seconds) + ' ago'; }
      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
}
