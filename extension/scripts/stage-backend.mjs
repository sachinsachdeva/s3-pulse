// Copies a built backend into bin/<platform>-<arch>/ so the extension's
// bundled-binary fallback runs it. This is what makes the Extension Development
// Host work without configuring s3Pulse.backendPath at all, and what release
// packaging uses to place the binary for one target.
//
// Defaults to the debug profile because that is what the launch configuration
// builds; pass --release when staging for packaging.
//
//   node scripts/stage-backend.mjs                       # debug, this platform
//   node scripts/stage-backend.mjs --release             # release, this platform
//   node scripts/stage-backend.mjs --release \
//     --target linux-arm64 --from ../target/aarch64-unknown-linux-gnu/release

import { chmod, copyFile, mkdir, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64'
]);

const argv = process.argv.slice(2);
const release = argv.includes('--release');
const profile = release ? 'release' : 'debug';
const target = option('--target') ?? `${process.platform}-${process.arch}`;
if (!SUPPORTED.has(target)) {
  fail(`Unsupported target "${target}". Expected one of: ${[...SUPPORTED].join(', ')}`);
}

// The executable name follows the *target*, not the host, so a Windows VSIX
// staged from another platform still gets s3pulse.exe.
const executable = target.startsWith('win32-') ? 's3pulse.exe' : 's3pulse';
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const fromOption = option('--from');
const sourceDirectory = fromOption
  ? (isAbsolute(fromOption) ? fromOption : resolve(process.cwd(), fromOption))
  : resolve(repositoryRoot, 'target', profile);
const source = resolve(sourceDirectory, executable);
const directory = resolve(fileURLToPath(new URL('../bin/', import.meta.url)), target);
const destination = resolve(directory, executable);

try {
  const metadata = await stat(source);
  if (!metadata.isFile()) {
    fail(`${source} is not a file`);
  }
} catch {
  fail(
    `No ${profile} backend at ${source}\n` +
    `Build it first: cargo build ${release ? '--release ' : ''}-p s3pulse-cli`
  );
}

await mkdir(directory, { recursive: true });
await copyFile(source, destination);
if (!target.startsWith('win32-')) {
  // The extension checks the executable bit before spawning the backend.
  await chmod(destination, 0o755);
}

process.stdout.write(`Staged ${profile} backend at bin/${target}/${executable}\n`);
if (!release) {
  process.stdout.write('This is a debug build; re-stage with --release before packaging a VSIX.\n');
}

function option(name) {
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) {
    return argv[index + 1];
  }
  const inline = argv.find((value) => value.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : undefined;
}

function fail(message) {
  process.stderr.write(`S3 Pulse staging error: ${message}\n`);
  process.exit(1);
}
