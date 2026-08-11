import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JsonLineDecoder, isJsonRpcNotification, isJsonRpcResponse } from '../src/rpcProtocol';

test('decoder accepts fragmented, concurrent JSON-RPC lines and CRLF', () => {
  const decoder = new JsonLineDecoder();
  assert.deepEqual(decoder.push(Buffer.from('{"jsonrpc":"2.0","id":2,"res')), []);
  assert.deepEqual(decoder.push(Buffer.from('ult":{"ok":true}}\r\n{"jsonrpc":"2.0","method":"objects.added"}\n')), [
    { jsonrpc: '2.0', id: 2, result: { ok: true } },
    { jsonrpc: '2.0', method: 'objects.added' }
  ]);
});

test('decoder preserves split UTF-8 characters', () => {
  const bytes = Buffer.from('{"value":"arrival ✓"}\n');
  const split = bytes.indexOf(0xe2) + 1;
  const decoder = new JsonLineDecoder();
  assert.deepEqual(decoder.push(bytes.subarray(0, split)), []);
  assert.deepEqual(decoder.push(bytes.subarray(split)), [{ value: 'arrival ✓' }]);
});

test('decoder finishes an unterminated final line', () => {
  const decoder = new JsonLineDecoder();
  decoder.push(Buffer.from('{"done":true}'));
  assert.deepEqual(decoder.finish(), [{ done: true }]);
});

test('response and notification guards reject ambiguous messages', () => {
  assert.equal(isJsonRpcResponse({ jsonrpc: '2.0', id: 1, result: null }), true);
  assert.equal(isJsonRpcResponse({ jsonrpc: '2.0', id: 1 }), false);
  assert.equal(isJsonRpcNotification({ jsonrpc: '2.0', method: 'watch.error' }), true);
  assert.equal(isJsonRpcNotification({ jsonrpc: '2.0', id: 1, method: 'watch.error' }), false);
});
