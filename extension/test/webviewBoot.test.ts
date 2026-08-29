import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { declaredIds, renderPage, renderedScript, SOURCE_PATH } from './renderPage';

// The dashboard page lives in a template literal, so tsc never sees the script
// inside it. Checking it parses is not enough: the handshake that brings the
// panel to life is the very last statement of a ~400-line IIFE, so anything
// that throws above it leaves a dashboard that renders, wires no buttons, and
// reports nothing — which is indistinguishable from the extension being broken.
//
// Booting the script against a stub DOM is what turns that into a caught
// failure instead of a silent one.

const source = readFileSync(SOURCE_PATH, 'utf8');
const page = renderPage();
const script = renderedScript(page);
const ids = declaredIds(page);

interface BootResult {
  readonly posted: { type?: string }[];
  readonly persisted: Record<string, unknown> | undefined;
  readonly unknownIds: string[];
}

/** Runs the webview script against a permissive stub of the browser it expects. */
function boot(): BootResult {
  const element = (id: string): Record<string, unknown> => {
    const node: Record<string, unknown> = {
      id, dataset: {}, style: {}, textContent: '', innerHTML: '', className: '',
      value: '', checked: false, hidden: false, children: [],
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 600, bottom: 245, width: 600, height: 245 }),
      getContext: () => new Proxy({ canvas: { width: 600, height: 245 } }, {
        get: (target: Record<string, unknown>, key: string) =>
          key in target ? target[key] : () => ({ addColorStop() {} })
      }),
      querySelector: () => element('q'),
      querySelectorAll: () => [],
      closest: () => null,
      appendChild: (child: unknown) => child
    };
    return new Proxy(node, {
      get: (target, key: string) => (key in target ? target[key] : () => {}),
      set: (target, key: string, value) => { target[key] = value; return true; }
    });
  };

  const nodes = new Map<string, Record<string, unknown>>();
  const byId = (id: string): Record<string, unknown> => {
    if (!nodes.has(id)) { nodes.set(id, element(id)); }
    return nodes.get(id) as Record<string, unknown>;
  };
  const body = element('body');
  (body.dataset as Record<string, string>).watcherId = 'feed-under-test';

  const unknownIds: string[] = [];
  const posted: { type?: string }[] = [];
  let persisted: Record<string, unknown> | undefined;

  const scope = globalThis as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  const define = (name: string, value: unknown): void => {
    saved.set(name, scope[name]);
    Object.defineProperty(scope, name, { value, configurable: true, writable: true });
  };

  define('document', {
    body,
    documentElement: element('html'),
    getElementById: (id: string) => { if (!ids.has(id)) { unknownIds.push(id); } return byId(id); },
    querySelector: () => element('q'),
    querySelectorAll: () => [],
    createElement: (tag: string) => element(tag),
    createDocumentFragment: () => element('fragment'),
    createTextNode: (text: string) => ({ textContent: text }),
    addEventListener() {}, removeEventListener() {}
  });
  define('window', {
    addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1,
    matchMedia: () => ({ matches: false, addEventListener() {} })
  });
  define('requestAnimationFrame', (callback: (t: number) => void) => { callback(0); return 1; });
  define('getComputedStyle', () => new Proxy({}, { get: () => '' }));
  define('devicePixelRatio', 1);
  define('ResizeObserver', class { observe() {} disconnect() {} });
  define('MutationObserver', class { observe() {} disconnect() {} takeRecords() { return []; } });
  define('IntersectionObserver', class { observe() {} disconnect() {} });
  define('navigator', { clipboard: { writeText: async () => {} }, language: 'en-US' });
  // The page installs a 30s refresh timer; left real it would hold the runner open.
  define('setInterval', () => 0);
  define('acquireVsCodeApi', () => ({
    postMessage: (message: { type?: string }) => { posted.push(message); },
    getState: () => undefined,
    setState: (value: Record<string, unknown>) => { persisted = value; }
  }));

  try {
    new Function(script)();
  } finally {
    for (const [name, value] of saved) {
      Object.defineProperty(scope, name, { value, configurable: true, writable: true });
    }
  }
  return { posted, persisted, unknownIds };
}

const result = boot();

test('the rendered script is what a browser can actually parse', () => {
  // The page is built in a template literal, so an escape in the source is
  // consumed before the browser sees it. A backslash that looked like a regex
  // in source once shipped as a line comment, which made the whole script a
  // syntax error and left every control on the dashboard dead.
  assert.doesNotThrow(() => new Function(script), 'the rendered script must parse');
});

test('the dashboard script boots without throwing', () => {
  // Reaching this line at all means it ran; boot() rethrows otherwise.
  assert.ok(result.posted.length > 0, 'the script reached its first postMessage');
});

test('booting completes the handshake that makes the panel live', () => {
  assert.ok(
    result.posted.some((message) => message.type === 'ready'),
    'without this the extension never sends a snapshot and every control is inert'
  );
});

test('booting persists the feed id a restored panel is reconnected by', () => {
  assert.equal(result.persisted?.watcherId, 'feed-under-test');
});

test('the script only reaches elements the page declares', () => {
  assert.deepEqual(result.unknownIds, [], 'a missing id throws and kills the rest of the script');
});

test('a page that never reports ready is called out, not left looking idle', () => {
  // This is the failure that cost the most time: a dashboard that renders its
  // placeholders and answers no control, while the log said nothing at all.
  assert.match(source, /never reported ready/, 'the watchdog exists');
  assert.match(source, /clearTimeout\(handshake\)/, 'and any message cancels it');
  assert.match(source, /sent an unrecognised message/, 'a dropped message is reported too');
});
