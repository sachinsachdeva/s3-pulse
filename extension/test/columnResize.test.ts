import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderPage, renderedScript } from './renderPage';

// Column resizing lives in the webview script, which tsc never sees and no
// other test drives with real headers: webviewBoot.test.ts hands the page an
// empty header list, so a handle that throws while being built would still
// pass there and leave a dashboard with every control dead. This boots the
// rendered script against a small fake DOM and works the handles directly.

const script = renderedScript(renderPage());

type Listener = (event: Record<string, unknown>) => void;

class FakeElement {
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly listeners = new Map<string, Listener[]>();
  children: FakeElement[] = [];
  parentElement: FakeElement | undefined;
  textContent = '';
  className = '';
  value = '';
  /** What the browser's automatic layout would have made this element. */
  layoutWidth = 0;
  clientWidth = 0;
  scrollWidth = 0;
  display = '';
  readonly classList = {
    add: (...names: string[]) => names.forEach((name) => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach((name) => this.classes.delete(name)),
    toggle: (name: string, force?: boolean) => {
      const on = force ?? !this.classes.has(name);
      if (on) { this.classes.add(name); } else { this.classes.delete(name); }
      return on;
    },
    contains: (name: string) => this.classes.has(name)
  };

  constructor(readonly tag: string) {}

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
  }

  dispatch(type: string, event: Record<string, unknown> = {}): { defaultPrevented: boolean } {
    const result = { defaultPrevented: false };
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ button: 0, pointerId: 1, preventDefault: () => { result.defaultPrevented = true; }, ...event });
    }
    return result;
  }

  setAttribute(name: string, value: unknown): void { this.attributes.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  appendChild(child: FakeElement): FakeElement { child.parentElement = this; this.children.push(child); return child; }
  querySelector(selector: string): FakeElement | null {
    return this.children.find((child) => (selector.startsWith('.') ? child.className === selector.slice(1) : child.tag === selector)) ?? null;
  }
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    const width = this.display === 'none' ? 0 : this.layoutWidth;
    return { left: 0, top: 0, right: width, bottom: 20, width, height: 20 };
  }
  setPointerCapture(): void {}
}

// Anything the script touches that these tests do not care about is a no-op.
function lenient<T extends object>(target: T): T {
  return new Proxy(target, { get: (object, key) => (key in object ? Reflect.get(object, key) : () => {}) });
}

const COLUMNS: readonly (readonly [string, string, number])[] = [
  ['key', 'Key', 300],
  ['lastModified', 'Modified', 170],
  ['size', 'Size', 80],
  ['age', 'Age', 90],
  ['intervalSeconds', 'Δ previous', 110],
  ['storageClass', 'Storage class', 120]
];

interface Page {
  readonly headers: Map<string, FakeElement>;
  readonly handle: (column: string) => FakeElement;
  readonly element: (id: string) => FakeElement;
  readonly posted: { type?: string }[];
  readonly saved: () => Record<string, unknown> | undefined;
}

function boot(options: { prior?: Record<string, unknown>; panelWidth?: number; hidden?: readonly string[] } = {}): Page {
  const elements = new Map<string, FakeElement>();
  const element = (id: string): FakeElement => {
    if (!elements.has(id)) { elements.set(id, lenient(new FakeElement(id))); }
    return elements.get(id) as FakeElement;
  };
  element('grid-scroll').clientWidth = options.panelWidth ?? 1200;

  const row = element('header-row');
  const headers = new Map<string, FakeElement>();
  for (const [column, label, width] of COLUMNS) {
    const header = lenient(new FakeElement('th'));
    header.dataset.column = column;
    header.textContent = label;
    header.layoutWidth = width;
    header.display = options.hidden?.includes(column) ? 'none' : '';
    header.appendChild(lenient(new FakeElement('button')));
    row.appendChild(header);
    headers.set(column, header);
  }
  row.appendChild(element('actions-column'));

  const body = lenient(new FakeElement('body'));
  body.dataset.watcherId = 'feed-under-test';
  const document = lenient({
    body,
    getElementById: element,
    createElement: (tag: string) => lenient(new FakeElement(tag)),
    createDocumentFragment: () => lenient(new FakeElement('fragment')),
    querySelectorAll: (selector: string) => {
      if (selector === 'th[data-column]') { return [...headers.values()]; }
      if (selector === 'th[data-column] button') { return [...headers.values()].map((header) => header.children[0]); }
      return [];
    }
  });

  const posted: { type?: string }[] = [];
  let saved: Record<string, unknown> | undefined;
  const vscodeApi = {
    postMessage: (message: { type?: string }) => { posted.push(message); },
    getState: () => options.prior,
    setState: (value: Record<string, unknown>) => { saved = value; }
  };
  const Observer = class { observe(): void {} disconnect(): void {} };

  // Passed as parameters rather than installed as globals, so the handlers
  // the script leaves behind still see them when the tests fire events.
  new Function(
    'document', 'window', 'getComputedStyle', 'ResizeObserver', 'MutationObserver', 'setInterval', 'acquireVsCodeApi',
    script
  )(
    document,
    lenient({ devicePixelRatio: 1 }),
    (node: FakeElement) => ({ display: node.display, getPropertyValue: () => '' }),
    Observer,
    Observer,
    () => 0,
    () => vscodeApi
  );

  return {
    headers,
    handle: (column) => {
      const found = headers.get(column)?.querySelector('.resize');
      assert.ok(found, `no resize handle on the ${column} column`);
      return found;
    },
    element,
    posted,
    saved: () => saved
  };
}

function drag(page: Page, column: string, from: number, to: number): void {
  const handle = page.handle(column);
  handle.dispatch('pointerdown', { clientX: from });
  handle.dispatch('pointermove', { clientX: (from + to) / 2 });
  handle.dispatch('pointermove', { clientX: to });
  handle.dispatch('pointerup', { clientX: to });
}

test('every sortable column gets a labelled resize handle and the page still boots', () => {
  const page = boot();
  for (const [column, label] of COLUMNS) {
    const handle = page.handle(column);
    assert.equal(handle.getAttribute('role'), 'separator');
    assert.equal(handle.getAttribute('aria-label'), `Resize ${label} column`);
  }
  assert.ok(page.posted.some((message) => message.type === 'ready'), 'the handshake still runs after the handles are built');
  assert.equal(page.element('grid').classes.has('sized'), false, 'an untouched grid keeps the automatic layout');
  assert.equal(page.headers.get('key')?.style.width, '');
});

test('dragging a handle resizes that column from its on-screen width', () => {
  const page = boot();
  drag(page, 'key', 400, 460);

  assert.equal(page.headers.get('key')?.style.width, '360px', '300px on screen plus a 60px drag');
  assert.equal(page.headers.get('size')?.style.width, '80px', 'the other columns are frozen where they were');
  assert.ok(page.element('grid').classes.has('sized'));
  assert.equal(page.element('grid').classes.has('resizing'), false, 'the drag state is cleared on release');
  assert.deepEqual(page.saved()?.widths, {
    key: 360, lastModified: 170, size: 80, age: 90, intervalSeconds: 110, storageClass: 120
  });
});

test('a column cannot be dragged narrower than the minimum', () => {
  const page = boot();
  drag(page, 'size', 400, 100);
  assert.equal(page.headers.get('size')?.style.width, '48px');
  assert.equal((page.saved()?.widths as Record<string, number>).size, 48, 'the next drag starts from what is shown');
});

test('the actions column takes up the slack but never squeezes the row buttons', () => {
  const page = boot({ panelWidth: 1200 });
  drag(page, 'key', 0, 0);
  // 300 + 170 + 80 + 90 + 110 + 120 = 870 of a 1200px panel.
  assert.equal(page.element('actions-column').style.width, '330px');
  assert.equal(page.element('grid').style.width, '1200px');

  drag(page, 'key', 0, 1000);
  assert.equal(page.element('actions-column').style.width, '100px');
  assert.equal(page.element('grid').style.width, `${1300 + 570 + 100}px`, 'wider than the panel, so it scrolls');
});

test('a column hidden by a narrow panel keeps a width but takes no space', () => {
  const page = boot({ panelWidth: 900, hidden: ['age', 'storageClass'] });
  drag(page, 'key', 0, 0);
  const widths = page.saved()?.widths as Record<string, number>;
  assert.equal(widths.age, 100, 'a hidden column cannot be measured, so it gets its default');
  // 300 + 170 + 80 + 110 = 660 visible, the rest to the actions column.
  assert.equal(page.element('actions-column').style.width, '240px');
});

test('widths saved by an earlier session are applied on boot', () => {
  const page = boot({ prior: { widths: { key: 420, size: 64 } } });
  assert.ok(page.element('grid').classes.has('sized'));
  assert.equal(page.headers.get('key')?.style.width, '420px');
  assert.equal(page.headers.get('size')?.style.width, '64px');
  assert.equal(page.headers.get('lastModified')?.style.width, '170px', 'a missing width falls back to the default');
});

test('arrow keys resize a focused handle and double-click fits the content', () => {
  const page = boot();
  const handle = page.handle('lastModified');
  assert.equal(handle.dispatch('keydown', { key: 'ArrowRight' }).defaultPrevented, true);
  assert.equal(page.headers.get('lastModified')?.style.width, '180px');
  handle.dispatch('keydown', { key: 'ArrowLeft' });
  handle.dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(page.headers.get('lastModified')?.style.width, '160px');
  assert.equal((page.saved()?.widths as Record<string, number>).lastModified, 160);

  // The Modified cell is the second in each row; the widest one wins.
  const rows = page.element('rows');
  for (const width of [140, 212, 190]) {
    const row = new FakeElement('tr');
    for (let index = 0; index < 7; index += 1) {
      row.appendChild(new FakeElement('td')).scrollWidth = index === 1 ? width : 999;
    }
    rows.appendChild(row);
  }
  handle.dispatch('dblclick');
  assert.equal(page.headers.get('lastModified')?.style.width, '214px');
});

test('only the primary button starts a resize', () => {
  const page = boot();
  page.handle('key').dispatch('pointerdown', { button: 2, clientX: 0 });
  page.handle('key').dispatch('pointermove', { clientX: 200 });
  assert.equal(page.element('grid').classes.has('sized'), false);
  assert.equal(page.headers.get('key')?.style.width, '');
});
