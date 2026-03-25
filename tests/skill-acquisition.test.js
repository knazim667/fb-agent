'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');

const {
  appendSkillFeedback,
  saveNewSkill,
  skillPathFromTopic,
  SKILL_FEEDBACK_PATH,
} = require('../src/filesystem');
const { findBestSkillForText, findSkillByTopic } = require('../src/skills');
const { resolveSkillForTask } = require('../src/brain');

test('saveNewSkill writes a structured reusable skill file', async () => {
  const topic = 'Car Detailing Test Skill';
  const filePath = skillPathFromTopic(topic);

  await fs.rm(filePath, { force: true });

  try {
    const saved = await saveNewSkill(
      topic,
      [
        'Goal: Build local trust and get Facebook inquiries.',
        'Audience: Local car owners, auto groups, and nearby businesses.',
        'Expertise: Paint correction, ceramic coating, interior detailing.',
        'Tone: Friendly, practical, not salesy.',
        'Avoid: Hard selling, robotic language.',
      ].join('\n')
    );

    const content = await fs.readFile(saved.filePath, 'utf8');
    assert.equal(saved.skillId, 'car_detailing_test_skill');
    assert.match(content, /^# Car Detailing Test Skill/m);
    assert.match(content, /^## Mission$/m);
    assert.match(content, /^## Goal$/m);
    assert.match(content, /^## Audience$/m);
    assert.match(content, /^## Expertise$/m);
    assert.match(content, /^## Tone$/m);
    assert.match(content, /^## Avoid$/m);
  } finally {
    await fs.rm(filePath, { force: true });
  }
});

test('appendSkillFeedback stores reusable outcome notes', async () => {
  const original = await fs.readFile(SKILL_FEEDBACK_PATH, 'utf8').catch(() => '');

  try {
    await appendSkillFeedback('amazon_hidden_money', {
      interactionType: 'comment',
      outcome: 'success',
      note: 'Helpful reimbursement comment got a positive reply.',
      source: 'test',
    });

    const updated = await fs.readFile(SKILL_FEEDBACK_PATH, 'utf8');
    assert.match(updated, /## amazon_hidden_money/m);
    assert.match(updated, /Helpful reimbursement comment got a positive reply\./);
  } finally {
    await fs.writeFile(SKILL_FEEDBACK_PATH, original, 'utf8');
  }
});

test('newly saved skills can be discovered and reused automatically', async () => {
  const topic = 'Car Detailing Test Skill';
  const filePath = skillPathFromTopic(topic);

  await fs.rm(filePath, { force: true });

  try {
    await saveNewSkill(
      topic,
      [
        'Goal: Build local trust and attract inquiries.',
        'Audience: Local drivers and car owners.',
        'Expertise: Paint correction, detailing packages, maintenance tips.',
        'Tone: Friendly and local.',
      ].join('\n')
    );

    const best = await findBestSkillForText('help people with car detailing tips and coating questions');
    assert.equal(best?.id, 'car_detailing_test_skill');

    const byTopic = await findSkillByTopic('car detailing');
    assert.equal(byTopic?.id, 'car_detailing_test_skill');

    const resolved = await resolveSkillForTask({
      objective: 'engage with local car detailing customers on Facebook',
    });
    assert.equal(resolved.id, 'car_detailing_test_skill');
  } finally {
    await fs.rm(filePath, { force: true });
  }
});
