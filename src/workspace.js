'use strict';

const fs = require('fs/promises');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const MEMORY_DIR = path.join(ROOT_DIR, 'memory');
const PERSONA_PATH = path.join(MEMORY_DIR, 'persona.md');
const SKILL_FEEDBACK_PATH = path.join(MEMORY_DIR, 'skill_feedback.md');
const AGENTS_PATH = path.join(ROOT_DIR, 'AGENTS.md');
const SOUL_PATH = path.join(ROOT_DIR, 'SOUL.md');
const TOOLS_PATH = path.join(ROOT_DIR, 'TOOLS.md');
const USER_PATH = path.join(ROOT_DIR, 'USER.md');
const MEMORY_PATH = path.join(ROOT_DIR, 'MEMORY.md');

function todayFileName(now = new Date()) {
  return `${now.toISOString().slice(0, 10)}.md`;
}

function yesterdayFileName(now = new Date()) {
  const date = new Date(now);
  date.setDate(date.getDate() - 1);
  return `${date.toISOString().slice(0, 10)}.md`;
}

async function ensureFile(filePath, content) {
  try {
    await fs.access(filePath);
  } catch (_error) {
    await fs.writeFile(filePath, content, 'utf8');
  }
}

async function safeRead(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (_error) {
    return '';
  }
}

async function ensureWorkspaceDocs() {
  await fs.mkdir(MEMORY_DIR, { recursive: true });

  await ensureFile(PERSONA_PATH, [
    '# Agent Personality Profile: "The Helpful Expert"',
    '',
    '## Tone And Voice',
    '- Language: simple, direct English with no fluff.',
    '- Style: professional but friendly, like a busy business owner helping a friend.',
    '- Never say "As an AI".',
    '- If someone sounds frustrated, acknowledge that first.',
    '',
    '## Decision Logic',
    '- Achievement: congratulate them and mention a specific detail.',
    '- Problem: use a known skill if it fits, otherwise give a useful suggestion or one clarifying question.',
    '- Random Feed: like real posts, skip ads and junk.',
    '',
  ].join('\n'), 'utf8');

  await ensureFile(USER_PATH, [
    '# USER',
    '',
    '## Identity',
    '- Muhammad Nazam',
    '- Runs a Facebook lead-generation and account-management workflow',
    '',
    '## Preferences',
    '- Prefer simple English',
    '- Prefer chat-first control over background automation',
    '- Want the agent to understand intent, not exact commands',
    '- Likes practical summaries and clear next actions',
    '',
    '## Business Focus',
    '- Amazon Hidden Money Recovery',
    '- Lead generation in Amazon-related Facebook groups',
    '- Drafting comments, replies, and posts',
    '',
  ].join('\n'), 'utf8');

  await ensureFile(MEMORY_PATH, [
    '# MEMORY',
    '',
    '## Durable Facts',
    '- This workspace manages a Facebook account assistant for Amazon seller lead generation.',
    '- The preferred interaction style is conversational, step-by-step, and operator-controlled.',
    '- The agent should prefer current group and current post context when the user refers to numbered items.',
    '',
    '## Constraints',
    '- Avoid background activity unless explicitly asked.',
    '- Keep responses concise and operational.',
    '',
  ].join('\n'), 'utf8');

  await ensureFile(SKILL_FEEDBACK_PATH, [
    '# Skill Feedback',
    '',
    'Operational notes about which skills, replies, and patterns worked or failed.',
    '',
  ].join('\n'), 'utf8');

  const todayPath = path.join(MEMORY_DIR, todayFileName());
  await ensureFile(todayPath, [
    `# ${todayFileName().replace(/\.md$/, '')}`,
    '',
    '## Session Notes',
    '- Session started.',
    '',
  ].join('\n'), 'utf8');
}

async function loadWorkspaceContext() {
  const today = todayFileName();
  const yesterday = yesterdayFileName();
  const todayPath = path.join(MEMORY_DIR, today);
  const yesterdayPath = path.join(MEMORY_DIR, yesterday);

  const [
    agents,
    soul,
    tools,
    persona,
    user,
    memory,
    todayMemory,
    yesterdayMemory,
  ] = await Promise.all([
    safeRead(AGENTS_PATH),
    safeRead(SOUL_PATH),
    safeRead(TOOLS_PATH),
    safeRead(PERSONA_PATH),
    safeRead(USER_PATH),
    safeRead(MEMORY_PATH),
    safeRead(todayPath),
    safeRead(yesterdayPath),
  ]);

  return {
    agents,
    soul,
    tools,
    persona,
    user,
    memory,
    skillFeedback: await safeRead(SKILL_FEEDBACK_PATH),
    todayMemory,
    yesterdayMemory,
  };
}

module.exports = {
  ensureWorkspaceDocs,
  loadWorkspaceContext,
};
