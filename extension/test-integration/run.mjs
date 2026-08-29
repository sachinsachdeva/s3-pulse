import { runTests } from '@vscode/test-electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(here, '..');

try {
  const code = await runTests({
    version: 'stable',
    extensionDevelopmentPath,
    extensionTestsPath: path.resolve(here, 'index.js'),
    launchArgs: [
      '--user-data-dir', process.env.ITEST_USER_DIR,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes'
    ]
  });
  console.log('RUNNER EXIT', code);
} catch (error) {
  console.error('RUNNER FAILED:', error?.message || error);
  process.exit(1);
}
