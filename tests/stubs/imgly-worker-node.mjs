// Runs the browser worker bundle inside a Node worker thread: the module only
// knows `self`, `postMessage` and `onmessage`, so provide those.
import { parentPort } from 'node:worker_threads';

globalThis.self = globalThis;
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
parentPort.on('message', (data) => globalThis.onmessage?.({ data }));

await import('../../dist-test/imgly-worker.mjs');
