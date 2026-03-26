'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildObjectiveChecklist,
  inferObjectiveFamily,
  interpretObjectiveForBrowser,
} = require('../src/brain');

test('inferObjectiveFamily maps drafting requests', () => {
  assert.equal(inferObjectiveFamily('draft a post on my feed'), 'drafting');
});

test('inferObjectiveFamily maps business scan requests', () => {
  assert.equal(
    inferObjectiveFamily('find posts about reimbursements and settlement issues in this group'),
    'business_scan'
  );
});

test('inferObjectiveFamily maps general engagement requests', () => {
  assert.equal(inferObjectiveFamily('like first 5 posts in group 17'), 'general_engagement');
});

test('buildObjectiveChecklist returns family-specific steps', () => {
  assert.deepEqual(buildObjectiveChecklist('drafting', 'draft a post'), [
    'Draft the text first.',
    'Show the draft to the operator before opening the browser.',
    'Only publish if the operator explicitly confirms or asks to post it.',
  ]);
});

test('interpretObjectiveForBrowser expands amazon hidden money lead search intent', async () => {
  const plan = await interpretObjectiveForBrowser({
    objective: 'find leads about our amazon hidden money business',
    currentPlatform: 'reddit',
    currentSurface: 'reddit_home',
    relevantSkill: 'amazon_hidden_money',
  }, {
    disableModel: true,
  });

  assert.equal(plan.family, 'business_scan');
  assert.equal(plan.intent, 'find_leads');
  assert.ok(Array.isArray(plan.searchQueries));
  assert.ok(plan.searchQueries.some((query) => /reimbursement|fees|settlement|inventory|profit/i.test(query)));
  assert.ok(plan.mustMatchAny.some((term) => /reimbursement|inventory|fees|profit|settlement/i.test(term)));
});

test('interpretObjectiveForBrowser does not keep the raw sentence as the only search query', async () => {
  const plan = await interpretObjectiveForBrowser({
    objective: 'search reddit on our amazon hidden money business, maybe somebody is looking for help to recover his money',
    currentPlatform: 'reddit',
    currentSurface: 'reddit_home',
    relevantSkill: 'amazon_hidden_money',
  }, {
    disableModel: true,
  });

  assert.ok(plan.searchQueries.length >= 2);
  assert.notEqual(
    plan.searchQueries[0].toLowerCase(),
    'search reddit on our amazon hidden money business, maybe somebody is looking for help to recover his money'
  );
});
