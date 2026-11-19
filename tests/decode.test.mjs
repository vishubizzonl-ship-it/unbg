// Format sniffing must be right — it is what turns "could not be decoded" into
// "this is a HEIC photo, Chrome cannot open it".
import test from 'node:test';
import assert from 'node:assert/strict';
import { sniffImage, formatLabel, isBrowserDecodable } from '../dist-test/decode.js';

const bytes = (...parts) => {
  const out = [];
  for (const p of parts) {
    if (typeof p === 'string') out.push(...[...p].map((c) => c.charCodeAt(0)));
    else out.push(p);
  }
  return new Uint8Array(out);
};
const ftyp = (brand) => bytes(0, 0, 0, 0x18, 'ftyp', brand, 0, 0, 0, 0, brand, 'mif1');

test('JPEG is recognised by its SOI marker', () => {
  assert.equal(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0, 'JFIF', 0)), 'jpeg');
});

test('PNG magic wins even with a JPEG-like name', () => {
  assert.equal(sniffImage(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13)), 'png');
});

test('WebP needs RIFF *and* WEBP', () => {
  assert.equal(sniffImage(bytes('RIFF', 0, 0, 0, 0, 'WEBP', 0)), 'webp');
  assert.equal(sniffImage(bytes('RIFF', 0, 0, 0, 0, 'WAVE', 0)), 'unknown');
});

test('HEIC brands are spotted inside the ftyp box', () => {
  for (const brand of ['heic', 'heix', 'hevc', 'mif1', 'msf1']) {
    assert.equal(sniffImage(ftyp(brand)), 'heic', brand);
  }
});

test('AVIF is not mistaken for HEIC', () => {
  assert.equal(sniffImage(ftyp('avif')), 'avif');
  assert.equal(sniffImage(ftyp('avis')), 'avif');
});

test('other containers: gif, bmp, tiff (both byte orders), pdf', () => {
  assert.equal(sniffImage(bytes('GIF89a', 0, 0)), 'gif');
  assert.equal(sniffImage(bytes('BM', 0, 0, 0)), 'bmp');
  assert.equal(sniffImage(bytes('II', 0x2a, 0x00, 0)), 'tiff');
  assert.equal(sniffImage(bytes('MM', 0x00, 0x2a, 0)), 'tiff');
  assert.equal(sniffImage(bytes('%PDF-1.7')), 'pdf');
});

test('SVG is detected as text, junk is unknown', () => {
  assert.equal(sniffImage(bytes('<?xml version="1.0"?><svg xmlns=')), 'svg');
  assert.equal(sniffImage(bytes('<svg viewBox="0 0 1 1">')), 'svg');
  assert.equal(sniffImage(bytes('hello world, not an image')), 'unknown');
});

test('an empty file does not throw', () => {
  assert.equal(sniffImage(new Uint8Array(0)), 'unknown');
});

test('decodability answers match the browser (HEIC/TIFF/PDF are the no list)', () => {
  assert.equal(isBrowserDecodable('heic'), false);
  assert.equal(isBrowserDecodable('tiff'), false);
  assert.equal(isBrowserDecodable('pdf'), false);
  assert.equal(isBrowserDecodable('jpeg'), true);
  assert.equal(isBrowserDecodable('png'), true);
  assert.equal(isBrowserDecodable('webp'), true);
});

test('labels are the ones the user sees', () => {
  assert.equal(formatLabel('heic'), 'HEIC/HEIF');
  assert.equal(formatLabel('jpeg'), 'JPEG');
  assert.equal(formatLabel('unknown'), 'unrecognised');
});
