import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The dashboard webview is a page built inside a template literal, so tsc never
// type-checks the script it contains and the other tests cannot import it: the
// module pulls in 'vscode', which does not resolve outside the extension host.
//
// Reading the source and evaluating the graph functions is therefore the only
// way to cover this code, and it has the advantage of exercising exactly what
// ships rather than a copy that can drift.

const SOURCE_PATH = 'src/dashboard.ts';

function readWebviewScript(): string {
  let source: string;
  try {
    source = readFileSync(SOURCE_PATH, 'utf8');
  } catch {
    throw new Error(`Could not read ${SOURCE_PATH}; run the tests from the extension directory`);
  }
  const tag = source.indexOf('<script nonce=');
  const start = source.indexOf('>', tag) + 1;
  const end = source.indexOf('</script>', start);
  if (tag < 0 || end < 0) {
    throw new Error('Could not locate the webview script in the dashboard template');
  }
  return source.slice(start, end);
}

const webviewScript = readWebviewScript();

/** Lifts one top-level function declaration out of the webview script. */
function extractFunction(name: string): string {
  const start = webviewScript.indexOf(`function ${name}(`);
  if (start < 0) {
    throw new Error(`Webview function "${name}" no longer exists; update this test with it`);
  }
  let depth = 0;
  for (let index = webviewScript.indexOf('{', start); index < webviewScript.length; index += 1) {
    const character = webviewScript[index];
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return webviewScript.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Unbalanced braces while extracting "${name}"`);
}

interface TipLine {
  readonly text: string;
  readonly strong?: boolean;
}

interface GraphApi {
  tipLines(point: Record<string, unknown>): TipLine[];
  pointAt(clientX: number, clientY: number): number;
  graphSamples(): Record<string, unknown>[];
  intervalPoints(samples: readonly unknown[]): Record<string, unknown>[];
  bucketPoints(samples: readonly unknown[], minutes: number): Record<string, unknown>[];
  setState(value: unknown): void;
  setPlotted(value: unknown): void;
}

const NAMES = [
  'tipLines', 'pointAt', 'graphSamples', 'intervalPoints', 'bucketPoints',
  'dateValue', 'dateTime', 'shortTime', 'bytes', 'duration', 'relative'
];

// A 600x245 canvas at the origin stands in for the real element.
const graph = new Function(`
  let state = { history: [], objects: [] };
  let plotted = [];
  const graph = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 245 }) };
  ${NAMES.map(extractFunction).join('\n')}
  return {
    tipLines, pointAt, graphSamples, intervalPoints, bucketPoints,
    setState: (value) => { state = value; },
    setPlotted: (value) => { plotted = value; }
  };
`)() as GraphApi;

const at = (seconds: number): string => new Date(Date.UTC(2026, 7, 11, 12, 0, seconds)).toISOString();

test('the webview script is syntactically valid', () => {
  // tsc cannot see inside the template literal, so this is the only guard
  // against shipping a dashboard that throws on open.
  assert.doesNotThrow(() => new Function(webviewScript));
});

test('graph samples join size and storage class from the object grid', () => {
  // History samples carry only key, timestamp and interval; the rest of the
  // detail the tooltip shows has to come from the objects list.
  graph.setState({
    history: [
      { key: 'trades/a.csv', lastModified: at(0) },
      { key: 'trades/b.csv', lastModified: at(5), intervalSeconds: 5 }
    ],
    objects: [
      { key: 'trades/a.csv', lastModified: at(0), size: 68, storageClass: 'STANDARD' },
      { key: 'trades/b.csv', lastModified: at(5), size: 71, storageClass: 'STANDARD' }
    ]
  });

  const samples = graph.graphSamples();
  assert.equal(samples.length, 2);
  assert.equal(samples[1]?.size, 71);
  assert.equal(samples[1]?.storageClass, 'STANDARD');

  const points = graph.intervalPoints(samples);
  assert.equal(points.length, 1, 'the first arrival has no preceding interval to plot');
  assert.equal(points[0]?.key, 'trades/b.csv');
  assert.equal(points[0]?.size, 71);
});

test('a key missing from the object grid still yields a usable sample', () => {
  graph.setState({
    history: [{ key: 'trades/orphan.csv', lastModified: at(0), intervalSeconds: 3 }],
    objects: []
  });
  const [sample] = graph.graphSamples();
  assert.equal(sample?.key, 'trades/orphan.csv');
  assert.ok(!Number.isFinite(sample?.size as number), 'an unknown size stays unknown rather than becoming 0');
});

test('the tooltip names the file without its prefix and never renders blank', () => {
  const nested = graph.tipLines({ time: Date.parse(at(0)), value: 5, key: 'a/b/c/deep.parquet', size: 10, mode: 'inter-arrival' });
  assert.equal(nested[0]?.text, 'deep.parquet');
  assert.equal(nested[0]?.strong, true);
  assert.equal(nested.length, 3, 'name, timestamp, facts — the full path is not repeated');
  assert.ok(!nested.some((line) => line.text.includes('a/b/c')), 'the key prefix never appears');

  // A directory marker's key ends in '/', whose naive basename is empty.
  assert.equal(
    graph.tipLines({ time: Date.parse(at(0)), value: 5, key: 'feeds/2026/08/11/', size: 0, mode: 'inter-arrival' })[0]?.text,
    '11'
  );
  assert.equal(graph.tipLines({ time: Date.parse(at(0)), value: 5, key: '/', mode: 'inter-arrival' })[0]?.text, 'Arrival');
  assert.equal(graph.tipLines({ time: Date.parse(at(0)), value: 5, mode: 'inter-arrival' })[0]?.text, 'Arrival');
});

test('the tooltip reports size and interval without leaking NaN', () => {
  const known = graph.tipLines({ time: Date.parse(at(0)), value: 5, key: 'x.csv', size: 68, mode: 'inter-arrival' });
  assert.match(known[2]?.text ?? '', /68 B/);
  assert.match(known[2]?.text ?? '', /5s since previous/);

  const unknown = graph.tipLines({ time: Date.parse(at(0)), value: 12, key: 'x.csv', size: Number.NaN, mode: 'inter-arrival' });
  assert.ok(!unknown.some((line) => line.text.includes('NaN')));
});

test('bucket mode describes the window instead of a single file', () => {
  assert.equal(graph.tipLines({ time: 0, value: 1, spanMs: 900_000, mode: 'files-per-bucket' })[0]?.text, '1 file');
  assert.equal(graph.tipLines({ time: 0, value: 6, spanMs: 900_000, mode: 'files-per-bucket' })[0]?.text, '6 files');
  assert.equal(graph.tipLines({ time: 0, value: 0, spanMs: 900_000, mode: 'files-per-bucket' })[0]?.text, '0 files');
});

test('hit-testing resolves to the nearest point by x and gives up beyond it', () => {
  graph.setPlotted([{ x: 100, y: 50 }, { x: 200, y: 60 }, { x: 300, y: 20 }]);
  assert.equal(graph.pointAt(205, 200), 1, 'matched on x even when the pointer is far below');
  assert.equal(graph.pointAt(140, 50), 0);
  assert.equal(graph.pointAt(160, 50), 1);
  assert.equal(graph.pointAt(600, 50), -1, 'far past the last point selects nothing');
  assert.equal(graph.pointAt(100, 900), -1, 'outside the canvas selects nothing');

  graph.setPlotted([{ x: 300, y: 40 }]);
  assert.equal(graph.pointAt(320, 40), 0, 'a lone point still gets a usable hit area');
  assert.equal(graph.pointAt(30, 40), -1);

  graph.setPlotted([]);
  assert.equal(graph.pointAt(150, 50), -1, 'an empty graph selects nothing');
});

test('bucket points carry their span so the tooltip can state the window', () => {
  const samples = [
    { time: Date.parse(at(0)), intervalSeconds: Number.NaN },
    { time: Date.parse(at(30)), intervalSeconds: 30 }
  ];
  const buckets = graph.bucketPoints(samples, 15);
  assert.ok(buckets.length >= 1);
  assert.equal(buckets[0]?.spanMs, 15 * 60_000);
});
