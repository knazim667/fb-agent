'use strict';

const fs = require('fs/promises');
const path = require('path');

const { getContextMemory } = require('./database');

const DEFAULT_OLLAMA_URL =
  process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-r1:32b';
const DEFAULT_OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 45_000);
const MORNING_BRIEFING_MODEL =
  process.env.MORNING_BRIEFING_MODEL || 'gpt-oss:20b';
const LEAD_QUALIFIER_MODEL =
  process.env.LEAD_QUALIFIER_MODEL || 'gpt-oss:20b';

const SKILLS_DIR = path.join(__dirname, '..', 'skills');
const MEMORY_DIR = path.join(__dirname, '..', 'memory');
const AGENT_INSIGHTS_PATH = path.join(MEMORY_DIR, 'agent_insights.md');
const HIGH_VALUE_PATTERNS = [
  /\bprice\b/i,
  /\bpricing\b/i,
  /\bcost\b/i,
  /\bquote\b/i,
  /\bdm me\b/i,
  /\bmessage me\b/i,
];

async function listAvailableSkills() {
  const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => ({
      id: entry.name.replace(/\.md$/i, ''),
      fileName: entry.name,
      filePath: path.join(SKILLS_DIR, entry.name),
    }));
}

async function loadSkill(skillName) {
  const normalizedSkill = skillName.replace(/\.md$/i, '');
  const filePath = path.join(SKILLS_DIR, `${normalizedSkill}.md`);
  const content = await fs.readFile(filePath, 'utf8');
  const phases = extractPhasesFromSkill(content);
  const manualFallbacks = extractManualFallbacks(content);

  return {
    id: normalizedSkill,
    filePath,
    content,
    phases,
    manualFallbacks,
  };
}

async function ensureMemoryFile() {
  await fs.mkdir(MEMORY_DIR, { recursive: true });

  try {
    await fs.access(AGENT_INSIGHTS_PATH);
  } catch (_error) {
    await fs.writeFile(
      AGENT_INSIGHTS_PATH,
      '# Agent Insights\n\nLearnings from successful Facebook lead interactions.\n',
      'utf8'
    );
  }
}

async function readAgentInsights() {
  await ensureMemoryFile();
  return fs.readFile(AGENT_INSIGHTS_PATH, 'utf8');
}

async function appendAgentInsights(entry) {
  await ensureMemoryFile();
  await fs.appendFile(AGENT_INSIGHTS_PATH, `${entry}\n`, 'utf8');
}

function extractPhasesFromSkill(content) {
  const phases = {};
  const phaseRegex = /PHASE\s+([1-4])(?:[^\n:]*):\s*"([^"]+)"|PHASE\s+([1-4])(?:[^\n:]*):\s*([^\n]+)/gi;

  for (const match of content.matchAll(phaseRegex)) {
    const phaseNumber = Number(match[1] || match[3]);
    const phaseText = (match[2] || match[4] || '').trim();
    if (phaseNumber && phaseText) {
      phases[phaseNumber] = phaseText;
    }
  }

  return phases;
}

function extractManualFallbacks(content) {
  const fallbackRegex = /- Q:\s*"([^"]+)"\s*\n\s*- A:\s*"([^"]+)"/g;
  const manualFallbacks = [];

  for (const match of content.matchAll(fallbackRegex)) {
    manualFallbacks.push({
      question: match[1].trim(),
      answer: match[2].trim(),
    });
  }

  return manualFallbacks;
}

async function resolveSkillForTask(task = {}) {
  if (task.active_skill) {
    return loadSkill(task.active_skill);
  }

  const haystack = JSON.stringify(task).toLowerCase();

  if (haystack.includes('amazon') || haystack.includes('fba')) {
    return loadSkill('amazon_expert');
  }

  if (
    haystack.includes('website') ||
    haystack.includes('web dev') ||
    haystack.includes('landing page')
  ) {
    return loadSkill('web_dev');
  }

  return loadSkill('web_dev');
}

async function callOllama(prompt, options = {}) {
  let response;

  try {
    response = await fetch(options.url || DEFAULT_OLLAMA_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_OLLAMA_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model || DEFAULT_OLLAMA_MODEL,
        prompt,
        stream: false,
        options: options.generationOptions || {
          temperature: 0.1,
          num_ctx: 2048,
        },
      }),
    });
  } catch (error) {
    const reason = error?.cause?.code || error?.name || error?.message || 'unknown_error';
    throw new Error(`Ollama request failed before response (${reason}).`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.response ? data.response.trim() : '';
}

function extractScore(rawText) {
  const match = rawText.match(/(?:^|\b)(10|[0-9])(?:\b|$)/);
  if (!match) {
    return 0;
  }

  return Number(match[1]);
}

function detectHighValueLead(text) {
  return HIGH_VALUE_PATTERNS.some((pattern) => pattern.test(text));
}

function emitHighValueLeadAlert(sourceText, metadata = {}) {
  if (!detectHighValueLead(sourceText)) {
    return false;
  }

  const context = metadata && Object.keys(metadata).length
    ? ` ${JSON.stringify(metadata)}`
    : '';
  console.warn(`HIGH VALUE LEAD:${context} ${sourceText}`);
  return true;
}

function inferPhaseFromUserReply(lastUserReply = '') {
  const text = lastUserReply.toLowerCase();

  if (
    /\bprice\b|\bpricing\b|\bcost\b|\bhow much\b|\bfee\b|\brate\b/.test(text)
  ) {
    return 4;
  }

  if (
    /\bcheck mine\b|\bmine\b|\breview mine\b|\bcan you check\b|\blook at my\b|\bhere is\b|\bi can share\b|\bscreenshot\b|\bsettlement\b/.test(text)
  ) {
    return 3;
  }

  if (/\bhow\b|\bwhat do you mean\b|\bwhy\b|\bexplain\b|\breally\b/.test(text)) {
    return 2;
  }

  return 1;
}

function determineNextPhase({ skill, currentPhase = null, lastUserReply = '' }) {
  const availablePhases = Object.keys(skill.phases || {})
    .map(Number)
    .sort((left, right) => left - right);

  if (!availablePhases.length) {
    return 1;
  }

  const inferredPhase = inferPhaseFromUserReply(lastUserReply);

  if (!currentPhase) {
    return availablePhases.includes(inferredPhase) ? inferredPhase : availablePhases[0];
  }

  const requestedPhase = Math.max(currentPhase + 1, inferredPhase);
  const nextPhase = availablePhases.find((phase) => phase >= requestedPhase);
  return nextPhase || availablePhases[availablePhases.length - 1];
}

async function getThreadState(threadId) {
  const context = await getContextMemory(threadId);
  return {
    context,
    threadHistory: context?.thread_history || [],
    currentPhase: context?.current_phase || null,
    summary: context?.summary_of_discussion || '',
  };
}

async function scorePostAgainstSkill(post, skill, options = {}) {
  const insights = await readAgentInsights();
  const prompt = [
    `Analyze this Amazon Seller post: '${post.content || ''}'.`,
    'Goal: Identify if the seller is losing money or facing financial distress.',
    'Check for:',
    '1. Lost/Damaged Inventory (Missing shipments, warehouse losses).',
    '2. Fee Discrepancies (High FBA/Referral fees, overcharging).',
    '3. Low Profit/Margins (High sales but low take-home pay).',
    '4. Settlement/Payout Issues (Negative balance, payment mismatch).',
    '5. Seeking Recovery/Audit help.',
    '',
    'Read agent_insights.md and apply previous successful tones to this new interaction.',
    insights,
    '',
    "Output ONLY JSON: {'is_lead': boolean, 'confidence': 1-10, 'category': 'string', 'reason': 'string'}.",
  ].join('\n');

  let raw = '';

  try {
    raw = await callOllama(prompt, {
      ...options,
      model: LEAD_QUALIFIER_MODEL,
      timeoutMs: options.timeoutMs || 30_000,
      generationOptions: {
        temperature: 0.1,
        num_ctx: 2048,
        num_predict: 160,
        ...options.generationOptions,
      },
    });
  } catch (_error) {
    return {
      score: 0,
      raw: '',
      shouldInteract: false,
      is_lead: false,
      confidence: 0,
      category: 'unknown',
      reason: 'AI request failed or timed out.',
    };
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  let parsed = null;

  try {
    parsed = jsonMatch ? JSON.parse(jsonMatch[0].replace(/'/g, '"')) : null;
  } catch (_error) {
    parsed = null;
  }

  const confidence = Math.max(
    0,
    Math.min(10, Number(parsed?.confidence || extractScore(raw) || 0))
  );

  return {
    score: confidence,
    raw,
    shouldInteract: Boolean(parsed?.is_lead) && confidence >= 7,
    is_lead: Boolean(parsed?.is_lead),
    confidence,
    category: parsed?.category || 'unknown',
    reason: parsed?.reason || '',
  };
}

async function draftReply({
  skill,
  post,
  contextSummary = '',
  tone = 'professional, warm, concise',
  threadId = null,
  phaseOverride = null,
}, options = {}) {
  const insights = await readAgentInsights();
  const threadState = threadId ? await getThreadState(threadId) : {
    context: null,
    threadHistory: [],
    currentPhase: null,
    summary: '',
  };
  const lastUserReply = [...threadState.threadHistory]
    .reverse()
    .find((entry) => entry.role === 'user')?.text || post.content || '';
  const targetPhase = phaseOverride || determineNextPhase({
    skill,
    currentPhase: threadState.currentPhase,
    lastUserReply,
  });
  const phaseInstruction = skill.phases?.[targetPhase] || '';

  const prompt = [
    'Write a Facebook reply.',
    `Tone: ${tone}.`,
    'Keep it concise, natural, and helpful.',
    'Do not use hashtags.',
    'Do not overpromise.',
    `Conversation phase to send now: Phase ${targetPhase}.`,
    'Do not repeat an earlier phase already used in this thread.',
    '',
    'Skill instructions:',
    skill.content,
    '',
    'Agent insights:',
    insights,
    '',
    'Thread history:',
    threadState.threadHistory.length
      ? threadState.threadHistory
          .map((entry) => `${entry.role}: ${entry.text}`)
          .join('\n')
      : 'No prior thread history available.',
    '',
    'Known discussion context:',
    contextSummary || threadState.summary || 'No prior context available.',
    '',
    `Phase ${targetPhase} guidance:`,
    phaseInstruction || 'Advance the conversation in the most appropriate next step.',
    '',
    'Original post:',
    post.content || '',
    '',
    'Reply:',
  ].join('\n');

  const reply = await callOllama(prompt, {
    ...options,
    generationOptions: {
      temperature: 0.5,
      num_predict: 180,
      ...options.generationOptions,
    },
  });

  emitHighValueLeadAlert(`${post.content || ''}\n${reply}`, {
    post_id: post.post_id || null,
    skill: skill.id,
    phase: targetPhase,
  });

  return {
    reply,
    phase: targetPhase,
    previousPhase: threadState.currentPhase,
  };
}

async function summarizeDiscussion({
  skill,
  postContent,
  replies = [],
}, options = {}) {
  const prompt = [
    'Summarize this Facebook discussion in 3 sentences or fewer.',
    'Focus on business need, objections, and next-step opportunity.',
    '',
    'Skill instructions:',
    skill.content,
    '',
    'Original post:',
    postContent || '',
    '',
    'Replies:',
    replies.length ? replies.join('\n') : 'No replies yet.',
  ].join('\n');

  return callOllama(prompt, {
    ...options,
    generationOptions: {
      temperature: 0.2,
      num_predict: 160,
      ...options.generationOptions,
    },
  });
}

module.exports = {
  AGENT_INSIGHTS_PATH,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_TIMEOUT_MS,
  DEFAULT_OLLAMA_URL,
  LEAD_QUALIFIER_MODEL,
  MORNING_BRIEFING_MODEL,
  SKILLS_DIR,
  appendAgentInsights,
  callOllama,
  determineNextPhase,
  detectHighValueLead,
  draftReply,
  ensureMemoryFile,
  emitHighValueLeadAlert,
  extractManualFallbacks,
  extractPhasesFromSkill,
  getThreadState,
  inferPhaseFromUserReply,
  listAvailableSkills,
  loadSkill,
  readAgentInsights,
  resolveSkillForTask,
  scorePostAgainstSkill,
  summarizeDiscussion,
};
