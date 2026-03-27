'use strict';

const fs = require('fs/promises');
const path = require('path');

const { getContextMemory } = require('./database');
const { SKILL_FEEDBACK_PATH } = require('./filesystem');
const {
  extractSection,
  findBestSkillForText,
  findSkillByTopic,
  loadSkillCatalog,
} = require('./skills');
const { loadWorkspaceContext } = require('./workspace');

const DEFAULT_OLLAMA_URL =
  process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
const DEFAULT_OPENAI_URL =
  process.env.OPENAI_URL || 'https://api.openai.com/v1/responses';
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const DEFAULT_MODEL_PROVIDER = process.env.MODEL_PROVIDER || 'ollama';
const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-r1:32b';
const DEFAULT_OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 45_000);
const MORNING_BRIEFING_MODEL =
  process.env.MORNING_BRIEFING_MODEL || 'gpt-oss:20b';
const LEAD_QUALIFIER_MODEL =
  process.env.LEAD_QUALIFIER_MODEL || 'gpt-oss:20b';
const DOM_REASONER_MODEL =
  process.env.DOM_REASONER_MODEL || 'gpt-oss:20b';

const SKILLS_DIR = path.join(__dirname, '..', 'skills');
const MEMORY_DIR = path.join(__dirname, '..', 'memory');
const AGENT_INSIGHTS_PATH = path.join(MEMORY_DIR, 'agent_insights.md');
const PERSONA_PROFILE_PATH = path.join(MEMORY_DIR, 'persona.md');
const HIGH_VALUE_PATTERNS = [
  /\bprice\b/i,
  /\bpricing\b/i,
  /\bcost\b/i,
  /\bquote\b/i,
  /\bdm me\b/i,
  /\bmessage me\b/i,
];
const runtimeModelConfig = {
  provider: DEFAULT_MODEL_PROVIDER,
  model: null,
};

function extractJsonObjectCandidate(raw = '') {
  const text = String(raw || '').trim();
  if (!text) {
    return null;
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const match = candidate.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

function parseRelaxedJsonObject(raw = '') {
  const candidate = extractJsonObjectCandidate(raw);
  if (!candidate) {
    return null;
  }

  const normalized = candidate
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(normalized);
  } catch (_error) {
    try {
      return JSON.parse(normalized.replace(/'/g, '"'));
    } catch (_secondError) {
      return null;
    }
  }
}

async function repairJsonObjectResponse(raw, schemaHint, options = {}) {
  const prompt = [
    'Convert the following model output into valid JSON only.',
    `Required schema hint: ${schemaHint}`,
    'Do not explain anything. Return only one valid JSON object.',
    '',
    raw,
  ].join('\n');

  const repairedRaw = await callOllama(prompt, {
    ...options,
    timeoutMs: Math.min(options.timeoutMs || DEFAULT_OLLAMA_TIMEOUT_MS, 15_000),
    generationOptions: {
      temperature: 0,
      num_ctx: 2048,
      num_predict: 180,
      ...options.generationOptions,
    },
  });

  return parseRelaxedJsonObject(repairedRaw);
}

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

  try {
    await fs.access(PERSONA_PROFILE_PATH);
  } catch (_error) {
    await fs.writeFile(
      PERSONA_PROFILE_PATH,
      [
        '# Agent Personality Profile: "The Helpful Expert"',
        '',
        '## Tone And Voice',
        '- Language: simple, direct English with no fluff.',
        '- Style: professional but friendly.',
        '- Never say "As an AI".',
        '',
      ].join('\n'),
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

async function readPersonaProfile() {
  await ensureMemoryFile();
  return fs.readFile(PERSONA_PROFILE_PATH, 'utf8');
}

async function readSkillFeedback(skillId = '') {
  await ensureMemoryFile();

  let content = '';
  try {
    content = await fs.readFile(SKILL_FEEDBACK_PATH, 'utf8');
  } catch (_error) {
    return '';
  }

  if (!skillId) {
    return content;
  }

  const escaped = String(skillId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|\\Z)`, 'im'));
  return match ? `${skillId}\n${match[1].trim()}` : '';
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
  const learnedSkill = await findBestSkillForText(haystack).catch(() => null);
  if (learnedSkill?.id) {
    return loadSkill(learnedSkill.id);
  }

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
  const provider = options.provider || runtimeModelConfig.provider || DEFAULT_MODEL_PROVIDER;
  if (provider === 'openai') {
    return callOpenAI(prompt, options);
  }

  let response;

  try {
    response = await fetch(options.url || DEFAULT_OLLAMA_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_OLLAMA_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: runtimeModelConfig.model || options.model || DEFAULT_OLLAMA_MODEL,
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

async function callOpenAI(prompt, options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set.');
  }

  let response;
  try {
    response = await fetch(options.url || DEFAULT_OPENAI_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_OLLAMA_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: runtimeModelConfig.model || options.model || DEFAULT_OPENAI_MODEL,
        input: prompt,
      }),
    });
  } catch (error) {
    const reason = error?.cause?.code || error?.name || error?.message || 'unknown_error';
    throw new Error(`OpenAI request failed before response (${reason}).`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const fallbackText = Array.isArray(data.output)
    ? data.output
        .flatMap((item) => item?.content || [])
        .map((item) => item?.text || '')
        .join('\n')
        .trim()
    : '';

  return fallbackText;
}

function setModelRuntimeConfig(config = {}) {
  if (config.provider) {
    runtimeModelConfig.provider = config.provider;
  }

  if (typeof config.model === 'string') {
    runtimeModelConfig.model = config.model;
  }

  return {
    provider: runtimeModelConfig.provider,
    model: runtimeModelConfig.model,
  };
}

function getModelRuntimeConfig() {
  return {
    provider: runtimeModelConfig.provider,
    model: runtimeModelConfig.model,
  };
}

function extractScore(rawText) {
  const match = rawText.match(/(?:^|\b)(10|[0-9])(?:\b|$)/);
  if (!match) {
    return 0;
  }

  return Number(match[1]);
}

function inferLeadFromRawOrParsed(parsed, raw, confidence) {
  if (confidence >= 7) {
    return true;
  }

  if (typeof parsed?.is_lead === 'boolean') {
    return parsed.is_lead;
  }

  const normalized = String(raw || '').toLowerCase();
  if (/"is_lead"\s*:\s*true|'is_lead'\s*:\s*true/.test(normalized)) {
    return true;
  }

  return false;
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
    'Goal: Identify if the seller is a lead under the active business skill.',
    'Use the skill as operating policy, not just generic Amazon keywords.',
    'Classify the post as HOT, WARM, or COLD.',
    '',
    'Business skill:',
    skill?.content || 'No skill content.',
    '',
    'Read agent_insights.md and apply previous successful tones to this new interaction.',
    insights,
    '',
    "Output ONLY JSON: {'is_lead': boolean, 'confidence': 1-10, 'temperature': 'HOT|WARM|COLD', 'category': 'string', 'reason': 'string'}.",
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

  let parsed = parseRelaxedJsonObject(raw);
  if (!parsed) {
    try {
      parsed = await repairJsonObjectResponse(
        raw,
        "{'is_lead': boolean, 'confidence': 1-10, 'category': 'string', 'reason': 'string'}",
        {
          model: LEAD_QUALIFIER_MODEL,
        }
      );
    } catch (_error) {
      parsed = null;
    }
  }

  const confidence = Math.max(
    0,
    Math.min(10, Number(parsed?.confidence || extractScore(raw) || 0))
  );
  const isLead = inferLeadFromRawOrParsed(parsed, raw, confidence);

  return {
    score: confidence,
    raw,
    shouldInteract: isLead && confidence >= 7,
    is_lead: isLead,
    confidence,
    lead_temperature: String(parsed?.temperature || (confidence >= 8 ? 'HOT' : confidence >= 5 ? 'WARM' : 'COLD')).toUpperCase(),
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
  const persona = await readPersonaProfile();
  const skillFeedback = await readSkillFeedback(skill?.id);
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
    'Persona profile:',
    persona,
    '',
    'Skill instructions:',
    skill.content,
    '',
    'Agent insights:',
    insights,
    '',
    'Skill feedback:',
    skillFeedback || 'No skill feedback yet.',
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

function inferObjectiveFamily(objective = '') {
  const normalized = String(objective || '').toLowerCase();

  if (/\bdraft\b|\bwrite\b.*\bpost\b|\bcreate\b.*\bpost\b/.test(normalized)) {
    return 'drafting';
  }

  if (
    /\blike\b|\bcomment\b|\breply\b|\breact\b|\brecent posts?\b|\blatest posts?\b|\brandom posts?\b|\bshow posts?\b|\bnotifications?\b|\blist groups?\b|\bopen group\b|\bgo to group\b/.test(normalized)
  ) {
    return 'general_engagement';
  }

  if (
    /\blead\b|\bscan\b|\bfind\b.*\b(posts?|content)\b|\bhidden money\b|\breimbursement\b|\bsettlement\b|\binventory\b|\bprofit\b|\bfees?\b|\bmargins?\b/.test(normalized)
  ) {
    return 'business_scan';
  }

  return 'general_engagement';
}

function buildObjectiveChecklist(family, objective = '') {
  if (family === 'drafting') {
    return [
      'Draft the text first.',
      'Show the draft to the operator before opening the browser.',
      'After approval, publish immediately and verify the result.',
    ];
  }

  if (family === 'business_scan') {
    return [
      'Open the relevant search surface, group, or subreddit and observe what is visible.',
      'Use the active skill to decide what pain signals count as leads and what to ignore.',
      'Inspect visible posts, retry with broader phrasing if results are weak, and adapt before stopping.',
      'Report the strongest hot or warm leads with the next action to take.',
    ];
  }

  const normalized = String(objective || '').toLowerCase();
  if (/\blike\b/.test(normalized)) {
    return [
      'Resolve the target group or page.',
      'Collect visible original post anchors.',
      'Scroll until enough visible posts are available.',
      'Like the requested posts one by one and verify each like registered.',
    ];
  }

  if (/\bcomment\b|\breply\b/.test(normalized)) {
    return [
      'Resolve the target group or page.',
      'Collect visible original post anchors.',
      'Draft natural comments for the requested posts.',
      'Post comments one by one and verify each comment appears.',
    ];
  }

  if (/\bnotifications?\b/.test(normalized)) {
    return [
      'Open the notifications view.',
      'Collect the latest visible notifications.',
      'Filter them to the requested subset.',
      'Show the result clearly and only mark read if requested.',
    ];
  }

  if (/\bgroups?\b/.test(normalized)) {
    return [
      'Load the joined groups list.',
      'Filter to the requested type such as Amazon-related groups.',
      'Sort the list by recent activity if asked.',
      'Show the requested number of groups.',
    ];
  }

  return [
    'Resolve the requested page or group.',
    'Collect visible original posts or controls.',
    'Take the requested engagement action.',
    'Verify the UI changed before finishing.',
  ];
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const unique = [];
  for (const value of values) {
    const normalized = String(value || '').trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
}

function interleaveUniqueLists(lists = [], limit = 12) {
  const normalizedLists = lists.map((list) => Array.isArray(list) ? [...list] : []);
  const results = [];
  const seen = new Set();

  while (results.length < limit) {
    let advanced = false;
    for (const list of normalizedLists) {
      while (list.length) {
        const candidate = String(list.shift() || '').trim();
        const key = candidate.toLowerCase();
        if (!candidate || seen.has(key)) {
          continue;
        }
        seen.add(key);
        results.push(candidate);
        advanced = true;
        break;
      }
      if (results.length >= limit) {
        break;
      }
    }
    if (!advanced) {
      break;
    }
  }

  return results;
}

function extractBulletItems(sectionText = '') {
  return uniqueStrings(
    String(sectionText || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[-*]\s+/.test(line))
      .map((line) => line.replace(/^[-*]\s+/, '').trim().replace(/^"|"$/g, ''))
  );
}

function extractSectionSubheadings(sectionText = '') {
  return uniqueStrings(
    String(sectionText || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^##\s+/.test(line))
      .map((line) => line.replace(/^##\s+/, '').trim())
  );
}

function sentenceCase(text = '') {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return '';
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function buildNaturalQuestionVariants(phrases = []) {
  const results = [];
  for (const phrase of phrases) {
    const normalized = String(phrase || '').trim().replace(/^"+|"+$/g, '');
    if (!normalized) {
      continue;
    }
    const compact = normalized.replace(/\.$/, '');
    if (compact.includes('?')) {
      results.push(compact);
      continue;
    }
    results.push(compact);
    results.push(`is this normal ${compact.toLowerCase()}`);
    results.push(`can someone explain ${compact.toLowerCase()}`);
  }
  return uniqueStrings(results);
}

function buildSymptomQueriesFromSignals(signals = []) {
  const results = [];
  const normalizedSignals = Array.isArray(signals) ? signals : [];
  for (const signal of normalizedSignals) {
    const text = String(signal || '').toLowerCase();
    if (!text) {
      continue;
    }
    if (/lost inventory|missing units|missing inventory|warehouse losses|damaged stock/.test(text)) {
      results.push(
        'amazon received fewer units than shipped',
        'missing units amazon fba',
        'amazon lost inventory what do i do',
        'amazon warehouse lost my inventory',
        'amazon received 82 out of 100',
        'amazon lost 18 units',
        'am i missing inventory amazon',
        'where did my inventory go amazon',
        'amazon says received less than shipped',
        'amazon checked in fewer units'
      );
    }
    if (/fees|fba fees|incorrect fees|overcharging/.test(text)) {
      results.push(
        'why is my amazon profit low',
        'amazon fees too high',
        'fba fee error',
        'amazon overcharging fees',
        'is this normal amazon fba'
      );
    }
    if (/reimbursement/.test(text)) {
      results.push(
        'amazon reimbursement not received',
        'missing reimbursement amazon fba',
        'how does amazon reimbursement work',
        'is this normal amazon fba'
      );
    }
    if (/settlement|payout|payout numbers|payout mismatch/.test(text)) {
      results.push(
        'amazon payout lower than expected',
        'can someone explain settlement report',
        'amazon settlement report does not make sense',
        'amazon payout seems low',
        'anyone understand this settlement report'
      );
    }
    if (/profit|margin|money is leaking|margins dropped/.test(text)) {
      results.push(
        'why is my amazon profit low',
        'amazon margins dropped suddenly',
        'amazon sales good but profit low',
        'amazon payout seems low',
        'is this normal amazon fba'
      );
    }
  }
  return uniqueStrings(results);
}

async function buildSkillDecisionContext({
  objective = '',
  activeSkill = '',
  relevantSkill = '',
  skillContent = '',
  family = '',
} = {}) {
  const normalizedObjective = String(objective || '').toLowerCase();
  const catalog = await loadSkillCatalog().catch(() => []);
  const catalogById = new Map(catalog.map((item) => [item.id, item]));
  const chosenSkillIds = [];
  const explicitAmazonFocus = /\bamazon\b|\bfba\b|\breimbursement\b|\binventory\b|\bsettlement\b|\bfees?\b|\bprofit\b|\bmargins?\b/.test(normalizedObjective);
  const visibilityFocused = family === 'general_engagement'
    || /\b(comment|reply|engage|visibility|warm up|warm-up|like)\b/.test(normalizedObjective);
  const pureVisibilityEngagement = family === 'general_engagement'
    && visibilityFocused
    && !explicitAmazonFocus;

  function includeSkill(id) {
    const normalizedId = String(id || '').trim();
    if (!normalizedId || chosenSkillIds.includes(normalizedId) || !catalogById.has(normalizedId)) {
      return;
    }
    chosenSkillIds.push(normalizedId);
  }

  function includeInitialSkill(id) {
    const normalizedId = String(id || '').trim();
    if (!normalizedId) {
      return;
    }
    if (pureVisibilityEngagement && /^amazon_(hidden_money|expert)$/i.test(normalizedId)) {
      return;
    }
    includeSkill(normalizedId);
  }

  includeInitialSkill(activeSkill);
  includeInitialSkill(relevantSkill);

  const bestSkill = await findBestSkillForText(normalizedObjective, {
    catalog,
    minimumScore: 3,
  }).catch(() => null);
  if (!(pureVisibilityEngagement && /^amazon_(hidden_money|expert)$/i.test(String(bestSkill?.id || '')))) {
    includeSkill(bestSkill?.id);
  }

  const amazonFocused = explicitAmazonFocus
    || chosenSkillIds.includes('amazon_hidden_money')
    || chosenSkillIds.includes('amazon_expert');

  if (amazonFocused && !pureVisibilityEngagement) {
    includeSkill('amazon_hidden_money');
    includeSkill('amazon_expert');
  }

  if (visibilityFocused) {
    includeSkill('visibility_engagement');
  }

  const skills = [];
  for (const skillId of chosenSkillIds) {
    const catalogEntry = catalogById.get(skillId);
    let content = '';
    if (skillId === activeSkill && skillContent) {
      content = skillContent;
    } else if (catalogEntry?.filePath) {
      content = await fs.readFile(catalogEntry.filePath, 'utf8').catch(() => '');
    }
    skills.push({
      id: skillId,
      title: catalogEntry?.title || skillId,
      content,
      leadSignals: extractBulletItems(
        extractSection(content, 'Lead Signals')
        || extractSection(content, 'When To Escalate To Hidden Money Offer')
      ),
      searchThemes: extractBulletItems(extractSection(content, 'High-Value Search Themes')),
      goodLeadExamples: extractBulletItems(extractSection(content, 'Good Lead Examples')),
      weakSignals: extractBulletItems(
        extractSection(content, 'Weak Or Non-Lead Cases')
        || extractSection(content, 'What Not To Do')
        || extractSection(content, 'Avoid')
      ),
      focusAreas: extractBulletItems(extractSection(content, 'Focus Areas') || extractSection(content, 'Where To Engage')),
      commentTypes: uniqueStrings([
        ...extractSectionSubheadings(extractSection(content, 'Comment Types')),
        ...extractBulletItems(extractSection(content, 'Comment Types')),
      ]),
      commentRules: extractBulletItems(extractSection(content, 'Comment Rules') || extractSection(content, 'Rules')),
      toneRules: extractBulletItems(extractSection(content, 'Tone')),
      positioningRules: extractBulletItems(extractSection(content, 'Positioning')),
      escalationRules: extractBulletItems(extractSection(content, 'When To Escalate To Hidden Money Offer')),
      dmRules: extractBulletItems(extractSection(content, 'DM Rules')),
      dailyActivityRules: extractBulletItems(extractSection(content, 'Daily Activity') || extractSection(content, 'Timing Strategy')),
      goal: sentenceCase(extractSection(content, 'Goal') || extractSection(content, 'Purpose')),
      mission: sentenceCase(extractSection(content, 'Mission') || extractSection(content, 'Role')),
    });
  }

  const leadSignals = uniqueStrings(skills.flatMap((item) => item.leadSignals));
  const searchThemes = uniqueStrings(skills.flatMap((item) => item.searchThemes));
  const goodLeadExamples = uniqueStrings(skills.flatMap((item) => item.goodLeadExamples));
  const weakSignals = uniqueStrings(skills.flatMap((item) => item.weakSignals));
  const focusAreas = uniqueStrings(skills.flatMap((item) => item.focusAreas));
  const commentTypes = uniqueStrings(skills.flatMap((item) => item.commentTypes));
  const commentRules = uniqueStrings(skills.flatMap((item) => item.commentRules));
  const toneRules = uniqueStrings(skills.flatMap((item) => item.toneRules));
  const positioningRules = uniqueStrings(skills.flatMap((item) => item.positioningRules));
  const escalationRules = uniqueStrings(skills.flatMap((item) => item.escalationRules));
  const dmRules = uniqueStrings(skills.flatMap((item) => item.dmRules));
  const dailyActivityRules = uniqueStrings(skills.flatMap((item) => item.dailyActivityRules));
  const symptomQueries = buildSymptomQueriesFromSignals([
    ...leadSignals,
    ...focusAreas,
    ...positioningRules,
    ...escalationRules,
  ]);
  const naturalQueries = buildNaturalQuestionVariants(goodLeadExamples);

  return {
    activeSkillId: activeSkill || relevantSkill || chosenSkillIds[0] || '',
    loadedSkillIds: chosenSkillIds,
    loadedSkillTitles: skills.map((item) => item.title),
    searchThemes,
    symptomQueries,
    naturalQueries,
    leadSignals,
    weakSignals,
    focusAreas,
    commentTypes,
    commentRules,
    toneRules,
    positioningRules,
    escalationRules,
    dmRules,
    dailyActivityRules,
    goals: uniqueStrings(skills.map((item) => item.goal).filter(Boolean)),
    missions: uniqueStrings(skills.map((item) => item.mission).filter(Boolean)),
  };
}

function extractSearchTerms(text = '') {
  const stopWords = new Set([
    'about', 'our', 'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'your',
    'business', 'posts', 'post', 'find', 'related', 'reddit', 'group', 'groups', 'need',
    'somebody', 'maybe', 'looking', 'help', 'search', 'scan', 'show', 'give', 'lead', 'leads',
  ]);
  return uniqueStrings(
    (String(text || '').toLowerCase().match(/[a-z0-9]{3,}/gi) || [])
      .filter((term) => !stopWords.has(term))
  );
}

function buildHeuristicSearchPlan({
  objective = '',
  family = '',
  relevantSkill = '',
  topic = '',
  skillPolicy = null,
} = {}) {
  const normalized = String(objective || '').toLowerCase();
  const searchQueries = [];
  const mustMatchAny = [];
  const searchPasses = [];
  let intent = family === 'drafting' ? 'draft' : family === 'general_engagement' ? 'engage' : 'find_leads';
  let resolvedTopic = String(topic || '').trim();

  const isAmazonHiddenMoney =
    relevantSkill === 'amazon_hidden_money'
    || /amazon hidden money|reimbursement|settlement|lost inventory|missing inventory|fees?\s+too\s+high|low profit|margins?|fee errors?/i.test(normalized);

  if (isAmazonHiddenMoney) {
    resolvedTopic = resolvedTopic || 'Amazon seller money leaks and recovery pain points';
    intent = 'find_leads';
    searchQueries.push(
      'amazon reimbursement help',
      'amazon lost inventory',
      'amazon missing reimbursement',
      'amazon fees too high',
      'amazon low profit fba',
      'amazon settlement confusion',
      'amazon payout seems low',
      'amazon received 82 out of 100',
      'fba inventory reimbursement',
      'amazon margin problem'
    );
    mustMatchAny.push(
      'reimbursement',
      'reimbursements',
      'lost inventory',
      'missing inventory',
      'fees',
      'fee',
      'low profit',
      'profit',
      'margin',
      'settlement'
    );
  }

  if (/\blow profit\b|\bprofit\b|\bmargins?\b/.test(normalized)) {
    searchQueries.push('amazon low profit', 'amazon margin problem', 'fba low margins');
    mustMatchAny.push('low profit', 'profit', 'margin', 'margins');
  }

  if (/\breimburse/i.test(normalized)) {
    searchQueries.push('amazon reimbursement help', 'amazon reimbursement missing');
    mustMatchAny.push('reimbursement', 'reimbursements');
  }

  if (/\binventory\b/.test(normalized)) {
    searchQueries.push('amazon lost inventory', 'fba inventory reimbursement');
    mustMatchAny.push('inventory', 'lost inventory', 'missing inventory');
  }

  if (/\bfees?\b/.test(normalized)) {
    searchQueries.push('amazon fees too high', 'fba fee problem');
    mustMatchAny.push('fees', 'fee');
  }

  const exactQueries = uniqueStrings([
    ...(Array.isArray(skillPolicy?.searchThemes) ? skillPolicy.searchThemes : []),
    ...searchQueries,
  ]).slice(0, 6);
  const seededSymptomQueries = [];
  if (isAmazonHiddenMoney) {
    seededSymptomQueries.push(
      'amazon received 82 out of 100',
      'amazon payout seems low',
      'anyone understand this settlement report',
      'amazon says received less than shipped'
    );
  }
  seededSymptomQueries.push(...(Array.isArray(skillPolicy?.symptomQueries) ? skillPolicy.symptomQueries : []));
  const symptomQueries = uniqueStrings(seededSymptomQueries).slice(0, 6);
  const naturalQueries = uniqueStrings(
    Array.isArray(skillPolicy?.naturalQueries) ? skillPolicy.naturalQueries : []
  ).slice(0, 6);

  if (!searchQueries.length) {
    const terms = extractSearchTerms(objective);
    const compact = terms.slice(0, 5).join(' ');
    if (compact) {
      searchQueries.push(compact);
      mustMatchAny.push(...terms.slice(0, 6));
      resolvedTopic = resolvedTopic || compact;
    }
  }

  if (exactQueries.length) {
    searchPasses.push({ pass: 'exact_pain_terms', queries: exactQueries });
  }
  if (symptomQueries.length) {
    searchPasses.push({ pass: 'symptom_language', queries: symptomQueries });
  }
  if (naturalQueries.length) {
    searchPasses.push({ pass: 'seller_questions', queries: naturalQueries });
  }
  if (family === 'business_scan') {
    searchPasses.push({ pass: 'community_manual_exploration', queries: [] });
  }

  mustMatchAny.push(...(Array.isArray(skillPolicy?.leadSignals) ? skillPolicy.leadSignals : []));

  return {
    intent,
    topic: resolvedTopic || String(objective || '').trim(),
    searchQueries: interleaveUniqueLists([
      exactQueries,
      symptomQueries,
      naturalQueries,
      searchQueries,
    ], 12),
    searchPasses,
    mustMatchAny: uniqueStrings(mustMatchAny).slice(0, 18),
  };
}

async function interpretObjectiveForBrowser({
  objective,
  currentPlatform = 'facebook',
  currentSurface = '',
  relevantSkill = '',
  skillContent = '',
  family = '',
  topic = '',
} = {}, options = {}) {
  const normalizedObjective = String(objective || '').trim();
  const resolvedFamily = family || inferObjectiveFamily(normalizedObjective);
  const persona = await readPersonaProfile().catch(() => '');
  const insights = await readAgentInsights().catch(() => '');
  const workspace = await loadWorkspaceContext().catch(() => ({}));
  const skillPolicy = await buildSkillDecisionContext({
    objective: normalizedObjective,
    activeSkill: relevantSkill,
    relevantSkill,
    skillContent,
    family: resolvedFamily,
  }).catch(() => null);
  const heuristic = buildHeuristicSearchPlan({
    objective: normalizedObjective,
    family: resolvedFamily,
    relevantSkill,
    topic,
    skillPolicy,
  });

  if (options.disableModel) {
    return {
      objective: normalizedObjective,
      family: resolvedFamily,
      platform: currentPlatform,
      surface: currentSurface,
      relevantSkill,
      ...heuristic,
    };
  }

  const prompt = [
    'Interpret this operator request for a skill-driven browser operator before it touches the browser.',
    'Think like a business operator, not a command classifier.',
    'Translate the user meaning into a short browser-ready objective and search plan.',
    'Return JSON only like {"intent":"find_leads|search_posts|engage|draft","topic":"string","search_queries":["..."],"search_passes":[{"pass":"string","queries":["..."]}],"must_match_any":["..."],"family":"business_scan|general_engagement|drafting","relevant_skill":"string","reason":"string"}.',
    'Do not use the raw user sentence as the only search query unless it is already a good search query.',
    'If the skill is Amazon Hidden Money Recovery, expand it into seller pain-point queries like reimbursements, inventory loss, fees, low profit, and settlement confusion.',
    'Prefer short human phrasing and browser actions that can be executed immediately.',
    'If search results are weak, include manual exploration as a later pass instead of stopping early.',
    '',
    `Current platform: ${currentPlatform}`,
    `Current surface: ${currentSurface || 'unknown'}`,
    `Relevant skill: ${relevantSkill || 'none'}`,
    '',
    'AGENTS:',
    workspace.agents || 'No AGENTS.md provided.',
    '',
    'SOUL:',
    workspace.soul || 'No SOUL.md provided.',
    '',
    'Persona:',
    persona || 'No persona provided.',
    '',
    'Agent insights:',
    insights || 'No agent insights yet.',
    '',
    'Skill content:',
    skillContent || 'No skill content provided.',
    '',
    'Structured skill policy:',
    JSON.stringify(skillPolicy || {}, null, 2),
    '',
    'Objective:',
    normalizedObjective,
  ].join('\n');

  try {
    const raw = await callOllama(prompt, {
      ...options,
      timeoutMs: options.timeoutMs || 20_000,
      generationOptions: {
        temperature: 0.1,
        num_ctx: 3072,
        num_predict: 220,
        ...options.generationOptions,
      },
    });
    const parsed = parseRelaxedJsonObject(raw);
    if (parsed) {
      const searchQueries = uniqueStrings(Array.isArray(parsed.search_queries) ? parsed.search_queries : []);
      const mustMatchAny = uniqueStrings(Array.isArray(parsed.must_match_any) ? parsed.must_match_any : []);
      return {
        objective: normalizedObjective,
        family: ['business_scan', 'general_engagement', 'drafting'].includes(String(parsed.family || '').trim())
          ? String(parsed.family || '').trim()
          : resolvedFamily,
        platform: currentPlatform,
        surface: currentSurface,
        intent: String(parsed.intent || '').trim() || heuristic.intent,
        topic: String(parsed.topic || '').trim() || heuristic.topic,
        relevantSkill: String(parsed.relevant_skill || '').trim() || relevantSkill,
        searchQueries: searchQueries.length ? searchQueries : heuristic.searchQueries,
        searchPasses: Array.isArray(parsed.search_passes) && parsed.search_passes.length
          ? parsed.search_passes
          : heuristic.searchPasses,
        mustMatchAny: mustMatchAny.length ? mustMatchAny : heuristic.mustMatchAny,
        reason: String(parsed.reason || '').trim(),
        skillPolicy,
      };
    }
  } catch (_error) {
    // Fall back to the heuristic plan below.
  }

  return {
    objective: normalizedObjective,
    family: resolvedFamily,
    platform: currentPlatform,
    surface: currentSurface,
    relevantSkill,
    ...heuristic,
    reason: 'heuristic_search_plan',
    skillPolicy,
  };
}

async function planObjective({
  objective,
  context = {},
}, options = {}) {
  const persona = await readPersonaProfile().catch(() => '');
  const workspace = await loadWorkspaceContext().catch(() => ({}));
  const knownSkills = await listAvailableSkills().catch(() => []);
  const knownSkillCatalog = await loadSkillCatalog().catch(() => []);
  const knownSkillIds = knownSkills.map((item) => item.id);
  const skillSummaries = knownSkillCatalog
    .slice(0, 20)
    .map((skill) => `- ${skill.id}: ${skill.title}${skill.goal ? ` | ${skill.goal.replace(/\s+/g, ' ').slice(0, 180)}` : ''}`)
    .join('\n');
  const prompt = [
    'Create a short execution plan for a skill-driven browser operator.',
    'Treat the user request as a top-level objective.',
    'Classify the objective into one family: business_scan, general_engagement, or drafting.',
    'Return JSON only like {"objective":"string","family":"business_scan|general_engagement|drafting","steps":["...","..."],"mode":"business|general","needs_skill":true|false,"topic":"string","relevant_skill":"string","needs_new_skill":true|false}.',
    'Make the steps specific, action-first, and browser-executable.',
    'Use skill policy and observed browser state as the decision basis, not rigid intent labels.',
    'Draft actions must end in publish immediately after approval, not another draft loop.',
    '',
    'AGENTS:',
    workspace.agents || 'No AGENTS.md provided.',
    '',
    'SOUL:',
    workspace.soul || 'No SOUL.md provided.',
    '',
    'Persona:',
    persona || 'No persona provided.',
    '',
    'Known skills:',
    skillSummaries || (knownSkillIds.length ? knownSkillIds.join(', ') : 'none'),
    '',
    'Context:',
    JSON.stringify(context, null, 2),
    '',
    'Objective:',
    objective,
  ].join('\n');

  try {
    const raw = await callOllama(prompt, {
      ...options,
      timeoutMs: options.timeoutMs || 20_000,
      generationOptions: {
        temperature: 0.1,
        num_ctx: 2048,
        num_predict: 180,
        ...options.generationOptions,
      },
    });
    const parsed = parseRelaxedJsonObject(raw);
    if (parsed?.objective) {
      const relevantSkill = String(parsed.relevant_skill || '').trim();
      const skillByTopic = parsed.topic
        ? await findSkillByTopic(String(parsed.topic || '').trim()).catch(() => null)
        : null;
      const normalizedRelevantSkill = knownSkillIds.includes(relevantSkill)
        ? relevantSkill
        : (skillByTopic?.id && knownSkillIds.includes(skillByTopic.id) ? skillByTopic.id : '');
      return {
        objective: String(parsed.objective || objective).trim(),
        family: ['business_scan', 'general_engagement', 'drafting'].includes(String(parsed.family || '').trim())
          ? String(parsed.family || '').trim()
          : inferObjectiveFamily(parsed.objective || objective),
        steps: Array.isArray(parsed.steps) ? parsed.steps.map((step) => String(step).trim()).filter(Boolean) : [],
        mode: String(parsed.mode || '').trim() || 'general',
        needsSkill: Boolean(parsed.needs_skill),
        topic: String(parsed.topic || '').trim(),
        relevantSkill: normalizedRelevantSkill,
        needsNewSkill: Boolean(parsed.needs_new_skill) && !normalizedRelevantSkill,
      };
    }
  } catch (_error) {
    // Fall through to heuristic plan.
  }

  const normalizedObjective = String(objective || '');
  const needsSkill = /amazon|fba|seller|fees|reimbursement|settlement|inventory|profit/i.test(normalizedObjective);
  let relevantSkill = '';
  const learnedSkill = await findBestSkillForText(normalizedObjective).catch(() => null);
  if (learnedSkill?.id && knownSkillIds.includes(learnedSkill.id)) {
    relevantSkill = learnedSkill.id;
  } else if (/amazon hidden money|reimbursement|settlement|inventory|fees|profit/i.test(normalizedObjective) && knownSkillIds.includes('amazon_hidden_money')) {
    relevantSkill = 'amazon_hidden_money';
  } else if (/amazon|fba|seller/i.test(normalizedObjective) && knownSkillIds.includes('amazon_expert')) {
    relevantSkill = 'amazon_expert';
  } else if (/website|web|landing page/i.test(normalizedObjective) && knownSkillIds.includes('web_dev')) {
    relevantSkill = 'web_dev';
  }
  const fallbackTopicMatch = normalizedObjective.match(/\b(uber|driving|car detailing|detailing|real estate|shopify|walmart|ebay|airbnb)\b/i);
  const fallbackTopic = fallbackTopicMatch ? String(fallbackTopicMatch[1] || '').trim() : '';
  const family = inferObjectiveFamily(normalizedObjective);
  return {
    objective: String(objective || '').trim(),
    family,
    steps: buildObjectiveChecklist(family, normalizedObjective),
    mode: needsSkill ? 'business' : 'general',
    needsSkill,
    topic: relevantSkill ? '' : fallbackTopic,
    relevantSkill,
    needsNewSkill: Boolean(fallbackTopic) && !relevantSkill,
  };
}

async function classifyPostForEngagement({
  skill,
  postContent = '',
}, options = {}) {
  const normalized = String(postContent || '').trim();
  if (!normalized) {
    return {
      category: 'GENERAL',
      tone: 'friendly, concise, human',
      persona: 'polite high-value human',
      guidance: 'Keep it light and natural.',
    };
  }

  const heuristicCategory = (() => {
    if (/\?/.test(normalized) || /\bhow|what|why|where|when|does|can|should|help\b/i.test(normalized)) {
      return 'QUESTION';
    }
    if (/\bissue|problem|stuck|lost|missing|reimbursement|settlement|fees|low profit|margin|damaged|error|suspend|wrong\b/i.test(normalized)) {
      return 'PROBLEM';
    }
    if (/\bwon|launched|finally|hit|reached|grew|success|approved|celebrating|happy to share\b/i.test(normalized)) {
      return 'CELEBRATION';
    }
    if (/\bupdate|news|sharing|status|progress\b/i.test(normalized)) {
      return 'GENERAL';
    }
    return 'GENERAL';
  })();

  const prompt = [
    'Categorize this Facebook post for comment strategy.',
    'Return JSON only like {"category":"CELEBRATION|PROBLEM|QUESTION|GENERAL","tone":"string","persona":"string","guidance":"string"}.',
    'Rules:',
    '- If the post is about Amazon/FBA seller pain, category should usually be "PROBLEM" or "QUESTION".',
    '- If the post is a win, launch, approval, or growth milestone, use "CELEBRATION".',
    '- If the post is mixed or neutral, use "GENERAL".',
    '- If it is general and not tied to a known business skill, use persona "polite high-value human".',
    '- Avoid robotic language.',
    '',
    'Skill context:',
    skill?.content || 'No skill context.',
    '',
    'Post:',
    normalized,
  ].join('\n');

  try {
    const raw = await callOllama(prompt, {
      ...options,
      timeoutMs: options.timeoutMs || 20_000,
      generationOptions: {
        temperature: 0.1,
        num_ctx: 2048,
        num_predict: 160,
        ...options.generationOptions,
      },
    });
    const parsed = parseRelaxedJsonObject(raw);
    if (parsed?.category) {
      return {
        category: String(parsed.category || '').trim().toUpperCase() || 'GENERAL',
        tone: String(parsed.tone || '').trim() || 'friendly, concise, human',
        persona: String(parsed.persona || '').trim() || 'polite high-value human',
        guidance: String(parsed.guidance || '').trim() || 'Keep it natural and useful.',
      };
    }
  } catch (_error) {
    // Fall back to heuristics below.
  }

  if (heuristicCategory === 'PROBLEM') {
    return {
      category: 'PROBLEM',
      tone: 'helpful, specific, experienced, human',
      persona: /amazon|fba|seller|settlement|fee|inventory|reimbursement/i.test(normalized)
        ? 'amazon hidden money operator'
        : 'polite high-value human',
      guidance: 'Offer one concrete tip and a light next step.',
    };
  }

  if (heuristicCategory === 'CELEBRATION') {
    return {
      category: 'CELEBRATION',
      tone: 'warm, congratulatory, genuine, human',
      persona: 'polite high-value human',
      guidance: 'Acknowledge the win and encourage them naturally.',
    };
  }

  if (heuristicCategory === 'QUESTION') {
    return {
      category: 'QUESTION',
      tone: 'helpful, direct, accurate, human',
      persona: /amazon|fba|seller|settlement|fee|inventory|reimbursement/i.test(normalized)
        ? 'amazon hidden money operator'
        : 'polite high-value human',
      guidance: 'Answer clearly and simply. If relevant, use skill knowledge.',
    };
  }

  return {
    category: heuristicCategory || 'GENERAL',
    tone: 'friendly, supportive, human',
    persona: 'polite high-value human',
    guidance: 'Keep it positive and not salesy.',
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

async function decideNextDomAction({
  url,
  goal,
  memory = '',
  snapshot,
  pageState = 'generic_page',
  lastError = '',
}, options = {}) {
  const prompt = [
    `You are a Business Growth Agent. You are currently on ${url}.`,
    `Current page state: ${pageState}.`,
    `Your Goal: ${goal}.`,
    'Your Memory:',
    memory || 'No extra memory provided.',
    lastError ? `Previous action error: ${lastError}` : '',
    '',
    'Based on this simplified DOM snapshot, what is the next best single step?',
    'Respond ONLY in JSON:',
    '{',
    '  "thought": "brief internal observation",',
    '  "action": "type" | "click" | "scroll" | "wait" | "check" | "complete",',
    '  "id": "element_id or empty for scroll/wait/complete",',
    '  "value": "text to type or scroll/wait amount if applicable",',
    '  "reasoning": "why this helps"',
    '}',
    '',
    'Rules:',
    '- Use only element ids that exist in the snapshot.',
    '- If the page already satisfies the goal, return action=complete.',
    '- If a checkbox/rule agreement is needed, use action=check.',
    '- If text must be entered, use action=type with a short business-appropriate answer.',
    '- Keep answers honest and aligned with the memory/skill.',
    '- If the goal is to scan a group and posts are already visible in snapshot.posts, return action=complete.',
    '- If the goal is to engage with a post and a comment button or textbox is visible, choose the relevant click or type step.',
    '',
    'DOM snapshot JSON:',
    JSON.stringify(snapshot, null, 2),
  ].filter(Boolean).join('\n');

  const raw = await callOllama(prompt, {
    ...options,
    model: options.model || DOM_REASONER_MODEL,
    timeoutMs: options.timeoutMs || 30_000,
    generationOptions: {
      temperature: 0.1,
      num_ctx: 4096,
      num_predict: 220,
      ...options.generationOptions,
    },
  });

  let parsed = parseRelaxedJsonObject(raw);
  if (!parsed) {
    parsed = await repairJsonObjectResponse(
      raw,
      '{ "thought": "string", "action": "type|click|scroll|wait|check|complete", "id": "string", "value": "string", "reasoning": "string" }',
      {
        model: options.model || DOM_REASONER_MODEL,
        timeoutMs: 15_000,
      }
    );
  }
  if (!parsed) {
    throw new Error('DOM reasoner returned no valid JSON.');
  }
  return {
    thought: String(parsed.thought || '').trim(),
    action: String(parsed.action || '').trim().toLowerCase(),
    id: String(parsed.id || '').trim(),
    value: parsed.value == null ? '' : String(parsed.value),
    reasoning: String(parsed.reasoning || '').trim(),
  };
}

module.exports = {
  AGENT_INSIGHTS_PATH,
  DEFAULT_MODEL_PROVIDER,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_TIMEOUT_MS,
  DEFAULT_OLLAMA_URL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENAI_URL,
  DOM_REASONER_MODEL,
  LEAD_QUALIFIER_MODEL,
  MORNING_BRIEFING_MODEL,
  SKILLS_DIR,
  appendAgentInsights,
  buildSkillDecisionContext,
  callOllama,
  planObjective,
  interpretObjectiveForBrowser,
  readPersonaProfile,
  readSkillFeedback,
  determineNextPhase,
  detectHighValueLead,
  decideNextDomAction,
  draftReply,
  classifyPostForEngagement,
  ensureMemoryFile,
  emitHighValueLeadAlert,
  extractManualFallbacks,
  extractPhasesFromSkill,
  getThreadState,
  inferPhaseFromUserReply,
  getModelRuntimeConfig,
  listAvailableSkills,
  loadSkill,
  buildObjectiveChecklist,
  inferObjectiveFamily,
  readAgentInsights,
  resolveSkillForTask,
  setModelRuntimeConfig,
  scorePostAgainstSkill,
  summarizeDiscussion,
};
