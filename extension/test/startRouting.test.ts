import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Start is reachable from two places — the tree item's play button and the
// dashboard's own Start button — and they used to carry separate logic. The
// panel's copy called start() raw, so pressing it on a feed whose poll had
// failed asked the backend to start a watcher it still held, and the user got
// "Watcher already exists" instead of a retry.
//
// Neither call site can be imported here: both modules pull in 'vscode', which
// does not resolve outside the extension host. Reading the source is how this
// invariant gets covered at all.

const dashboard = readFileSync('src/dashboard.ts', 'utf8');
const extension = readFileSync('src/extension.ts', 'utf8');
const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
  activationEvents: string[];
};

test('both Start affordances route through the same branching', () => {
  assert.match(dashboard, /public async startOrRetry\(watcher: WatcherDefinition\)/);
  assert.match(
    dashboard,
    /case 'start':\s*\n\s*await this\.startOrRetry\(watcher\);/,
    'the dashboard button retries rather than starting blind'
  );
  assert.match(
    extension,
    /dashboards\.startOrRetry\(watcher\)/,
    'the tree action goes through the same path'
  );
});

test('startOrRetry covers running, errored and stopped feeds', () => {
  const start = dashboard.indexOf('public async startOrRetry(');
  const body = dashboard.slice(start, dashboard.indexOf('public async start(', start));
  assert.ok(body.includes("status === 'running'"), 'an already-running feed is reported, not restarted');
  assert.ok(body.includes("status === 'error'"), 'an errored feed is retried');
  assert.ok(body.includes('this.restart(watcher)'), 'retry tears the watcher down first');
  assert.ok(body.includes('this.start(watcher)'), 'a stopped feed just starts');
});

test('a restored dashboard tab can wake the extension by itself', () => {
  // onView and onCommand are derived from contributes; onWebviewPanel is not,
  // so it has to be declared. Without it, reloading with the dashboard focused
  // and the S3 Pulse view closed never activates the extension, the serializer
  // never runs, and the restored panel is as inert as it was with no
  // serializer at all.
  assert.ok(
    manifest.activationEvents.includes('onWebviewPanel:s3Pulse.dashboard'),
    'the dashboard viewType is an activation event'
  );
});

test('a panel saved before ids were persisted is recovered, not discarded', () => {
  // Those panels come back with no state. Discarding them would make the tab
  // disappear on the first reload after an upgrade.
  assert.match(dashboard, /#watcherByTitle\(panel\.title\)/, 'the title is the fallback');
  assert.match(dashboard, /matches\.length === 1 \? matches\[0\] : undefined/, 'an ambiguous name is not guessed at');
  assert.match(dashboard, /function dashboardTitle\(name: string\)/, 'the title has one definition to match against');
});

test('no feed command can return without saying so', () => {
  // Each of these returns quietly when nothing is selected. A click that
  // resolves to no feed used to leave the log completely empty, which is
  // exactly what "pressing Start does nothing" looks like from outside.
  assert.match(
    extension,
    /output\.appendLine\(`\[extension\] \$\{placeHolder\}: no feed selected`\)/,
    'the single choke point logs it'
  );
  const sites = extension.match(/selectWatcher\(store, argument, '[^']+', output\)/g) ?? [];
  assert.equal(sites.length, 5, 'every call site passes the channel');
});

test('editing a feed the backend would not release restarts it', () => {
  // Saving anyway leaves the watcher registered, so a plain start comes back
  // as "Watcher already exists" and the edit looks like it failed.
  assert.match(extension, /released \? dashboards\.start\(updated\) : dashboards\.restart\(updated\)/);
});
