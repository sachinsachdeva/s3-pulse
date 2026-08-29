// Runs inside a real VS Code extension host. It exercises the two things that
// cannot be checked from outside — that a real webview completes its handshake,
// and that Start actually reaches the backend — and leaves the evidence in the
// extension's own output channel, which the runner reads afterwards.
const vscode = require('vscode');

const FEED = {
  id: 'itest-0000-1111-2222-333344445555',
  name: 'itest',
  target: 's3://feed/trades/',
  profile: 's3pulse-local',
  region: 'us-east-1',
  pollIntervalSeconds: 5,
  historyLimit: 1000,
  bucketMinutes: 1,
  lookbackPeriods: 1
};

const BAD = { ...FEED, id: 'itest-bad', name: 'itestbad', target: 's3://nope/', profile: undefined, region: undefined };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.run = async function run() {
  const extension = vscode.extensions.getExtension('SachinSachdeva.s3-pulse');
  if (!extension) {
    throw new Error('extension not found in host');
  }
  await extension.activate();
  console.log('ITEST: activated');

  // 1. A real webview, and whether it reports itself ready.
  await vscode.commands.executeCommand('s3Pulse.openDashboard', FEED);
  console.log('ITEST: dashboard opened');
  await wait(9000);

  // 2. Start, through the same command the tree's play button invokes.
  await vscode.commands.executeCommand('s3Pulse.startFeed', FEED);
  console.log('ITEST: start returned');
  await wait(12000);

  // 3. Start again while running: must report, not silently do nothing.
  await vscode.commands.executeCommand('s3Pulse.startFeed', FEED);
  await wait(2000);

  // 4. The error path, and a retry on top of it.
  await vscode.commands.executeCommand('s3Pulse.startFeed', BAD);
  await wait(8000);
  await vscode.commands.executeCommand('s3Pulse.startFeed', BAD);
  await wait(6000);

  console.log('ITEST: done');
};
