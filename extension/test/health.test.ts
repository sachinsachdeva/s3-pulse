import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AlertEngine, DEFAULT_ALERT_POLICY, formatDuration } from '../src/health';
import { worstSeverity } from '../src/adapters';
import type { FeedHealth } from '../src/model';

// The alert engine is pure apart from an injected clock, so none of this sleeps.

const late = (lateSince: string, overdueSeconds = 120): FeedHealth => ({
  status: 'late',
  severity: 'warning',
  sizeStatus: 'normal',
  lateSince,
  overdueSeconds
});

const healthy: FeedHealth = { status: 'healthy', severity: 'ok', sizeStatus: 'normal' };

function engineAt(clock: { now: number }, policy = DEFAULT_ALERT_POLICY): AlertEngine {
  return new AlertEngine(policy, () => clock.now);
}

test('a single late observation is not enough to interrupt anyone', () => {
  const clock = { now: 0 };
  const engine = engineAt(clock);
  const snapshot = { watcherId: 'a', name: 'Trades', state: 'running' as const, health: late('2026-08-12T03:00:00Z') };
  assert.equal(engine.observe(snapshot), undefined, 'first observation only arms the alert');
  assert.ok(engine.observe(snapshot), 'the second confirms it');
});

test('one outage alerts once, however long it lasts', () => {
  const clock = { now: 0 };
  const engine = engineAt(clock);
  const episode = late('2026-08-12T03:00:00Z');
  const snapshot = { watcherId: 'a', name: 'Trades', state: 'running' as const, health: episode };

  engine.observe(snapshot);
  assert.ok(engine.observe(snapshot), 'alerts on confirmation');

  // Six hours of polling on the same episode must stay silent. lateSince does
  // not move while a feed stays late, which is what makes this work.
  for (let minute = 0; minute < 360; minute += 1) {
    clock.now += 60_000;
    assert.equal(engine.observe(snapshot), undefined, `minute ${minute} re-alerted`);
  }
});

test('a new outage after a recovery alerts again', () => {
  const clock = { now: 0 };
  const engine = engineAt(clock, { ...DEFAULT_ALERT_POLICY, confirmObservations: 1, cooldownMs: 0 });
  const feed = { watcherId: 'a', name: 'Trades', state: 'running' as const };

  assert.ok(engine.observe({ ...feed, health: late('2026-08-12T03:00:00Z') }));
  assert.equal(engine.observe({ ...feed, health: healthy }), undefined, 'recovery is silent by default');
  // A genuinely separate episode has a different lateSince.
  assert.ok(engine.observe({ ...feed, health: late('2026-08-12T09:00:00Z') }), 'a later outage is a new episode');
});

test('the cooldown holds back a second alert for the same feed', () => {
  const clock = { now: 0 };
  const engine = engineAt(clock, { ...DEFAULT_ALERT_POLICY, confirmObservations: 1, cooldownMs: 900_000 });
  const feed = { watcherId: 'a', name: 'Trades', state: 'running' as const };

  assert.ok(engine.observe({ ...feed, health: late('2026-08-12T03:00:00Z') }));
  clock.now += 60_000;
  assert.equal(engine.observe({ ...feed, health: late('2026-08-12T04:00:00Z') }), undefined, 'inside the cooldown');
  clock.now += 900_000;
  assert.ok(engine.observe({ ...feed, health: late('2026-08-12T05:00:00Z') }), 'past the cooldown');
});

test('an on-time but empty arrival still alerts, and outranks lateness', () => {
  const clock = { now: 0 };
  const engine = engineAt(clock, { ...DEFAULT_ALERT_POLICY, confirmObservations: 1 });
  const alert = engine.observe({
    watcherId: 'a',
    name: 'Trades',
    state: 'running',
    health: { status: 'healthy', severity: 'critical', sizeStatus: 'empty' }
  });
  assert.equal(alert?.kind, 'size');
  assert.equal(alert?.severity, 'critical');
  assert.match(alert?.message ?? '', /empty/);
});

test('a normal-sized, on-time feed produces nothing at all', () => {
  const engine = engineAt({ now: 0 });
  const feed = { watcherId: 'a', name: 'Trades', state: 'running' as const, health: healthy };
  assert.equal(engine.observe(feed), undefined);
  assert.equal(engine.observe(feed), undefined);
  assert.equal(engine.severityOf('a'), 'ok');
});

test('a backend error alerts and counts as critical', () => {
  const engine = engineAt({ now: 0 }, { ...DEFAULT_ALERT_POLICY, confirmObservations: 1 });
  const alert = engine.observe({ watcherId: 'a', name: 'Trades', state: 'error', error: 'expired token' });
  assert.equal(alert?.kind, 'error');
  assert.equal(engine.severityOf('a'), 'critical');
  assert.match(alert?.message ?? '', /expired token/);
});

test('policy switches suppress the kinds they disable', () => {
  const engine = engineAt({ now: 0 }, { ...DEFAULT_ALERT_POLICY, confirmObservations: 1, alertOnLate: false });
  assert.equal(
    engine.observe({ watcherId: 'a', name: 'Trades', state: 'running', health: late('2026-08-12T03:00:00Z') }),
    undefined
  );
  // Severity is still tracked, so the status bar reflects reality even when
  // notifications are turned off.
  assert.equal(engine.severityOf('a'), 'warning');
});

test('the roll-up reports the worst feed across all of them', () => {
  const engine = engineAt({ now: 0 });
  engine.observe({ watcherId: 'a', name: 'A', state: 'running', health: healthy });
  engine.observe({ watcherId: 'b', name: 'B', state: 'running', health: late('2026-08-12T03:00:00Z') });
  assert.equal(engine.worst(), 'warning');

  engine.observe({
    watcherId: 'c', name: 'C', state: 'running',
    health: { status: 'healthy', severity: 'critical', sizeStatus: 'empty' }
  });
  assert.equal(engine.worst(), 'critical');
  assert.deepEqual(engine.counts(), { unknown: 0, ok: 1, warning: 1, critical: 1 });

  engine.forget('c');
  assert.equal(engine.worst(), 'warning', 'a removed feed stops counting');
});

test('worstSeverity orders the scale correctly', () => {
  assert.equal(worstSeverity(['ok', 'warning', 'unknown']), 'warning');
  assert.equal(worstSeverity(['ok', 'critical', 'warning']), 'critical');
  assert.equal(worstSeverity([]), 'unknown');
  assert.equal(worstSeverity(['unknown', 'unknown']), 'unknown');
});

test('durations read naturally at every scale', () => {
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(120), '2m');
  assert.equal(formatDuration(3_700), '1h 1m');
  assert.equal(formatDuration(90_000), '1d 1h');
  assert.equal(formatDuration(-5), '0s');
});
