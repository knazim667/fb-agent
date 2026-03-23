'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  inferIntentHeuristically,
  routeOperatorIntent,
} = require('../src/agent/operator_console');

test('heuristic router maps natural scan phrasing', () => {
  const intent = inferIntentHeuristically('can you scan the groups for leads');
  assert.equal(intent.type, 'scan');
});

test('heuristic router extracts search keywords from natural phrasing', () => {
  const intent = inferIntentHeuristically('find groups for amazon ppc experts');
  assert.equal(intent.type, 'search');
  assert.equal(intent.keyword, 'amazon ppc experts');
});

test('router falls back to question intent when request is informational', async () => {
  const intent = await routeOperatorIntent('what notification do we have now', {
    callOllama: async () => {
      throw new Error('offline');
    },
    model: 'gpt-oss:20b',
  });

  assert.equal(intent.type, 'question');
  assert.equal(intent.text, 'what notification do we have now');
});
