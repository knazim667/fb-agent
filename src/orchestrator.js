'use strict';

require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const readline = require('readline');

const {
  AGENT_INSIGHTS_PATH,
  appendAgentInsights,
  callOllama,
  draftReply,
  MORNING_BRIEFING_MODEL,
  ensureMemoryFile,
  readAgentInsights,
  resolveSkillForTask,
  summarizeDiscussion,
  scorePostAgainstSkill,
} = require('./brain');
const {
  DEFAULT_TASK_INPUT_PATH,
  clickLike,
  closeBrowser,
  createNewPost,
  discoverGroups,
  ensureLoggedIn,
  extractGroupIdFromUrl,
  handleJoinGroup,
  humanJitter,
  inspectGroupMembershipStatus,
  isCreatePostComposerVisible,
  isCanonicalGroupUrl,
  isLikelyGroupName,
  launchBrowser,
  postComment,
  readTaskInput,
  scrapeGroupFeed,
  scrapeInboxPreviews,
  scrapeJoinApprovalNotifications,
  scrapeJoinedGroups,
  scrapeNotifications,
  sendInboxReply,
  visitGroup,
} = require('./browser');
const {
  appendThreadHistory,
  closeDatabase,
  completeJob,
  connectDatabase,
  enqueueUniqueJob,
  failJob,
  findGroupByName,
  findLeadByPostId,
  findPostById,
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

function createBrowserLock() {
  let chain = Promise.resolve();
  let activeLabel = null;

  return {
    async runExclusive(label, task) {
      const run = chain.then(async () => {
        activeLabel = label;
        try {
          return await task();
        } finally {
          activeLabel = null;
        }
      });

      chain = run.catch(() => {});
      return run;
    },
    isBusy() {
      return Boolean(activeLabel);
    },
    getActiveLabel() {
      return activeLabel;
    },
  };
}

function isLikelyEnglishGroupName(name = '') {
  return /^[\x00-\x7F\s.,&()'"/|:+-]+$/.test(name);
}

function isRelevantAmazonGroupName(name = '') {
  const text = name.toLowerCase();
  return (
    /(amazon|fba|private label|wholesale|seller|ecommerce|ppc)/i.test(text) &&
    !/(crypto|forex|loan|dating|casino|review group|buyer and seller|virtual assistant|chinese seller|ksa|uae|walmart|ebay|suspension|legal issues)/i.test(text)
  );
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
  const joinedGroups = await scrapeJoinedGroups(page, { limit: 120 });
  if (joinedGroups.length) {
    await saveDiscoveredGroups('__joined_sync__', joinedGroups.map((group) => ({
      ...group,
      status: 'joined',
      source: group.source || 'groups_feed',
    })));
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

  console.log(`Group sync complete. Joined approvals updated: ${updated}. Joined groups synced from feed: ${joinedGroups.length}`);
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

  const scrapedPosts = await scrapeGroupFeed(page, { limit: 30 });
  await updateGroupLastScanned(group.url, new Date());
  state.scrapedPosts += scrapedPosts.length;
  console.log(`Scraped ${scrapedPosts.length} posts from ${group.label}`);

  const found = [];

  for (const scrapedPost of scrapedPosts) {
    const storedPost = await upsertPost({
      post_id: scrapedPost.postId,
      group: group.label,
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
        relevance_score: scoreResult.score,
      });
    }
  }

  return found;
}

async function scanJoinedGroups(page, taskInput, skill, state) {
  const groups = await resolveScannableGroups(page, taskInput);
  const results = [];

  state.resolvedGroups = groups;
  console.log(`Groups to scan: ${groups.length}`);

  if (!groups.length) {
    console.log('No already-joined groups are available to scan. Use `search [keyword]` first or wait for pending approvals.');
  }

  for (const group of groups) {
    try {
      const found = await scanGroupFeed(
        page,
        group,
        skill,
        buildGoalSummary(taskInput),
        state
      );
      results.push(...found);
    } catch (error) {
      state.errors.push(`Group scan failed for ${group.label}: ${error.message}`);
    }
  }

  state.scanResults = results;
  console.log(`Scan complete. Qualified posts found: ${results.length}`);
  return results;
}

async function engageQualifiedPosts(page, skill, state) {
  const { posts } = getCollections();
  const candidates = await posts.find({ status: 'qualified' }).sort({ updated_at: -1 }).lean();

  console.log(`Engage queue size: ${candidates.length}`);

  for (const candidate of candidates) {
    if (!canPerformAction(state, 'like') && !canPerformAction(state, 'comment')) {
      break;
    }

    try {
      await page.goto(`${FACEBOOK_BASE_URL}/groups/search/?view=permalink&id=${candidate.post_id}`, {
        waitUntil: 'domcontentloaded',
        timeout: 90_000,
      });
    } catch (_error) {
      // Fallback: many posts are still visible in the current group view, so we continue.
    }

    if (canPerformAction(state, 'like') && !(await hasInteraction(candidate.post_id, 'like'))) {
      try {
        console.log(`Liking post ${candidate.post_id}`);
        await clickLike(page, candidate.post_id);
        await logInteraction({
          target_id: candidate.post_id,
          type: 'like',
          metadata: {
            group: candidate.group,
            score: candidate.relevance_score,
          },
        });
        state.likes += 1;
        await humanJitter(page, { logLabel: 'Post-like jitter' });
      } catch (error) {
        state.errors.push(`Like failed for ${candidate.post_id}: ${error.message}`);
      }
    }

    if (canPerformAction(state, 'comment') && !(await hasInteraction(candidate.post_id, 'comment'))) {
      try {
        console.log(`Drafting Phase 1 comment for post ${candidate.post_id}`);
        const draft = await draftReply({
          skill,
          post: {
            post_id: candidate.post_id,
            content: candidate.content,
          },
          threadId: candidate.post_id,
          contextSummary: candidate.content,
          tone: 'helpful, consultative, confident, concise',
          phaseOverride: 1,
        });

        console.log(`Posting comment on ${candidate.post_id}`);
        await postComment(page, candidate.post_id, draft.reply);
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

async function handleReplyLoop(page, skill, state, briefing = state.briefing) {
  const notifications = briefing.notifications?.length
    ? briefing.notifications.filter((item) => item.postId)
    : await scrapeNotificationReplies(page);

  console.log(`Notifications found for reply loop: ${notifications.length}`);

  for (const notification of notifications) {
    if (await hasInteraction(notification.postId, 'reply')) {
      continue;
    }

    const originalPost = await findPostById(notification.postId);
    const existingContext = await getContextMemory(notification.postId);
    const existingLead = await findLeadByPostId(notification.postId);

    if (!originalPost && !existingContext) {
      continue;
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
      continue;
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
    await humanJitter(page, { logLabel: 'Reply-loop jitter' });
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

async function scheduleStandardJobs() {
  await enqueueUniqueJob({ type: JOB_TYPES.HOUSEKEEPING });
  await enqueueUniqueJob({ type: JOB_TYPES.SCAN_GROUPS, runAt: new Date(Date.now() + 20_000) });
  await enqueueUniqueJob({ type: JOB_TYPES.ENGAGE, runAt: new Date(Date.now() + 45_000) });
}

async function executeJob(job, page, skill, state, taskInput) {
  switch (job.type) {
    case JOB_TYPES.HOUSEKEEPING:
      return runHousekeeping(page, skill, state);
    case JOB_TYPES.SYNC_GROUPS:
      return syncGroups(page);
    case JOB_TYPES.VERIFY_PENDING:
      return verifyPendingGroups(page);
    case JOB_TYPES.SCAN_GROUPS:
      return scanJoinedGroups(page, taskInput, skill, state);
    case JOB_TYPES.ENGAGE:
      return engageQualifiedPosts(page, skill, state);
    case JOB_TYPES.REPLY:
      return handleReplyLoop(page, skill, state, state.briefing);
    case JOB_TYPES.BRIEF:
      return summarizeInbox(page, skill, state);
    case JOB_TYPES.SEARCH_GROUPS:
      return searchAndJoinGroups(page, job.payload?.keyword || '', skill, state);
    default:
      throw new Error(`Unsupported job type: ${job.type}`);
  }
}

async function runQueuedJobs(lock, page, skill, state, taskInput) {
  await releaseExpiredJobs();

  for (;;) {
    const job = await leaseNextJob('browser-worker-1');
    if (!job) {
      break;
    }

    try {
      const result = await lock.runExclusive(`job:${job.type}`, async () =>
        executeJob(job, page, skill, state, taskInput)
      );
      await completeJob(job._id, result || null);
    } catch (error) {
      state.errors.push(`Job ${job.type} failed: ${error.message}`);
      await failJob(job._id, error);
    }
  }
}

async function summarizeRecentPostsFromDb(limit = 12) {
  const { posts } = getCollections();
  const recentPosts = await posts.find({})
    .sort({ updated_at: -1, created_at: -1 })
    .limit(limit)
    .lean();

  if (!recentPosts.length) {
    return 'No recent scanned posts are saved yet.';
  }

  const samples = recentPosts
    .map((post) => `- [${post.group}] ${String(post.content || '').slice(0, 280)}`)
    .join('\n');

  try {
    const summary = await callOllama([
      'Summarize what people are talking about across these Facebook group posts.',
      'Keep it short and practical in 4 bullet-style lines or fewer.',
      '',
      samples,
    ].join('\n'), {
      model: MORNING_BRIEFING_MODEL,
      timeoutMs: 30_000,
      generationOptions: {
        temperature: 0.2,
        num_ctx: 2048,
        num_predict: 180,
      },
    });

    return summary || 'Recent posts were found, but the summary came back empty.';
  } catch (_error) {
    return `Recent post samples:\n${samples}`;
  }
}

async function answerOperatorQuestion(input, page) {
  const normalized = input.toLowerCase();

  if (/how many groups|total groups|groups joined/.test(normalized)) {
    const joined = await getGroupsByStatus('joined', { limit: 500 });
    const pending = await getGroupsByStatus('pending', { limit: 500 });
    const discovered = await getGroupsByStatus('discovered', { limit: 500 });
    return `Groups in DB: ${joined.length} joined, ${pending.length} pending, ${discovered.length} discovered.`;
  }

  if (/not only amazon|non[- ]amazon|not amazon related|any group.*not.*amazon/.test(normalized)) {
    const joined = await getGroupsByStatus('joined', { limit: 500 });
    const nonAmazon = joined.filter((group) => !isRelevantAmazonGroupName(group.name));
    if (!nonAmazon.length) {
      return 'All joined groups currently saved in DB look Amazon/FBA-related.';
    }

    return `Joined non-Amazon or weak-fit groups:\n${nonAmazon
      .slice(0, 20)
      .map((group) => `- ${group.name}`)
      .join('\n')}`;
  }

  if (/what people are posting|people posting about|what are people talking about|summarize posts/.test(normalized)) {
    return summarizeRecentPostsFromDb();
  }

  if (/what notification|notifications now|show notifications|any notifications/.test(normalized)) {
    const notifications = await scrapeNotifications(page, { limit: 8 });
    if (!notifications.length) {
      return 'No visible notifications were scraped right now.';
    }

    return `Latest notifications:\n${notifications
      .map((item, index) => `${index + 1}. ${item.text}`)
      .join('\n')}`;
  }

  return [
    'I can answer these live console questions right now:',
    '- how many groups total we joined',
    '- any group not only amazon related',
    '- what people are posting about in any group',
    '- what notification we have now',
    '',
    'You can also use commands: status, groups, notifications, posts, scan, engage, reply, sync, exit',
  ].join('\n');
}

function startOperatorConsole({ page, taskInput, skill, state, lock }) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'fb-agent> ',
  });

  let busy = false;

  const run = async (input) => {
    const raw = input.trim();
    if (!raw) {
      return;
    }

    const normalized = raw.toLowerCase();

    if (normalized === 'help') {
      console.log('Commands: status, groups, notifications, posts, brief, sync, verify, search [keyword], scan, engage, reply, exit');
      return;
    }

    if (normalized === 'exit' || normalized === 'quit') {
      rl.close();
      process.exit(0);
    }

    if (busy) {
      console.log('A task is already running. Please wait for it to finish.');
      return;
    }

    busy = true;

    try {
      if (normalized === 'status' || normalized === 'stats') {
        const joined = await getGroupsByStatus('joined', { limit: 500 });
        const pending = await getGroupsByStatus('pending', { limit: 500 });
        const discovered = await getGroupsByStatus('discovered', { limit: 500 });
        const queuedJobs = await getJobsByStatus('queued', { limit: 200 });
        const runningJobs = await getJobsByStatus('running', { limit: 50 });
        console.log(`Status: ${joined.length} joined, ${pending.length} pending, ${discovered.length} discovered, ${queuedJobs.length} queued jobs, ${runningJobs.length} running jobs.`);
      } else if (normalized === 'groups') {
        const joined = await getGroupsByStatus('joined', { limit: 50 });
        if (!joined.length) {
          console.log('No joined groups are saved yet.');
        } else {
          console.log(`Joined groups (${joined.length}):`);
          for (const group of joined.slice(0, 25)) {
            console.log(`- ${group.name}`);
          }
        }
      } else if (normalized === 'notifications') {
        const answer = await lock.runExclusive('operator:notifications', async () =>
          answerOperatorQuestion('what notification we have now', page)
        );
        console.log(answer);
      } else if (normalized === 'posts') {
        console.log(await summarizeRecentPostsFromDb());
      } else if (normalized === 'brief') {
        await enqueueUniqueJob({ type: JOB_TYPES.BRIEF });
        console.log('Queued: brief');
        await runQueuedJobs(lock, page, skill, state, taskInput);
      } else if (normalized === 'sync') {
        await enqueueUniqueJob({ type: JOB_TYPES.SYNC_GROUPS });
        console.log('Queued: sync_groups');
        await runQueuedJobs(lock, page, skill, state, taskInput);
      } else if (normalized === 'verify') {
        await enqueueUniqueJob({ type: JOB_TYPES.VERIFY_PENDING });
        console.log('Queued: verify_pending');
        await runQueuedJobs(lock, page, skill, state, taskInput);
      } else if (normalized === 'scan') {
        await enqueueUniqueJob({ type: JOB_TYPES.SCAN_GROUPS });
        console.log('Queued: scan_groups');
        await runQueuedJobs(lock, page, skill, state, taskInput);
      } else if (normalized === 'engage') {
        await enqueueUniqueJob({ type: JOB_TYPES.ENGAGE });
        console.log('Queued: engage');
        await runQueuedJobs(lock, page, skill, state, taskInput);
      } else if (normalized === 'reply') {
        await enqueueUniqueJob({ type: JOB_TYPES.REPLY });
        console.log('Queued: reply');
        await runQueuedJobs(lock, page, skill, state, taskInput);
      } else if (normalized.startsWith('search ')) {
        const keyword = raw.slice(7).trim();
        await enqueueUniqueJob({
          type: JOB_TYPES.SEARCH_GROUPS,
          payload: { keyword },
        });
        console.log(`Queued: search_groups (${keyword})`);
        await runQueuedJobs(lock, page, skill, state, taskInput);
      } else {
        const answer = await lock.runExclusive('operator:question', async () =>
          answerOperatorQuestion(raw, page)
        );
        console.log(answer);
      }
    } catch (error) {
      console.log(`Command failed: ${error.message}`);
    } finally {
      busy = false;
      rl.prompt();
    }
  };

  rl.on('line', (line) => {
    run(line);
  });

  rl.on('close', () => {
    console.log('Operator console closed.');
  });

  console.log('Operator console ready. Type `help` for commands or ask a plain-English status question.');
  rl.prompt();
  return rl;
}

async function runAssistantSession(options = {}) {
  const taskInputPath = options.taskInputPath || DEFAULT_TASK_INPUT_PATH;
  const taskInput = await readTaskInput(taskInputPath);
  const skill = await resolveSkillForTask(taskInput);
  const todayStart = getStartOfToday();

  await connectDatabase();
  await setupCollections();

  const existingCounts = await getInteractionCountsSince(todayStart);
  const state = createSessionState(existingCounts);
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

    await ensureMemoryFile();
    await scheduleStandardJobs();
    await runQueuedJobs(lock, browser.page, skill, state, taskInput);
    startOperatorConsole({
      page: browser.page,
      taskInput,
      skill,
      state,
      lock,
    });

    setInterval(async () => {
      try {
        await scheduleStandardJobs();
        await runQueuedJobs(lock, browser.page, skill, state, taskInput);
        printSessionSummary(taskInput, skill, state, existingCounts);
      } catch (error) {
        console.error(`Housekeeping interval failed: ${error.message}`);
      }
    }, HOUSEKEEPING_INTERVAL_MS);

    setInterval(async () => {
      try {
        await runQueuedJobs(lock, browser.page, skill, state, taskInput);
      } catch (error) {
        console.error(`Job runner failed: ${error.message}`);
      }
    }, 15_000);

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
