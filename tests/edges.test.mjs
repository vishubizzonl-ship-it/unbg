// Edge polish is the difference between "AI cut it" and "a designer cut it".
// These pin the maths, because the visible failure mode (a halo) is subtle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { upsamplePlane, smoothstep, backgroundGrid, polishEdges, MAX_PIXELS } from '../dist-test/edges.js';

test('upsampling keeps the mask geometry', () => {
  const plane = { data: new Float32Array([0, 0, 1, 1]), width: 2, height: 2 };
  const big = upsamplePlane(plane, 4, 4);
  assert.equal(big.length, 16);
  assert.ok(big[0] < 0.3, 'corner stays background');
  assert.ok(big[15] > 0.7, 'corner stays subject');
  // The plane is [0,0 / 1,1], so the top half must stay darker than the bottom.
  const top = [0, 1, 2, 3].reduce((s, i) => s + big[i], 0) / 4;
  const bottom = [12, 13, 14, 15].reduce((s, i) => s + big[i], 0) / 4;
  assert.ok(top < bottom, 'rows keep their order');
});

test('smoothstep is a clamped S-curve', () => {
  assert.equal(smoothstep(0.2, 0.8, 0), 0);
  assert.equal(smoothstep(0.2, 0.8, 1), 1);
  assert.equal(smoothstep(0.2, 0.8, 0.2), 0);
  assert.equal(smoothstep(0.2, 0.8, 0.8), 1);
  assert.ok(Math.abs(smoothstep(0.2, 0.8, 0.5) - 0.5) < 1e-6);
  assert.ok(smoothstep(0.2, 0.8, 0.3) < 0.3, 'pulls the ramp down');
  assert.ok(smoothstep(0.2, 0.8, 0.7) > 0.7, 'pushes the ramp up');
});

test('the background grid only samples thrown-away pixels', () => {
  // 4x4 white photo, subject (red) in the middle two columns, alpha 1 there.
  const w = 4, h = 4;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const alpha = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const subject = x === 1 || x === 2;
      rgba[i * 4] = subject ? 200 : 250;
      rgba[i * 4 + 1] = subject ? 0 : 250;
      rgba[i * 4 + 2] = subject ? 0 : 250;
      rgba[i * 4 + 3] = 255;
      alpha[i] = subject ? 1 : 0;
    }
  }
  const grid = backgroundGrid(rgba, alpha, w, h, 2);
  assert.equal(grid.cols, 2);
  for (let g = 0; g < 4; g++) {
    assert.ok(grid.rgb[g * 3] > 200, `cell ${g} is white-ish`);
    assert.ok(grid.rgb[g * 3 + 1] > 200, `cell ${g} is white-ish`);
  }
});

test('a halo pixel loses the background colour it was carrying', () => {
  const w = 8, h = 8;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const plane = { data: new Float32Array(w * h), width: w, height: h };
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    // Background = pure white; subject = pure red; the two middle columns are
    // an edge pixel that is half subject, half background — the classic halo.
    const subject = x >= 4;
    const edge = x === 3 || x === 4;
    rgba[i * 4] = subject ? 255 : 255;
    rgba[i * 4 + 1] = subject ? 0 : 255;
    rgba[i * 4 + 2] = subject ? 0 : 255;
    rgba[i * 4 + 3] = 255;
    plane.data[i] = x < 3 ? 0 : x > 4 ? 1 : x === 3 ? 0.3 : 0.7;
    if (edge) {
      // what the sensor actually recorded: a wash of red and white
      rgba[i * 4] = 255;
      rgba[i * 4 + 1] = 128;
      rgba[i * 4 + 2] = 128;
    }
  }
  const out = polishEdges(rgba, w, h, plane);
  const edge = (4 * w + 4) * 4; // x=4, y=4
  assert.ok(out.bandPixels > 0, 'the band exists');
  assert.ok(out.rgb[edge + 1] < 128, 'green fringe pulled down towards the subject');
  assert.ok(out.rgb[edge + 2] < 128, 'blue fringe pulled down towards the subject');
  assert.ok(out.rgb[edge] >= 240, 'red stays');
  assert.ok(out.alpha[4 * w + 3] < 0.3, 'a 0.3 pixel is pushed down');
  assert.ok(out.alpha[4 * w + 4] > 0.7, 'a 0.7 pixel is pushed up');
});

test('solids are left alone and the input is never mutated', () => {
  const w = 4, h = 4;
  const rgba = new Uint8ClampedArray(w * h * 4).fill(120);
  const copy = Uint8ClampedArray.from(rgba);
  const plane = { data: new Float32Array(w * h).fill(1), width: w, height: h };
  const out = polishEdges(rgba, w, h, plane);
  assert.equal(out.bandPixels, 0, 'no transition, no work');
  assert.deepEqual(Array.from(rgba), Array.from(copy), 'source untouched');
  for (let i = 0; i < w * h; i++) assert.equal(out.alpha[i], 1);
});

test('the phone size limit is a real number', () => {
  assert.ok(MAX_PIXELS >= 4e6, 'a 2048px phone photo must be polished');
  assert.ok(MAX_PIXELS <= 12e6, 'but a 40 MP desktop photo must be skipped');
});
