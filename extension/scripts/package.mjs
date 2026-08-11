import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const supportedTargets = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64'
]);
const args = process.argv.slice(2);
const target = targetArgument(args);
if (!target || !supportedTargets.has(target)) {
  fail(`Pass exactly one supported target, for example: npm run package -- --target darwin-arm64`);
}

const executable = target.startsWith('win32-') ? 's3pulse.exe' : 's3pulse';
const backend = resolve('bin', target, executable);
let metadata;
try {
  metadata = statSync(backend);
} catch (error) {
  fail(`Missing ${target} backend at ${backend}: ${error instanceof Error ? error.message : String(error)}`);
}
if (!metadata.isFile()) {
  fail(`Backend path is not a file: ${backend}`);
}
if (!target.startsWith('win32-') && (metadata.mode & 0o111) === 0) {
  fail(`Backend is not executable: ${backend}`);
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(
  npx,
  ['--no-install', 'vsce', 'package', '--ignore-other-target-folders', ...args],
  { stdio: 'inherit', shell: false }
);
if (result.error) {
  fail(result.error.message);
}
process.exitCode = result.status ?? 1;

function targetArgument(values) {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if ((value === '--target' || value === '-t') && values[index + 1]) {
      return values[index + 1];
    }
    if (value.startsWith('--target=')) {
      return value.slice('--target='.length);
    }
  }
  return undefined;
}

function fail(message) {
  process.stderr.write(`S3 Pulse packaging error: ${message}\n`);
  process.exit(1);
}

