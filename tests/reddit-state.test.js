'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyRedditPage } = require('../src/browser/reddit');

test('classifyRedditPage identifies reddit login views', () => {
  assert.equal(
    classifyRedditPage({ url: 'https://www.reddit.com/login/' }),
    'reddit_login'
  );
  assert.equal(
    classifyRedditPage({ url: 'https://www.reddit.com/', needsLogin: true }),
    'reddit_login'
  );
});

test('classifyRedditPage identifies subreddit feeds', () => {
  assert.equal(
    classifyRedditPage({ url: 'https://www.reddit.com/r/FulfillmentByAmazon/' }),
    'reddit_subreddit_feed'
  );
});

test('classifyRedditPage identifies reddit search results', () => {
  assert.equal(
    classifyRedditPage({ url: 'https://www.reddit.com/search/?q=amazon%20fees' }),
    'reddit_search_results'
  );
});

test('classifyRedditPage identifies reddit post detail views', () => {
  assert.equal(
    classifyRedditPage({ url: 'https://www.reddit.com/r/FulfillmentByAmazon/comments/abc123/test_post/' }),
    'reddit_post_detail'
  );
});

test('classifyRedditPage identifies reddit home', () => {
  assert.equal(
    classifyRedditPage({ url: 'https://www.reddit.com/' }),
    'reddit_home'
  );
});
