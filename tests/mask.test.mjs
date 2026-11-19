// Node's test runner: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMask, labelComponents, binarize, keepLargest, fillHoles, feather } from '../dist-test/mask.js';

const makePlane = (w, h, fill = 0) => ({ data: new Float32Array(w * h).fill(fill), width: w, height: h });
const rect = (p, x0, y0, x1, y1, v = 1) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) p.data[y * p.width + x] = v;
};
const at = (p, x, y) => p.data[y * p.width + x];

test('labelComponents counts separate blobs', () => {
  const p = makePlane(20, 20);
  rect(p, 2, 2, 8, 8);
  rect(p, 12, 12, 15, 15);
  const bin = binarize(p);
  const { count } = labelComponents(bin, 20, 20);
  assert.equal(count, 2);
});

test('keepLargest removes stray blobs but keeps the subject', () => {
  const p = makePlane(40, 40);
  rect(p, 5, 5, 35, 35);      // subject 900 px
  rect(p, 0, 0, 3, 3);        // 9 px speck
  rect(p, 36, 0, 40, 2);      // 8 px speck
  const dropped = keepLargest(p, 0.02);
  assert.ok(dropped >= 17, `expected specks dropped, got ${dropped}`);
  assert.equal(at(p, 20, 20), 1, 'subject survives');
  assert.equal(at(p, 1, 1), 0, 'speck removed');
});

test('fillHoles closes an interior hole without leaking', () => {
  const p = makePlane(30, 30);
  rect(p, 4, 4, 26, 26);
  rect(p, 12, 12, 16, 16, 0); // punched hole
  const filled = fillHoles(p, 0.5);
  assert.equal(filled, 16);
  assert.equal(at(p, 13, 13), 1, 'hole filled');
  assert.equal(at(p, 1, 1), 0, 'outside untouched');
});

test('feather softens the edge', () => {
  const p = makePlane(10, 10);
  rect(p, 5, 0, 10, 10);
  feather(p, 1);
  assert.ok(at(p, 4, 5) > 0 && at(p, 4, 5) < 1, 'edge pixel is partial');
  assert.equal(at(p, 8, 5), 1, 'interior still opaque');
});

test('cleanMask keeps a large secondary object (does not over-clean)', () => {
  const p = makePlane(60, 60);
  rect(p, 5, 5, 45, 45);   // main subject 1600 px
  rect(p, 48, 5, 58, 25);  // a genuinely large second object: 200 px = 12%
  cleanMask(p, { clean: true, featherRadius: 0 });
  assert.equal(at(p, 50, 10), 1, 'large secondary object survives');
});

test('cleanMask full pipeline keeps the subject and kills junk', () => {
  const p = makePlane(50, 50);
  rect(p, 8, 8, 42, 42);      // subject
  rect(p, 0, 44, 3, 47);      // small blot bottom-left (9 px)
  rect(p, 20, 20, 24, 24, 0); // hole
  const report = cleanMask(p, { clean: true, featherRadius: 1 });
  assert.ok(report.blobsRemoved > 0);
  assert.ok(report.holesFilled > 0);
  assert.equal(at(p, 25, 25), 1, 'subject centre stays');
  assert.equal(at(p, 1, 45), 0, 'blot gone');
});
