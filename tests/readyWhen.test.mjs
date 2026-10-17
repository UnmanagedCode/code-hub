import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadyMatcher, READY_WINDOW_CHARS, READY_OVERLAP_CHARS, READY_MATCH_DEADLINE_MS } from '../src/readyWhen.js';

const S = READY_WINDOW_CHARS - READY_OVERLAP_CHARS;
const fill = (n) => '.'.repeat(n);
// A match of READY_OVERLAP_CHARS + 1 chars: the longest the matcher guarantees.
const LONGEST = `A[\\s\\S]{${READY_OVERLAP_CHARS - 1}}B`;

test('a match straddling two scans is found when it starts READY_OVERLAP_CHARS before the old end', () => {
  const m = createReadyMatcher(LONGEST);
  const o1 = fill(100) + 'A' + fill(READY_OVERLAP_CHARS - 1);
  assert.equal(m.scan(o1, o1.length), false);
  const o2 = o1 + 'B';
  assert.equal(m.scan(o2, o2.length), true);
});

test('a match straddling two slices within one scan is found at the slice-boundary extreme', () => {
  const m = createReadyMatcher(LONGEST);
  const o = fill(2 * S - 1) + 'A' + fill(READY_OVERLAP_CHARS - 1) + 'B' + fill(READY_WINDOW_CHARS);
  assert.equal(m.scan(o, o.length), true);
});

test('a match longer than READY_WINDOW_CHARS is never found even though the buffer holds it', () => {
  const pattern = `A[\\s\\S]{${READY_WINDOW_CHARS - 1}}B`;
  const text = 'A' + fill(READY_WINDOW_CHARS - 1) + 'B' + fill(10);
  assert.equal(new RegExp(pattern).test(text), true);
  assert.equal(createReadyMatcher(pattern).scan(text, text.length), false);
});

test('a marker at the start of the retained output is found after the ring trimmed past the last scan', () => {
  const L = 2 * READY_WINDOW_CHARS;
  const m = createReadyMatcher('READY');
  m.scan('x', 1);
  assert.equal(m.scan('READY' + fill(L - 5), 10 * L + 2), true);
});

test('a pattern that outruns the deadline throws naming the pattern, after about READY_MATCH_DEADLINE_MS', () => {
  const m = createReadyMatcher('(a|a)+$');
  const t0 = Date.now();
  assert.throws(
    () => m.scan('a'.repeat(40) + '!', 41),
    (e) => e.message.includes('(a|a)+$') && /deadline/.test(e.message) && /stopped/.test(e.message),
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 0.8 * READY_MATCH_DEADLINE_MS, `stopped too early: ${elapsed}ms`);
  assert.ok(elapsed < READY_MATCH_DEADLINE_MS + 1000, `stopped too late: ${elapsed}ms`);
});

test('the matcher still matches after a deadline was hit', () => {
  assert.throws(() => createReadyMatcher('(a|a)+$').scan('a'.repeat(40) + '!', 41));
  assert.equal(createReadyMatcher('listening on \\d+').scan('listening on 3000', 17), true);
});
