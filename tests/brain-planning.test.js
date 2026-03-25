'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildObjectiveChecklist,
  inferObjectiveFamily,
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
