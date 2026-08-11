import * as vscode from 'vscode';
import { normalizeTarget } from './adapters';
import type { WatcherDefinition } from './model';

const STORAGE_KEY = 's3Pulse.watchers.v1';

export class WatcherStore implements vscode.Disposable {
  readonly #changeEmitter = new vscode.EventEmitter<readonly WatcherDefinition[]>();
  #watchers: WatcherDefinition[];

  public readonly onDidChange = this.#changeEmitter.event;

  public constructor(private readonly state: vscode.Memento) {
    this.#watchers = decodeWatchers(state.get<unknown>(STORAGE_KEY));
  }

  public list(): readonly WatcherDefinition[] {
    return [...this.#watchers];
  }

  public get(id: string): WatcherDefinition | undefined {
    return this.#watchers.find((watcher) => watcher.id === id);
  }

  public async save(watcher: WatcherDefinition): Promise<void> {
    const next = this.#watchers.filter((item) => item.id !== watcher.id);
    next.push(watcher);
    next.sort((left, right) => left.name.localeCompare(right.name));
    await this.#commit(next);
  }

  public async remove(id: string): Promise<void> {
    await this.#commit(this.#watchers.filter((watcher) => watcher.id !== id));
  }

  public dispose(): void {
    this.#changeEmitter.dispose();
  }

  async #commit(watchers: WatcherDefinition[]): Promise<void> {
    await this.state.update(STORAGE_KEY, watchers);
    this.#watchers = watchers;
    this.#changeEmitter.fire(this.list());
  }
}

function decodeWatchers(value: unknown): WatcherDefinition[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const watchers: WatcherDefinition[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      continue;
    }
    const source = item as Record<string, unknown>;
    const id = typeof source.id === 'string' ? source.id : undefined;
    const name = typeof source.name === 'string' ? source.name.trim() : undefined;
    const target = typeof source.target === 'string' ? normalizeTarget(source.target) : undefined;
    if (!id || ids.has(id) || !name || !target) {
      continue;
    }
    ids.add(id);
    watchers.push({
      id,
      name,
      target,
      profile: optionalString(source.profile),
      region: optionalString(source.region),
      pollIntervalSeconds: boundedInteger(source.pollIntervalSeconds, 5, 3600, 30),
      expectedIntervalSeconds: optionalPositiveInteger(source.expectedIntervalSeconds),
      historyLimit: boundedInteger(source.historyLimit, 100, 1_000, 1_000),
      // Feeds saved before this setting existed fall back to the old default.
      bucketMinutes: boundedInteger(source.bucketMinutes, 1, 1_440, 15)
    });
  }
  return watchers.sort((left, right) => left.name.localeCompare(right.name));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}
