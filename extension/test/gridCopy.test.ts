import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizeObject, normalizeTarget, objectUri } from '../src/adapters';

// The grid's Copy URI button posts the row's key, and the host writes
// objectUri(watcher.target, key) to the clipboard. dashboard.ts pulls in
// 'vscode' and cannot be imported here, so the wiring is pinned by reading the
// source and the URI itself is checked through the function that builds it.

const dashboard = readFileSync('src/dashboard.ts', 'utf8');

test('Copy URI writes the URI objectUri builds for the row key', () => {
  assert.match(
    dashboard,
    /case 'copyUri':\s*\n\s*await vscode\.env\.clipboard\.writeText\(objectUri\(watcher\.target, message\.key\)\);/
  );
});

test('Copy URI names the row object for an ordinary key', () => {
  assert.equal(objectUri('s3://feed/trades/', 'trades/trades_0001.csv'), 's3://feed/trades/trades_0001.csv');
  assert.equal(objectUri('s3://feed/trades/', 'trades/a b+c%20.csv'), 's3://feed/trades/a b+c%20.csv');
});

test('Copy URI keeps a leading slash that is part of the key', () => {
  // S3 keys may begin with '/', and a feed can watch such a prefix:
  // normalizeTarget deliberately keeps s3://bucket//prefix, and the backend
  // lists and downloads the key exactly. The copied URI has to name the same
  // object, or pasting it into `aws s3 cp` fetches a different one.
  const target = normalizeTarget('s3://data-bucket//leading-slash/');
  assert.equal(target, 's3://data-bucket//leading-slash/');
  const key = '/leading-slash/2026-09-28.csv';

  assert.equal(objectUri(target ?? '', key), 's3://data-bucket//leading-slash/2026-09-28.csv');
  assert.equal(
    normalizeObject({ key, lastModified: '2026-09-28T00:00:00Z', size: 1 }, target)?.uri,
    's3://data-bucket//leading-slash/2026-09-28.csv'
  );
});
