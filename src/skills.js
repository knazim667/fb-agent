'use strict';

const fs = require('fs/promises');
const path = require('path');

const { SKILLS_DIR, normalizeTopicToSkillId } = require('./filesystem');

function tokenize(text = '') {
  return Array.from(
    new Set(
      String(text || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3)
    )
  );
}

function extractHeading(content = '') {
  const match = String(content || '').match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

function extractSection(content = '', heading = '') {
  const escaped = String(heading || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|\\Z)`, 'im');
  const match = String(content || '').match(regex);
  return match ? match[1].trim() : '';
}

function parseSkillMetadata(entry, content = '') {
  const title = extractHeading(content) || entry.name.replace(/\.md$/i, '');
  const mission = extractSection(content, 'Mission');
  const goal = extractSection(content, 'Goal') || extractSection(content, 'Business Goal');
  const audience = extractSection(content, 'Audience');
  const expertise = extractSection(content, 'Expertise') || extractSection(content, 'Core Knowledge');
  const tone = extractSection(content, 'Tone');
  const leadSignals = extractSection(content, 'Lead Signals');
  const sourceText = [
    title,
    mission,
    goal,
    audience,
    expertise,
    tone,
    leadSignals,
    entry.name,
  ].filter(Boolean).join('\n');

  return {
    id: entry.name.replace(/\.md$/i, ''),
    fileName: entry.name,
    filePath: path.join(SKILLS_DIR, entry.name),
    title,
    mission,
    goal,
    audience,
    expertise,
    tone,
    leadSignals,
    keywords: tokenize(sourceText),
  };
}

async function loadSkillCatalog() {
  const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md'));
  const catalog = [];

  for (const entry of files) {
    const filePath = path.join(SKILLS_DIR, entry.name);
    const content = await fs.readFile(filePath, 'utf8');
    catalog.push(parseSkillMetadata(entry, content));
  }

  return catalog;
}

function scoreSkillAgainstText(text = '', skill = {}) {
  const normalizedText = String(text || '').toLowerCase();
  const textTokens = tokenize(normalizedText);
  if (!textTokens.length) {
    return 0;
  }

  let score = 0;
  const skillId = String(skill.id || '').toLowerCase();
  const title = String(skill.title || '').toLowerCase();

  if (skillId && normalizedText.includes(skillId.replace(/_/g, ' '))) {
    score += 6;
  }
  if (title && normalizedText.includes(title)) {
    score += 8;
  }

  const topicId = normalizeTopicToSkillId(text);
  if (skillId && topicId === skillId) {
    score += 10;
  }

  const keywordSet = new Set(skill.keywords || []);
  for (const token of textTokens) {
    if (keywordSet.has(token)) {
      score += 2;
    }
  }

  return score;
}

async function findBestSkillForText(text = '', options = {}) {
  const catalog = options.catalog || await loadSkillCatalog();
  let best = null;

  for (const skill of catalog) {
    const score = scoreSkillAgainstText(text, skill);
    if (!best || score > best.score) {
      best = { ...skill, score };
    }
  }

  if (!best || best.score < (options.minimumScore || 4)) {
    return null;
  }

  return best;
}

async function findSkillByTopic(topic = '', options = {}) {
  const normalizedTopic = normalizeTopicToSkillId(topic);
  if (!normalizedTopic) {
    return null;
  }

  const catalog = options.catalog || await loadSkillCatalog();
  const exact = catalog.find((skill) => skill.id === normalizedTopic);
  if (exact) {
    return exact;
  }

  return findBestSkillForText(topic, {
    ...options,
    catalog,
    minimumScore: options.minimumScore || 3,
  });
}

module.exports = {
  extractHeading,
  extractSection,
  findBestSkillForText,
  findSkillByTopic,
  loadSkillCatalog,
  parseSkillMetadata,
  scoreSkillAgainstText,
  tokenize,
};
