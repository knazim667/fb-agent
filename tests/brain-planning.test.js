'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSkillDecisionContext,
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
    'After approval, publish immediately and verify the result.',
  ]);
});

test('buildObjectiveChecklist keeps business scan action-first and adaptive', () => {
  assert.deepEqual(buildObjectiveChecklist('business_scan', 'find leads on facebook'), [
    'Open the relevant search surface, group, or subreddit and observe what is visible.',
    'Use the active skill to decide what pain signals count as leads and what to ignore.',
    'Inspect visible posts, retry with broader phrasing if results are weak, and adapt before stopping.',
    'Report the strongest hot or warm leads with the next action to take.',
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
  assert.ok(Array.isArray(plan.searchPasses));
  assert.ok(plan.searchPasses.some((item) => item.pass === 'community_manual_exploration'));
  assert.ok(plan.searchQueries.some((query) => /reimbursement|fees|settlement|inventory|profit/i.test(query)));
  assert.ok(plan.searchQueries.some((query) => /received 82 out of 100|lost 18 units|payout seems low|understand this settlement report|received less than shipped/i.test(query)));
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

test('buildSkillDecisionContext loads related amazon skills as policy', async () => {
  const policy = await buildSkillDecisionContext({
    objective: 'find leads about amazon reimbursements and low profit',
    activeSkill: 'amazon_hidden_money',
    family: 'business_scan',
  });

  assert.ok(policy.loadedSkillIds.includes('amazon_hidden_money'));
  assert.ok(policy.loadedSkillIds.includes('amazon_expert'));
  assert.ok(policy.searchThemes.some((item) => /reimbursement|inventory|fees|settlement/i.test(item)));
  assert.ok(policy.leadSignals.some((item) => /profit|fees|inventory|reimbursement/i.test(item)));
});

test('buildSkillDecisionContext produces short human seller symptom queries', async () => {
  const policy = await buildSkillDecisionContext({
    objective: 'find amazon sellers confused about missing units and low payout',
    activeSkill: 'amazon_hidden_money',
    family: 'business_scan',
  });

  assert.ok(policy.symptomQueries.some((item) => /received 82 out of 100|lost 18 units|missing inventory amazon|received less than shipped/i.test(item)));
  assert.ok(policy.symptomQueries.some((item) => /payout seems low|understand this settlement report|is this normal amazon fba/i.test(item)));
});

test('buildSkillDecisionContext wires richer updated skill sections into policy', async () => {
  const policy = await buildSkillDecisionContext({
    objective: 'warm up visibility with natural seller comments and move good leads toward dm',
    activeSkill: 'amazon_hidden_money',
    family: 'general_engagement',
  });

  assert.ok(policy.loadedSkillIds.includes('visibility_engagement'));
  assert.ok(policy.commentTypes.some((item) => /agreement comments|light insight comments|curious comments/i.test(item)));
  assert.ok(policy.escalationRules.some((item) => /missing units|incorrect fees|payout confusion/i.test(item)));
  assert.ok(policy.dmRules.some((item) => /minimum info needed|no links unless necessary|no hard close/i.test(item)));
});
