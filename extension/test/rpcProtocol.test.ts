import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JsonLineDecoder, describeRemoteError, isJsonRpcNotification, isJsonRpcResponse } from '../src/rpcProtocol';

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


test('describes a remote error by its detail, then by its kind', () => {
  assert.equal(
    describeRemoteError('Invalid params', { detail: 'key "x" is outside the watcher\'s target s3://b/p/' }),
    'Invalid params: key "x" is outside the watcher\'s target s3://b/p/'
  );
  assert.equal(describeRemoteError('boom', { detail: 'boom' }), 'boom', 'a detail equal to the message is not repeated');

  // The message already names the AWS code; the kind says whose problem it
  // is, and retryable says whether trying again is worth anything.
  assert.equal(
    describeRemoteError('GetObject failed: AccessDenied: Access Denied', { kind: 'accessDenied', message: 'x', retryable: false }),
    'GetObject failed: AccessDenied: Access Denied (access denied; check the IAM policy for this bucket and key, and any KMS key policy)'
  );
  assert.equal(
    describeRemoteError('GetObject failed: dispatch failure', { kind: 'network', retryable: true }),
    'GetObject failed: dispatch failure (the request did not reach S3; check network and region, retrying may succeed)'
  );
  assert.equal(
    describeRemoteError('GetObject failed: ExpiredToken: expired', { kind: 'authentication' }),
    'GetObject failed: ExpiredToken: expired (AWS credentials are missing or expired; sign in again)'
  );
  assert.equal(describeRemoteError('x', { kind: 'somethingNew' }), 'x (somethingNew)', 'an unknown kind is still shown');
  assert.equal(describeRemoteError('x', 'not an object'), 'x');
  assert.equal(describeRemoteError('x', undefined), 'x');
});
