// Background presets are a product promise: transparent, white, or any colour,
// without re-running a model. The colour parsing must be strict and predictable.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBackground,
  backgroundCss,
  isTransparent,
  NAMED_BACKGROUNDS,
} from '../dist-test/compose.js';

test('transparent means "keep the alpha", everything else means a flat colour', () => {
  assert.equal(parseBackground('transparent'), null);
  assert.equal(parseBackground(''), null);
  assert.equal(parseBackground('  NONE '), null);
  assert.equal(isTransparent('transparent'), true);
  assert.equal(isTransparent('white'), false);
});

test('named colours resolve', () => {
  assert.deepEqual(parseBackground('white'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseBackground('black'), { r: 0, g: 0, b: 0 });
  assert.ok('gray' in NAMED_BACKGROUNDS);
});

test('hex colours parse with and without #, short and long', () => {
  assert.deepEqual(parseBackground('#ff8800'), { r: 255, g: 136, b: 0 });
  assert.deepEqual(parseBackground('ff8800'), { r: 255, g: 136, b: 0 });
  assert.deepEqual(parseBackground('#0af'), { r: 0, g: 170, b: 255 });
  assert.deepEqual(parseBackground('#AABBCC'), { r: 170, g: 187, b: 204 });
});

test('junk is rejected loudly, not silently rendered black', () => {
  assert.throws(() => parseBackground('banana'));
  assert.throws(() => parseBackground('#12345'));
  assert.throws(() => parseBackground('rgb(1,2,3)'));
});

test('css helper returns a usable colour or transparent', () => {
  assert.equal(backgroundCss('white'), 'rgb(255 255 255)');
  assert.equal(backgroundCss('#0af'), 'rgb(0 170 255)');
  assert.equal(backgroundCss('transparent'), 'transparent');
});
