'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  inferIntentHeuristically,
  inferPlatformScopedIntent,
  inspectSemanticLeadSignals,
  looksLikeDraftApproval,
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

test('draft approval helper detects natural approval phrases', () => {
  assert.equal(looksLikeDraftApproval('yes post it'), true);
  assert.equal(looksLikeDraftApproval('approved'), true);
  assert.equal(looksLikeDraftApproval('go ahead'), true);
  assert.equal(looksLikeDraftApproval('post the last draft'), true);
  assert.equal(looksLikeDraftApproval('show me another draft'), false);
});

test('heuristic router maps debug toggle requests', () => {
  assert.deepEqual(inferIntentHeuristically('debug on'), { type: 'debug_mode', enabled: true });
  assert.deepEqual(inferIntentHeuristically('debug off'), { type: 'debug_mode', enabled: false });
});

test('heuristic router maps dry-run toggle requests', () => {
  assert.deepEqual(inferIntentHeuristically('dry run on'), { type: 'dry_run_mode', enabled: true });
  assert.deepEqual(inferIntentHeuristically('dry run off'), { type: 'dry_run_mode', enabled: false });
});

test('heuristic router maps platform switch to reddit', () => {
  assert.deepEqual(inferIntentHeuristically('go to reddit'), { type: 'switch_platform', platform: 'reddit' });
});

test('heuristic router maps embedded platform switch to reddit', () => {
  assert.deepEqual(
    inferIntentHeuristically('you are on facebook, switch to reddit'),
    { type: 'switch_platform', platform: 'reddit' }
  );
});

test('heuristic router maps reddit login inspection', () => {
  assert.deepEqual(
    inferIntentHeuristically('are you login on reddit'),
    { type: 'inspect_platform', platform: 'reddit' }
  );
});

test('heuristic router maps facebook scan phrasing', () => {
  assert.deepEqual(
    inferIntentHeuristically('search on facebook about amazon reimbursement, amazon inventory issues, amazon fees'),
    { type: 'scan' }
  );
});

test('heuristic router maps subreddit post listing', () => {
  const intent = inferIntentHeuristically('show me 10 recent posts from r/FulfillmentByAmazon');
  assert.equal(intent.type, 'reddit_show_posts');
  assert.equal(intent.subreddit, 'FulfillmentByAmazon');
  assert.equal(intent.limit, 10);
});

test('heuristic router maps reddit search requests', () => {
  const intent = inferIntentHeuristically('go to reddit and find posts about amazon reimbursement');
  assert.equal(intent.type, 'reddit_search_posts');
  assert.match(intent.query, /amazon reimbursement/i);
});

test('heuristic router maps reddit search requests with on-reddit phrasing', () => {
  const intent = inferIntentHeuristically('find posts about low profit on reddit');
  assert.equal(intent.type, 'reddit_search_posts');
  assert.match(intent.query, /low profit/i);
});

test('platform scoped reddit scan stays on reddit for generic related-post requests', () => {
  const intent = inferPlatformScopedIntent(
    'find post related about our amazon hidden money business',
    { currentPlatform: 'reddit' }
  );
  assert.equal(intent?.tool, 'reddit_scan_posts');
  assert.match(intent?.args?.topic || '', /amazon hidden money/i);
});

test('platform scoped reddit scan is ignored outside reddit', () => {
  const intent = inferPlatformScopedIntent(
    'find post related about our amazon hidden money business',
    { currentPlatform: 'facebook' }
  );
  assert.equal(intent, null);
});

test('platform scoped reddit scan is ignored when facebook is explicitly requested', () => {
  const intent = inferPlatformScopedIntent(
    'search on facebook about amazon reimbursement, amazon inventory issues, amazon fees',
    { currentPlatform: 'reddit' }
  );
  assert.equal(intent, null);
});

test('platform scoped reddit scan maps lead-finding requests to reddit', () => {
  const intent = inferPlatformScopedIntent(
    'find leads about our amazon hidden money business',
    { currentPlatform: 'reddit' }
  );
  assert.equal(intent?.tool, 'reddit_scan_posts');
  assert.match(intent?.args?.topic || '', /amazon hidden money/i);
});

test('platform scoped reddit scan maps search-for-help requests to reddit', () => {
  const intent = inferPlatformScopedIntent(
    'search reddit on our amazon hidden money business, maybe somebody is looking for help to recover his money',
    { currentPlatform: 'reddit' }
  );
  assert.equal(intent?.tool, 'reddit_scan_posts');
  assert.match(intent?.args?.topic || '', /recover/i);
});

test('semantic lead inspection catches seller confusion and payout pain as warm trigger', () => {
  const result = inspectSemanticLeadSignals(
    'Can someone explain why my Amazon payout is lower than expected? This settlement report does not make sense.',
    ['settlement', 'payout']
  );

  assert.ok(result.matchedSignals.includes('settlement_confusion'));
  assert.ok(result.matchedSignals.includes('seller_confusion'));
  assert.equal(result.warmTrigger, true);
  assert.ok(result.score >= 3);
});
