'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  looksLikeFacebookTimestamp,
  classifyFacebookPageMode,
  isVisiblePostCandidate,
} = require('../src/browser/feed');

test('looksLikeFacebookTimestamp supports relative Facebook times', () => {
  assert.equal(looksLikeFacebookTimestamp('2m'), true);
  assert.equal(looksLikeFacebookTimestamp('5 hours'), true);
  assert.equal(looksLikeFacebookTimestamp('Yesterday'), true);
});

test('looksLikeFacebookTimestamp supports absolute Facebook times', () => {
  assert.equal(looksLikeFacebookTimestamp('March 9 at 12:01 AM'), true);
  assert.equal(looksLikeFacebookTimestamp('Sep 14 at 8:30 PM'), true);
  assert.equal(looksLikeFacebookTimestamp('March 9, 2026 at 12:01 AM'), true);
  assert.equal(looksLikeFacebookTimestamp('2h ago'), true);
});

test('classifyFacebookPageMode identifies post detail views', () => {
  assert.equal(
    classifyFacebookPageMode({
      articleCount: 1,
      bodyText: 'View more answers Write an answer',
      url: 'https://www.facebook.com/groups/example/posts/1234567890/',
    }),
    'post_detail'
  );
});

test('classifyFacebookPageMode identifies group feed views', () => {
  assert.equal(
    classifyFacebookPageMode({
      articleCount: 8,
      bodyText: 'Like Comment Share',
      url: 'https://www.facebook.com/groups/amazonexample',
    }),
    'group_feed'
  );
});

test('classifyFacebookPageMode keeps group urls as group_feed even with comment-heavy body text', () => {
  assert.equal(
    classifyFacebookPageMode({
      articleCount: 2,
      bodyText: 'View more answers public comment comments',
      url: 'https://www.facebook.com/groups/example-group',
    }),
    'group_feed'
  );
});

test('isVisiblePostCandidate allows missing timestamp when other post signals are strong', () => {
  assert.equal(
    isVisiblePostCandidate({
      authorName: 'Zain Khokhar',
      bodyText: 'Super results on Walmart USA with strong order volume and profit details.',
      actionControlCount: 3,
      timestampText: '',
    }),
    true
  );
});
