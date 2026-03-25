'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  looksLikeFacebookTimestamp,
  classifyFacebookPageMode,
} = require('../src/browser/feed');

test('looksLikeFacebookTimestamp supports relative Facebook times', () => {
  assert.equal(looksLikeFacebookTimestamp('2m'), true);
  assert.equal(looksLikeFacebookTimestamp('5 hours'), true);
  assert.equal(looksLikeFacebookTimestamp('Yesterday'), true);
});

test('looksLikeFacebookTimestamp supports absolute Facebook times', () => {
  assert.equal(looksLikeFacebookTimestamp('March 9 at 12:01 AM'), true);
  assert.equal(looksLikeFacebookTimestamp('Sep 14 at 8:30 PM'), true);
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
