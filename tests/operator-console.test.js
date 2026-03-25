'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  inferIntentHeuristically,
  resolveNamedGroup,
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

test('heuristic router captures list-of count phrasing for groups', () => {
  const intent = inferIntentHeuristically('give me a list of 5 most active amazon groups');
  assert.equal(intent.type, 'list_groups');
  assert.equal(intent.amazon_only, true);
  assert.equal(intent.sort_by, 'activity');
  assert.equal(intent.limit, 5);
});

test('heuristic router maps random like requests', () => {
  const intent = inferIntentHeuristically('can you like at least 10 random post in group Amazon FBA PrivateLabel - plfba.com');
  assert.equal(intent.type, 'like_random_posts');
  assert.equal(intent.count, 10);
  assert.match(intent.group_name, /plfba\.com/i);
});

test('heuristic router maps numbered group random likes', () => {
  const intent = inferIntentHeuristically('now can you like 5 random posts in group 1');
  assert.equal(intent.type, 'like_random_posts');
  assert.equal(intent.count, 5);
  assert.equal(intent.group_index, 1);
});

test('heuristic router maps numbered group random likes with on-group phrasing', () => {
  const intent = inferIntentHeuristically('like 5 random post on group 22');
  assert.equal(intent.type, 'like_random_posts');
  assert.equal(intent.count, 5);
  assert.equal(intent.group_index, 22);
  assert.equal(intent.selection, 'random');
});

test('heuristic router maps first-post like requests', () => {
  const intent = inferIntentHeuristically('go to group 17 and like first 5 posts in this group');
  assert.equal(intent.type, 'like_random_posts');
  assert.equal(intent.count, 5);
  assert.equal(intent.group_index, 17);
  assert.equal(intent.selection, 'first');
});

test('heuristic router maps numbered group random comments', () => {
  const intent = inferIntentHeuristically('can you comment on 5 random post on group 7');
  assert.equal(intent.type, 'comment_random_posts');
  assert.equal(intent.count, 5);
  assert.equal(intent.group_index, 7);
  assert.equal(intent.selection, 'random');
});

test('heuristic router maps first-post comment requests', () => {
  const intent = inferIntentHeuristically('comment on first 3 posts on group 7');
  assert.equal(intent.type, 'comment_random_posts');
  assert.equal(intent.count, 3);
  assert.equal(intent.group_index, 7);
  assert.equal(intent.selection, 'first');
});

test('heuristic router maps recent posts request for numbered group', () => {
  const intent = inferIntentHeuristically('can you give me recent 5 posts from group 2');
  assert.equal(intent.type, 'show_posts');
  assert.equal(intent.limit, 5);
  assert.equal(intent.group_index, 2);
});

test('heuristic router maps random posts request for numbered group', () => {
  const intent = inferIntentHeuristically('can you give me any random posts in group 2');
  assert.equal(intent.type, 'show_posts');
  assert.equal(intent.group_index, 2);
  assert.equal(intent.random, true);
});

test('heuristic router maps feed post listing requests', () => {
  const intent = inferIntentHeuristically('show me recent 5 posts from my feed');
  assert.equal(intent.type, 'show_posts');
  assert.equal(intent.surface, 'feed');
  assert.equal(intent.limit, 5);
});

test('heuristic router maps feed like requests', () => {
  const intent = inferIntentHeuristically('go to the feed and like the first 5 random posts');
  assert.equal(intent.type, 'like_random_posts');
  assert.equal(intent.surface, 'feed');
  assert.equal(intent.count, 5);
});

test('resolveNamedGroup prefers exact normalized matches before loose contains', () => {
  const groups = [
    { name: 'Amazon FBA Sellers and Community', url: 'https://facebook.com/groups/1' },
    { name: 'Amazon FBA Sellers Community', url: 'https://facebook.com/groups/2' },
    { name: 'Get and sell Amazon Products', url: 'https://facebook.com/groups/3' },
  ];

  const match = resolveNamedGroup(groups, 'Amazon FBA Sellers Community');
  assert.equal(match?.url, 'https://facebook.com/groups/2');
});

test('heuristic router maps draft post on numbered group', () => {
  const intent = inferIntentHeuristically('draft a post on group 1 about our amazon hidden money business');
  assert.equal(intent.type, 'draft_post');
  assert.equal(intent.target, 'group');
  assert.equal(intent.group_index, 1);
  assert.match(intent.topic, /amazon hidden money/i);
});

test('heuristic router maps natural draft-then-post phrasing for groups', () => {
  const intent = inferIntentHeuristically(
    'draft a post about our amazon hidden money business and post it to group 14'
  );
  assert.equal(intent.type, 'draft_post');
  assert.equal(intent.target, 'group');
  assert.equal(intent.group_index, 14);
  assert.match(intent.topic, /amazon hidden money/i);
});

test('heuristic router maps post-last-draft requests', () => {
  const intent = inferIntentHeuristically('post the last draft');
  assert.equal(intent.type, 'post_last_draft');
});

test('heuristic router maps debug toggle requests', () => {
  assert.deepEqual(inferIntentHeuristically('debug on'), { type: 'debug_mode', enabled: true });
  assert.deepEqual(inferIntentHeuristically('debug off'), { type: 'debug_mode', enabled: false });
});
