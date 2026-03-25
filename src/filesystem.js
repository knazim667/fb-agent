'use strict';

const fs = require('fs/promises');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const SKILLS_DIR = path.join(ROOT_DIR, 'skills');
const MEMORY_DIR = path.join(ROOT_DIR, 'memory');
const SKILL_FEEDBACK_PATH = path.join(MEMORY_DIR, 'skill_feedback.md');

function normalizeTopicToSkillId(topic = '') {
  const normalized = String(topic || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  return normalized || 'general_business';
}

function skillPathFromTopic(topic = '') {
  return path.join(SKILLS_DIR, `${normalizeTopicToSkillId(topic)}.md`);
}

async function ensureSkillMemoryFiles() {
  await fs.mkdir(SKILLS_DIR, { recursive: true });
  await fs.mkdir(MEMORY_DIR, { recursive: true });

  try {
    await fs.access(SKILL_FEEDBACK_PATH);
  } catch (_error) {
    await fs.writeFile(
      SKILL_FEEDBACK_PATH,
      [
        '# Skill Feedback',
        '',
        'Operational notes about which skills, replies, and patterns worked or failed.',
        '',
      ].join('\n'),
      'utf8'
    );
  }
}

function parseBriefSections(brief = '') {
  const lines = String(brief || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const sections = {
    goal: [],
    audience: [],
    expertise: [],
    tone: [],
    avoid: [],
    leadSignals: [],
    notes: [],
  };

  for (const line of lines) {
    const match = line.match(/^(goal|audience|expertise|tone|avoid|lead signals?|notes?)\s*:\s*(.+)$/i);
    if (!match) {
      sections.notes.push(line);
      continue;
    }

    const key = match[1].toLowerCase().replace(/\s+/g, '');
    const value = match[2].trim();

    if (key === 'goals' || key === 'goal') {
      sections.goal.push(value);
    } else if (key === 'audience') {
      sections.audience.push(value);
    } else if (key === 'expertise') {
      sections.expertise.push(value);
    } else if (key === 'tone') {
      sections.tone.push(value);
    } else if (key === 'avoid') {
      sections.avoid.push(value);
    } else if (key === 'leadsignal' || key === 'leadsignals') {
      sections.leadSignals.push(value);
    } else {
      sections.notes.push(value);
    }
  }

  if (!sections.goal.length && brief) {
    sections.goal.push(String(brief).trim());
  }

  return sections;
}

function asBullets(items = [], fallback = []) {
  const source = items.length ? items : fallback;
  return source.map((item) => `- ${item}`);
}

function buildSkillMarkdown(topic, brief) {
  const parsed = parseBriefSections(brief);
  return [
    `# ${topic}`,
    '',
    '## Mission',
    `- Help the operator handle Facebook activity for ${topic} with practical, human communication.`,
    '- Reuse this skill when the topic clearly matches.',
    '',
    '## Goal',
    ...asBullets(parsed.goal, ['Build trust, be helpful, and support the operator’s objective in this business.']),
    '',
    '## Audience',
    ...asBullets(parsed.audience, ['People in this Facebook niche, related customers, and useful peers.']),
    '',
    '## Expertise',
    ...asBullets(parsed.expertise, ['Use practical domain knowledge, answer simply, and avoid fake certainty.']),
    '',
    '## Tone',
    ...asBullets(parsed.tone, ['Simple English', 'Helpful, practical, and human', 'No hype, no robotic language']),
    '',
    '## Lead Signals',
    ...asBullets(parsed.leadSignals, ['People asking for help', 'People sharing a struggle', 'People asking how to improve results']),
    '',
    '## Helpful Comment Patterns',
    '- Celebration: congratulate them and mention one specific detail from their post.',
    '- Problem: offer one practical tip, then a light next step.',
    '- Question: answer clearly and simply, then invite follow-up if useful.',
    '- General: keep a positive, real-human presence without forcing a pitch.',
    '',
    '## Avoid',
    ...asBullets(parsed.avoid, ['Do not say "As an AI".', 'Do not hard-sell.', 'Do not force unrelated business advice.']),
    '',
    '## Discovery Notes',
    ...asBullets(parsed.notes, ['Learned from operator brief. Refine this skill over time with feedback from live interactions.']),
    '',
  ].join('\n');
}

async function saveNewSkill(topic, brief, options = {}) {
  await ensureSkillMemoryFiles();
  await fs.mkdir(SKILLS_DIR, { recursive: true });
  const skillId = normalizeTopicToSkillId(topic);
  const filePath = skillPathFromTopic(topic);
  const content = buildSkillMarkdown(topic, brief);
  let existed = false;

  try {
    await fs.access(filePath);
    existed = true;
  } catch (_error) {
    existed = false;
  }

  if (existed && options.overwrite === false) {
    return { skillId, filePath, existed: true };
  }

  await fs.writeFile(filePath, content, 'utf8');
  await appendSkillFeedback(skillId, {
    interactionType: 'skill_acquisition',
    outcome: existed ? 'updated' : 'created',
    note: `Saved skill from operator brief for topic "${topic}".`,
    source: 'operator_console',
  });
  return {
    skillId,
    filePath,
    existed,
  };
}

async function appendSkillFeedback(skillId, feedback = {}) {
  await ensureSkillMemoryFiles();
  const heading = `## ${skillId}`;
  const original = await fs.readFile(SKILL_FEEDBACK_PATH, 'utf8').catch(() => '# Skill Feedback\n\n');
  const note = [
    `- ${new Date().toISOString()}`,
    `  - interaction: ${feedback.interactionType || 'unknown'}`,
    `  - outcome: ${feedback.outcome || 'unknown'}`,
    feedback.source ? `  - source: ${feedback.source}` : '',
    feedback.note ? `  - note: ${feedback.note}` : '',
  ].filter(Boolean).join('\n');

  let updated;
  if (original.includes(heading)) {
    updated = original.replace(heading, `${heading}\n${note}`);
  } else {
    updated = [original.trimEnd(), '', heading, note, ''].join('\n');
  }

  await fs.writeFile(SKILL_FEEDBACK_PATH, updated, 'utf8');
}

module.exports = {
  appendSkillFeedback,
  buildSkillMarkdown,
  ensureSkillMemoryFiles,
  normalizeTopicToSkillId,
  saveNewSkill,
  skillPathFromTopic,
  SKILL_FEEDBACK_PATH,
  SKILLS_DIR,
};
