// The local-server engine: URL building, model id mapping, and error messages
// that tell the user what to actually do.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isServerModel,
  serverModelId,
  removeUrl,
  describeServerError,
  networkError,
  serverBase,
  DEFAULT_SERVER_URL,
  SERVER_MODEL_IDS,
} from '../dist-test/server-api.js';

test('only api/ ids are routed to the local server', () => {
  assert.equal(isServerModel('api/birefnet-portrait'), true);
  assert.equal(isServerModel('onnx-community/BiRefNet_lite-ONNX'), false);
  assert.equal(isServerModel('cloud:huggingface'), false);
  assert.equal(isServerModel('imgly/isnet-fp16'), false);
});

test('model ids strip the api/ prefix so the server sees its own registry ids', () => {
  assert.equal(serverModelId('api/birefnet-portrait'), 'birefnet-portrait');
  assert.equal(serverModelId('birefnet-portrait'), 'birefnet-portrait');
  for (const id of SERVER_MODEL_IDS) {
    assert.match(serverModelId(id), /^[a-z0-9-]+$/);
  }
});

test('the remove URL carries model, background, matte, detail and subject', () => {
  const url = new URL(
    removeUrl('api/birefnet-portrait', { background: '#ff8800', matte: true, detail: 'high', subject: 'person' }),
  );
  assert.equal(url.pathname, '/api/remove');
  assert.equal(url.searchParams.get('model'), 'birefnet-portrait');
  assert.equal(url.searchParams.get('background'), '#ff8800');
  assert.equal(url.searchParams.get('matte'), 'true');
  assert.equal(url.searchParams.get('detail'), 'high');
  assert.equal(url.searchParams.get('subject'), 'person');
});

test('defaults are safe: transparent background, matting on', () => {
  const url = new URL(removeUrl('api/u2netp'));
  assert.equal(url.searchParams.get('background'), 'transparent');
  assert.equal(url.searchParams.get('matte'), 'true');
  assert.equal(url.searchParams.get('detail'), 'normal');
});

test('trailing slashes on the base URL never double up', () => {
  const url = removeUrl('api/u2netp', {}, 'http://127.0.0.1:8000///');
  assert.ok(url.startsWith('http://127.0.0.1:8000/api/remove?'));
  assert.equal(serverBase(), DEFAULT_SERVER_URL);
});

test('server errors become advice, not status codes', () => {
  const unavailable = describeServerError(503, {
    error: 'model_unavailable',
    message: 'x',
  });
  assert.equal(unavailable.code, 'model_unavailable');
  assert.match(unavailable.message, /fetch_models\.py/);

  const unknown = describeServerError(404, { error: 'unknown_model' });
  assert.match(unknown.message, /registered nahi/);

  const tooLarge = describeServerError(413, { error: 'too_large' });
  assert.match(tooLarge.message, /20 MB/);
});

test('an unreachable server tells the user the exact command', () => {
  const error = networkError(new TypeError('Failed to fetch'));
  assert.equal(error.code, 'unreachable');
  assert.match(error.message, /uvicorn unbg_server\.main:app/);
});
