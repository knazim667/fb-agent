'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectLeadSignals,
  mergePostReading,
} = require('../src/browser/multimodal');

test('detectLeadSignals finds amazon money-loss patterns in merged text', () => {
  const signals = detectLeadSignals(
    'Amazon says received 82 out of 100. My payout seems low and I think reimbursements are missing.'
  );

  assert.ok(signals.includes('missing units'));
  assert.ok(signals.includes('payout confusion'));
  assert.ok(signals.includes('reimbursement'));
});

test('mergePostReading combines dom, fallback, and image text into one normalized post reading', () => {
  const merged = mergePostReading({
    author: 'Seller Example',
    textFromDom: 'Amazon fees are too high.',
    textFromVisibleFallback: 'Settlement report does not make sense.',
    textFromImages: 'Seller Central screenshot shows missing units.',
    visualSummary: 'Amazon dashboard screenshot with payout discrepancy.',
    attachedImagesCount: 1,
  });

  assert.match(merged.merged_text, /fees are too high/i);
  assert.match(merged.merged_text, /missing units/i);
  assert.ok(merged.confidence_score >= 0.72);
  assert.ok(merged.lead_signals_matched.includes('high fees'));
  assert.ok(merged.lead_signals_matched.includes('missing units'));
});
