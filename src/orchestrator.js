'use strict';

require('dotenv').config();

const path = require('path');
const readline = require('readline');

const {
  callOllama,
  draftReply,
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
  isCanonicalGroupUrl,
  isLikelyGroupName,
  launchBrowser,
  postComment,
  readTaskInput,
  scrapeGroupFeed,
  scrapeInboxPreviews,
  scrapeNotifications,
  sendInboxReply,
  visitGroup,
} = require('./browser');
const {
  appendThreadHistory,
  closeDatabase,
  connectDatabase,
  findPostById,
  getCollections,
  getContextMemory,
  getDiscoveredGroups,
  getInteractionCountsSince,
  hasInteraction,
  logInteraction,
  markPostStatus,
  saveDiscoveredGroups,
  setupCollections,
  updateContextPhase,
  updatePostScore,
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
  return async function answerJoinQuestions(questions = []) {
    if (!questions.length) {
      return { answers: [], optionHints: [] };
    }

    const prompt = [
      'You are applying to a Facebook Group.',
      'Answer these questions briefly and professionally so an admin will approve you.',
      `Use the context of our business: ${skill.content}`,
      'Return strict JSON with this shape: {"answers":["..."],"optionHints":["..."]}',
      'Keep answers short and credible.',
      '',
      'Questions:',
      ...questions.map((question, index) => `${index + 1}. ${question}`),
    ].join('\n');

    const raw = await callOllama(prompt, {
      generationOptions: {
        temperature: 0.2,
        num_predict: 240,
      },
    });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        answers: questions.map(() => 'I work with Amazon sellers and would love to join the community.'),
        optionHints: [],
      };
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        answers: Array.isArray(parsed.answers) ? parsed.answers : [],
        optionHints: Array.isArray(parsed.optionHints) ? parsed.optionHints : [],
      };
    } catch (_error) {
      return {
        answers: questions.map(() => 'I help Amazon sellers identify hidden losses and would be glad to contribute.'),
        optionHints: [],
      };
    }
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

  return callOllama(prompt, {
    generationOptions: {
      temperature: 0.2,
      num_predict: 120,
    },
  });
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

async function scanGroupFeed(page, group, skill, goalSummary, state, triggerPatterns, answerJoinQuestions) {
  console.log(`Opening group: ${group.label}`);
  await visitGroup(page, group.url);
  state.groupsVisited.push(group.label);

  const joinState = await handleJoinGroup(page, { answerJoinQuestions });
  if (joinState.joined) {
    console.log(`Join requested for group: ${group.label}`);
    state.joinRequests += 1;
    return [];
  }

  const scrapedPosts = await scrapeGroupFeed(page, { limit: 30 });
  state.scrapedPosts += scrapedPosts.length;
  console.log(`Scraped ${scrapedPosts.length} posts from ${group.label}`);

  const found = [];

  for (const scrapedPost of scrapedPosts) {
    const matchedTriggers = triggerPatterns.some((pattern) => pattern.test(scrapedPost.postText));
    if (!matchedTriggers) {
      continue;
    }

    state.triggerMatches += 1;
    console.log(`Trigger matched in post ${scrapedPost.postId} from ${group.label}`);

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
    console.log(`Scored post ${storedPost.post_id}: ${scoreResult.score}/10 (${status})`);

    if (scoreResult.shouldInteract) {
      state.eligiblePosts += 1;
      found.push({
        ...storedPost,
        relevance_score: scoreResult.score,
      });
    }
  }

  return found;
}

async function scanJoinedGroups(page, taskInput, skill, state) {
  const groups = await resolveTargetGroups(page, taskInput);
  const triggerPatterns = buildTriggerPatterns(taskInput);
  const answerJoinQuestions = await answerJoinQuestionsFactory(skill);
  const results = [];

  state.resolvedGroups = groups;
  console.log(`Groups to scan: ${groups.length}`);

  for (const group of groups) {
    try {
      const found = await scanGroupFeed(
        page,
        group,
        skill,
        buildGoalSummary(taskInput),
        state,
        triggerPatterns,
        answerJoinQuestions
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
        state.comments += 1;
        await humanJitter(page, { logLabel: 'Post-comment jitter' });
      } catch (error) {
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

    const draft = await draftReply({
      skill,
      post: {
        post_id: notification.postId,
        content: notification.text,
      },
      threadId: notification.postId,
      contextSummary,
      tone: 'warm, concise, and specific',
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

async function handleManualCommand(command, context) {
  const input = command.trim();
  if (!input) {
    return true;
  }

  if (input === 'exit' || input === 'quit') {
    printSessionSummary(context.taskInput, context.skill, context.state, context.existingCounts);
    return false;
  }

  if (input.startsWith('search ')) {
    const keyword = input.slice(7).trim();
    if (!keyword) {
      console.log('Usage: search [keyword]');
      return true;
    }

    const results = await discoverGroups(context.page, keyword, { maxResults: 5 });
    await saveDiscoveredGroups(keyword, results);
    const answerJoinQuestions = await answerJoinQuestionsFactory(context.skill);

    for (const group of results) {
      console.log(`Search found group: ${group.name} -> ${group.url}`);
      await visitGroup(context.page, group.url);
      await handleJoinGroup(context.page, { answerJoinQuestions });
    }

    return true;
  }

  if (input === 'scan') {
    await scanJoinedGroups(context.page, context.taskInput, context.skill, context.state);
    return true;
  }

  if (input === 'engage') {
    await engageQualifiedPosts(context.page, context.skill, context.state);
    return true;
  }

  if (input === 'reply') {
    await handleReplyLoop(context.page, context.skill, context.state, context.state.briefing);
    return true;
  }

  console.log('Commands: search [keyword], scan, engage, reply, exit');
  return true;
}

async function startCommandLoop(context) {
  console.log('Command mode ready. Commands: search [keyword], scan, engage, reply, exit');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'fb-agent> ',
  });

  rl.prompt();

  for await (const line of rl) {
    try {
      const shouldContinue = await handleManualCommand(line, context);
      if (!shouldContinue) {
        rl.close();
        break;
      }
    } catch (error) {
      console.error(`Command failed: ${error.message}`);
    }

    rl.prompt();
  }
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

  try {
    const browser = await launchBrowser({
      headless: false,
      userDataDir: options.userDataDir || path.join(__dirname, '..', 'user_data'),
    });

    browserContext = browser.context;

    await ensureLoggedIn(browser.page);
    await runMorningBriefing(browser.page, skill, state);

    console.log(`Goal for today: ${buildGoalSummary(taskInput)}`);
    console.log(`Using skill: ${skill.id}`);

    await startCommandLoop({
      page: browser.page,
      skill,
      state,
      taskInput,
      existingCounts,
    });
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
  resolveTargetGroups,
  runAssistantSession,
  runMorningBriefing,
  scanJoinedGroups,
  scrapeNotificationReplies,
};
