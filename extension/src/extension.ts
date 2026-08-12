import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { errorMessage, formatCost, normalizeTarget, normalizeWatchStatuses, projectedMonthlyCost } from './adapters';
import { AlertController } from './alerts';
import { BackendService } from './backend';
import { costModel, DashboardManager } from './dashboard';
import { FeedTreeItem, FeedTreeProvider } from './feedTree';
import type { CostModel, WatcherDefinition } from './model';
import { WatcherStore } from './watcherStore';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('S3 Pulse', { log: true });
  const store = new WatcherStore(context.globalState);
  const tree = new FeedTreeProvider(store);
  const backend = new BackendService(context.extensionPath, output);
  const dashboards = new DashboardManager(backend, tree, output, store);
  // Subscribes to the backend's notifications independently of dashboards, so
  // a feed's health is tracked whether or not its panel is open.
  const alerts = new AlertController(backend, store, output);

  context.subscriptions.push(
    output,
    store,
    tree,
    backend,
    dashboards,
    alerts,
    vscode.window.registerTreeDataProvider('s3Pulse.feeds', tree),
    vscode.commands.registerCommand('s3Pulse.addFeed', async () => {
      const watcher = await feedWizard();
      if (!watcher) {
        return;
      }
      await store.save(watcher);
      dashboards.open(watcher);
      const action = await vscode.window.showInformationMessage(`Saved S3 feed “${watcher.name}”.`, 'Start Monitoring');
      if (action === 'Start Monitoring') {
        await runUserAction(output, () => dashboards.start(watcher));
      }
    }),
    vscode.commands.registerCommand('s3Pulse.openDashboard', async (argument?: unknown) => {
      const watcher = await selectWatcher(store, argument, 'Open feed dashboard');
      if (watcher) {
        dashboards.open(watcher);
      }
    }),
    vscode.commands.registerCommand('s3Pulse.startFeed', async (argument?: unknown) => {
      const watcher = await selectWatcher(store, argument, 'Start monitoring feed');
      if (!watcher) {
        return;
      }
      const status = tree.stateFor(watcher.id).status;
      if (status === 'running' || status === 'starting' || status === 'error') {
        dashboards.open(watcher);
        return;
      }
      await runUserAction(output, () => dashboards.start(watcher));
    }),
    vscode.commands.registerCommand('s3Pulse.stopFeed', async (argument?: unknown) => {
      const watcher = await selectWatcher(store, argument, 'Stop monitoring feed');
      if (watcher) {
        await runUserAction(output, () => dashboards.stop(watcher));
      }
    }),
    vscode.commands.registerCommand('s3Pulse.editFeed', async (argument?: unknown) => {
      const existing = await selectWatcher(store, argument, 'Edit saved feed');
      if (!existing) {
        return;
      }
      const updated = await feedWizard(existing);
      if (!updated) {
        return;
      }

      // The backend holds immutable per-watcher config, so a live watcher has
      // to be torn down and restarted under the same id to pick up changes.
      const state = tree.stateFor(existing.id).status;
      const wasActive = state === 'running' || state === 'starting' || state === 'error';
      if (wasActive) {
        try {
          await dashboards.stop(existing);
        } catch (error) {
          const saveAnyway = await vscode.window.showWarningMessage(
            `The backend could not stop “${existing.name}”: ${errorMessage(error)}`,
            { modal: true },
            'Save Changes Anyway'
          );
          if (saveAnyway !== 'Save Changes Anyway') {
            return;
          }
          backend.forgetActive(existing.id);
        }
      }

      // A dashboard binds its definition at construction, so rebuild it rather
      // than leaving the panel pointed at the previous target.
      const wasOpen = dashboards.isOpen(existing.id);
      dashboards.close(existing.id);
      await store.save(updated);
      if (wasOpen) {
        dashboards.open(updated);
      }
      if (wasActive) {
        await runUserAction(output, () => dashboards.start(updated));
      } else {
        void vscode.window.showInformationMessage(`Updated S3 feed “${updated.name}”.`);
      }
    }),
    vscode.commands.registerCommand('s3Pulse.removeFeed', async (argument?: unknown) => {
      const watcher = await selectWatcher(store, argument, 'Remove saved feed');
      if (!watcher) {
        return;
      }
      const confirmation = await vscode.window.showWarningMessage(
        `Remove “${watcher.name}” from S3 Pulse? This does not change anything in S3.`,
        { modal: true },
        'Remove Feed'
      );
      if (confirmation !== 'Remove Feed') {
        return;
      }
      const state = tree.stateFor(watcher.id).status;
      if (state === 'running' || state === 'starting' || state === 'error') {
        try {
          await dashboards.stop(watcher);
        } catch (error) {
          const removeAnyway = await vscode.window.showWarningMessage(
            `The backend could not stop “${watcher.name}”: ${errorMessage(error)}`,
            { modal: true },
            'Remove Saved Definition Anyway'
          );
          if (removeAnyway !== 'Remove Saved Definition Anyway') {
            return;
          }
        }
      }
      backend.forgetActive(watcher.id);
      dashboards.close(watcher.id);
      tree.remove(watcher.id);
      alerts.forget(watcher.id);
      await store.remove(watcher.id);
    }),
    vscode.commands.registerCommand('s3Pulse.refreshFeeds', async () => {
      if (store.list().length === 0) {
        tree.refresh();
        return;
      }
      await runUserAction(output, async () => {
        const result = await backend.request('watch.status', {});
        for (const status of normalizeWatchStatuses(result)) {
          tree.setStatus(status);
        }
        tree.refresh();
      });
    }),
    vscode.commands.registerCommand('s3Pulse.showOutput', () => output.show(true)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('s3Pulse.backendPath') || event.affectsConfiguration('s3Pulse.backendLogLevel')) {
        void runUserAction(output, () => backend.restart());
      }
    })
  );

  output.appendLine(`S3 Pulse extension activated on ${process.platform}-${process.arch}`);
  if (vscode.env.uiKind === vscode.UIKind.Web) {
    void vscode.window.showErrorMessage('S3 Pulse requires a desktop or remote extension host to run its native backend.');
  }
}

async function feedWizard(existing?: WatcherDefinition): Promise<WatcherDefinition | undefined> {
  const title = existing ? 'Edit S3 Pulse Feed' : 'Add S3 Pulse Feed';
  const targetInput = await vscode.window.showInputBox({
    title: `${title} (1/6)`,
    prompt: 'S3 bucket and prefix to monitor',
    placeHolder: 's3://prod-data/trades/daily/',
    value: existing?.target,
    ignoreFocusOut: true,
    validateInput: (value) => normalizeTarget(value) ? undefined : 'Enter an S3 URI such as s3://bucket/prefix/'
  });
  if (targetInput === undefined) {
    return undefined;
  }
  const target = normalizeTarget(targetInput);
  if (!target) {
    return undefined;
  }

  const name = await vscode.window.showInputBox({
    title: `${title} (2/6)`,
    prompt: 'Display name',
    value: existing?.name ?? suggestedName(target),
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : 'Enter a feed name'
  });
  if (name === undefined) {
    return undefined;
  }

  const profile = await vscode.window.showInputBox({
    title: `${title} (3/6)`,
    prompt: 'AWS profile (optional)',
    placeHolder: 'Leave empty to use the normal AWS credential chain',
    value: existing?.profile ?? '',
    ignoreFocusOut: true
  });
  if (profile === undefined) {
    return undefined;
  }

  const defaultPoll = vscode.workspace.getConfiguration('s3Pulse').get<number>('defaultPollIntervalSeconds', 30);
  const current = existing?.pollIntervalSeconds;
  const intervals = [...new Set([defaultPoll, ...(current ? [current] : []), 5, 10, 30, 60, 300])]
    .filter((seconds) => Number.isInteger(seconds) && seconds >= 5 && seconds <= 3600)
    .sort((left, right) => left - right);
  const cost = costModel();
  const selectedInterval = await vscode.window.showQuickPick(
    intervals.map((seconds) => ({
      label: formatInterval(seconds),
      description: seconds === current ? 'Current' : seconds === defaultPoll ? 'Default' : undefined,
      detail: pollCostDetail(seconds, cost),
      seconds
    })),
    {
      title: `${title} (4/6)`,
      placeHolder: 'Polling interval',
      ignoreFocusOut: true
    }
  );
  if (!selectedInterval) {
    return undefined;
  }

  const expectedInput = await vscode.window.showInputBox({
    title: `${title} (5/6)`,
    prompt: 'Expected arrival interval in seconds (optional)',
    placeHolder: 'For example, 900 for a 15-minute feed; leave empty to auto-learn',
    value: existing?.expectedIntervalSeconds?.toString() ?? '',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value.trim()) {
        return undefined;
      }
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed > 0 ? undefined : 'Enter a positive whole number of seconds';
    }
  });
  if (expectedInput === undefined) {
    return undefined;
  }

  const bucketChoices = [1, 5, 15, 30, 60, 240, 1_440];
  const defaultBucket = vscode.workspace.getConfiguration('s3Pulse').get<number>('defaultBucketMinutes', 15);
  const currentBucket = existing?.bucketMinutes
    ?? (Number.isInteger(defaultBucket) && defaultBucket >= 1 && defaultBucket <= 1_440 ? defaultBucket : 15);
  const selectedBucket = await vscode.window.showQuickPick(
    [...new Set([currentBucket, ...bucketChoices])]
      .filter((minutes) => Number.isInteger(minutes) && minutes >= 1 && minutes <= 1_440)
      .sort((left, right) => left - right)
      .map((minutes) => ({
        label: formatBucket(minutes),
        description: minutes === currentBucket ? 'Current' : undefined,
        minutes
      })),
    {
      title: `${title} (6/6)`,
      placeHolder: 'Bucket width for the "files per interval" graph',
      ignoreFocusOut: true
    }
  );
  if (!selectedBucket) {
    return undefined;
  }

  const historyLimit = vscode.workspace.getConfiguration('s3Pulse').get<number>('historyLimit', 1_000);
  return {
    id: existing?.id ?? randomUUID(),
    name: name.trim(),
    target,
    profile: profile.trim() || undefined,
    region: existing?.region,
    pollIntervalSeconds: selectedInterval.seconds,
    expectedIntervalSeconds: expectedInput.trim() ? Number(expectedInput) : undefined,
    historyLimit: Number.isInteger(historyLimit) ? Math.min(1_000, Math.max(100, historyLimit)) : 1_000,
    bucketMinutes: selectedBucket.minutes
  };
}

// A floor, not a forecast: it assumes one LIST page per poll, so a prefix
// holding over 1,000 objects costs proportionally more.
function pollCostDetail(seconds: number, cost: CostModel): string | undefined {
  const formatted = formatCost(projectedMonthlyCost(seconds, cost), cost.currency);
  if (!formatted) {
    return undefined;
  }
  const perMonth = Math.round((30 * 24 * 60 * 60) / seconds);
  return `about ${perMonth.toLocaleString()} LIST requests/month, from ${formatted}`;
}

function formatBucket(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} min`;
  }
  if (minutes === 1_440) {
    return '1 day';
  }
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hour${hours === 1 ? '' : 's'}`;
}

async function selectWatcher(
  store: WatcherStore,
  argument: unknown,
  placeHolder: string
): Promise<WatcherDefinition | undefined> {
  if (argument instanceof FeedTreeItem) {
    return argument.watcher;
  }
  if (isWatcher(argument)) {
    return store.get(argument.id) ?? argument;
  }
  const watchers = store.list();
  if (watchers.length === 0) {
    const action = await vscode.window.showInformationMessage('No S3 Pulse feeds are configured.', 'Add Feed');
    if (action === 'Add Feed') {
      await vscode.commands.executeCommand('s3Pulse.addFeed');
    }
    return undefined;
  }
  if (watchers.length === 1) {
    return watchers[0];
  }
  return (await vscode.window.showQuickPick(
    watchers.map((watcher) => ({ label: watcher.name, description: watcher.target, watcher })),
    { placeHolder }
  ))?.watcher;
}

function isWatcher(value: unknown): value is WatcherDefinition {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const source = value as Record<string, unknown>;
  return typeof source.id === 'string' && typeof source.name === 'string' && typeof source.target === 'string';
}

async function runUserAction(output: vscode.OutputChannel, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof vscode.CancellationError) {
      return;
    }
    const message = errorMessage(error);
    output.appendLine(`[extension] ${message}`);
    const selection = await vscode.window.showErrorMessage(`S3 Pulse: ${message}`, 'Show Output', 'Configure Backend');
    if (selection === 'Show Output') {
      output.show(true);
    } else if (selection === 'Configure Backend') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 's3Pulse.backendPath');
    }
  }
}

function suggestedName(target: string): string {
  const withoutScheme = target.slice('s3://'.length).replace(/\/+$/, '');
  const parts = withoutScheme.split('/').filter(Boolean);
  return parts.at(-1) ?? 'S3 Feed';
}

function formatInterval(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} seconds`;
  }
  if (seconds % 60 === 0 && seconds < 3600) {
    return `${seconds / 60} ${seconds === 60 ? 'minute' : 'minutes'}`;
  }
  return `${seconds} seconds`;
}
