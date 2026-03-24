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

test('heuristic router maps loose joined-group phrasing', () => {
  const intent = inferIntentHeuristically('give me a list of all group we already joined');
  assert.equal(intent.type, 'list_groups');
});

test('heuristic router maps draft comment requests', () => {
  const intent = inferIntentHeuristically('draft a comment for post 1');
  assert.equal(intent.type, 'draft_comment');
  assert.equal(intent.post_index, 1);
});

test('heuristic router maps draft feed post requests', () => {
  const intent = inferIntentHeuristically('draft a post on feed');
  assert.equal(intent.type, 'draft_post');
  assert.equal(intent.target, 'feed');
});

test('router maps notification questions directly when phrasing is clear', async () => {
  const intent = await routeOperatorIntent('what notification do we have now', {
    callOllama: async () => {
      throw new Error('offline');
    },
    model: 'gpt-oss:20b',
  });

  assert.equal(intent.type, 'check_notifications');
});

test('heuristic router maps unread mark-as-read notification requests', () => {
  const intent = inferIntentHeuristically(
    'show me at least 5 unread notification from today to yesterday and mark as read'
  );
  assert.equal(intent.type, 'check_notifications');
  assert.equal(intent.unread_only, true);
  assert.equal(intent.mark_read, true);
  assert.equal(intent.within_hours, 48);
  assert.equal(intent.limit, 5);
});

test('heuristic router captures group list limit and activity sorting', () => {
  const intent = inferIntentHeuristically('give me a list of active amazon groups maximum 10 groups');
  assert.equal(intent.type, 'list_groups');
  assert.equal(intent.amazon_only, true);
  assert.equal(intent.sort_by, 'activity');
  assert.equal(intent.limit, 10);
});

test('heuristic router maps random like requests', () => {
  const intent = inferIntentHeuristically('can you like at least 10 random post in group Amazon FBA PrivateLabel - plfba.com');
  assert.equal(intent.type, 'like_random_posts');
  assert.equal(intent.count, 10);
  assert.match(intent.group_name, /plfba\.com/i);
});
