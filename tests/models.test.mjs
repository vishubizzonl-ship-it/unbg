// The model list is the product surface: the three headline models must be
// there, first, and every entry must be loadable and documented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, DEFAULT_MODEL_ID, recommendedModelId } from '../dist-test/models.js';

const ids = MODELS.map((m) => m.id);

test('the three headline models are present and on top', () => {
  assert.ok(ids.includes('onnx-community/BEN2-ONNX'), 'BEN2');
  assert.ok(ids.includes('kn4666/bria-rmbg-2.0-web'), 'BRIA RMBG 2.0');
  assert.ok(ids.includes('onnx-community/BiRefNet_lite-ONNX'), 'BiRefNet');
  assert.deepEqual(ids.slice(0, 3), [
    'onnx-community/BEN2-ONNX',
    'kn4666/bria-rmbg-2.0-web',
    'onnx-community/BiRefNet_lite-ONNX',
  ]);
});

test('every entry is complete and unique', () => {
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
  for (const m of MODELS) {
    assert.match(m.id, /^[\w.-]+\/[\w.-]+$/, `id looks like a repo: ${m.id}`);
    assert.ok(m.label?.length > 0, `label: ${m.id}`);
    assert.ok(m.note?.length > 0, `note: ${m.id}`);
    assert.ok(m.license?.length > 0, `license: ${m.id}`);
    assert.equal(typeof m.licenseOk, 'boolean', `licenseOk: ${m.id}`);
    assert.ok(Number.isFinite(m.sizeMb), `sizeMb: ${m.id}`);
  }
});

test('RMBG 2.0 is marked non-commercial, BEN2 and BiRefNet are marked clean', () => {
  const byId = Object.fromEntries(MODELS.map((m) => [m.id, m]));
  assert.equal(byId['kn4666/bria-rmbg-2.0-web'].licenseOk, false);
  assert.equal(byId['onnx-community/BEN2-ONNX'].licenseOk, true);
  assert.equal(byId['onnx-community/BiRefNet_lite-ONNX'].licenseOk, true);
});

test('recommendations stay honest: BEN2 on GPU, small model on CPU', () => {
  assert.equal(recommendedModelId('webgpu'), 'onnx-community/BEN2-ONNX');
  assert.equal(recommendedModelId('wasm'), DEFAULT_MODEL_ID);
  assert.ok(MODELS.find((m) => m.id === DEFAULT_MODEL_ID).sizeMb <= 100, 'CPU default stays small');
});

test('local-server models are opt-in, at the end, and never the default', () => {
  const serverModels = MODELS.filter((m) => m.engine === 'server');
  assert.ok(serverModels.length >= 2, 'portrait + general server models');
  for (const m of serverModels) {
    assert.match(m.id, /^api\//, `server ids are namespaced: ${m.id}`);
    assert.equal(m.licenseOk, true, `only MIT/Apache models on the server list: ${m.id}`);
    assert.notEqual(m.id, DEFAULT_MODEL_ID, 'the server is never the default engine');
  }
  assert.ok(ids.length >= 16, 'all on-device models are still listed');
});
