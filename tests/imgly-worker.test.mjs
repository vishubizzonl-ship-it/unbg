// The worker is the only place the IMG.LY model runs; its message protocol is
// what the UI depends on, so the protocol is what gets tested.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('./stubs/imgly-worker-node.mjs', import.meta.url));

const runWorker = (file, model = 'isnet_quint8') =>
  new Promise((resolve) => {
    const messages = [];
    const worker = new Worker(workerPath);
    worker.on('message', (message) => {
      messages.push(message);
      if (message.type === 'done' || message.type === 'error') {
        worker.terminate();
        resolve({ messages, final: message });
      }
    });
    worker.on('error', (error) => resolve({ messages, final: { type: 'error', message: error.message } }));
    worker.postMessage({ id: 7, file, model });
  });

test('a successful run reports progress and returns a PNG buffer', async () => {
  const { messages, final } = await runWorker(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])]));
  assert.equal(final.type, 'done');
  assert.equal(final.mime, 'image/png');
  assert.ok(final.buffer.byteLength > 0);
  assert.equal(new Uint8Array(final.buffer)[0], 0x89, 'PNG signature');
  const progress = messages.filter((m) => m.type === 'progress');
  assert.ok(progress.length >= 4, 'progress messages arrived');
  assert.deepEqual(
    progress.map((m) => m.current),
    [1, 2, 3, 4, 4],
  );
  assert.equal(final.id, 7, 'responses are tagged with the request id');
  assert.ok(final.ms >= 0);
});

test('a failing run reports the reason instead of throwing', async () => {
  const { final } = await runWorker(new Blob([new Uint8Array([0x00, 0x01])]));
  assert.equal(final.type, 'error');
  assert.match(final.message, /undecodable/);
});
