import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// A failed download used to be visible only as toasts that hide themselves,
// with nothing in Output for "Show Output" to show. Neither dashboard.ts nor
// rpcClient.ts can be imported here because both pull in 'vscode', so these
// invariants are pinned by reading the source, as startRouting.test.ts does.

const dashboard = readFileSync('src/dashboard.ts', 'utf8');
const rpcClient = readFileSync('src/rpcClient.ts', 'utf8');

test('a failed dashboard action is written to Output with its code and data', () => {
  const start = dashboard.indexOf('async #handleWebviewMessage(');
  const body = dashboard.slice(start, dashboard.indexOf('async #download(', start));
  assert.match(body, /catch \(error\) \{[\s\S]*this\.output\.appendLine\([\s\S]*errorDetail\(error\)/);
  assert.match(
    dashboard,
    /function errorDetail\(error: unknown\): string[\s\S]*error instanceof RpcRemoteError[\s\S]*error\.code/
  );
});

test('a download failure notification is logged rather than treated as progress', () => {
  const start = dashboard.indexOf('#reportDownload(progress: DownloadProgress)');
  const body = dashboard.slice(start, dashboard.indexOf('class FeedDashboard', start));
  assert.match(body, /if \(progress\.error\) \{[\s\S]*this\.output\.appendLine\([\s\S]*continue;/);
});

test('the RPC client describes remote errors with the shared, tested builder', () => {
  assert.match(rpcClient, /import \{[^}]*describeRemoteError[^}]*\} from '\.\/rpcProtocol'/);
  assert.match(rpcClient, /super\(describeRemoteError\(message, data\)\)/);
  assert.doesNotMatch(rpcClient, /function remoteErrorMessage/);
});
