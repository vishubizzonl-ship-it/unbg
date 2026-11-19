// Puter's failures are the only thing this engine can guarantee, so they are
// translated and tested; the happy path needs a signed-in Puter account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { puterError } from '../dist-test/puter.js';

const err = (message, extra = {}) => Object.assign(new Error(message), extra);

test('out of credits is explained as credits, not as an HTTP code', () => {
  const message = puterError(err('Payment required', { errorCode: 'insufficient_funds' }));
  assert.match(message, /credits/i);
  assert.doesNotMatch(message, /402|Payment required/);
});

test('a content-filter refusal says so and suggests another photo', () => {
  assert.match(puterError(err('bad_request', { errorCode: 'moderation_flagged' })), /refuse|filter/i);
});

test('upstream failures are marked retryable', () => {
  assert.match(puterError(err('upstream_failed')), /dobara try/i);
});

test('a blocked SDK is blamed on the network, not on the photo', () => {
  assert.match(puterError(err('Puter.js load failed — network block?')), /internet|js\.puter\.com/i);
});

test('the sign-in path has its own sentence', () => {
  assert.match(puterError(err('sign_in_required')), /sign-in/i);
});

test('anything unknown is passed through untouched', () => {
  assert.equal(puterError(err('weird thing')), 'weird thing');
});
