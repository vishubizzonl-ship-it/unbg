// The dropdown id decides which precision the worker downloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { imglyModelFor, IMGLY_MODEL_PREFIX } from '../dist-test/imgly.js';

test('the quint8 entry maps to the quantised model', () => {
  assert.equal(imglyModelFor('imgly/isnet-quint8'), 'isnet_quint8');
});

test('the fp16 entry maps to the half-precision model', () => {
  assert.equal(imglyModelFor('imgly/isnet-fp16'), 'isnet_fp16');
  assert.equal(imglyModelFor('imgly/anything-else'), 'isnet_fp16', 'default is the better model');
});

test('every IMG.LY id shares the prefix the UI branches on', () => {
  assert.ok('imgly/isnet-fp16'.startsWith(IMGLY_MODEL_PREFIX));
  assert.ok(!'onnx-community/BEN2-ONNX'.startsWith(IMGLY_MODEL_PREFIX));
});
