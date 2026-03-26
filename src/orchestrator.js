'use strict';

require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const readline = require('node:readline/promises');

const {
  AGENT_INSIGHTS_PATH,
  appendAgentInsights,
  callOllama,
  classifyPostForEngagement,
  decideNextDomAction,
  DEFAULT_MODEL_PROVIDER,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OPENAI_MODEL,
  draftReply,
  getModelRuntimeConfig,
  MORNING_BRIEFING_MODEL,
  ensureMemoryFile,
  planObjective,
  readAgentInsights,
  resolveSkillForTask,
  setModelRuntimeConfig,
  summarizeDiscussion,
  scorePostAgainstSkill,
} = require('./brain');
const {
  saveNewSkill,
} = require('./filesystem');
const {
  createBrowserLock,
  runQueuedJobs,
} = require('./agent/runtime');
const {
  ensureWorkspaceDocs,
  loadWorkspaceContext,
} = require('./workspace');
const {
  startOperatorConsole,
} = require('./agent/operator_console');
const {
  anchorVisiblePost,
  DEFAULT_TASK_INPUT_PATH,
  clickLike,
  clickLikeOnVisiblePost,
  commentAnchoredPost,
  closeBrowser,
  createFeedPost,
  createNewPost,
  discoverGroups,
  ensureLoggedIn,
  executeAgentAction,
  extractAnchoredPostData,
  extractPostIdFromUrl,
  extractGroupIdFromUrl,
  getSimplifiedDOM,
  handleJoinGroup,
  humanJitter,
  inspectRedditSession,
  inspectGroupActivity,
  inspectGroupMembershipStatus,
  isCreatePostComposerVisible,
  isCanonicalGroupUrl,
  isLikelyGroupName,
  launchBrowser,
  likeAnchoredPost,
  listVisibleGroups,
  listVisibleNotifications,
  listVisiblePosts,
  listVisibleRedditPosts,
  markNotificationsRead,
  postComment,
  postCommentOnVisiblePost,
  readTaskInput,
  classifyPageState,
  searchRedditPosts,
  scrapeGroupFeed,
  scrapeInboxPreviews,
  scrapeJoinApprovalNotifications,
  scrapeJoinedGroups,
  scrapeNotifications,
  sendInboxReply,
  visitGroup,
  visitRedditHome,
  visitSubreddit,
} = require('./browser');
const {
  appendThreadHistory,
  clearJobs,
  closeDatabase,
  completeJob,
  connectDatabase,
  enqueueUniqueJob,
  failJob,
  findGroupByName,
  findLeadByPostId,
  findPostById,
  getAgentState,
  getCollections,
  getContextMemory,
  getDiscoveredGroups,
  getLeadsByInteractionResult,
  getGroupsByStatus,
  getInteractionCountsSince,
  getJobsByStatus,
  hasInteraction,
  leaseNextJob,
  logInteraction,
  markPostStatus,
  releaseExpiredJobs,
  saveDiscoveredGroups,
  setupCollections,
  upsertAgentState,
  updateDiscoveredGroupStatus,
  updateLeadInteractionResult,
  updateLeadStatus,
  updateGroupLastScanned,
  updateContextPhase,
  updatePostScore,
  upsertLead,
  upsertContextMemory,
  upsertPost,
} = require('./database');

const FACEBOOK_BASE_URL = 'https://www.facebook.com';
const DEFAULT_SESSION_LIMITS = {
  comments: 10,
  likes: 20,
  posts: 5,
};
const KEY_TRIGGER_PATTERNS = [
  /\blost inventory\b/i,
  /\bmissing inventory\b/i,
  /\bhigh fees\b/i,
  /\bfba fees?\b/i,
  /\bprofit\b/i,
  /\bmargin\b/i,
  /\bsettlement\b/i,
  /\breimbursement\b/i,
];
const DEFAULT_OUTBOUND_POSTS = [
  'A lot of Amazon sellers lose money through missed reimbursements, fee errors, and inventory issues without noticing it in their settlement reports.',
  'If your Amazon margins feel tighter than they should, it is worth checking for hidden FBA fees, return losses, and unrecovered inventory.',
  'Settlement reports often hide the exact places money leaks out of an Amazon account. A quick audit usually reveals something useful.',
  'Private label sellers doing solid revenue can still miss recoveries from lost inventory and incorrect fee charges.',
  'Most Amazon sellers watch sales closely but do not review settlements deeply enough to catch hidden losses and reimbursement gaps.',
];
const HOUSEKEEPING_INTERVAL_MS = 3 * 60 * 60 * 1000;
const MAX_GROUPS_PER_SCAN = Number(process.env.MAX_GROUPS_PER_SCAN || 8);
const MAX_ACTIVITY_AGE_HOURS = Number(process.env.MAX_ACTIVITY_AGE_HOURS || 24 * 14);
const JOB_TYPES = {
  HOUSEKEEPING: 'housekeeping',
  SYNC_GROUPS: 'sync_groups',
  VERIFY_PENDING: 'verify_pending',
  SCAN_GROUPS: 'scan_groups',
  ENGAGE: 'engage',
  REPLY: 'reply',
  SEARCH_GROUPS: 'search_groups',
  BRIEF: 'brief',
};
const STALL_TIMEOUT_MS = 120_000;
const TRACE_LOG_DIR = path.join(__dirname, '..', 'logs', 'traces');

function isLikelyEnglishGroupName(name = '') {
  return /^[\x00-\x7F\s.,&()'"/|:+-]+$/.test(name);
}

function isRelevantAmazonGroupName(name = '') {
  const text = name.toLowerCase();
  const strongSignals = /(amazon|fba|amz|private label|wholesale|ppc|seller|brand builders?|reimbursement|inventory|settlement)/i;
  const weakOrOffTarget = /(crypto|forex|loan|dating|casino|review(?:ers?| group)?|buyer\b|buyers\b|buyer group|seller & buyer|buyer & seller|virtual assistant|\bva\b|chinese|🇨🇳|ksa|uae|walmart|ebay|suspension|legal issues?|certification|passion\b|reviewers community|support\s*&\s*virtual|amazon chinese)/i;
  const requiresExtraSignal = /(support|community|group|help|seller)/i;

  if (!strongSignals.test(text)) {
    return false;
  }

  if (weakOrOffTarget.test(text)) {
    if (!/(fba|private label|ppc|wholesale|reimbursement|inventory|settlement)/i.test(text)) {
      return false;
    }
  }

  if (requiresExtraSignal.test(text) && !/(amazon|fba|amz|private label|ppc|wholesale)/i.test(text)) {
    return false;
  }

  return true;
}

function matchesTargetGroupHints(name = '', taskInput = {}) {
  const targets = Array.isArray(taskInput.target_groups) ? taskInput.target_groups : [];
  if (!targets.length) {
    return true;
  }

  const normalizedName = name.toLowerCase();

  return targets.some((target) => {
    const normalizedTarget = String(target).toLowerCase();
    const tokens = normalizedTarget.split(/\s+/).filter((token) => token.length > 2);
    return tokens.some((token) => normalizedName.includes(token));
  });
}

function getStartOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function extractGroupId(url = '') {
  const match = url.match(/\/groups\/([^/?]+)/i);
  return match ? match[1] : null;
}

function normalizeGroupEntry(groupEntry) {
  if (!groupEntry) {
    return null;
  }

  if (typeof groupEntry === 'string') {
    const isUrl = /^https?:\/\//i.test(groupEntry);
    return {
      id: isUrl ? extractGroupId(groupEntry) : null,
      url: isUrl ? groupEntry : null,
      label: groupEntry,
      keyword: isUrl ? null : groupEntry,
    };
  }

  return {
    id: groupEntry.id || extractGroupId(groupEntry.url),
    url: groupEntry.url,
    label: groupEntry.name || groupEntry.url,
    keyword: groupEntry.keyword || null,
  };
}

function buildGoalSummary(taskInput) {
  const dailyTasks = taskInput.daily_tasks || [];
  if (dailyTasks.length) {
    return dailyTasks
      .map((task) => `${task.name}: ${task.intent || 'No intent provided.'}`)
      .join(' | ');
  }

  const triggers = taskInput.triggers || [];
  if (triggers.length) {
    return `Find posts mentioning: ${triggers.join(', ')}`;
  }

  return 'No daily task description provided.';
}

function buildTriggerPatterns(taskInput) {
  const configuredTriggers = Array.isArray(taskInput.triggers) ? taskInput.triggers : [];
  if (!configuredTriggers.length) {
    return KEY_TRIGGER_PATTERNS;
  }

  return configuredTriggers.map((trigger) => {
    const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'i');
  });
}

function createSessionState(existingCounts = {}) {
  return {
    likes: existingCounts.like || 0,
    comments: existingCounts.comment || 0,
    posts: existingCounts.personal_post || 0,
    replies: existingCounts.reply || 0,
    limits: { ...DEFAULT_SESSION_LIMITS },
    scrapedPosts: 0,
    scoredPosts: 0,
    eligiblePosts: 0,
    triggerMatches: 0,
    skippedDuplicates: 0,
    joinRequests: 0,
    groupsVisited: [],
    errors: [],
    scanResults: [],
    resolvedGroups: [],
    briefing: {
      notifications: [],
      inboxPreviews: [],
      summary: '',
    },
    lastInsightDate: null,
    operatorContext: {
      executionMode: 'confirm',
      currentGroup: null,
      lastListedGroups: [],
      lastPosts: [],
      lastNotifications: [],
      lastDraft: null,
    },
    workspaceContext: null,
  };
}

function canPerformAction(state, type) {
  if (type === 'like') {
    return state.likes < state.limits.likes;
  }

  if (type === 'comment') {
    return state.comments < state.limits.comments;
  }

  if (type === 'personal_post') {
    return state.posts < state.limits.posts;
  }

  return true;
}

function looksLikePotentialLeadPost(text = '') {
  const normalized = String(text).toLowerCase();
  return /amazon|fba|seller|inventory|shipment|warehouse|fee|fees|profit|margin|settlement|reimbursement|refund|negative balance|payout|damaged|lost/i.test(
    normalized
  );
}

async function selectModelProviderOnStart() {
  if (!process.stdin.isTTY || process.env.MODEL_SELECTION_ON_START === 'false') {
    return getModelRuntimeConfig();
  }

  const current = getModelRuntimeConfig();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const providerAnswer = await rl.question(
      `Select model provider: [1] Ollama (default) [2] OpenAI [enter=${current.provider || DEFAULT_MODEL_PROVIDER}]: `
    );
    const providerChoice = providerAnswer.trim();
    let provider = current.provider || DEFAULT_MODEL_PROVIDER;

    if (providerChoice === '1') {
      provider = 'ollama';
    } else if (providerChoice === '2') {
      provider = 'openai';
    } else if (/^openai$/i.test(providerChoice)) {
      provider = 'openai';
    } else if (/^ollama$/i.test(providerChoice)) {
      provider = 'ollama';
    }

    let model = null;

    if (provider === 'openai') {
      const openAiAnswer = await rl.question(
        `Select OpenAI model: [1] gpt-5-mini (recommended) [2] gpt-5 [enter=${DEFAULT_OPENAI_MODEL}]: `
      );
      const choice = openAiAnswer.trim();
      model = choice === '2' ? 'gpt-5' : choice === '1' ? 'gpt-5-mini' : (choice || DEFAULT_OPENAI_MODEL);

      if (!process.env.OPENAI_API_KEY) {
        console.log('OPENAI_API_KEY is not set. Falling back to Ollama for this session.');
        provider = 'ollama';
        model = DEFAULT_OLLAMA_MODEL;
      }
    } else {
      const ollamaAnswer = await rl.question(
        `Select Ollama model [enter=${DEFAULT_OLLAMA_MODEL}]: `
      );
      model = ollamaAnswer.trim() || DEFAULT_OLLAMA_MODEL;
    }

    const resolved = setModelRuntimeConfig({ provider, model });
    console.log(`Model runtime: ${resolved.provider}/${resolved.model}`);
    return resolved;
  } finally {
    rl.close();
  }
}

async function answerJoinQuestionsFactory(skill) {
  return async function answerJoinQuestions(questionEntries = []) {
    if (!questionEntries.length) {
      return { answers: [], optionHints: [] };
    }

    const fallbackAnswers = questionEntries.map((entry) => {
      const question = entry.questionText || '';
      const fallback = (skill.manualFallbacks || []).find((item) =>
        question.toLowerCase().includes(item.question.toLowerCase())
      );
      return fallback
        ? fallback.answer
        : 'I work with Amazon sellers and would love to contribute and learn from the community.';
    });
    const answers = [];
    const usedAnswers = new Set();

    for (let index = 0; index < questionEntries.length; index += 1) {
      const entry = questionEntries[index];
      const question = entry.questionText || '';

      if (/checkbox/i.test(entry.fieldType || '') && /agree|rules|spam|policy/i.test(question)) {
        answers.push('AGREE_CHECKBOX');
        continue;
      }

      const makePrompt = (avoidText = '') => [
        'You are applying to join a professional Facebook group for Amazon Sellers.',
        `QUESTION: "${question}"`,
        `MY BUSINESS SKILL: ${skill.content}`,
        '',
        'TASK: Write a short (1-sentence), professional, and honest answer based on the skill file.',
        "- If they ask about revenue, use the '$10k-$50k' range.",
        '- If they ask why I want to join, mention networking and fee management.',
        `- DO NOT use generic AI phrases like 'As an AI...' or 'I would like to...'.`,
        '- Sound like a real busy entrepreneur.',
        avoidText ? `- Do not reuse this sentence: "${avoidText}"` : '',
      ].filter(Boolean).join('\n');

      let answer = fallbackAnswers[index];

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const raw = await callOllama(makePrompt(attempt === 1 ? answer : ''), {
            model: MORNING_BRIEFING_MODEL,
            timeoutMs: 30_000,
            generationOptions: {
              temperature: 0.3,
              num_ctx: 2048,
              num_predict: 80,
            },
          });

          const candidate = raw.replace(/^["']|["']$/g, '').trim();
          if (candidate && !usedAnswers.has(candidate)) {
            answer = candidate;
            break;
          }
        } catch (_error) {
          // Fall back below.
        }
      }

      if (usedAnswers.has(answer)) {
        answer = `${answer} Focused on Amazon fee control and seller networking.`;
      }

      usedAnswers.add(answer);
      answers.push(answer);
    }

    return {
      answers,
      optionHints: questionEntries.map((entry) =>
        /checkbox/i.test(entry.fieldType || '') && /agree|rules|spam|policy/i.test(entry.questionText || '')
          ? 'yes'
          : ''
      ),
    };
  };
}

async function runPerceiveReasonActLoop(page, {
  goal,
  skill,
  workspaceContext = null,
  maxSteps = 8,
  onStall = null,
}) {
  let traceStarted = false;
  const tracePath = path.join(
    TRACE_LOG_DIR,
    `pra_${new Date().toISOString().replace(/[:.]/g, '-')}.zip`
  );
  const insights = await readAgentInsights().catch(() => '');
  const memorySections = [
    skill?.content || '',
    insights || '',
    workspaceContext?.persona || '',
    workspaceContext?.memory || '',
    workspaceContext?.user || '',
    workspaceContext?.agents || '',
  ].filter(Boolean);
  let lastError = '';
  let lastUrl = page.url();
  let lastProgressAt = Date.now();
  let hintNote = '';

  try {
    await fs.mkdir(TRACE_LOG_DIR, { recursive: true });
    if (page.context().tracing && typeof page.context().tracing.start === 'function') {
      await page.context().tracing.start({ screenshots: true, snapshots: true });
      traceStarted = true;
    }
  } catch (_error) {
    traceStarted = false;
  }

  try {
    for (let step = 1; step <= maxSteps; step += 1) {
      const snapshot = await getSimplifiedDOM(page, { maxElements: 80 });
      const pageState = classifyPageState(snapshot);
      const now = Date.now();

      if (/find and extract text from all posts in this group/i.test(goal) && Array.isArray(snapshot.posts) && snapshot.posts.length > 0) {
        return {
          success: true,
          completed: true,
          steps: step,
          lastThought: 'Visible posts already present in the current group snapshot.',
        };
      }

      if (page.url() !== lastUrl) {
        lastUrl = page.url();
        lastProgressAt = now;
      }

      if (now - lastProgressAt > STALL_TIMEOUT_MS && typeof onStall === 'function') {
        const stallResult = await onStall({
          page,
          snapshot,
          goal,
          step,
          lastError,
        });
        if (stallResult?.handled) {
          lastProgressAt = Date.now();
          hintNote = stallResult.hint ? `Operator hint: ${stallResult.hint}` : '';
          lastError = hintNote || '';
          continue;
        }
      }

      let nextStep;
      try {
        nextStep = await decideNextDomAction({
          url: page.url(),
          goal,
          memory: memorySections.join('\n\n'),
          snapshot,
          pageState,
          lastError: [lastError, hintNote].filter(Boolean).join('\n'),
        });
      } catch (error) {
        lastError = error.message;
        break;
      }

      if (nextStep.action === 'complete') {
        return {
          success: true,
          completed: true,
          steps: step,
          lastThought: nextStep.thought,
        };
      }

      try {
        await executeAgentAction(page, nextStep);
        await page.waitForTimeout(1000);
        lastError = '';
        lastProgressAt = Date.now();
      } catch (error) {
        lastError = error.message;
        continue;
      }
    }

    return {
      success: false,
      completed: false,
      error: lastError || 'Reasoning loop reached the maximum number of steps.',
      tracePath: traceStarted ? tracePath : null,
    };
  } finally {
    if (traceStarted) {
      try {
        const shouldPersist = Boolean(process.env.TRACE_AGENT_LOOPS) || Boolean(lastError);
        await page.context().tracing.stop(shouldPersist ? { path: tracePath } : {});
      } catch (_error) {
        // Ignore tracing shutdown issues.
      }
    }
  }
}

async function appendRecoveryLesson(hint, metadata = {}) {
  const entry = [
    '',
    '# RECOVERY LESSONS',
    `- ${new Date().toISOString()}: Hint="${hint}" | Goal="${metadata.goal || ''}" | Step=${metadata.step || ''} | Error="${metadata.lastError || ''}" | Screenshot="${metadata.screenshotPath || ''}"`,
  ].join('\n');
  await appendAgentInsights(entry);
}

function normalizePostUrl(url = '') {
  if (!url) {
    return '';
  }

  return url.startsWith('http') ? url : `${FACEBOOK_BASE_URL}${url}`;
}

async function extractLeadPostsFromCurrentPage(page, groupLabel, skill, state, topic = '') {
  const visiblePosts = await listVisiblePosts(page, { limit: 12, scrollRounds: 1, validationMode: 'business' });
  const posts = visiblePosts.map((post) => ({
    visible_index: post.visibleIndex,
    post_id: post.postId,
    author: post.authorName || 'Unknown',
    text: post.postText,
    post_url: post.postUrl,
    timestamp: post.timestampText || '',
  }));
  const filteredByTopic = await filterPostsByRequestedTopic(posts, topic, skill);
  const aiCandidates = filteredByTopic.slice(0, 12);
  const found = [];

  for (const post of aiCandidates) {
    const normalizedText = String(post.text || '').replace(/\s+/g, ' ').trim();
    if (
      !normalizedText ||
      (/\b(i'?m interested|interested|dm me|inbox me|available let'?s connect|available let's connect)\b/i.test(normalizedText) && normalizedText.length < 160) ||
      /\blike\s+reply\b/i.test(normalizedText)
    ) {
      continue;
    }

    const stablePostId = post.post_id || extractPostIdFromUrl(normalizePostUrl(post.post_url)) || `visible-post-${post.visible_index}`;
    const storedPost = await upsertPost({
      post_id: stablePostId,
      group: groupLabel,
      post_url: normalizePostUrl(post.post_url),
      content: normalizedText,
      author: post.author || 'Unknown',
      status: 'pending',
    });

    const scoreResult = await scorePostAgainstSkill(
      {
        post_id: storedPost.post_id,
        group: storedPost.group,
        author: storedPost.author,
        content: storedPost.content,
      },
      skill
    );

    state.scoredPosts += 1;
    const status = scoreResult.shouldInteract ? 'qualified' : 'ignored';
    await updatePostScore(storedPost.post_id, scoreResult.score, status);

    if (scoreResult.shouldInteract) {
      await upsertLead({
        post_id: storedPost.post_id,
        group: storedPost.group,
        content: storedPost.content,
        author: storedPost.author,
        category: scoreResult.category,
        confidence: scoreResult.confidence,
        reason: scoreResult.reason,
        status: 'New',
      });
      found.push({
        ...storedPost,
        post_url: normalizePostUrl(post.post_url),
        relevance_score: scoreResult.score,
        visible_index: post.visible_index,
      });
    }
  }

  return found;
}

async function filterPostsByRequestedTopic(posts = [], topic = '', skill) {
  if (!topic || !posts.length) {
    return posts;
  }

  const prompt = [
    'Select which visible Facebook posts match this business goal.',
    `GOAL: ${topic}`,
    'Use the skill context when judging relevance.',
    skill.content,
    '',
    'Return JSON only like {"keep_indexes":[1,3]}',
    JSON.stringify(
      posts.slice(0, 20).map((post, index) => ({
        index: index + 1,
        author: post.author,
        text: post.text.slice(0, 300),
      })),
      null,
      2
    ),
  ].join('\n');

  try {
    const raw = await callOllama(prompt, {
      model: MORNING_BRIEFING_MODEL,
      timeoutMs: 20_000,
      generationOptions: {
        temperature: 0.1,
        num_ctx: 2048,
        num_predict: 120,
      },
    });
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0].replace(/'/g, '"')) : null;
    const keep = new Set(Array.isArray(parsed?.keep_indexes) ? parsed.keep_indexes.map(Number) : []);
    return keep.size ? posts.filter((_post, index) => keep.has(index + 1)) : posts;
  } catch (_error) {
    return posts;
  }
}

async function scanGroupWithReasoningLoop(page, group, skill, state, options = {}) {
  console.log(`Opening group: ${group.label}`);
  await visitGroup(page, group.url);
  state.groupsVisited.push(group.label);

  await updateDiscoveredGroupStatus(group.url, 'joined', {
    name: group.label,
    group_id: group.id,
  });

  const activity = await inspectGroupActivity(page);
  if (activity.activityLabel) {
    console.log(`Last active ${activity.activityLabel}`);
  }

  await updateDiscoveredGroupStatus(group.url, 'joined', {
    name: group.label,
    group_id: group.id,
    activity_label: activity.activityLabel,
    activity_age_hours: activity.activityAgeHours,
    lastActivityCheckedAt: new Date(),
  });

  if (
    Number.isFinite(activity.activityAgeHours) &&
    activity.activityAgeHours > MAX_ACTIVITY_AGE_HOURS
  ) {
    console.log(`Skipping stale group: ${group.label}`);
    return [];
  }

  const immediatelyVisiblePosts = await listVisiblePosts(page, { limit: 8, scrollRounds: 1, validationMode: 'business' }).catch(() => []);

  if (!immediatelyVisiblePosts.length) {
    const loopResult = await runPerceiveReasonActLoop(page, {
      goal: `Find and extract text from all posts in this group that match our business interests${options.topic ? ` about ${options.topic}` : ''}. Scroll if needed. Complete when visible relevant posts can be extracted or when there are clearly no relevant posts visible.`,
      skill,
      workspaceContext: state.workspaceContext || null,
      maxSteps: 8,
      onStall: options.onStall || null,
    });

    if (!loopResult.success && loopResult.error) {
      state.errors.push(`Scan loop issue for ${group.label}: ${loopResult.error}`);
    }
  }

  const found = await extractLeadPostsFromCurrentPage(page, group.label, skill, state, options.topic || '');
  state.scrapedPosts += found.length;
  await updateGroupLastScanned(group.url, new Date());
  console.log(`Matched ${found.length} lead posts from ${group.label}`);
  return found;
}

async function engageLeadWithReasoningLoop(page, skill, candidate, state, options = {}) {
  if (!candidate.post_url) {
    throw new Error(`No direct post URL stored for ${candidate.post_id}.`);
  }

  const draft = options.draft || await draftCommentForCandidate(skill, candidate, {
    phaseOverride: 1,
  });

  await page.goto(candidate.post_url, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });

  const result = await runPerceiveReasonActLoop(page, {
    goal: `Read the identified lead and post this exact helpful, non-spammy comment based on our skill file: "${draft.reply}" Complete only after the comment has been entered and submitted.`,
    skill,
    workspaceContext: state.workspaceContext || null,
    maxSteps: 8,
    onStall: options.onStall || null,
  });

  if (!result.success) {
    throw new Error(result.error || 'Engagement loop did not complete successfully.');
  }

  await logInteraction({
    target_id: candidate.post_id,
    type: 'comment',
    content_sent: draft.reply,
    metadata: {
      group: candidate.group,
      score: candidate.relevance_score,
    },
  });
  await appendThreadHistory(candidate.post_id, {
    role: 'assistant',
    text: draft.reply,
    phase: draft.phase,
  }, {
    related_post_id: candidate.post_id,
    current_phase: draft.phase,
    summary_of_discussion: `Initial outbound comment sent for ${candidate.group}.`,
  });
  await updateContextPhase(candidate.post_id, draft.phase);
  await markPostStatus(candidate.post_id, 'engaged');
  await updateLeadInteractionResult(candidate.post_id, 'Success');
  state.comments += 1;
  return draft;
}

async function resolveTargetGroups(page, taskInput) {
  const configuredGroups = (
    taskInput.facebook_groups ||
    taskInput.target_groups ||
    []
  ).map(normalizeGroupEntry).filter(Boolean);

  const resolvedGroups = [];

  for (const group of configuredGroups) {
    if (group.url) {
      resolvedGroups.push(group);
      continue;
    }

    const keyword = group.keyword || group.label;
    let discovered = (await getDiscoveredGroups(keyword, { limit: 10 })).filter(
      (match) => isCanonicalGroupUrl(match.url) && isLikelyGroupName(match.name)
    );

    if (!discovered.length) {
      console.log(`Discovering groups for keyword: ${keyword}`);
      const results = await discoverGroups(page, keyword, { maxResults: 5 });
      console.log(`Discovered ${results.length} candidate groups for "${keyword}"`);
      await saveDiscoveredGroups(keyword, results);
      discovered = (await getDiscoveredGroups(keyword, { limit: 10 })).filter(
        (match) => isCanonicalGroupUrl(match.url) && isLikelyGroupName(match.name)
      );
    }

    for (const match of discovered) {
      resolvedGroups.push({
        id: match.group_id || extractGroupIdFromUrl(match.url),
        url: match.url,
        label: match.name || keyword,
        keyword,
      });
    }
  }

  const uniqueByUrl = new Map();
  for (const group of resolvedGroups) {
    if (group.url && !uniqueByUrl.has(group.url)) {
      uniqueByUrl.set(group.url, group);
    }
  }

  return [...uniqueByUrl.values()];
}

async function resolveScannableGroups(page, taskInput) {
  const joinedGroups = await getGroupsByStatus('joined', { limit: 200 });
  return joinedGroups
    .filter((group) => isLikelyEnglishGroupName(group.name))
    .filter((group) => isRelevantAmazonGroupName(group.name))
    .filter((group) => matchesTargetGroupHints(group.name, taskInput))
    .sort((left, right) => {
      const leftActivity = Number.isFinite(left.activity_age_hours) ? left.activity_age_hours : Number.MAX_SAFE_INTEGER;
      const rightActivity = Number.isFinite(right.activity_age_hours) ? right.activity_age_hours : Number.MAX_SAFE_INTEGER;
      if (leftActivity !== rightActivity) {
        return leftActivity - rightActivity;
      }
      const leftTime = left.lastScanned ? new Date(left.lastScanned).getTime() : 0;
      const rightTime = right.lastScanned ? new Date(right.lastScanned).getTime() : 0;
      return leftTime - rightTime;
    })
    .slice(0, MAX_GROUPS_PER_SCAN)
    .map((group) => ({
      id: group.group_id || extractGroupIdFromUrl(group.url),
      url: group.url,
      label: group.name,
      keyword: group.keyword,
      status: group.status,
      lastScanned: group.lastScanned || null,
    }));
}

async function syncGroups(page) {
  const joinedGroups = await scrapeJoinedGroups(page, { limit: 500, scrollRounds: 14 });
  if (joinedGroups.length) {
    await saveDiscoveredGroups('__joined_sync__', joinedGroups.map((group) => ({
      ...group,
      status: 'joined',
      source: group.source || 'groups_feed',
    })));
    await upsertAgentState('account_group_summary', {
      totalJoinedGroups: joinedGroups.length,
      lastFullSyncAt: new Date(),
      sampleGroupNames: joinedGroups.slice(0, 20).map((group) => group.name),
    });
  }

  const approvals = await scrapeJoinApprovalNotifications(page, { limit: 10 });
  let updated = 0;

  for (const approval of approvals) {
    const group = await findGroupByName(approval.groupName);
    if (!group) {
      continue;
    }

    await updateDiscoveredGroupStatus(group.url, 'joined');
    updated += 1;
  }

  console.log(`Group sync complete. Joined approvals updated: ${updated}. Account-level joined groups synced: ${joinedGroups.length}`);
  return {
    approvalsUpdated: updated,
    joinedGroupsSynced: joinedGroups.length,
  };
}

async function verifyPendingGroups(page) {
  const pendingGroups = await getGroupsByStatus('pending', { limit: 200 });
  let verified = 0;

  console.log(`Verifying pending groups: ${pendingGroups.length}`);

  for (const group of pendingGroups) {
    await visitGroup(page, group.url);

    if (await isCreatePostComposerVisible(page)) {
      await updateDiscoveredGroupStatus(group.url, 'joined');
      verified += 1;
      console.log(`Verified joined: ${group.name}`);
      continue;
    }

    const membershipStatus = await inspectGroupMembershipStatus(page);
    if (membershipStatus === 'joined') {
      await updateDiscoveredGroupStatus(group.url, 'joined');
      verified += 1;
      console.log(`Verified joined: ${group.name}`);
    } else if (membershipStatus === 'discovered') {
      await updateDiscoveredGroupStatus(group.url, 'discovered');
      console.log(`No longer pending: ${group.name}`);
    }
  }

  console.log(`Verify complete. Groups marked joined: ${verified}`);
  return verified;
}

async function generateMorningBriefing(skill, notifications, inboxPreviews) {
  const prompt = [
    'Create a short morning briefing for the business owner.',
    'Start with "Boss,".',
    'Mention how many DM leads and notification replies were found.',
    'End with "What is our mission today?"',
    'Keep it to one or two sentences.',
    '',
    'Business context:',
    skill.content,
    '',
    `Notifications (${notifications.length}):`,
    notifications.length ? notifications.map((item) => `- ${item.text}`).join('\n') : '- None',
    '',
    `Inbox previews (${inboxPreviews.length}):`,
    inboxPreviews.length ? inboxPreviews.map((item) => `- ${item.text}`).join('\n') : '- None',
  ].join('\n');

  try {
    return await callOllama(prompt, {
      model: MORNING_BRIEFING_MODEL,
      timeoutMs: 30_000,
      generationOptions: {
        temperature: 0.2,
        num_ctx: 2048,
        num_predict: 120,
      },
    });
  } catch (_error) {
    const dmCount = inboxPreviews.length;
    const notificationCount = notifications.length;
    return `Boss, you have ${dmCount} DM leads and ${notificationCount} active notifications. What is our mission today?`;
  }
}

async function runMorningBriefing(page, skill, state) {
  const notifications = await scrapeNotifications(page, { limit: 5 });
  const inboxPreviews = await scrapeInboxPreviews(page, { limit: 3 });
  const summary = await generateMorningBriefing(skill, notifications, inboxPreviews);

  state.briefing = {
    notifications,
    inboxPreviews,
    summary,
  };

  console.log('\n=== Morning Briefing ===');
  console.log(summary);
  console.log('========================\n');

  return state.briefing;
}

async function summarizeInbox(page, skill, state) {
  return runMorningBriefing(page, skill, state);
}

async function performSocialBreak(page) {
  if (Math.random() > 0.35) {
    return 0;
  }

  await page.goto(FACEBOOK_BASE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  await page.waitForTimeout(3000);

  const likeButtons = page.getByRole('button', { name: /like/i });
  const likeCount = Math.min(await likeButtons.count(), 8);
  let likesDone = 0;
  const targetLikes = Math.min(2, Math.max(1, Math.floor(Math.random() * 2) + 1));

  for (let index = 0; index < likeCount && likesDone < targetLikes; index += 1) {
    const button = likeButtons.nth(index);
    try {
      await button.scrollIntoViewIfNeeded();
      await button.click({ delay: 80 });
      likesDone += 1;
      await page.waitForTimeout(1200);
    } catch (_error) {
      continue;
    }
  }

  if (likesDone) {
    console.log(`Social break complete. Liked ${likesDone} home-feed posts.`);
  }

  return likesDone;
}

async function writeDailyInsights(skill, state) {
  const today = new Date().toISOString().slice(0, 10);
  if (state.lastInsightDate === today) {
    return null;
  }

  const successfulLeads = await getLeadsByInteractionResult('Success', { limit: 20 });
  if (!successfulLeads.length) {
    state.lastInsightDate = today;
    return null;
  }

  const insightsFile = await readAgentInsights();
  const prompt = [
    'Analyze these successful Facebook seller leads.',
    'Why did these sellers reply to us? What keywords or tone worked best?',
    'Keep the answer concise and actionable.',
    '',
    'Existing insights:',
    insightsFile,
    '',
    'Successful leads:',
    successfulLeads.map((lead) => `- ${lead.content}`).join('\n'),
  ].join('\n');

  const analysis = await callOllama(prompt, {
    model: MORNING_BRIEFING_MODEL,
    timeoutMs: 30_000,
    generationOptions: {
      temperature: 0.1,
      num_ctx: 2048,
      num_predict: 220,
    },
  }).catch(() => '');

  if (!analysis) {
    return null;
  }

  const entry = `\n## ${today}\n${analysis}\n`;
  await appendAgentInsights(entry);
  state.lastInsightDate = today;
  console.log(`Agent insights updated: ${AGENT_INSIGHTS_PATH}`);
  return analysis;
}

async function runHousekeeping(page, skill, state) {
  console.log('Starting housekeeping cycle...');
  await ensureLoggedIn(page);
  await syncGroups(page);
  await verifyPendingGroups(page);
  try {
    await summarizeInbox(page, skill, state);
  } catch (error) {
    state.errors.push(`Morning briefing failed: ${error.message}`);
    state.briefing = state.briefing || {
      notifications: [],
      inboxPreviews: [],
      summary: '',
    };
    console.log(`Morning briefing skipped: ${error.message}`);
  }

  try {
    await handleReplyLoop(page, skill, state, state.briefing);
  } catch (error) {
    state.errors.push(`Reply loop failed: ${error.message}`);
    console.log(`Reply loop skipped: ${error.message}`);
  }

  try {
    await performSocialBreak(page);
  } catch (error) {
    state.errors.push(`Social break failed: ${error.message}`);
    console.log(`Social break skipped: ${error.message}`);
  }

  try {
    await writeDailyInsights(skill, state);
  } catch (error) {
    state.errors.push(`Daily insights failed: ${error.message}`);
    console.log(`Daily insights skipped: ${error.message}`);
  }
  console.log('Housekeeping cycle complete.');
}

async function searchAndJoinGroups(page, keyword, skill, state) {
  const cleanedKeyword = String(keyword || '').trim();
  if (!cleanedKeyword) {
    throw new Error('A group keyword is required.');
  }

  console.log(`Searching groups for keyword: ${cleanedKeyword}`);
  const discovered = await discoverGroups(page, cleanedKeyword, { maxResults: 8 });
  const filtered = discovered.filter((group) => isCanonicalGroupUrl(group.url) && isLikelyGroupName(group.name));
  await saveDiscoveredGroups(cleanedKeyword, filtered);

  const answerJoinQuestions = await answerJoinQuestionsFactory(skill);
  let joinAttempts = 0;
  let pendingCount = 0;
  let joinedCount = 0;

  for (const group of filtered) {
    console.log(`Search found group: ${group.name} -> ${group.url}`);
    await visitGroup(page, group.url);
    const membershipStatus = await inspectGroupMembershipStatus(page);

    if (membershipStatus === 'joined') {
      await updateDiscoveredGroupStatus(group.url, 'joined', {
        name: group.name,
        group_id: group.id,
      });
      joinedCount += 1;
      continue;
    }

    if (membershipStatus === 'pending') {
      await updateDiscoveredGroupStatus(group.url, 'pending', {
        name: group.name,
        group_id: group.id,
      });
      pendingCount += 1;
      console.log(`Already pending: ${group.name}`);
      continue;
    }

    const result = await handleJoinGroup(page, {
      answerJoinQuestions,
      dynamicJoinLoop: async (loopPage, _joinDialog) => {
        const dynamicResult = await runPerceiveReasonActLoop(loopPage, {
          goal: 'Join Group and answer questions truthfully using the Amazon Hidden Money business context. Submit the modal when complete.',
          skill,
          workspaceContext: state.workspaceContext || null,
          maxSteps: 10,
        });

        if (dynamicResult?.success) {
          await appendAgentInsights(
            `\n[${new Date().toISOString()}] Success Note: Completed a Facebook group join flow using the perceive-reason-act loop.\n`
          ).catch(() => {});
          return {
            joined: true,
            pendingApproval: true,
            modalHandled: true,
            answeredQuestions: [],
            answers: [],
            submitted: true,
          };
        }

        return null;
      },
    });

    joinAttempts += 1;
    const nextStatus = result.pendingApproval ? 'pending' : 'joined';
    await updateDiscoveredGroupStatus(group.url, nextStatus, {
      name: group.name,
      group_id: group.id,
    });

    if (nextStatus === 'pending') {
      pendingCount += 1;
      state.joinRequests += 1;
      console.log(`Join submitted: ${group.name}`);
    } else {
      joinedCount += 1;
      console.log(`Joined immediately: ${group.name}`);
    }
  }

  return {
    discovered: filtered.length,
    joinAttempts,
    pendingCount,
    joinedCount,
  };
}

async function scanGroupFeed(page, group, skill, goalSummary, state) {
  console.log(`Opening group: ${group.label}`);
  await visitGroup(page, group.url);
  state.groupsVisited.push(group.label);

  const membershipStatus = await inspectGroupMembershipStatus(page);

  if (membershipStatus === 'pending') {
    await updateDiscoveredGroupStatus(group.url, 'pending', {
      name: group.label,
      group_id: group.id,
    });
    console.log(`Skipping pending group: ${group.label}`);
    return [];
  }

  if (membershipStatus === 'discovered') {
    await updateDiscoveredGroupStatus(group.url, 'discovered', {
      name: group.label,
      group_id: group.id,
    });
    console.log(`Skipping discovered group: ${group.label}`);
    return [];
  }

  await updateDiscoveredGroupStatus(group.url, 'joined', {
    name: group.label,
    group_id: group.id,
  });

  const activity = await inspectGroupActivity(page);
  if (activity.activityLabel) {
    console.log(`Last active ${activity.activityLabel}`);
  }

  await updateDiscoveredGroupStatus(group.url, 'joined', {
    name: group.label,
    group_id: group.id,
    activity_label: activity.activityLabel,
    activity_age_hours: activity.activityAgeHours,
    lastActivityCheckedAt: new Date(),
  });

  if (
    Number.isFinite(activity.activityAgeHours) &&
    activity.activityAgeHours > MAX_ACTIVITY_AGE_HOURS
  ) {
    console.log(`Skipping stale group: ${group.label}`);
    return [];
  }

  const scrapedPosts = await listVisiblePosts(page, { limit: 18, scrollRounds: 2, validationMode: 'business' });
  await updateGroupLastScanned(group.url, new Date());
  state.scrapedPosts += scrapedPosts.length;
  console.log(`Scraped ${scrapedPosts.length} posts from ${group.label}`);

  const found = [];
  const aiCandidates = scrapedPosts.filter((post) => looksLikePotentialLeadPost(post.postText)).slice(0, 8);
  console.log(`Prefiltered ${aiCandidates.length} posts for AI scoring in ${group.label}`);

  for (const scrapedPost of aiCandidates) {
    const storedPost = await upsertPost({
      post_id: scrapedPost.postId,
      group: group.label,
      post_url: scrapedPost.postUrl || null,
      content: scrapedPost.postText,
      author: scrapedPost.authorName || 'Unknown',
      status: 'pending',
    });

    const scoreResult = await scorePostAgainstSkill(
      {
        post_id: storedPost.post_id,
        group: storedPost.group,
        author: storedPost.author,
        content: storedPost.content,
      },
      skill
    );

    state.scoredPosts += 1;
    const status = scoreResult.shouldInteract ? 'qualified' : 'ignored';
    await updatePostScore(storedPost.post_id, scoreResult.score, status);
    console.log(
      `Scored post ${storedPost.post_id}: ${scoreResult.score}/10 (${status}) ${scoreResult.category || ''}`
    );

    if (scoreResult.shouldInteract) {
      state.triggerMatches += 1;
      state.eligiblePosts += 1;
      await upsertLead({
        post_id: storedPost.post_id,
        group: storedPost.group,
        content: storedPost.content,
        author: storedPost.author,
        category: scoreResult.category,
        confidence: scoreResult.confidence,
        reason: scoreResult.reason,
        status: 'New',
      });
      found.push({
        ...storedPost,
        post_url: scrapedPost.postUrl || storedPost.post_url || null,
        relevance_score: scoreResult.score,
      });
    }
  }

  return found;
}

async function scanJoinedGroups(page, taskInput, skill, state) {
  const groups = (await resolveScannableGroups(page, taskInput)).slice(0, MAX_GROUPS_PER_SCAN);
  const results = [];

  state.resolvedGroups = groups;
  console.log(`Groups to scan this cycle: ${groups.length} (cap ${MAX_GROUPS_PER_SCAN})`);

  if (!groups.length) {
    console.log('No already-joined groups are available to scan. Use `search [keyword]` first or wait for pending approvals.');
  }

  for (const group of groups) {
    try {
      const found = await scanGroupWithReasoningLoop(page, group, skill, state, {
        topic: buildGoalSummary(taskInput),
      });
      results.push(...found);
    } catch (error) {
      state.errors.push(`Group scan failed for ${group.label}: ${error.message}`);
    }
  }

  state.scanResults = results;
  console.log(`Scan complete. Qualified posts found: ${results.length}`);
  return results;
}

async function openCandidatePost(page, candidate, state) {
  if (!candidate?.post_url) {
    state.errors.push(`Skipping ${candidate?.post_id || 'unknown'}: no direct post URL was stored.`);
    await updateLeadInteractionResult(candidate?.post_id, 'Blocked').catch(() => {});
    return false;
  }

  try {
    await page.goto(candidate.post_url, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });
    return true;
  } catch (error) {
    state.errors.push(`Open failed for ${candidate.post_id}: ${error.message}`);
    await updateLeadInteractionResult(candidate.post_id, 'Blocked').catch(() => {});
    return false;
  }
}

async function likeQualifiedPost(page, candidate, state) {
  if (!(await openCandidatePost(page, candidate, state))) {
    return false;
  }

  if (await hasInteraction(candidate.post_id, 'like')) {
    state.skippedDuplicates += 1;
    return false;
  }

  console.log(`Liking post ${candidate.post_id}`);
  await clickLike(page, candidate.post_id, { postUrl: candidate.post_url || null });
  await logInteraction({
    target_id: candidate.post_id,
    type: 'like',
    metadata: {
      group: candidate.group,
      score: candidate.relevance_score,
    },
  });
  state.likes += 1;
  return true;
}

async function draftCommentForCandidate(skill, candidate, options = {}) {
  const classification = await classifyPostForEngagement({
    skill,
    postContent: candidate.content,
  }, {
    model: MORNING_BRIEFING_MODEL,
  });

  const isSkillRelevant = /amazon|fba|seller|fee|reimbursement|settlement|inventory|margin|profit/i.test(
    String(candidate.content || '')
  );
  const contextualSummary = [
    `Post category: [${classification.category}].`,
    `Persona: ${classification.persona}.`,
    `Guidance: ${classification.guidance}.`,
    classification.category === 'PROBLEM'
      ? 'This is a problem post. Look for a practical solution in the relevant skill before drafting.'
      : classification.category === 'QUESTION'
        ? 'This is a question post. Answer accurately and simply.'
        : classification.category === 'CELEBRATION'
          ? 'This is a celebration post. Congratulate them and mention a specific detail.'
          : 'This is a general post. Keep the reply positive, useful, and human.',
    isSkillRelevant
      ? 'Use the Amazon hidden money skill only where it genuinely fits the post.'
      : 'This is general engagement. Do not force Amazon hidden money advice if it does not fit.',
  ].join(' ');

  return draftReply({
    skill,
    post: {
      post_id: candidate.post_id,
      content: candidate.content,
    },
    threadId: candidate.post_id,
    contextSummary: `${candidate.content}\n\n${contextualSummary}`,
    tone: options.tone || classification.tone || 'helpful, consultative, confident, concise',
    phaseOverride: options.phaseOverride ?? 1,
  });
}

async function commentOnQualifiedPost(page, skill, candidate, state, options = {}) {
  if (!(await openCandidatePost(page, candidate, state))) {
    return { posted: false, draft: null };
  }

  if (await hasInteraction(candidate.post_id, 'comment')) {
    state.skippedDuplicates += 1;
    return { posted: false, draft: null };
  }

  const draft = options.draft || await draftCommentForCandidate(skill, candidate, options);
  console.log(`Posting comment on ${candidate.post_id}`);
  await postComment(page, candidate.post_id, draft.reply, { postUrl: candidate.post_url || null });
  await logInteraction({
    target_id: candidate.post_id,
    type: 'comment',
    content_sent: draft.reply,
    metadata: {
      group: candidate.group,
      score: candidate.relevance_score,
    },
  });
  await appendThreadHistory(candidate.post_id, {
    role: 'assistant',
    text: draft.reply,
    phase: draft.phase,
  }, {
    related_post_id: candidate.post_id,
    current_phase: draft.phase,
    summary_of_discussion: `Initial outbound comment sent for ${candidate.group}.`,
  });
  await updateContextPhase(candidate.post_id, draft.phase);
  await markPostStatus(candidate.post_id, 'engaged');
  await updateLeadInteractionResult(candidate.post_id, 'Success');
  state.comments += 1;
  return { posted: true, draft };
}

async function engageQualifiedPosts(page, skill, state) {
  const { posts } = getCollections();
  const candidates = await posts.find({ status: 'qualified' }).sort({ updated_at: -1 }).lean();

  console.log(`Engage queue size: ${candidates.length}`);

  for (const candidate of candidates) {
    if (!canPerformAction(state, 'like') && !canPerformAction(state, 'comment')) {
      break;
    }

    if (canPerformAction(state, 'like') && !(await hasInteraction(candidate.post_id, 'like'))) {
      try {
        const liked = await likeQualifiedPost(page, candidate, state);
        if (liked) {
          await humanJitter(page, { logLabel: 'Post-like jitter' });
        }
      } catch (error) {
        state.errors.push(`Like failed for ${candidate.post_id}: ${error.message}`);
      }
    }

    if (canPerformAction(state, 'comment') && !(await hasInteraction(candidate.post_id, 'comment'))) {
      try {
        console.log(`Drafting Phase 1 comment for post ${candidate.post_id}`);
        const draft = await draftCommentForCandidate(skill, candidate, { phaseOverride: 1 });
        await commentOnQualifiedPost(page, skill, candidate, state, {
          draft,
        });
        await humanJitter(page, { logLabel: 'Post-comment jitter' });
      } catch (error) {
        await updateLeadInteractionResult(candidate.post_id, 'Blocked');
        state.errors.push(`Comment failed for ${candidate.post_id}: ${error.message}`);
      }
    }
  }

  if (state.resolvedGroups.length) {
    const outboundPosts = Array.isArray(state.taskInput.personal_posts)
      ? state.taskInput.personal_posts
      : DEFAULT_OUTBOUND_POSTS;

    for (const group of state.resolvedGroups) {
      if (!canPerformAction(state, 'personal_post')) {
        break;
      }

      if (!group.id) {
        continue;
      }

      try {
        const postText = outboundPosts[state.posts % outboundPosts.length];
        console.log(`Creating outbound post in group: ${group.label}`);
        await createNewPost(page, group.id, postText, null);
        await logInteraction({
          target_id: `${group.id}:${new Date().toISOString().slice(0, 10)}`,
          type: 'personal_post',
          content_sent: postText,
          metadata: {
            group: group.label,
            skill: skill.id,
          },
        });
        state.posts += 1;
        await humanJitter(page, { logLabel: 'Outbound-post jitter' });
      } catch (error) {
        state.errors.push(`Create post failed for ${group.label}: ${error.message}`);
      }
    }
  }
}

async function scrapeNotificationReplies(page) {
  const notifications = await scrapeNotifications(page, { limit: 10 });
  return notifications.filter((item) => item.postId);
}

async function replyToInboxPreviews(page, skill, state, inboxPreviews) {
  for (const preview of inboxPreviews) {
    if (!preview.href) {
      continue;
    }

    if (await hasInteraction(preview.href, 'dm_reply')) {
      continue;
    }

    const prompt = [
      'Write a concise Facebook Messenger reply.',
      'Be helpful, simple, and professional.',
      'No hype. No AI mention.',
      '',
      'Business context:',
      skill.content,
      '',
      'Latest message preview:',
      preview.text,
      '',
      'Reply:',
    ].join('\n');

    const replyText = await callOllama(prompt, {
      generationOptions: {
        temperature: 0.4,
        num_predict: 140,
      },
    });

    console.log(`Replying to DM thread: ${preview.href}`);
    await sendInboxReply(page, preview.href, replyText);
    await logInteraction({
      target_id: preview.href,
      type: 'dm_reply',
      content_sent: replyText,
      metadata: {
        preview: preview.text,
      },
    });
    await humanJitter(page, { logLabel: 'DM-reply jitter' });
  }
}

async function replyToNotificationItem(page, skill, state, notification) {
  if (await hasInteraction(notification.postId, 'reply')) {
    return { replied: false, reason: 'duplicate' };
  }

  const originalPost = await findPostById(notification.postId);
  const existingContext = await getContextMemory(notification.postId);
  const existingLead = await findLeadByPostId(notification.postId);

  if (!originalPost && !existingContext) {
    return { replied: false, reason: 'missing_context' };
  }

  const contextSummary = existingContext?.summary_of_discussion
    || originalPost?.content
    || 'Follow-up on an earlier Facebook discussion.';

  await appendThreadHistory(notification.postId, {
    role: 'user',
    text: notification.text,
    phase: existingContext?.current_phase ?? null,
  }, {
    related_post_id: notification.postId,
    current_phase: existingContext?.current_phase ?? null,
    summary_of_discussion: existingContext?.summary_of_discussion || 'User replied to our outreach.',
  });

  const looksLikeQuestion = /\?/.test(notification.text);
  const draft = await draftReply({
    skill,
    post: {
      post_id: notification.postId,
      content: notification.text,
    },
    threadId: notification.postId,
    contextSummary,
    tone: 'warm, concise, and specific',
    phaseOverride: looksLikeQuestion ? 2 : null,
  });

  if (!notification.href) {
    return { replied: false, reason: 'missing_href', draft };
  }

  console.log(`Posting reply for notification thread ${notification.postId}`);
  await page.goto(notification.href, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  await page.waitForTimeout(2_000);
  await postComment(page, notification.postId, draft.reply);

  const summary = await summarizeDiscussion({
    skill,
    postContent: originalPost?.content || contextSummary,
    replies: [notification.text, draft.reply],
  });

  await upsertContextMemory({
    thread_id: notification.postId,
    summary_of_discussion: summary,
    related_post_id: notification.postId,
    current_phase: draft.phase,
    thread_history: [
      ...(existingContext?.thread_history || []),
      {
        role: 'user',
        text: notification.text,
        phase: existingContext?.current_phase ?? null,
        timestamp: new Date(),
      },
      {
        role: 'assistant',
        text: draft.reply,
        phase: draft.phase,
        timestamp: new Date(),
      },
    ],
  });
  await updateContextPhase(notification.postId, draft.phase);

  await logInteraction({
    target_id: notification.postId,
    type: 'reply',
    content_sent: draft.reply,
    metadata: {
      notification_text: notification.text,
      phase: draft.phase,
    },
  });

  if (existingLead || originalPost) {
    await updateLeadStatus(notification.postId, 'Warm');
    await updateLeadInteractionResult(notification.postId, 'Success');
  }

  state.replies += 1;
  return { replied: true, draft };
}

async function handleReplyLoop(page, skill, state, briefing = state.briefing) {
  const notifications = briefing.notifications?.length
    ? briefing.notifications.filter((item) => item.postId)
    : await scrapeNotificationReplies(page);

  console.log(`Notifications found for reply loop: ${notifications.length}`);

  for (const notification of notifications) {
    const result = await replyToNotificationItem(page, skill, state, notification);
    if (result.replied) {
      await humanJitter(page, { logLabel: 'Reply-loop jitter' });
    }
  }

  if (briefing.inboxPreviews?.length) {
    await replyToInboxPreviews(page, skill, state, briefing.inboxPreviews);
  }
}

function printSessionSummary(taskInput, skill, state, dbCounts) {
  const taskNames = (taskInput.daily_tasks || []).map((task) => task.name).join(', ');

  console.log('=== Facebook Agent Session Summary ===');
  console.log(`Skill: ${skill.id}`);
  console.log(`Tasks: ${taskNames || 'No tasks listed'}`);
  console.log(`Groups visited: ${state.groupsVisited.length}`);
  console.log(`Posts scraped: ${state.scrapedPosts}`);
  console.log(`Posts scored: ${state.scoredPosts}`);
  console.log(`Trigger matches: ${state.triggerMatches}`);
  console.log(`Qualified posts: ${state.eligiblePosts}`);
  console.log(`Join requests sent: ${state.joinRequests}`);
  console.log(`Comments posted this session: ${state.comments - (dbCounts.comment || 0)}`);
  console.log(`Likes added this session: ${state.likes - (dbCounts.like || 0)}`);
  console.log(`Personal posts created this session: ${state.posts - (dbCounts.personal_post || 0)}`);
  console.log(`Replies posted this session: ${state.replies - (dbCounts.reply || 0)}`);
  console.log(`Duplicate interactions skipped: ${state.skippedDuplicates}`);

  if (state.errors.length) {
    console.log('Errors:');
    for (const error of state.errors) {
      console.log(`- ${error}`);
    }
  }
}

async function runAssistantSession(options = {}) {
  const taskInputPath = options.taskInputPath || DEFAULT_TASK_INPUT_PATH;
  const selectedModel = await selectModelProviderOnStart();
  const taskInput = await readTaskInput(taskInputPath);
  const skill = await resolveSkillForTask(taskInput);
  const todayStart = getStartOfToday();

  await connectDatabase();
  await setupCollections();
  await ensureWorkspaceDocs();
  await clearJobs({
    types: [
      JOB_TYPES.HOUSEKEEPING,
      JOB_TYPES.SYNC_GROUPS,
      JOB_TYPES.VERIFY_PENDING,
      JOB_TYPES.SCAN_GROUPS,
      JOB_TYPES.ENGAGE,
      JOB_TYPES.REPLY,
      JOB_TYPES.BRIEF,
    ],
  });

  const existingCounts = await getInteractionCountsSince(todayStart);
  const state = createSessionState(existingCounts);
  state.workspaceContext = await loadWorkspaceContext();
  const savedOperatorContext = await getAgentState('operator_context');
  if (savedOperatorContext?.value && typeof savedOperatorContext.value === 'object') {
    state.operatorContext = {
      ...state.operatorContext,
      ...savedOperatorContext.value,
    };
  }
  state.limits = {
    comments: taskInput.daily_limits?.comments || DEFAULT_SESSION_LIMITS.comments,
    likes: taskInput.daily_limits?.likes || DEFAULT_SESSION_LIMITS.likes,
    posts: taskInput.daily_limits?.posts || DEFAULT_SESSION_LIMITS.posts,
  };
  state.taskInput = taskInput;

  let browserContext;
  const lock = createBrowserLock();

  try {
    const browser = await launchBrowser({
      headless: false,
      userDataDir: options.userDataDir || path.join(__dirname, '..', 'user_data'),
    });

    browserContext = browser.context;

    console.log(`Goal for today: ${buildGoalSummary(taskInput)}`);
    console.log(`Using skill: ${skill.id}`);
    console.log(`Using model runtime: ${selectedModel.provider}/${selectedModel.model}`);

    await ensureMemoryFile();
    await ensureLoggedIn(browser.page);
    const runtimeContext = {
      lock,
      page: browser.page,
      skill,
      state,
      taskInput,
      jobTypes: JOB_TYPES,
      enqueueUniqueJob,
      releaseExpiredJobs,
      leaseNextJob,
      completeJob,
      failJob,
      runHousekeeping,
      syncGroups,
      verifyPendingGroups,
      scanJoinedGroups,
      engageQualifiedPosts,
      handleReplyLoop,
      summarizeInbox,
      searchAndJoinGroups,
    };

    startOperatorConsole({
      page: browser.page,
      taskInput,
      skill,
      state,
      lock,
      getGroupsByStatus,
      getJobsByStatus,
      getAgentState,
      enqueueUniqueJob,
      runQueuedJobs: () => runQueuedJobs(runtimeContext),
      scrapeNotifications,
      listVisibleGroups: () => listVisibleGroups(browser.page, { limit: 200, scrollRounds: 8 }),
      listVisibleNotifications: (optionsArg) => listVisibleNotifications(browser.page, optionsArg),
      listVisiblePosts: (optionsArg) => listVisiblePosts(browser.page, optionsArg),
      listVisibleRedditPosts: (optionsArg) => listVisibleRedditPosts(browser.page, optionsArg),
      isRelevantAmazonGroupName,
      getCollections,
      callOllama,
      model: MORNING_BRIEFING_MODEL,
      jobTypes: JOB_TYPES,
      visitGroup,
      scrapeInboxPreviews,
      syncGroups: () => syncGroups(browser.page),
      verifyPendingGroups: () => verifyPendingGroups(browser.page),
      searchAndJoinGroups: (keyword) => searchAndJoinGroups(browser.page, keyword, skill, state),
      scanJoinedGroups: () => scanJoinedGroups(browser.page, taskInput, skill, state),
      scanSingleGroup: async (group, options = {}) => {
        const results = await scanGroupWithReasoningLoop(browser.page, group, skill, state, options);
        state.scanResults = results;
        return results;
      },
      engageQualifiedPosts: () => engageQualifiedPosts(browser.page, skill, state),
      summarizeInbox: () => summarizeInbox(browser.page, skill, state),
      handleReplyLoop: (briefing) => handleReplyLoop(browser.page, skill, state, briefing),
      likeQualifiedPost: (candidate) => likeQualifiedPost(browser.page, candidate, state),
      clickLikeOnVisiblePost: (visibleIndex) => clickLikeOnVisiblePost(browser.page, visibleIndex),
      anchorVisiblePost: (visibleIndex, options) => anchorVisiblePost(browser.page, visibleIndex, options),
      extractAnchoredPostData: (visibleIndex, options) => extractAnchoredPostData(browser.page, visibleIndex, options),
      likeAnchoredPost: (visibleIndex, options) => likeAnchoredPost(browser.page, visibleIndex, options),
      draftCommentForCandidate: (candidate, options) => draftCommentForCandidate(skill, candidate, options),
      commentOnQualifiedPost: (candidate, options) => commentOnQualifiedPost(browser.page, skill, candidate, state, options),
      commentAnchoredPost: (visibleIndex, text, options) => commentAnchoredPost(browser.page, visibleIndex, text, options),
      planObjective: (payload, options) => planObjective(payload, options),
      searchRedditPosts: (query) => searchRedditPosts(browser.page, query),
      saveNewSkill,
      postCommentOnVisiblePost: (visibleIndex, text) => postCommentOnVisiblePost(browser.page, visibleIndex, text),
      createNewPost,
      createFeedPost,
      scrapeGroupFeed: (pageArg, optionsArg) => scrapeGroupFeed(pageArg || browser.page, optionsArg),
      markNotificationsRead: (notifications, options) => markNotificationsRead(browser.page, notifications, options),
      scrapeNotifications: (pageArg, optionsArg) => scrapeNotifications(pageArg || browser.page, optionsArg),
      scrapeNotificationReplies: () => scrapeNotificationReplies(browser.page),
      replyToNotificationItem: (notification) => replyToNotificationItem(browser.page, skill, state, notification),
      upsertAgentState,
      humanJitter,
      inspectRedditSession: () => inspectRedditSession(browser.page),
      appendRecoveryLesson,
      visitRedditHome: () => visitRedditHome(browser.page),
      visitSubreddit: (subreddit) => visitSubreddit(browser.page, subreddit),
      runQueuedJobs: () => runQueuedJobs(runtimeContext),
    });

    await new Promise(() => {});
  } finally {
    await closeBrowser(browserContext);
    await closeDatabase();
  }
}

if (require.main === module) {
  runAssistantSession()
    .catch((error) => {
      console.error('Orchestrator failed:', error);
      process.exitCode = 1;
    });
}

module.exports = {
  answerJoinQuestionsFactory,
  buildGoalSummary,
  buildTriggerPatterns,
  createSessionState,
  engageQualifiedPosts,
  handleReplyLoop,
  resolveScannableGroups,
  runAssistantSession,
  runHousekeeping,
  runMorningBriefing,
  scanJoinedGroups,
  scrapeNotificationReplies,
  startOperatorConsole,
  syncGroups,
  verifyPendingGroups,
};
