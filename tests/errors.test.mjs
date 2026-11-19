// The error text is UI: it must be actionable and never contradict the screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyError, DecodeError } from '../dist-test/remove-bg.js';

test('out of memory on the smallest model does not tell you to pick it', () => {
  const msg = friendlyError(new Error('Aborted(OOM)'), 'MODNet');
  assert.match(msg, /memory/i);
  assert.doesNotMatch(msg, /Model chhota karo/);
  assert.match(msg, /MODNet hi sabse chhota/);
});

test('out of memory on a big model suggests the small one', () => {
  const msg = friendlyError(new Error('RuntimeError: out of memory'), 'BEN2');
  assert.match(msg, /MODNet/);
  assert.doesNotMatch(msg, /MODNet hi sabse chhota/);
});

test('a HEIC decode failure names the format and the way out', () => {
  const msg = friendlyError(new DecodeError('heic', 3.2 * 1024 * 1024, 'createImageBitmap: fail'));
  assert.match(msg, /HEIC\/HEIF/);
  assert.match(msg, /Chrome/);
  assert.match(msg, /JPEG/);
  assert.match(msg, /3\.2 MB/);
});

test('small files report KB, not 0.0 MB', () => {
  const msg = friendlyError(new DecodeError('tiff', 2048, 'fail'));
  assert.match(msg, /2 KB/);
  assert.doesNotMatch(msg, /0\.0 MB/);
});

test('network failures still explain the model download', () => {
  assert.match(friendlyError(new Error('Failed to load resource: 404')), /network|Model download/i);
});

test('plain messages pass through unchanged', () => {
  assert.equal(friendlyError(new Error('something odd')), 'something odd');
});
