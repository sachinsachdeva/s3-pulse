import { StringDecoder } from 'node:string_decoder';

export const JSON_RPC_VERSION = '2.0' as const;

export interface JsonRpcRequest {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: number | null;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorObject;
}

export class JsonLineDecoder {
  readonly #decoder = new StringDecoder('utf8');
  #buffer = '';

  public constructor(private readonly maximumBufferLength = 8 * 1024 * 1024) {}

  public push(chunk: Uint8Array): unknown[] {
    this.#buffer += this.#decoder.write(Buffer.from(chunk));
    if (this.#buffer.length > this.maximumBufferLength) {
      this.#buffer = '';
      throw new Error(`JSON-RPC line exceeded ${this.maximumBufferLength} characters`);
    }
    return this.#consumeCompleteLines();
  }

  public finish(): unknown[] {
    this.#buffer += this.#decoder.end();
    const values = this.#consumeCompleteLines();
    const finalLine = this.#buffer.trim();
    this.#buffer = '';
    if (finalLine) {
      values.push(JSON.parse(finalLine) as unknown);
    }
    return values;
  }

  #consumeCompleteLines(): unknown[] {
    const values: unknown[] = [];
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) {
        break;
      }
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) {
        values.push(JSON.parse(line) as unknown);
      }
    }
    return values;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  const source = record(value);
  return source?.jsonrpc === JSON_RPC_VERSION
    && (typeof source.id === 'number' || source.id === null)
    && (Object.hasOwn(source, 'result') || Object.hasOwn(source, 'error'));
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  const source = record(value);
  return source?.jsonrpc === JSON_RPC_VERSION
    && typeof source.method === 'string'
    && !Object.hasOwn(source, 'id');
}
