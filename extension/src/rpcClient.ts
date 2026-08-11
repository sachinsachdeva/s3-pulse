import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as vscode from 'vscode';
import {
  isJsonRpcNotification,
  isJsonRpcResponse,
  JSON_RPC_VERSION,
  JsonLineDecoder,
  type JsonRpcNotification,
  type JsonRpcRequest
} from './rpcProtocol';

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cancellation?: vscode.Disposable;
  readonly timeout?: NodeJS.Timeout;
}

export interface RpcRequestOptions {
  readonly cancellation?: vscode.CancellationToken;
  readonly timeoutMs?: number;
}

export class RpcRemoteError extends Error {
  public constructor(
    message: string,
    public readonly code: number,
    public readonly data?: unknown
  ) {
    super(remoteErrorMessage(message, data));
    this.name = 'RpcRemoteError';
  }
}

function remoteErrorMessage(message: string, data: unknown): string {
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const detail = (data as Record<string, unknown>).detail;
    if (typeof detail === 'string' && detail.trim() && detail !== message) {
      return `${message}: ${detail}`;
    }
  }
  return message;
}

export class RpcClient implements vscode.Disposable {
  readonly #decoder = new JsonLineDecoder();
  readonly #pending = new Map<number, PendingRequest>();
  readonly #notificationEmitter = new vscode.EventEmitter<JsonRpcNotification>();
  readonly #closeEmitter = new vscode.EventEmitter<Error>();
  readonly #stderrReader: ReturnType<typeof createInterface>;
  #nextId = 1;
  #closed = false;
  #expectedClose = false;

  public readonly onNotification = this.#notificationEmitter.event;
  public readonly onDidClose = this.#closeEmitter.event;

  public constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly output: vscode.OutputChannel
  ) {
    child.stdout.on('data', (chunk: Buffer) => this.#acceptChunk(chunk));
    child.stdout.once('end', () => this.#finishStream());
    child.stdin.on('error', (error) => this.#close(error));
    child.once('error', (error) => this.#close(error));
    child.once('exit', (code, signal) => {
      const detail = signal ? `signal ${signal}` : `exit code ${String(code)}`;
      const prefix = this.#expectedClose ? 'Backend stopped' : 'Backend exited unexpectedly';
      this.#close(new Error(`${prefix} (${detail})`));
    });

    this.#stderrReader = createInterface({ input: child.stderr, crlfDelay: Infinity });
    this.#stderrReader.on('line', (line) => {
      if (line.trim()) {
        this.output.appendLine(`[backend] ${line}`);
      }
    });
  }

  public get processId(): number | undefined {
    return this.child.pid;
  }

  public async request<T = unknown>(
    method: string,
    params?: unknown,
    options: RpcRequestOptions = {}
  ): Promise<T> {
    if (this.#closed || !this.child.stdin.writable) {
      throw new Error('S3 Pulse backend is not running');
    }
    if (options.cancellation?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    const id = this.#allocateId();
    const request: JsonRpcRequest = { jsonrpc: JSON_RPC_VERSION, id, method, params };
    return await new Promise<T>((resolve, reject) => {
      let cancellation: vscode.Disposable | undefined;
      let timeout: NodeJS.Timeout | undefined;

      const rejectRequest = (error: Error, cancelRemote: boolean): void => {
        const pending = this.#takePending(id);
        if (!pending) {
          return;
        }
        if (cancelRemote) {
          this.notify('$/cancelRequest', { id });
        }
        pending.reject(error);
      };

      if (options.cancellation) {
        cancellation = options.cancellation.onCancellationRequested(() => {
          rejectRequest(new vscode.CancellationError(), true);
        });
      }
      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timeout = setTimeout(() => {
          rejectRequest(new Error(`Backend request ${method} timed out after ${options.timeoutMs} ms`), true);
        }, options.timeoutMs);
        timeout.unref();
      }

      this.#pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        cancellation,
        timeout
      });

      const line = `${JSON.stringify(request)}\n`;
      this.child.stdin.write(line, 'utf8', (error) => {
        if (error) {
          rejectRequest(error, false);
        }
      });
    });
  }

  public notify(method: string, params?: unknown): void {
    if (this.#closed || !this.child.stdin.writable) {
      return;
    }
    const line = `${JSON.stringify({ jsonrpc: JSON_RPC_VERSION, method, params })}\n`;
    this.child.stdin.write(line, 'utf8', (error) => {
      if (error) {
        this.output.appendLine(`[rpc] Could not send ${method}: ${error.message}`);
      }
    });
  }

  public dispose(): void {
    if (this.#closed) {
      return;
    }
    this.#expectedClose = true;
    this.child.stdin.end();
    const timer = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill();
      }
    }, 2_000);
    timer.unref();
    this.#close(new Error('S3 Pulse backend was stopped'));
  }

  #acceptChunk(chunk: Buffer): void {
    if (this.#closed) {
      return;
    }
    try {
      for (const message of this.#decoder.push(chunk)) {
        this.#acceptMessage(message);
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.output.appendLine(`[rpc] Invalid backend stdout: ${failure.message}`);
      this.child.kill();
      this.#close(new Error(`Invalid JSON-RPC output from S3 Pulse backend: ${failure.message}`));
    }
  }

  #finishStream(): void {
    if (this.#closed) {
      return;
    }
    try {
      for (const message of this.#decoder.finish()) {
        this.#acceptMessage(message);
      }
    } catch (error) {
      this.output.appendLine(`[rpc] Invalid final backend response: ${String(error)}`);
    }
  }

  #acceptMessage(message: unknown): void {
    if (isJsonRpcResponse(message)) {
      if (message.id === null) {
        this.output.appendLine('[rpc] Ignored response with null id');
        return;
      }
      const pending = this.#takePending(message.id);
      if (!pending) {
        this.output.appendLine(`[rpc] Ignored response for unknown request ${message.id}`);
        return;
      }
      if (message.error) {
        pending.reject(new RpcRemoteError(message.error.message, message.error.code, message.error.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (isJsonRpcNotification(message)) {
      this.#notificationEmitter.fire(message);
      return;
    }
    this.output.appendLine('[rpc] Ignored unrecognized backend message');
  }

  #allocateId(): number {
    for (;;) {
      const candidate = this.#nextId;
      this.#nextId = this.#nextId >= Number.MAX_SAFE_INTEGER ? 1 : this.#nextId + 1;
      if (!this.#pending.has(candidate)) {
        return candidate;
      }
    }
  }

  #takePending(id: number): PendingRequest | undefined {
    const pending = this.#pending.get(id);
    if (pending) {
      this.#pending.delete(id);
      pending.cancellation?.dispose();
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
    }
    return pending;
  }

  #close(error: Error): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#stderrReader.close();
    for (const [id] of this.#pending) {
      this.#takePending(id)?.reject(error);
    }
    this.#closeEmitter.fire(error);
    this.#notificationEmitter.dispose();
    this.#closeEmitter.dispose();
  }
}
