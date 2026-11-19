// A cutout that keeps the whole photo is not a cutout. These guard the rule
// that a model which finds nothing is retried instead of shipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { maskLooksWrong, ESCALATION, upgradeSuggestion } from '../dist-test/remove-bg.js';
import { MODELS } from '../dist-test/models.js';

test('a mask that keeps the whole frame is flagged', () => {
  assert.equal(maskLooksWrong({ coverage: 0.99, border: 0.98 }), 'kept-all');
  assert.equal(maskLooksWrong({ coverage: 0.93, border: 0.8 }), 'kept-all');
});

test('a close-up portrait is not called a failure', () => {
  // The real MODNet result for a tight portrait: the subject fills the frame.
  assert.equal(maskLooksWrong({ coverage: 0.839, border: 0.467 }), null);
  assert.equal(maskLooksWrong({ coverage: 0.9, border: 0.5 }), null);
  assert.equal(maskLooksWrong({ coverage: 0.95, border: 0.6 }), null, 'big subject, edge free');
});

test('a mask that throws the subject away is flagged', () => {
  assert.equal(maskLooksWrong({ coverage: 0.0, border: 0.0 }), 'kept-none');
  assert.equal(maskLooksWrong({ coverage: 0.01, border: 0.0 }), 'kept-none');
});

test('a normal cutout is not flagged', () => {
  for (const m of [
    { coverage: 0.02, border: 0.01 },
    { coverage: 0.15, border: 0.02 },
    { coverage: 0.408, border: 0.23 },
    { coverage: 0.62, border: 0.1 },
    { coverage: 0.81, border: 0.4 },
  ]) {
    assert.equal(maskLooksWrong(m), null, JSON.stringify(m));
  }
});

test('the escalation chain starts at the phone default', () => {
  assert.ok('Xenova/modnet' in ESCALATION, 'MODNet is what a phone runs first');
});

test('every escalation hop stays on a permissive, loadable model', () => {
  const byId = new Map(MODELS.map((m) => [m.id, m]));
  for (const [from, to] of Object.entries(ESCALATION)) {
    assert.ok(byId.has(from), `source is a listed model: ${from}`);
    const target = byId.get(to);
    assert.ok(target, `target is a listed model: ${to}`);
    assert.equal(target.licenseOk, true, `licence allows shipping ${to}: ${target.license}`);
    assert.ok(target.sizeMb > byId.get(from).sizeMb, `${to} is actually bigger than ${from}`);
  }
});

test('the chain terminates', () => {
  for (const start of Object.keys(ESCALATION)) {
    const seen = new Set([start]);
    let cur = ESCALATION[start];
    while (cur) {
      assert.ok(!seen.has(cur), `cycle at ${cur}`);
      seen.add(cur);
      cur = ESCALATION[cur];
    }
    assert.ok(seen.size <= 3, 'no more than three attempts');
  }
});

test('an upgrade is offered, never forced', () => {
  assert.equal(upgradeSuggestion('Xenova/modnet'), 'onnx-community/ormbg-ONNX');
  assert.equal(upgradeSuggestion('onnx-community/ormbg-ONNX'), 'onnx-community/BiRefNet_lite-ONNX');
  assert.equal(upgradeSuggestion('onnx-community/BiRefNet_lite-ONNX'), null, 'end of the line');
  assert.equal(upgradeSuggestion('imgly/isnet-quint8'), null, 'no suggestion for other engines');
});
