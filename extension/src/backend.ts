import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { errorMessage, serializeWatcher } from './adapters';
import type { WatcherDefinition } from './model';
import { RpcClient, type RpcRequestOptions } from './rpcClient';
import type { JsonRpcNotification } from './rpcProtocol';

const DEFAULT_REQUEST_TIMEOUT = 60_000;
const SUPPORTED_PROTOCOL_VERSION = 1;

export async function discoverBackendPath(extensionPath: string): Promise<string> {
  const configuration = vscode.workspace.getConfiguration('s3Pulse');
  const configured = configuration.get<string>('backendPath', '').trim();
  const executableName = process.platform === 'win32' ? 's3pulse.exe' : 's3pulse';
  let candidate: string;

  if (configured) {
    candidate = expandConfiguredPath(configured, extensionPath);
    if (!path.isAbsolute(candidate)) {
      throw new Error('s3Pulse.backendPath must resolve to an absolute path');
    }
  } else {
    const platform = `${process.platform}-${process.arch}`;
    candidate = path.join(extensionPath, 'bin', platform, executableName);
  }

  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile()) {
      throw new Error('path is not a file');
    }
    await access(candidate, process.platform === 'win32' ? constants.R_OK : constants.R_OK | constants.X_OK);
  } catch (error) {
    const source = configured ? 'configured' : `bundled ${process.platform}-${process.arch}`;
    throw new Error(`The ${source} S3 Pulse backend is unavailable at ${candidate}: ${errorMessage(error)}`);
  }
  return candidate;
}

function expandConfiguredPath(value: string, extensionPath: string): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return value
    .replaceAll('${extensionPath}', extensionPath)
    .replaceAll('${workspaceFolder}', workspaceFolder)
    .replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => process.env[name] ?? '');
}

export class BackendService implements vscode.Disposable {
  readonly #notificationEmitter = new vscode.EventEmitter<JsonRpcNotification>();
  readonly #restartEmitter = new vscode.EventEmitter<void>();
  readonly #activeWatchers = new Map<string, WatcherDefinition>();
  readonly #subscriptions: vscode.Disposable[] = [];
  #client?: RpcClient;
  #starting?: Promise<RpcClient>;
  #restartTimer?: NodeJS.Timeout;
  #restartStabilityTimer?: NodeJS.Timeout;
  #restartAttempt = 0;
  #generation = 0;
  #disposed = false;
  #suppressRestart = false;

  public readonly onNotification = this.#notificationEmitter.event;
  public readonly onDidRestart = this.#restartEmitter.event;

  public constructor(
    private readonly extensionPath: string,
    private readonly output: vscode.OutputChannel
  ) {}

  public async request<T = unknown>(
    method: string,
    params?: unknown,
    options: RpcRequestOptions = {}
  ): Promise<T> {
    const client = await this.#ensureClient();
    return await client.request<T>(method, params, {
      timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT,
      cancellation: options.cancellation
    });
  }

  public rememberActive(watcher: WatcherDefinition): void {
    this.#activeWatchers.set(watcher.id, watcher);
  }

  public forgetActive(watcherId: string): void {
    this.#activeWatchers.delete(watcherId);
  }

  public async restart(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
    }
    this.#restartAttempt = 0;
    this.output.appendLine('[extension] Restarting backend after configuration change');
    this.#restartAttempt = 0;
    if (this.#restartStabilityTimer) {
      clearTimeout(this.#restartStabilityTimer);
      this.#restartStabilityTimer = undefined;
    }
    this.#suppressRestart = true;
    this.#generation += 1;
    this.#client?.dispose();
    this.#client = undefined;
    this.#starting = undefined;
    this.#suppressRestart = false;
    if (this.#activeWatchers.size > 0) {
      await this.#startAndRestore();
    }
  }

  public dispose(): void {
    this.#disposed = true;
    this.#generation += 1;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
    }
    if (this.#restartStabilityTimer) {
      clearTimeout(this.#restartStabilityTimer);
    }
    this.#suppressRestart = true;
    this.#client?.dispose();
    for (const subscription of this.#subscriptions) {
      subscription.dispose();
    }
    this.#notificationEmitter.dispose();
    this.#restartEmitter.dispose();
  }

  async #ensureClient(): Promise<RpcClient> {
    if (this.#disposed) {
      throw new Error('S3 Pulse backend service has been disposed');
    }
    if (this.#client) {
      return this.#client;
    }
    if (!this.#starting) {
      this.#starting = this.#launch(this.#generation);
    }
    const starting = this.#starting;
    try {
      return await starting;
    } finally {
      if (this.#starting === starting) {
        this.#starting = undefined;
      }
    }
  }

  async #launch(generation: number): Promise<RpcClient> {
    const executable = await discoverBackendPath(this.extensionPath);
    if (this.#disposed || generation !== this.#generation) {
      throw new Error('Backend start was superseded');
    }
    const logLevel = vscode.workspace.getConfiguration('s3Pulse').get<string>('backendLogLevel', 'info');
    this.output.appendLine(`[extension] Starting ${executable} serve --stdio`);
    const child = spawn(executable, ['serve', '--stdio'], {
      cwd: this.extensionPath,
      env: {
        ...process.env,
        RUST_LOG: process.env.RUST_LOG ?? logLevel,
        S3PULSE_LOG: logLevel
      },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams;

    await waitForSpawn(child);
    if (this.#disposed || generation !== this.#generation) {
      child.kill();
      throw new Error('Backend start was superseded');
    }
    const client = new RpcClient(child, this.output);
    this.#client = client;
    this.#subscriptions.push(
      client.onNotification((notification) => this.#notificationEmitter.fire(notification)),
      client.onDidClose((error) => this.#handleClose(client, error))
    );

    try {
      const version = await client.request<unknown>('system.version', {}, { timeoutMs: 10_000 });
      const backendVersion = compatibleBackendVersion(version);
      this.output.appendLine(`[extension] Backend ready (pid ${String(client.processId)}, version ${backendVersion})`);
      if (this.#restartStabilityTimer) {
        clearTimeout(this.#restartStabilityTimer);
      }
      this.#restartStabilityTimer = setTimeout(() => {
        this.#restartAttempt = 0;
        this.#restartStabilityTimer = undefined;
      }, 30_000);
      this.#restartStabilityTimer.unref();
      return client;
    } catch (error) {
      client.dispose();
      if (this.#client === client) {
        this.#client = undefined;
      }
      throw new Error(`S3 Pulse backend handshake failed: ${errorMessage(error)}`);
    }
  }

  #handleClose(client: RpcClient, error: Error): void {
    if (this.#client !== client) {
      return;
    }
    this.#client = undefined;
    if (this.#restartStabilityTimer) {
      clearTimeout(this.#restartStabilityTimer);
      this.#restartStabilityTimer = undefined;
    }
    this.output.appendLine(`[extension] ${error.message}`);
    if (this.#disposed || this.#suppressRestart || this.#activeWatchers.size === 0) {
      return;
    }
    const shouldRestart = vscode.workspace.getConfiguration('s3Pulse').get<boolean>('restartBackend', true);
    for (const watcher of this.#activeWatchers.values()) {
      this.#notificationEmitter.fire(shouldRestart
        ? {
            jsonrpc: '2.0',
            method: 'watch.statusChanged',
            params: { watcherId: watcher.id, status: 'starting' }
          }
        : {
            jsonrpc: '2.0',
            method: 'watch.error',
            params: { watcherId: watcher.id, error: { message: error.message } }
          });
    }
    if (!shouldRestart) {
      return;
    }
    this.#scheduleRestart();
  }

  #scheduleRestart(): void {
    if (this.#restartTimer || this.#disposed) {
      return;
    }
    const delay = Math.min(15_000, 1_000 * 2 ** Math.min(this.#restartAttempt, 4));
    this.#restartAttempt += 1;
    this.output.appendLine(`[extension] Backend restart scheduled in ${delay} ms`);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      void this.#startAndRestore().catch((error: unknown) => {
        this.output.appendLine(`[extension] Backend restart failed: ${errorMessage(error)}`);
        this.#scheduleRestart();
      });
    }, delay);
    this.#restartTimer.unref();
  }

  async #startAndRestore(): Promise<void> {
    const client = await this.#ensureClient();
    for (const watcher of this.#activeWatchers.values()) {
      try {
        await client.request('watch.start', { watcher: serializeWatcher(watcher) }, { timeoutMs: DEFAULT_REQUEST_TIMEOUT });
      } catch (error) {
        const message = `Could not restore feed “${watcher.name}”: ${errorMessage(error)}`;
        this.output.appendLine(`[extension] ${message}`);
        this.#notificationEmitter.fire({
          jsonrpc: '2.0',
          method: 'watch.error',
          params: { watcherId: watcher.id, error: { message } }
        });
      }
    }
    this.output.appendLine(`[extension] Restored ${this.#activeWatchers.size} active feed(s)`);
    this.#restartEmitter.fire();
  }
}

async function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function compatibleBackendVersion(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    if (source.protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
      throw new Error(
        `Unsupported S3 Pulse protocol version ${String(source.protocolVersion ?? 'missing')}; expected ${SUPPORTED_PROTOCOL_VERSION}`
      );
    }
    const version = source.version ?? source.backendVersion;
    if (typeof version === 'string') {
      return version;
    }
  }
  throw new Error('Backend version response is missing required protocol metadata');
}
