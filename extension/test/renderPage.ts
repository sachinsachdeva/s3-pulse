import { readFileSync } from 'node:fs';

export const SOURCE_PATH = 'src/dashboard.ts';

/**
 * Builds the dashboard page the way the extension does, by evaluating the
 * template literal it lives in.
 *
 * Reading the source text instead skips that evaluation, and the difference is
 * not cosmetic: a backslash in the page source is an escape the template
 * consumes, so source and shipped script can differ in ways that turn valid
 * code into a syntax error. Tests have to look at the rendered output.
 */
export function renderPage(watcherId = 'feed-under-test'): string {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  const at = source.indexOf('function dashboardHtml');
  if (at < 0) {
    throw new Error('dashboardHtml no longer exists; update this helper with it');
  }
  const open = source.indexOf('`', source.indexOf('return `', at));
  const close = source.indexOf('`', source.indexOf('</html>', open));
  const template = source.slice(open + 1, close);
  const build = new Function('webview', 'nonce', 'watcherId', `return \`${template}\``) as (
    webview: { cspSource: string },
    nonce: string,
    watcherId: string
  ) => string;
  return build({ cspSource: 'vscode-webview://unit-test' }, 'test-nonce', watcherId);
}

/** The script the browser would actually parse, lifted out of a rendered page. */
export function renderedScript(page: string): string {
  const tag = page.indexOf('<script nonce=');
  if (tag < 0) {
    throw new Error('Could not locate the webview script in the rendered page');
  }
  return page.slice(page.indexOf('>', tag) + 1, page.indexOf('</script>', tag));
}

/** Element ids the rendered page declares, for checking what the script reaches. */
export function declaredIds(page: string): Set<string> {
  const body = page.slice(page.indexOf('<body'), page.indexOf('</body>'));
  const html = body.slice(0, body.indexOf('<script nonce='));
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] as string));
}
