import * as esbuild from 'esbuild';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const outputDirectory = new URL('../.test-dist/', import.meta.url);
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await esbuild.build({
  entryPoints: ['test/**/*.test.ts'],
  outdir: '.test-dist',
  outbase: 'test',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: 'inline'
});

const tests = (await readdir(outputDirectory))
  .filter((name) => name.endsWith('.test.js'))
  .map((name) => `.test-dist/${name}`);
const child = spawn(process.execPath, ['--test', ...tests], {
  cwd: new URL('..', import.meta.url),
  stdio: 'inherit'
});

child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
});
