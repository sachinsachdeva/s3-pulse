import * as vscode from 'vscode';
import type { WatchState, WatchStatus, WatcherDefinition } from './model';
import type { WatcherStore } from './watcherStore';

export class FeedTreeProvider implements vscode.TreeDataProvider<FeedTreeItem>, vscode.Disposable {
  readonly #changeEmitter = new vscode.EventEmitter<FeedTreeItem | undefined>();
  readonly #statuses = new Map<string, WatchStatus>();
  readonly #storeSubscription: vscode.Disposable;

  public readonly onDidChangeTreeData = this.#changeEmitter.event;

  public constructor(private readonly store: WatcherStore) {
    this.#storeSubscription = store.onDidChange(() => this.refresh());
  }

  public getTreeItem(element: FeedTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: FeedTreeItem): FeedTreeItem[] {
    if (element) {
      return [];
    }
    return this.store.list().map((watcher) => new FeedTreeItem(watcher, this.stateFor(watcher.id)));
  }

  public stateFor(watcherId: string): WatchStatus {
    return this.#statuses.get(watcherId) ?? { watcherId, status: 'stopped' };
  }

  public setStatus(status: WatchStatus): void {
    const previous = this.#statuses.get(status.watcherId);
    this.#statuses.set(status.watcherId, {
      ...previous,
      ...status,
      error: status.error ?? (status.status === 'error' ? previous?.error : undefined)
    });
    this.refresh();
  }

  public setState(watcherId: string, status: WatchState, error?: string): void {
    this.setStatus({ watcherId, status, error });
  }

  public remove(watcherId: string): void {
    this.#statuses.delete(watcherId);
    this.refresh();
  }

  public refresh(): void {
    this.#changeEmitter.fire(undefined);
  }

  public dispose(): void {
    this.#storeSubscription.dispose();
    this.#changeEmitter.dispose();
  }
}

export class FeedTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly watcher: WatcherDefinition,
    public readonly watchStatus: WatchStatus
  ) {
    super(watcher.name, vscode.TreeItemCollapsibleState.None);
    const state = watchStatus.status;
    this.id = watcher.id;
    this.contextValue = state === 'running' || state === 'starting' || state === 'error'
      ? 's3Pulse.feed.running'
      : 's3Pulse.feed.stopped';
    this.description = state === 'stopped' ? watcher.target : `${displayState(state)} · ${watcher.target}`;
    this.iconPath = iconForState(state);
    this.command = {
      command: 's3Pulse.openDashboard',
      title: 'Open S3 Pulse Dashboard',
      arguments: [watcher]
    };
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**${escapeMarkdown(watcher.name)}**\n\n`);
    tooltip.appendText(watcher.target);
    tooltip.appendMarkdown(`\n\nStatus: **${escapeMarkdown(displayState(state))}**`);
    if (watchStatus.lastPollAt) {
      tooltip.appendMarkdown(`\n\nLast poll: ${escapeMarkdown(watchStatus.lastPollAt)}`);
    }
    if (watchStatus.error) {
      tooltip.appendMarkdown('\n\n');
      tooltip.appendText(watchStatus.error);
    }
    this.tooltip = tooltip;
    this.accessibilityInformation = {
      label: `${watcher.name}, ${displayState(state)}, ${watcher.target}`,
      role: 'treeitem'
    };
  }
}

function displayState(state: WatchState): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function iconForState(state: WatchState): vscode.ThemeIcon {
  switch (state) {
    case 'running':
      return new vscode.ThemeIcon('pulse', new vscode.ThemeColor('testing.iconPassed'));
    case 'starting':
      return new vscode.ThemeIcon('loading~spin');
    case 'error':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    case 'unknown':
      return new vscode.ThemeIcon('question');
    case 'stopped':
      return new vscode.ThemeIcon('circle-outline');
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!]/g, '\\$&');
}
