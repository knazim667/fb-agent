'use strict';

const readline = require('readline');
const fs = require('fs/promises');
const path = require('path');

const TOOL_NAMES = [
  'dashboard',
  'status',
  'switch_platform',
  'list_groups',
  'search_groups',
  'open_group',
  'scan_current_group',
  'scan_joined_groups',
  'show_posts',
  'like_post',
  'like_random_posts',
  'comment_random_posts',
  'draft_comment',
  'comment_post',
  'check_notifications',
  'reply_notification',
  'draft_post',
  'post_last_draft',
  'reddit_show_posts',
  'reddit_search_posts',
  'reddit_scan_posts',
  'debug_mode',
  'sync_groups',
  'verify_pending_groups',
  'help',
  'exit',
  'answer',
];

function ensureOperatorContext(state) {
  if (!state.operatorContext) {
    state.operatorContext = {
      executionMode: 'confirm',
      debugMode: false,
      currentPlatform: 'facebook',
      currentSurface: 'group',
      currentGroup: null,
      lastListedGroups: [],
      lastPosts: [],
      lastNotifications: [],
      lastDraft: null,
      lastObservedRedditUrl: '',
      conversationHistory: [],
    };
  }

  if (!Array.isArray(state.operatorContext.conversationHistory)) {
    state.operatorContext.conversationHistory = [];
  }

  if (!state.operatorContext.currentSurface) {
    state.operatorContext.currentSurface = 'group';
  }

  if (!state.operatorContext.currentPlatform) {
    state.operatorContext.currentPlatform = 'facebook';
  }

  return state.operatorContext;
}

const STALL_LOG_DIR = path.join(__dirname, '..', '..', 'logs', 'stalls');

async function persistOperatorContext(state, upsertAgentState) {
  if (typeof upsertAgentState !== 'function') {
    return;
  }

  const context = ensureOperatorContext(state);
  await upsertAgentState('operator_context', {
    executionMode: context.executionMode,
    debugMode: Boolean(context.debugMode),
    currentPlatform: context.currentPlatform || 'facebook',
    currentSurface: context.currentSurface || 'group',
    currentGroup: context.currentGroup,
    lastListedGroups: context.lastListedGroups,
    lastPosts: context.lastPosts,
    lastNotifications: context.lastNotifications,
    lastDraft: context.lastDraft,
    lastObservedRedditUrl: context.lastObservedRedditUrl || '',
    conversationHistory: context.conversationHistory.slice(-12),
  });
}

function excerpt(text = '', max = 180) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) {
    return normalized;
  }

  return `${normalized.slice(0, max - 3)}...`;
}

function extractFirstJsonObject(raw = '') {
  const text = String(raw || '');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const match = candidate.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

function asYesNo(value) {
  return value ? 'yes' : 'no';
}

function formatGroups(groups = [], title = 'Groups') {
  if (!groups.length) {
    return `${title}: none`;
  }

  return [
    `${title}:`,
    ...groups.map((group, index) => {
      const activity = group.activity_label ? ` | last active ${group.activity_label}` : '';
      return `${index + 1}. ${group.name} [${group.status || 'joined'}]${activity}`;
    }),
  ].join('\n');
}

function formatPosts(posts = [], title = 'Posts') {
  if (!posts.length) {
    return `${title}: none`;
  }

  return [
    `${title}:`,
    ...posts.map((post, index) => {
      const score = post.relevance_score != null ? ` | score ${post.relevance_score}/10` : '';
      const label = post.title || post.author || 'Unknown';
      return `${index + 1}. ${label}${score}\n   ${excerpt(post.content || post.postText || '', 220)}`;
    }),
  ].join('\n');
}

function formatOriginalPosts(posts = [], title = 'Original posts') {
  if (!posts.length) {
    return `${title}: none`;
  }

  return [
    `I see ${posts.length} original posts.`,
    ...posts.map((post, index) => {
      const number = post.visible_index || index + 1;
      const author = post.title || post.author || 'Unknown';
      const summary = excerpt(post.content || post.postText || '', 220);
      return `Post #${number}: ${author}\n   ${summary}`;
    }),
  ].join('\n');
}

function dedupeGroupsByUrl(groups = []) {
  const seen = new Set();
  const unique = [];
  for (const group of groups) {
    const key = String(group.url || group.group_id || group.id || group.name || '').trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(group);
  }
  return unique;
}

function formatNotifications(notifications = [], title = 'Notifications') {
  if (!notifications.length) {
    return `${title}: none`;
  }

  return [
    `${title}:`,
    ...notifications.map((item, index) => {
      const badges = [
        item.unread ? 'unread' : '',
        item.age_label ? item.age_label : '',
      ].filter(Boolean).join(' | ');
      return `${index + 1}. ${item.text}${badges ? ` [${badges}]` : ''}`;
    }),
  ].join('\n');
}

function activityAgeForGroup(group = {}) {
  const label = String(group.activity_label || '').toLowerCase().trim();
  if (label) {
    if (/few seconds|just now/.test(label)) {
      return 0;
    }
    if (/about an hour|an hour|a hour/.test(label)) {
      return 1;
    }

    const minuteMatch = label.match(/(\d+|an?|few)\s+minutes?/);
    if (minuteMatch) {
      const raw = minuteMatch[1];
      const minutes = raw === 'a' || raw === 'an' ? 1 : raw === 'few' ? 3 : Number(raw);
      return minutes / 60;
    }

    const hourMatch = label.match(/(\d+)\s+hours?/);
    if (hourMatch) {
      return Number(hourMatch[1]);
    }

    const dayMatch = label.match(/(\d+|an?|few)\s+days?/);
    if (dayMatch) {
      const raw = dayMatch[1];
      const days = raw === 'a' || raw === 'an' ? 1 : raw === 'few' ? 3 : Number(raw);
      return days * 24;
    }

    const weekMatch = label.match(/(\d+|an?)\s+weeks?/);
    if (weekMatch) {
      const raw = weekMatch[1];
      const weeks = raw === 'a' || raw === 'an' ? 1 : Number(raw);
      return weeks * 24 * 7;
    }

    const yearMatch = label.match(/(\d+|an?|a)\s+years?/);
    if (yearMatch) {
      const raw = yearMatch[1];
      const years = raw === 'a' || raw === 'an' ? 1 : Number(raw);
      return years * 24 * 365;
    }
  }

  const direct = Number(group.activity_age_hours);
  if (Number.isFinite(direct)) {
    return direct;
  }

  return Number.MAX_SAFE_INTEGER;
}

function normalizeGroupReference(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreGroupReferenceMatch(query = '', candidateName = '') {
  const normalizedQuery = normalizeGroupReference(query);
  const normalizedCandidate = normalizeGroupReference(candidateName);
  if (!normalizedQuery || !normalizedCandidate) {
    return 0;
  }

  if (normalizedQuery === normalizedCandidate) {
    return 1000;
  }

  if (normalizedCandidate.startsWith(normalizedQuery)) {
    return 800 + normalizedQuery.length;
  }

  if (normalizedQuery.startsWith(normalizedCandidate)) {
    return 700 + normalizedCandidate.length;
  }

  if (normalizedCandidate.includes(normalizedQuery)) {
    return 600 + normalizedQuery.length;
  }

  const queryTokens = normalizedQuery.split(' ').filter(Boolean);
  const candidateTokens = new Set(normalizedCandidate.split(' ').filter(Boolean));
  const overlap = queryTokens.filter((token) => candidateTokens.has(token)).length;
  if (!overlap) {
    return 0;
  }

  return 300 + (overlap * 40);
}

function resolveNamedGroup(groups = [], query = '') {
  const candidates = Array.isArray(groups) ? groups : [];
  let best = null;
  let bestScore = 0;

  for (const group of candidates) {
    const score = scoreGroupReferenceMatch(query, group?.name || group?.label || '');
    if (score > bestScore) {
      bestScore = score;
      best = group;
    }
  }

  return bestScore > 0 ? best : null;
}

function addConversationTurn(state, role, text) {
  const context = ensureOperatorContext(state);
  context.conversationHistory.push({
    role,
    text: String(text || '').trim(),
    timestamp: new Date().toISOString(),
  });
  context.conversationHistory = context.conversationHistory.slice(-12);
}

function logDebug(context, message) {
  if (!context?.debugMode) {
    return;
  }
  console.log(`[debug] ${message}`);
}

async function summarizeRecentPostsFromDb(getCollections, callOllama, model, limit = 12) {
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
      model,
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

async function buildDashboard(deps) {
  const {
    getGroupsByStatus,
    getJobsByStatus,
    getCollections,
    getAgentState,
    state,
  } = deps;
  const { leads, interactions } = getCollections();
  const [joined, pending, discovered, queuedJobs, runningJobs, accountSummary] = await Promise.all([
    getGroupsByStatus('joined', { limit: 1000 }),
    getGroupsByStatus('pending', { limit: 1000 }),
    getGroupsByStatus('discovered', { limit: 1000 }),
    getJobsByStatus('queued', { limit: 500 }),
    getJobsByStatus('running', { limit: 100 }),
    getAgentState('account_group_summary'),
  ]);

  const [newLeads, warmLeads, successfulLeads, todaysInteractions] = await Promise.all([
    leads.countDocuments({ status: 'New' }),
    leads.countDocuments({ status: 'Warm' }),
    leads.countDocuments({ interaction_result: 'Success' }),
    interactions.countDocuments({
      timestamp: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
    }),
  ]);

  const totalJoined = accountSummary?.value?.totalJoinedGroups || joined.length;
  const lastSync = accountSummary?.value?.lastFullSyncAt
    ? new Date(accountSummary.value.lastFullSyncAt).toLocaleString()
    : 'never';
  const context = ensureOperatorContext(state || {});

  return [
    '=== Agent Dashboard ===',
    `Mode: ${context.executionMode}`,
    `Platform: ${context.currentPlatform || 'facebook'}`,
    `Current group: ${context.currentGroup?.name || 'none selected'}`,
    `Account-level joined groups: ${totalJoined}`,
    `Tracked groups in DB: ${joined.length} joined, ${pending.length} pending, ${discovered.length} discovered`,
    `Jobs: ${queuedJobs.length} queued, ${runningJobs.length} running`,
    `Leads: ${newLeads} new, ${warmLeads} warm, ${successfulLeads} successful`,
    `Today's interactions: ${todaysInteractions}`,
    `Last full group sync: ${lastSync}`,
  ].join('\n');
}

function inferIntentHeuristically(input) {
  const normalized = String(input || '').trim().toLowerCase();

  if (!normalized) {
    return { type: 'noop' };
  }

  if (normalized === 'help') {
    return { type: 'help' };
  }

  if (normalized === 'debug on') {
    return { type: 'debug_mode', enabled: true };
  }

  if (normalized === 'debug off') {
    return { type: 'debug_mode', enabled: false };
  }

  if (normalized === 'exit' || normalized === 'quit') {
    return { type: 'exit' };
  }

  if (/^(go to|switch to|use)\s+reddit$/.test(normalized)) {
    return { type: 'switch_platform', platform: 'reddit' };
  }

  if (/^(go to|switch to|use)\s+facebook$/.test(normalized)) {
    return { type: 'switch_platform', platform: 'facebook' };
  }

  const redditSubredditMatch = String(input || '').match(/(?:show|give|list|find)\s+(?:me\s+)?(\d+)?\s*(?:recent|latest|top)?\s*posts?\s+(?:from|in)\s+r\/([a-z0-9_]+)/i);
  if (redditSubredditMatch) {
    return {
      type: 'reddit_show_posts',
      subreddit: String(redditSubredditMatch[2] || '').trim(),
      limit: Number(redditSubredditMatch[1] || 0) || undefined,
    };
  }

  const redditSearchMatch = String(input || '').match(/(?:go to\s+reddit\s+and\s+)?(?:find|search|show|give)\s+(?:me\s+)?reddit\s+posts?\s+about\s+(.+)$/i)
    || String(input || '').match(/go to\s+reddit\s+and\s+find\s+posts?\s+about\s+(.+)$/i)
    || String(input || '').match(/(?:find|search|show|give)\s+(?:me\s+)?posts?\s+about\s+(.+?)\s+on\s+reddit$/i);
  if (redditSearchMatch) {
    return {
      type: 'reddit_search_posts',
      query: String(redditSearchMatch[1] || '').trim(),
    };
  }

  if (
    (normalized.includes('group') || normalized.includes('groups')) &&
    /(list|show|give|which|what)/.test(normalized) &&
    /(joined|already|all|amazon|related)/.test(normalized)
  ) {
    const limitMatch = normalized.match(/(?:max(?:imum)?|at least|top|show|give me|list of|of)\s+(\d+)/i)
      || normalized.match(/^(\d+)\s+(?:most\s+active\s+)?groups?/i);
    return {
      type: 'list_groups',
      amazon_only: /amazon|fba|private label|seller/.test(normalized),
      sort_by: (/most active|active .*first/i.test(normalized) || (normalized.includes('active') && /groups?/.test(normalized)))
        ? 'activity'
        : undefined,
      limit: Number(limitMatch?.[1] || 0) || undefined,
    };
  }

  if (/what notifications?|check notifications?|what notification do we have now/i.test(normalized)) {
    return { type: 'check_notifications' };
  }

  if (/unread.*notifications?|notifications?.*unread|mark as read|from today to yesterday|today to yesterday/i.test(normalized)) {
    const limitMatch = normalized.match(/at least\s+(\d+)|show\s+(\d+)|top\s+(\d+)/i);
    return {
      type: 'check_notifications',
      unread_only: /unread/.test(normalized),
      within_hours: /today to yesterday|from today to yesterday|yesterday/.test(normalized) ? 48 : undefined,
      mark_read: /mark as read/.test(normalized),
      limit: Number(limitMatch?.[1] || limitMatch?.[2] || limitMatch?.[3] || 5),
    };
  }

  const draftCommentMatch = normalized.match(/draft (?:a )?comment for post\s+(\d+)/i);
  if (draftCommentMatch) {
    return {
      type: 'draft_comment',
      post_index: Number(draftCommentMatch[1]),
    };
  }

  if (/draft (?:a )?post (?:on|for) (?:my )?feed|draft post on feed|draft a feed post/i.test(normalized)) {
    return {
      type: 'draft_post',
      target: 'feed',
    };
  }

  if (/post (?:the )?(?:last )?draft|publish (?:the )?(?:last )?draft|post it now/i.test(normalized)) {
    return {
      type: 'post_last_draft',
    };
  }

  const draftThenPostToGroupMatch =
    String(input || '').match(
      /draft (?:a )?post about (.+?) and post (?:it )?(?:to|in|on|for) group\s+(\d+)/i
    );
  if (draftThenPostToGroupMatch) {
    return {
      type: 'draft_post',
      target: 'group',
      group_index: Number(draftThenPostToGroupMatch[2]),
      topic: String(draftThenPostToGroupMatch[1] || '').trim() || undefined,
    };
  }

  const draftGroupMatch = String(input || '').match(/draft (?:a )?post .*?(?:on|for) group\s+(\d+)(?:\s+about\s+(.+))?/i)
    || String(input || '').match(/draft (?:a )?post .*?(?:on|for)\s+group\s+(.+?)(?:\s+about\s+(.+))?$/i);
  if (draftGroupMatch) {
    const numericIndex = Number(draftGroupMatch[1]);
    return {
      type: 'draft_post',
      target: 'group',
      group_index: Number.isFinite(numericIndex) && numericIndex > 0 ? numericIndex : undefined,
      group_name: !Number.isFinite(numericIndex) ? String(draftGroupMatch[1] || '').trim() : '',
      topic: String(draftGroupMatch[2] || '').trim() || undefined,
    };
  }

  if (/most active .*groups?|groups? .*most active|active groups? first/i.test(normalized)) {
    const limitMatch = normalized.match(/(?:max(?:imum)?|at least|top|show|give me|list of|of)\s+(\d+)/i);
    return {
      type: 'list_groups',
      amazon_only: /amazon|fba|private label|seller/.test(normalized),
      sort_by: 'activity',
      limit: Number(limitMatch?.[1] || 0) || undefined,
    };
  }

  const randomLikeMatch = String(input || '').match(/like(?:\s+at\s+least)?(?:\s+the)?(?:\s+first)?\s+(\d+)\s+random\s+posts?(?:\s+(?:in|on|for)\s+group\s+(.+))?/i)
    || String(input || '').match(/like(?:\s+at\s+least)?(?:\s+the)?(?:\s+first)?\s+(\d+)\s+posts?(?:\s+(?:in|on|for)\s+group\s+(.+))?/i);
  if (randomLikeMatch) {
    const maybeIndex = Number(randomLikeMatch[2]);
    const fallbackGroupIndex = Number((normalized.match(/\bgroup\s+(\d+)\b/i) || [])[1]);
    return {
      type: 'like_random_posts',
      count: Number(randomLikeMatch[1]),
      selection: /\bfirst\b/i.test(normalized) ? 'first' : 'random',
      group_index: Number.isFinite(maybeIndex) && maybeIndex > 0
        ? maybeIndex
        : (Number.isFinite(fallbackGroupIndex) && fallbackGroupIndex > 0 ? fallbackGroupIndex : undefined),
      group_name: randomLikeMatch[2] && !(Number.isFinite(maybeIndex) && maybeIndex > 0)
        ? randomLikeMatch[2].trim()
        : '',
      surface: /\bhome feed\b|\bmy feed\b|\bthe feed\b|\bfeed\b/i.test(normalized) ? 'feed' : 'group',
    };
  }

  const randomCommentMatch = String(input || '').match(/comment(?:\s+on)?(?:\s+at\s+least)?(?:\s+the)?(?:\s+first)?\s+(\d+)\s+random\s+posts?(?:\s+(?:in|on|for)\s+group\s+(.+))?/i)
    || String(input || '').match(/comm+ment on(?:\s+the)?(?:\s+first)?\s+(\d+)\s+random\s+posts?(?:\s+(?:in|on|for)\s+group\s+(.+))?/i)
    || String(input || '').match(/comment(?:\s+on)?(?:\s+the)?(?:\s+first)?\s+(\d+)\s+posts?(?:\s+(?:in|on|for)\s+group\s+(.+))?/i);
  if (randomCommentMatch) {
    const maybeIndex = Number(randomCommentMatch[2]);
    const fallbackGroupIndex = Number((normalized.match(/\bgroup\s+(\d+)\b/i) || [])[1]);
    return {
      type: 'comment_random_posts',
      count: Number(randomCommentMatch[1]),
      selection: /\bfirst\b/i.test(normalized) ? 'first' : 'random',
      group_index: Number.isFinite(maybeIndex) && maybeIndex > 0
        ? maybeIndex
        : (Number.isFinite(fallbackGroupIndex) && fallbackGroupIndex > 0 ? fallbackGroupIndex : undefined),
      group_name: randomCommentMatch[2] && !(Number.isFinite(maybeIndex) && maybeIndex > 0)
        ? randomCommentMatch[2].trim()
        : '',
      surface: /\bhome feed\b|\bmy feed\b|\bthe feed\b|\bfeed\b/i.test(normalized) ? 'feed' : 'group',
    };
  }

  if (/scan(?: the)? groups?|scan this group|look for leads|find posts?|go on that group and find posts?/i.test(normalized)) {
    return normalized.includes('this group')
      ? { type: 'scan_current_group' }
      : { type: 'scan' };
  }

  const showPostsMatch = String(input || '').match(/(?:show|give|find|list)\s+(?:me\s+)?(?:recent|latest|any|random)?\s*(\d+)?\s*posts?(?:\s+from|\s+in|\s+on)?\s+group\s+(.+)/i);
  if (showPostsMatch) {
    const maybeIndex = Number(showPostsMatch[2]);
    return {
      type: 'show_posts',
      limit: Number(showPostsMatch[1] || 0) || undefined,
      group_index: Number.isFinite(maybeIndex) && maybeIndex > 0 ? maybeIndex : undefined,
      group_name: showPostsMatch[2] && !(Number.isFinite(maybeIndex) && maybeIndex > 0)
        ? showPostsMatch[2].trim()
        : '',
      random: /\brandom\b/i.test(normalized),
      surface: /\bhome feed\b|\bmy feed\b|\bthe feed\b|\bfeed\b/i.test(normalized) ? 'feed' : 'group',
    };
  }

  if (/\b(any|recent|latest|random)\s+posts?\b/i.test(normalized) && /\bgroup\s+\d+\b/i.test(normalized)) {
    const match = normalized.match(/\bgroup\s+(\d+)\b/i);
    return {
      type: 'show_posts',
      group_index: Number(match?.[1] || 0) || undefined,
      random: /\brandom\b/i.test(normalized),
      limit: Number((normalized.match(/\b(\d+)\s+posts?\b/i) || [])[1] || 0) || undefined,
    };
  }

  if (/\b(show|give|find|list)\b/i.test(normalized) && /\bposts?\b/i.test(normalized) && /\b(home feed|my feed|the feed|feed)\b/i.test(normalized)) {
    return {
      type: 'show_posts',
      surface: 'feed',
      random: /\brandom\b/i.test(normalized),
      limit: Number((normalized.match(/\b(\d+)\s+posts?\b/i) || [])[1] || 0) || undefined,
    };
  }

  if (/find groups? for |search groups? |look for groups? /i.test(normalized)) {
    const match = String(input || '').match(/(?:find|search|look for)\s+groups?\s+(?:about|for)?\s*(.+)$/i);
    return {
      type: 'search',
      keyword: match?.[1]?.trim() || '',
    };
  }

  return { type: 'question', text: String(input || '').trim() };
}

async function routeOperatorIntent(input, deps) {
  const heuristic = inferIntentHeuristically(input);
  if (heuristic.type !== 'question') {
    return heuristic;
  }

  return heuristic;
}

function inferDirectActionIntent(input) {
  const intent = inferIntentHeuristically(input);
  const directTypes = new Set([
    'switch_platform',
    'debug_mode',
    'list_groups',
    'check_notifications',
    'show_posts',
    'reddit_show_posts',
    'reddit_search_posts',
    'like_random_posts',
    'comment_random_posts',
    'draft_comment',
    'draft_post',
    'post_last_draft',
  ]);

  return directTypes.has(intent.type) ? intent : null;
}

function inferPlatformScopedIntent(input, context = {}) {
  const normalized = String(input || '').trim().toLowerCase();
  if (!normalized || String(context.currentPlatform || 'facebook').toLowerCase() !== 'reddit') {
    return null;
  }

  const exactTopicMatch = String(input || '').match(
    /(?:find|scan|show|give|list)\s+(?:me\s+)?posts?\s+(?:related\s+)?(?:about|for)\s+(.+)$/i
  ) || String(input || '').match(
    /find\s+post\s+related\s+about\s+(.+)$/i
  );

  if (exactTopicMatch) {
    return {
      tool: 'reddit_scan_posts',
      args: {
        topic: String(exactTopicMatch[1] || '').trim(),
        limit: Number((normalized.match(/\b(\d+)\s+posts?\b/i) || [])[1] || 0) || 10,
      },
    };
  }

  if (/\b(scan|find)\b/.test(normalized) && /\b(posts?|threads?)\b/.test(normalized)) {
    return {
      tool: 'reddit_scan_posts',
      args: {
        limit: Number((normalized.match(/\b(\d+)\s+posts?\b/i) || [])[1] || 0) || 10,
      },
    };
  }

  return null;
}

function normalizePlannerActions(parsed) {
  const actions = Array.isArray(parsed?.actions) ? parsed.actions : [];
  return actions
    .map((action) => ({
      tool: String(action?.tool || '').trim(),
      args: action?.args && typeof action.args === 'object' ? action.args : {},
    }))
    .filter((action) => TOOL_NAMES.includes(action.tool));
}

function plannerToolGuide() {
  return [
    'Available tools:',
    '- dashboard {}',
    '- status {}',
    '- list_groups {"status":"joined|pending|discovered|all","amazon_only":true|false,"limit":number}',
    '- search_groups {"keyword":"text"}',
    '- open_group {"group_index":number,"group_name":"optional"}',
    '- scan_current_group {"topic":"optional"}',
    '- scan_joined_groups {"topic":"optional","limit":number}',
    '- show_posts {"source":"current","group_index":number,"group_name":"optional","limit":number,"random":true|false}',
    '- like_post {"post_index":number}',
    '- like_random_posts {"count":number,"selection":"first|random","group_index":number,"group_name":"optional"}',
    '- comment_random_posts {"count":number,"selection":"first|random","group_index":number,"group_name":"optional"}',
    '- draft_comment {"post_index":number,"instructions":"optional"}',
    '- comment_post {"post_index":number,"instructions":"optional"}',
    '- check_notifications {"comments_only":true|false,"unread_only":true|false,"within_hours":number,"mark_read":true|false,"limit":number}',
    '- reply_notification {"notification_index":number,"instructions":"optional"}',
    '- draft_post {"target":"feed|group","group_index":number,"group_name":"optional","topic":"optional"}',
    '- post_last_draft {}',
    '- debug_mode {"enabled":true|false}',
    '- sync_groups {}',
    '- verify_pending_groups {}',
    '- help {}',
    '- exit {}',
    '- answer {"text":"use only when no tool is needed"}',
  ].join('\n');
}

function buildPlannerContext(message, state, taskInput) {
  const context = ensureOperatorContext(state);
  const workspace = state.workspaceContext || {};
  const lastGroups = (context.lastListedGroups || []).slice(0, 40).map((group, index) => ({
    index: index + 1,
    name: group.name,
    status: group.status,
  }));
  const lastPosts = (context.lastPosts || []).slice(0, 20).map((post, index) => ({
    index: index + 1,
    author: post.author,
    group: post.group,
    score: post.relevance_score ?? null,
    text: excerpt(post.content || post.postText || '', 160),
  }));
  const lastNotifications = (context.lastNotifications || []).slice(0, 20).map((item, index) => ({
    index: index + 1,
    text: excerpt(item.text || '', 180),
  }));
  const history = (context.conversationHistory || []).slice(-8);

  return JSON.stringify({
    task_goal: taskInput?.active_skill || 'general_facebook_management',
    workspace: {
      agents: excerpt(workspace.agents || '', 800),
      soul: excerpt(workspace.soul || '', 600),
      persona: excerpt(workspace.persona || '', 800),
      user: excerpt(workspace.user || '', 600),
      memory: excerpt(workspace.memory || '', 800),
      skill_feedback: excerpt(workspace.skillFeedback || '', 800),
      today_memory: excerpt(workspace.todayMemory || '', 600),
      yesterday_memory: excerpt(workspace.yesterdayMemory || '', 600),
      tools: excerpt(workspace.tools || '', 800),
    },
    execution_mode: context.executionMode,
    debug_mode: Boolean(context.debugMode),
    current_group: context.currentGroup
      ? { name: context.currentGroup.name || context.currentGroup.label, url: context.currentGroup.url }
      : null,
    last_listed_groups: lastGroups,
    last_posts: lastPosts,
    last_notifications: lastNotifications,
    conversation_history: history,
    user_message: message,
  }, null, 2);
}

function buildLoopPlannerContext({
  userMessage,
  state,
  taskInput,
  observations,
  stepNumber,
}) {
  return JSON.stringify({
    step_number: stepNumber,
    task_goal: taskInput?.active_skill || 'general_facebook_management',
    current_context: JSON.parse(buildPlannerContext(userMessage, state, taskInput)),
    observations,
  }, null, 2);
}

async function planOperatorMessage(message, deps) {
  const {
    callOllama,
    model,
    state,
    taskInput,
    objectivePlan,
  } = deps;

  const prompt = [
    'You are the planner for a Facebook account manager agent.',
    'Treat the user message as a top-level objective.',
    'Read the user message, current context, and choose the smallest useful tool plan.',
    'Decompose the objective using the chosen family: business_scan, general_engagement, or drafting.',
    'Understand the meaning, not exact commands.',
    'If the user asks for Amazon-related groups only, use list_groups with amazon_only=true.',
    'If the user refers to a numbered group or post, use the current list indexes from context.',
    'If the user asks to go to a group and then find lead posts, use open_group then scan_current_group.',
    'If the user asks for general Facebook engagement or recent/raw posts, do not force a business-only filter.',
    'If the user asks to draft, show the draft first. Do not publish in the same step unless they explicitly ask to post.',
    'Use the Amazon skill only when the content clearly fits that business context. Otherwise act like a polite high-value human account manager.',
    'If the user asks for a draft, do not post unless execution mode and user intent clearly allow it.',
    'Prefer multi-step plans when the user asks for a sequence.',
    'Do not repeat list_groups if the user is clearly referring to an existing numbered list already in context.',
    'Return JSON only with this shape:',
    '{"assistant_reply":"short optional note","actions":[{"tool":"tool_name","args":{}}]}',
    '',
    plannerToolGuide(),
    '',
    'Examples:',
    'USER: "show me a list of group related to amazon"',
    'JSON: {"assistant_reply":"","actions":[{"tool":"list_groups","args":{"status":"joined","amazon_only":true,"limit":200}}]}',
    'USER: "go to group 1 and find related post about our amazon business and show me all the post you find"',
    'JSON: {"assistant_reply":"","actions":[{"tool":"open_group","args":{"group_index":1}},{"tool":"scan_current_group","args":{"topic":"amazon hidden money leads for our business"}},{"tool":"show_posts","args":{"source":"current"}}]}',
    'USER: "comment on post 2"',
    'JSON: {"assistant_reply":"","actions":[{"tool":"comment_post","args":{"post_index":2}}]}',
    'USER: "show me only amazon related groups"',
    'JSON: {"assistant_reply":"","actions":[{"tool":"list_groups","args":{"status":"joined","amazon_only":true,"limit":200}}]}',
    'USER: "can you give me recent 5 posts from group 2"',
    'JSON: {"assistant_reply":"","actions":[{"tool":"show_posts","args":{"group_index":2,"limit":5}}]}',
    'USER: "like a couple of random posts on group 2"',
    'JSON: {"assistant_reply":"","actions":[{"tool":"like_random_posts","args":{"group_index":2,"count":2}}]}',
    '',
    'Objective plan JSON:',
    JSON.stringify(objectivePlan || {}, null, 2),
    '',
    'Current context JSON:',
    buildPlannerContext(message, state, taskInput),
  ].join('\n');

  const raw = await callOllama(prompt, {
    model,
    timeoutMs: 30_000,
    generationOptions: {
      temperature: 0.1,
      num_ctx: 4096,
      num_predict: 500,
    },
  });

  const jsonText = extractFirstJsonObject(raw);
  if (!jsonText) {
    throw new Error('Planner returned no JSON.');
  }

  const parsed = JSON.parse(jsonText.replace(/'/g, '"'));
  return {
    assistantReply: String(parsed.assistant_reply || '').trim(),
    actions: normalizePlannerActions(parsed),
  };
}

async function decideNextToolStep({
  userMessage,
  deps,
  observations,
  stepNumber,
  objectivePlan = null,
}) {
  const {
    callOllama,
    model,
    state,
    taskInput,
  } = deps;

  const prompt = [
    'You are the reasoning loop for a Facebook account manager agent.',
    'Think step by step, but return JSON only.',
    'Treat the user message as one top-level objective and choose the next best step toward completing it.',
    'Choose exactly one next tool action, or finish.',
    'Use the observations from previous tools to decide the next step.',
    'If the user is referring to a numbered group or post, use the indexes from current context and observations.',
    'Do not restart from the beginning if the needed list is already available in context.',
    'If the user asks for general engagement or raw recent posts, do not narrow it to business-only lead scanning unless they explicitly ask for that.',
    'If the objective family is drafting, do not publish inside the planning loop. Draft first and stop.',
    'When enough information has been gathered, finish with a concise final response.',
    '',
    plannerToolGuide(),
    '',
    'Return one of these JSON shapes only:',
    '{"done":false,"assistant_reply":"optional short note","action":{"tool":"tool_name","args":{}}}',
    '{"done":true,"assistant_reply":"final response to the user"}',
    '',
    'Examples:',
    'USER: "show me a list of group related to amazon"',
    'STEP JSON: {"done":false,"assistant_reply":"","action":{"tool":"list_groups","args":{"status":"joined","amazon_only":true,"limit":200}}}',
    'After observation contains the list,',
    'STEP JSON: {"done":true,"assistant_reply":"Here are the Amazon-related groups currently joined."}',
    'USER: "go to group 1 and find related post about our amazon business and show me all the post you find"',
    'STEP JSON: {"done":false,"assistant_reply":"","action":{"tool":"open_group","args":{"group_index":1}}}',
    'After opening the group,',
    'STEP JSON: {"done":false,"assistant_reply":"","action":{"tool":"scan_current_group","args":{"topic":"amazon hidden money leads for our business"}}}',
    'After scan results are available,',
    'STEP JSON: {"done":false,"assistant_reply":"","action":{"tool":"show_posts","args":{"source":"current"}}}',
    'After showing posts,',
    'STEP JSON: {"done":true,"assistant_reply":"I opened the group and showed the matching posts I found."}',
    '',
    'Objective plan JSON:',
    JSON.stringify(objectivePlan || {}, null, 2),
    '',
    'Loop context JSON:',
    buildLoopPlannerContext({
      userMessage,
      state,
      taskInput,
      observations,
      stepNumber,
    }),
  ].join('\n');

  const raw = await callOllama(prompt, {
    model,
    timeoutMs: 30_000,
    generationOptions: {
      temperature: 0.1,
      num_ctx: 4096,
      num_predict: 350,
    },
  });

  const jsonText = extractFirstJsonObject(raw);
  if (!jsonText) {
    throw new Error('Loop planner returned no JSON.');
  }

  const parsed = JSON.parse(jsonText.replace(/'/g, '"'));
  const action = parsed.action && typeof parsed.action === 'object'
    ? {
        tool: String(parsed.action.tool || '').trim(),
        args: parsed.action.args && typeof parsed.action.args === 'object' ? parsed.action.args : {},
      }
    : null;

  return {
    done: Boolean(parsed.done),
    assistantReply: String(parsed.assistant_reply || '').trim(),
    action: action && TOOL_NAMES.includes(action.tool) ? action : null,
  };
}

async function answerOperatorQuestion(input, deps) {
  const {
    getGroupsByStatus,
    scrapeNotifications,
    page,
    getCollections,
    callOllama,
    model,
  } = deps;
  const normalized = String(input || '').toLowerCase();

  if (/how many groups|total groups|groups joined/.test(normalized)) {
    const joined = await getGroupsByStatus('joined', { limit: 500 });
    return `Tracked joined groups: ${joined.length}.`;
  }

  if (/list groups?|joined groups?/i.test(normalized)) {
    let joined = await getGroupsByStatus('joined', { limit: 200 });
    if (/amazon|fba|private label|seller/.test(normalized)) {
      joined = filterAmazonGroups(joined, deps.isRelevantAmazonGroupName || (() => true));
    }
    return formatGroups(joined.map((group) => ({ ...group, status: 'joined' })), 'Joined groups');
  }

  if (/notifications?/.test(normalized)) {
    const notifications = await scrapeNotifications(page, { limit: 10 });
    return formatNotifications(notifications, 'Latest notifications');
  }

  if (/what people are posting|summarize posts/.test(normalized)) {
    return summarizeRecentPostsFromDb(getCollections, callOllama, model);
  }

  return 'I understood the request as informational, but I need a bit more context to act on it.';
}

function filterAmazonGroups(groups, isRelevantAmazonGroupName) {
  return groups.filter((group) => isRelevantAmazonGroupName(group.name || ''));
}

async function filterPostsByTopic(posts, topic, callOllama, model) {
  if (!topic || !posts.length) {
    return posts;
  }

  const compactPosts = posts.slice(0, 12).map((post, index) => ({
    index: index + 1,
    text: excerpt(post.content || post.postText || '', 180),
  }));

  try {
    const raw = await callOllama([
      'Select which posts are relevant to this business topic.',
      `TOPIC: ${topic}`,
      'Return JSON only like {"keep_indexes":[1,3]}',
      '',
      JSON.stringify(compactPosts, null, 2),
    ].join('\n'), {
      model,
      timeoutMs: 20_000,
      generationOptions: {
        temperature: 0.1,
        num_ctx: 2048,
        num_predict: 120,
      },
    });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0].replace(/'/g, '"')) : null;
    const keep = Array.isArray(parsed?.keep_indexes)
      ? new Set(parsed.keep_indexes.map((value) => Number(value)))
      : null;
    if (!keep || !keep.size) {
      return posts;
    }

    return posts.filter((_post, index) => keep.has(index + 1));
  } catch (_error) {
    return posts;
  }
}

function keywordFilterPosts(posts, topic) {
  const normalizedTopic = String(topic || '').toLowerCase();
  if (!normalizedTopic.trim()) {
    return posts;
  }

  const stopWords = new Set([
    'about', 'our', 'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'your',
    'business', 'posts', 'post', 'find', 'related', 'reddit',
  ]);
  const rawTerms = normalizedTopic.match(/[a-z0-9]{3,}/gi) || [];
  const uniqueTerms = [...new Set(rawTerms.map((term) => term.toLowerCase()).filter((term) => !stopWords.has(term)))];

  if (!uniqueTerms.length) {
    return posts;
  }

  const matches = posts.filter((post) => {
    const haystack = String([
      post.title || '',
      post.content || '',
      post.postText || '',
    ].join(' ')).toLowerCase();
    const hitCount = uniqueTerms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0);
    return hitCount > 0;
  });

  return matches;
}

function startOperatorConsole(deps) {
  const {
    page,
    taskInput,
    skill,
    state,
    lock,
    getGroupsByStatus,
    getJobsByStatus,
    scrapeNotifications,
    markNotificationsRead,
    listVisibleGroups,
    listVisibleNotifications,
    listVisiblePosts,
    listVisibleRedditPosts,
    scrapeGroupFeed,
    scrapeInboxPreviews,
    isRelevantAmazonGroupName,
    getCollections,
    callOllama,
    model,
    getAgentState,
    visitGroup,
    syncGroups,
    verifyPendingGroups,
    searchAndJoinGroups,
    scanJoinedGroups,
    scanSingleGroup,
    engageQualifiedPosts,
    summarizeInbox,
    handleReplyLoop,
    likeQualifiedPost,
    clickLikeOnVisiblePost,
    anchorVisiblePost,
    extractAnchoredPostData,
    likeAnchoredPost,
    draftCommentForCandidate,
    commentOnQualifiedPost,
    commentAnchoredPost,
    planObjective,
    searchRedditPosts,
    inspectRedditSession,
    observeRedditPage,
    saveNewSkill,
    postCommentOnVisiblePost,
    createNewPost,
    createFeedPost,
    scrapeNotificationReplies,
    replyToNotificationItem,
    upsertAgentState,
    humanJitter,
    appendRecoveryLesson,
    visitRedditHome,
    visitSubreddit,
  } = deps;
  const FACEBOOK_HOME_URL = 'https://www.facebook.com/';

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'fb-agent> ',
  });

  const ask = (question) => new Promise((resolve) => rl.question(question, resolve));
  const context = ensureOperatorContext(state);
  let busy = false;

  async function maybeConfirm(label) {
    if (context.executionMode === 'execute') {
      return true;
    }

    if (context.executionMode === 'draft') {
      return false;
    }

    const answer = await ask(`${label}? [y/N]: `);
    return /^y(es)?$/i.test(answer.trim());
  }

  async function storeDraft(draft) {
    context.lastDraft = {
      ...draft,
      createdAt: new Date().toISOString(),
    };
    await persistOperatorContext(state, upsertAgentState);
  }

  async function handleStall({ page, goal, step, lastError }) {
    await fs.mkdir(STALL_LOG_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotPath = path.join(STALL_LOG_DIR, `stall_${timestamp}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.log(`ALERT: I am stuck. Check the screenshot in ./logs/stalls/. Provide a HINT to continue (e.g., 'click the X' or 'refresh').`);
    const hint = (await ask('HINT> ')).trim();
    if (!hint) {
      return { handled: false };
    }

    if (typeof appendRecoveryLesson === 'function') {
      await appendRecoveryLesson(hint, {
        goal,
        step,
        lastError,
        screenshotPath,
      });
    }

    return {
      handled: true,
      hint,
    };
  }

  function currentPosts() {
    return Array.isArray(context.lastPosts) ? context.lastPosts : [];
  }

  async function runAnchoredActionWithRecovery(label, visibleIndex, runner) {
    try {
      return await runner();
    } catch (error) {
      const stall = await handleStall({
        page,
        goal: label,
        step: visibleIndex,
        lastError: error.message,
      });
      if (stall?.handled) {
        return runner();
      }
      throw error;
    }
  }

  function currentNotifications() {
    return Array.isArray(context.lastNotifications) ? context.lastNotifications : [];
  }

  async function openHomeFeed() {
    await page.goto(FACEBOOK_HOME_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });
    await page.waitForLoadState('networkidle').catch(() => null);
    await page.waitForTimeout(3_000);
    context.currentPlatform = 'facebook';
    context.currentSurface = 'feed';
    context.currentGroup = null;
    context.lastPosts = [];
    context.lastObservedRedditUrl = '';
  }

  async function openRedditHome() {
    if (typeof visitRedditHome === 'function') {
      await visitRedditHome();
    }
    context.currentPlatform = 'reddit';
    context.currentSurface = 'reddit_home';
    context.currentGroup = null;
    context.lastPosts = [];
    context.lastObservedRedditUrl = '';
  }

  async function observePlatformPage(options = {}) {
    if (String(context.currentPlatform || 'facebook').toLowerCase() === 'reddit' && typeof observeRedditPage === 'function') {
      const observation = await observeRedditPage(options);
      context.currentSurface = observation.state || context.currentSurface || 'reddit_unknown';
      return observation;
    }

    return {
      platform: 'facebook',
      state: context.currentSurface === 'group' ? 'facebook_group_feed' : 'facebook_feed',
      url: page.url(),
    };
  }

  function planNextAction({ goal, observation, args = {} }) {
    if (observation?.platform !== 'reddit') {
      return { type: 'none' };
    }

    if (observation.state === 'reddit_login') {
      return { type: 'answer', message: 'You are not logged in on Reddit yet. Please log in first, then tell me what you want me to do on Reddit.' };
    }

    if (goal === 'switch_platform') {
      return { type: 'none' };
    }

    if (goal === 'reddit_scan_posts') {
      const topic = String(args.topic || '').trim();
      if (observation.state === 'reddit_home' && !topic) {
        return { type: 'answer', message: 'I am on the Reddit home page right now. Tell me a subreddit like r/FulfillmentByAmazon or ask me to search Reddit for a topic.' };
      }
      if (observation.state === 'reddit_home' && topic) {
        return { type: 'search', query: topic };
      }
    }

    return { type: 'none' };
  }

  async function executePlannedAction(plan) {
    if (!plan || plan.type === 'none') {
      return null;
    }

    if (plan.type === 'search') {
      await lock.runExclusive('operator:reddit-plan-search', async () => {
        await searchRedditPosts(plan.query);
      });
      context.currentPlatform = 'reddit';
      context.currentSurface = `reddit_search_results:${plan.query}`;
      context.currentGroup = null;
      context.lastPosts = [];
      return { type: 'search', query: plan.query };
    }

    return null;
  }

  async function verifyOutcome({ expectedStates = [] } = {}) {
    const observation = await observePlatformPage();
    const ok = !expectedStates.length || expectedStates.includes(observation.state);
    return {
      ok,
      observation,
    };
  }

  function storeRedditPosts(posts = []) {
    context.lastPosts = posts.map((post) => ({
      post_id: post.postId,
      post_url: post.postUrl,
      content: post.postText,
      title: post.title,
      author: post.authorName || 'Unknown',
      visible_index: post.visibleIndex,
      platform: 'reddit',
      subreddit: post.subreddit || '',
    }));
  }

  async function resolveTargetGroup(args = {}) {
    if (Number.isFinite(Number(args.group_index))) {
      return context.lastListedGroups[Number(args.group_index) - 1] || null;
    }

    if (!args.group_name) {
      return null;
    }

    const preferred = resolveNamedGroup(context.lastListedGroups, args.group_name);
    if (preferred) {
      return preferred;
    }

    const allJoined = await getGroupsByStatus('joined', { limit: 500 });
    return resolveNamedGroup(allJoined, args.group_name);
  }

  async function executeTool(action) {
    const tool = action.tool;
    const args = action.args || {};

    if (tool === 'help') {
      return [
        'You can ask naturally, for example:',
        '- go to reddit',
        '- show me 10 recent posts from r/FulfillmentByAmazon',
        '- find reddit posts about amazon reimbursement',
        '- give me the list of joined groups',
        '- show only amazon groups',
        '- go to group 12 and find amazon lead posts',
        '- comment on post 2',
        '- draft a post for this group',
        '- check comments on our posts',
        '- debug on',
        '- debug off',
      ].join('\n');
    }

    if (tool === 'answer') {
      return String(args.text || '').trim() || 'No action needed.';
    }

    if (tool === 'dashboard') {
      return buildDashboard({
        getGroupsByStatus,
        getJobsByStatus,
        getCollections,
        getAgentState,
        state,
      });
    }

    if (tool === 'status') {
      const joined = await getGroupsByStatus('joined', { limit: 500 });
      const pending = await getGroupsByStatus('pending', { limit: 500 });
      const discovered = await getGroupsByStatus('discovered', { limit: 500 });
      return `Status: ${joined.length} joined, ${pending.length} pending, ${discovered.length} discovered. Mode: ${context.executionMode}. Platform: ${context.currentPlatform || 'facebook'}. Current group: ${context.currentGroup?.name || 'none'}.`;
    }

    if (tool === 'switch_platform') {
      const platform = String(args.platform || 'facebook').toLowerCase() === 'reddit' ? 'reddit' : 'facebook';
      if (platform === 'reddit') {
        await lock.runExclusive('operator:switch-platform-reddit', async () => {
          await openRedditHome();
        });
        const observation = await observePlatformPage();
        await persistOperatorContext(state, upsertAgentState);
        if (observation?.state === 'reddit_login' || observation?.needsLogin) {
          return 'Switched to Reddit. You do not look logged in there yet. Please log in first, then tell me what you want me to do on Reddit.';
        }
        if (observation?.uncertain) {
          return 'Switched to Reddit. I could not confirm the login state yet. If you want replies or posting there, please make sure you are logged in first. Then tell me what you want me to do on Reddit.';
        }
        return 'Switched to Reddit. What do you want me to do on Reddit?';
      }

      await lock.runExclusive('operator:switch-platform-facebook', async () => {
        await openHomeFeed();
      });
      context.currentPlatform = 'facebook';
      await persistOperatorContext(state, upsertAgentState);
      return 'Switched to Facebook.';
    }

    if (tool === 'debug_mode') {
      context.debugMode = Boolean(args.enabled);
      await persistOperatorContext(state, upsertAgentState);
      return `Debug mode is now ${context.debugMode ? 'ON' : 'OFF'}.`;
    }

    if (tool === 'list_groups') {
      const requestedStatus = String(args.status || 'all').toLowerCase();
      const limit = Math.max(1, Math.min(Number(args.limit || 200), 500));
      const fetchLimit = args.amazon_only ? Math.max(limit * 5, 100) : limit;
      let groups = [];

      if (requestedStatus === 'all') {
        const [joined, pending, discovered] = await Promise.all([
          getGroupsByStatus('joined', { limit: fetchLimit }),
          getGroupsByStatus('pending', { limit: fetchLimit }),
          getGroupsByStatus('discovered', { limit: fetchLimit }),
        ]);
        groups = [
          ...joined.map((group) => ({ ...group, status: 'joined' })),
          ...pending.map((group) => ({ ...group, status: 'pending' })),
          ...discovered.map((group) => ({ ...group, status: 'discovered' })),
        ];
      } else {
        groups = (await getGroupsByStatus(requestedStatus, { limit: fetchLimit }))
          .map((group) => ({ ...group, status: requestedStatus }));
      }

      if ((requestedStatus === 'joined' || requestedStatus === 'all') && typeof listVisibleGroups === 'function') {
        const liveJoined = await lock.runExclusive('operator:list-visible-groups', async () =>
          listVisibleGroups({ limit: Math.max(limit, 50), scrollRounds: 8 })
        ).catch(() => []);

        if (liveJoined.length) {
          const liveMap = new Map(
            liveJoined.map((group) => [
              String(group.url || group.name || '').trim().toLowerCase(),
              group,
            ])
          );
          groups = groups.map((group) => {
            const key = String(group.url || group.name || '').trim().toLowerCase();
            const live = liveMap.get(key);
            return live ? { ...group, ...live, status: group.status || 'joined' } : group;
          });
        }
      }

      if (args.amazon_only) {
        groups = filterAmazonGroups(groups, isRelevantAmazonGroupName);
      }

      groups = dedupeGroupsByUrl(groups);

      if (args.sort_by === 'activity') {
        groups = groups.sort((left, right) => {
          const leftAge = activityAgeForGroup(left);
          const rightAge = activityAgeForGroup(right);
          return leftAge - rightAge;
        });
      }

      logDebug(context, `list_groups produced ${groups.length} groups before slicing to ${limit}.`);

      groups = groups.slice(0, limit);

      context.currentPlatform = 'facebook';
      context.lastListedGroups = groups;
      await persistOperatorContext(state, upsertAgentState);
      return formatGroups(groups, args.amazon_only ? 'Amazon-matching groups' : 'Tracked groups');
    }

    if (tool === 'search_groups') {
      const keyword = String(args.keyword || '').trim();
      if (!keyword) {
        return 'I need a keyword to search for groups.';
      }

      const result = await lock.runExclusive('operator:search-groups', async () =>
        searchAndJoinGroups(keyword)
      );
      return `Search complete for "${keyword}". Discovered ${result.discovered}, joined ${result.joinedCount}, pending ${result.pendingCount}.`;
    }

    if (tool === 'open_group') {
      const group = await resolveTargetGroup(args);

      if (!group) {
        return 'I could not find that group in the current list. Ask me to list groups first, or mention the group name more clearly.';
      }

      await lock.runExclusive('operator:open-group', async () => {
        await visitGroup(page, group.url);
      });
      context.currentPlatform = 'facebook';
      context.currentSurface = 'group';
      context.currentGroup = group;
      context.lastPosts = [];
      logDebug(context, `Opened group URL: ${group.url || 'unknown-url'}`);
      await persistOperatorContext(state, upsertAgentState);
      return `Opened group: ${group.name}`;
    }

    if (tool === 'scan_current_group') {
      if (!context.currentGroup?.url) {
        return 'No current group is selected yet. Ask me to list groups or open a specific group first.';
      }

      const results = await lock.runExclusive('operator:scan-current-group', async () =>
        scanSingleGroup({
          id: context.currentGroup.group_id || context.currentGroup.id,
          url: context.currentGroup.url,
          label: context.currentGroup.name || context.currentGroup.label,
          keyword: context.currentGroup.keyword || null,
          status: context.currentGroup.status || 'joined',
        }, {
          topic: args.topic || '',
          onStall: handleStall,
        })
      );
      const filteredPosts = await filterPostsByTopic(results, args.topic || '', callOllama, model);
      if (context.debugMode) {
        const matchedIds = new Set(filteredPosts.map((post, index) => String(post.post_id || post.postId || post.visible_index || index + 1)));
        results.forEach((post, index) => {
          const id = String(post.post_id || post.postId || post.visible_index || index + 1);
          logDebug(
            context,
            `scan post ${id}: ${matchedIds.has(id) ? 'matched business topic' : 'filtered out'} | ${excerpt(post.content || post.postText || '', 120)}`
          );
        });
      }
      context.lastPosts = filteredPosts;
      await persistOperatorContext(state, upsertAgentState);
      return formatOriginalPosts(context.lastPosts, `Matched posts in ${context.currentGroup.name || context.currentGroup.label}`);
    }

    if (tool === 'scan_joined_groups') {
      const results = await lock.runExclusive('operator:scan-joined-groups', async () => scanJoinedGroups());
      context.lastPosts = await filterPostsByTopic(results, args.topic || '', callOllama, model);
      await persistOperatorContext(state, upsertAgentState);
      return formatPosts(context.lastPosts, 'Qualified posts from joined groups');
    }

    if (tool === 'show_posts') {
      if (String(args.surface || '').toLowerCase() === 'feed') {
        await lock.runExclusive('operator:open-feed-for-show-posts', async () => {
          await openHomeFeed();
        });
      } else if (Number.isFinite(Number(args.group_index)) || args.group_name) {
        const selected = await resolveTargetGroup(args);
        if (selected?.url) {
          await lock.runExclusive('operator:open-group-for-show-posts', async () => {
            await visitGroup(page, selected.url);
          });
          context.currentPlatform = 'facebook';
          context.currentSurface = 'group';
          context.currentGroup = selected;
          context.lastPosts = [];
        }
      }

      if (currentPosts().length) {
        const chosenPosts = args.random
          ? [...currentPosts()].sort(() => Math.random() - 0.5).slice(0, Math.max(1, Number(args.limit || 5)))
          : currentPosts().slice(0, Math.max(1, Number(args.limit || currentPosts().length)));
        return formatOriginalPosts(chosenPosts, 'Current posts');
      }
      if ((context.currentSurface === 'feed' || context.currentGroup?.url) && typeof listVisiblePosts === 'function') {
        const visiblePostsResult = await lock.runExclusive('operator:list-visible-posts', async () =>
          listVisiblePosts({
            limit: Math.max(1, Number(args.limit || 12)),
            scrollRounds: 3,
            returnMeta: true,
            validationMode: 'engagement',
          })
        );
        const visiblePosts = Array.isArray(visiblePostsResult?.posts) ? visiblePostsResult.posts : [];
        if (context.debugMode) {
          const debugInfo = visiblePostsResult?.debug || {};
          logDebug(
            context,
            `visible post scan: mode=${debugInfo.pageMode || 'unknown'}, articles=${debugInfo.articleCount || 0}, kept=${debugInfo.keptCount || 0}`
          );
          logDebug(
            context,
            `visible post debug: url=${debugInfo.url || page.url()} feed_container=${debugInfo.feedContainerStatus?.found ? 'yes' : 'no'} top_level_articles=${debugInfo.feedContainerStatus?.topLevelArticleCount || 0} validation=${debugInfo.validationMode || 'engagement'}`
          );
          for (const rejection of (debugInfo.rejections || []).slice(0, 20)) {
            logDebug(
              context,
              `rejected article ${rejection.articleIndex}: ${rejection.reason}${rejection.detail ? ` (${rejection.detail})` : ''}`
            );
          }
          if (!visiblePosts.length && debugInfo.rejections?.[0]?.sampleText) {
            logDebug(context, `first rejected article text: ${debugInfo.rejections[0].sampleText}`);
          }
        }
        if (visiblePosts.length) {
          visiblePosts.forEach((post) => {
            logDebug(
              context,
              `visible post ${post.postId || post.visibleIndex}: accepted as original post anchor`
            );
          });
          context.lastPosts = visiblePosts.map((post) => ({
            post_id: post.postId,
            post_url: post.postUrl,
            content: post.postText,
            author: post.authorName || 'Unknown',
            visible_index: post.visibleIndex,
            selector_id: post.selectorId || '',
            group: context.currentGroup?.name || context.currentGroup?.label || '',
          }));
          await persistOperatorContext(state, upsertAgentState);
          const chosenPosts = args.random
            ? [...context.lastPosts].sort(() => Math.random() - 0.5).slice(0, Math.max(1, Number(args.limit || 5)))
            : context.lastPosts.slice(0, Math.max(1, Number(args.limit || context.lastPosts.length)));
          return formatOriginalPosts(
            chosenPosts,
            context.currentSurface === 'feed'
              ? 'Visible posts in your home feed'
              : `Visible posts in ${context.currentGroup.name || context.currentGroup.label}`
          );
        }
      }
      if (context.currentGroup?.name) {
        return `I opened ${context.currentGroup.name}, but I could not read visible original posts right now.`;
      }
      if (context.currentSurface === 'feed') {
        return 'I opened your home feed, but I could not read visible original posts right now.';
      }
      return summarizeRecentPostsFromDb(getCollections, callOllama, model);
    }

    if (tool === 'reddit_show_posts') {
      const subreddit = String(args.subreddit || '').trim();
      if (!subreddit) {
        return 'I need a subreddit name like r/FulfillmentByAmazon.';
      }

      await lock.runExclusive('operator:reddit-open-subreddit', async () => {
        await visitSubreddit(subreddit);
      });
      context.currentPlatform = 'reddit';
      context.currentSurface = `reddit_subreddit_feed:${subreddit}`;
      context.currentGroup = null;

      const observation = await observePlatformPage({
        includePosts: true,
        limit: Math.max(1, Number(args.limit || 10)),
        scrollRounds: 2,
      });
      const posts = Array.isArray(observation?.posts) ? observation.posts : [];
      if (context.debugMode) {
        logDebug(
          context,
          `reddit observe: state=${observation?.state || 'unknown'} url=${observation?.url || page.url()} cards=${observation?.postsDebug?.articleCount || observation?.articleCount || 0} kept=${observation?.postsDebug?.keptCount || posts.length}`
        );
      }
      storeRedditPosts(posts.map((post) => ({ ...post, subreddit: post.subreddit || subreddit })));
      context.lastObservedRedditUrl = observation?.url || page.url();
      await persistOperatorContext(state, upsertAgentState);

      if (observation?.state === 'reddit_login' || observation?.needsLogin) {
        return 'Reddit opened, but you are not logged in there yet. Please log in first, then ask again.';
      }
      if (!context.lastPosts.length) {
        return `I opened r/${subreddit}, but I couldn't find visible Reddit posts right now.`;
      }

      return formatOriginalPosts(
        context.lastPosts.slice(0, Math.max(1, Number(args.limit || context.lastPosts.length))),
        `Visible posts in r/${subreddit}`
      );
    }

    if (tool === 'reddit_search_posts') {
      const query = String(args.query || '').trim();
      if (!query) {
        return 'I need a Reddit search query.';
      }

      await lock.runExclusive('operator:reddit-search', async () => {
        await searchRedditPosts(query);
      });
      context.currentPlatform = 'reddit';
      context.currentSurface = `reddit_search_results:${query}`;
      context.currentGroup = null;

      const verification = await verifyOutcome({
        expectedStates: ['reddit_search_results', 'reddit_subreddit_feed', 'reddit_post_detail'],
      });
      const observation = await observePlatformPage({
        includePosts: true,
        limit: Math.max(1, Number(args.limit || 10)),
        scrollRounds: 2,
      });
      const posts = Array.isArray(observation?.posts) ? observation.posts : [];
      if (context.debugMode) {
        logDebug(
          context,
          `reddit observe: state=${observation?.state || 'unknown'} url=${observation?.url || page.url()} verify=${verification.ok ? 'ok' : 'mismatch'} cards=${observation?.postsDebug?.articleCount || observation?.articleCount || 0} kept=${observation?.postsDebug?.keptCount || posts.length}`
        );
      }
      storeRedditPosts(posts);
      context.lastObservedRedditUrl = observation?.url || page.url();
      await persistOperatorContext(state, upsertAgentState);

      if (observation?.state === 'reddit_login' || observation?.needsLogin) {
        return 'Reddit search opened, but you are not logged in there yet. Please log in first, then ask again.';
      }
      if (!context.lastPosts.length) {
        return `I searched Reddit for "${query}", but I couldn't find visible posts right now.`;
      }

      return formatOriginalPosts(context.lastPosts, `Reddit posts for "${query}"`);
    }

    if (tool === 'reddit_scan_posts') {
      if (context.currentPlatform !== 'reddit') {
        return 'Switch to Reddit first, then I can scan the current Reddit page.';
      }

      const topic = String(args.topic || '').trim();
      let observation = await observePlatformPage();
      if (context.debugMode) {
        logDebug(
          context,
          `reddit observe: state=${observation?.state || 'unknown'} url=${observation?.url || page.url()} logged_in=${observation?.loggedIn ? 'yes' : 'no'} search_visible=${observation?.searchVisible ? 'yes' : 'no'}`
        );
      }

      const plan = planNextAction({
        goal: 'reddit_scan_posts',
        observation,
        args,
      });

      if (plan.type === 'answer') {
        return plan.message;
      }

      if (plan.type !== 'none') {
        await executePlannedAction(plan);
        const verified = await verifyOutcome({
          expectedStates: ['reddit_search_results', 'reddit_subreddit_feed', 'reddit_post_detail'],
        });
        observation = verified.observation;
        if (!verified.ok && context.debugMode) {
          logDebug(context, `reddit verify: expected search/subreddit/detail but saw ${observation?.state || 'unknown'}`);
        }
      }

      let posts = currentPosts().filter((post) => String(post.platform || '').toLowerCase() === 'reddit');
      const currentUrl = page.url();
      const cachedUrl = String(context.lastObservedRedditUrl || '');
      if (!posts.length || (currentUrl && cachedUrl && currentUrl !== cachedUrl)) {
        observation = await observePlatformPage({
          includePosts: true,
          limit: Math.max(1, Number(args.limit || 10)),
          scrollRounds: 2,
        });
        posts = Array.isArray(observation?.posts) ? observation.posts.map((post) => ({
          post_id: post.postId,
          post_url: post.postUrl,
          content: post.postText,
          title: post.title,
          author: post.authorName || 'Unknown',
          visible_index: post.visibleIndex,
          platform: 'reddit',
          subreddit: post.subreddit || '',
        })) : [];
        if (context.debugMode) {
          logDebug(
            context,
            `reddit observe: state=${observation?.state || 'unknown'} url=${observation?.url || page.url()} cards=${observation?.postsDebug?.articleCount || observation?.articleCount || 0} kept=${observation?.postsDebug?.keptCount || posts.length}`
          );
        }
        context.lastPosts = posts;
        context.lastObservedRedditUrl = observation?.url || currentUrl;
        await persistOperatorContext(state, upsertAgentState);
      }

      const keywordMatched = topic ? keywordFilterPosts(posts, topic) : posts;
      const filtered = topic && keywordMatched.length
        ? await filterPostsByTopic(keywordMatched, topic, callOllama, model)
        : keywordMatched;
      const limit = Math.max(1, Number(args.limit || filtered.length || 10));

      if (!filtered.length) {
        return topic
          ? `I checked the current Reddit posts but found nothing clearly related to "${topic}".`
          : 'I checked the current Reddit posts, but I could not find visible posts right now.';
      }

      return formatOriginalPosts(
        filtered.slice(0, limit),
        topic ? `Matched Reddit posts for "${topic}"` : 'Visible Reddit posts'
      );
    }

    if (tool === 'like_post') {
      const post = currentPosts()[Number(args.post_index) - 1];
      if (!post) {
        return 'That post number is not in the current post list.';
      }

      const allowed = await maybeConfirm(`Like post ${args.post_index}`);
      if (!allowed) {
        return context.executionMode === 'draft'
          ? `Draft mode: I would like post ${args.post_index} from ${post.author || 'Unknown'}.`
          : 'Like cancelled.';
      }

      await lock.runExclusive('operator:like-post', async () => {
        if (Number.isFinite(Number(post.visible_index)) && typeof likeAnchoredPost === 'function') {
          await runAnchoredActionWithRecovery('Like anchored post', Number(post.visible_index), () =>
            likeAnchoredPost(Number(post.visible_index), { selectorId: post.selector_id || '' })
          );
        } else if (Number.isFinite(Number(post.visible_index)) && typeof clickLikeOnVisiblePost === 'function') {
          await clickLikeOnVisiblePost(Number(post.visible_index));
        } else {
          await likeQualifiedPost(post);
        }
      });
      await humanJitter(page, { logLabel: 'Manual like jitter' });
      return `Liked post ${args.post_index}.`;
    }

    if (tool === 'like_random_posts') {
      const requestedCount = Math.max(1, Math.min(Number(args.count || 1), 20));
      const selection = String(args.selection || 'random').toLowerCase() === 'first' ? 'first' : 'random';
      const surface = String(args.surface || '').toLowerCase() === 'feed' ? 'feed' : 'group';
      let targetGroup = surface === 'group' ? (await resolveTargetGroup(args)) || context.currentGroup || null : null;

      if (surface === 'feed') {
        await lock.runExclusive('operator:open-feed-for-random-likes', async () => {
          await openHomeFeed();
        });
      } else if (!targetGroup?.url) {
        return 'I need a valid joined group first. Open one first, or include the group name more clearly.';
      } else {
        await lock.runExclusive('operator:open-group-for-random-likes', async () => {
          await visitGroup(page, targetGroup.url);
        });
        context.currentPlatform = 'facebook';
        context.currentSurface = 'group';
        context.currentGroup = targetGroup;
        context.lastPosts = [];
      }

      let recentPosts = await lock.runExclusive('operator:scrape-random-like-posts', async () =>
        (typeof listVisiblePosts === 'function'
          ? listVisiblePosts({ limit: Math.max(requestedCount * 2, 12), scrollRounds: 2, validationMode: 'engagement' })
          : scrapeGroupFeed(page, { limit: Math.max(requestedCount * 2, 12), scrollRounds: 2, validationMode: 'engagement' }))
      );

      if (recentPosts.length < requestedCount) {
        recentPosts = await lock.runExclusive('operator:scrape-random-like-posts-more', async () =>
          (typeof listVisiblePosts === 'function'
            ? listVisiblePosts({ limit: Math.max(requestedCount * 3, 15), scrollRounds: 5, validationMode: 'engagement' })
            : scrapeGroupFeed(page, { limit: Math.max(requestedCount * 3, 15), scrollRounds: 5, validationMode: 'engagement' }))
        );
      }

      if (!recentPosts.length) {
        await persistOperatorContext(state, upsertAgentState);
        return `I opened ${surface === 'feed' ? 'your home feed' : targetGroup.name}, but I couldn't find visible posts to like right now.`;
      }

      let likedCount = 0;
      const errors = [];
      const candidatePosts = selection === 'first'
        ? [...recentPosts].sort((left, right) => Number(left.visibleIndex || 0) - Number(right.visibleIndex || 0))
        : [...recentPosts].sort(() => Math.random() - 0.5);

      candidatePosts.forEach((post) => {
        logDebug(
          context,
          `like candidate ${post.postId || post.visibleIndex}: visibleIndex=${post.visibleIndex} selection=${selection} controls=${(post.controlNames || []).join(',') || 'none'}`
        );
      });

      for (const post of candidatePosts) {
        if (likedCount >= requestedCount) {
          break;
        }

        try {
          await lock.runExclusive(`operator:random-like:${post.postId || post.visibleIndex}`, async () => {
            if (Number.isFinite(Number(post.visibleIndex)) && typeof likeAnchoredPost === 'function') {
              await runAnchoredActionWithRecovery('Like random anchored post', Number(post.visibleIndex), () =>
                likeAnchoredPost(Number(post.visibleIndex), { selectorId: post.selectorId || '' })
              );
            } else if (Number.isFinite(Number(post.visibleIndex)) && typeof clickLikeOnVisiblePost === 'function') {
              await clickLikeOnVisiblePost(Number(post.visibleIndex));
            } else {
              await likeQualifiedPost({
                post_id: post.postId,
                post_url: post.postUrl,
                group: targetGroup.name,
                author: post.authorName,
                content: post.postText,
              });
            }
          });
          likedCount += 1;
          console.log(`Finished ${likedCount}/${requestedCount}, looking for the next post.`);
          await humanJitter(page, { logLabel: 'Random like jitter' });
        } catch (error) {
          errors.push(`${post.postId}: ${error.message}`);
        }
      }

      await persistOperatorContext(state, upsertAgentState);
      return errors.length
        ? `Liked ${likedCount}/${requestedCount} ${selection === 'first' ? 'visible' : 'random'} posts in ${surface === 'feed' ? 'your home feed' : targetGroup.name}.\nErrors:\n- ${errors.slice(0, 3).join('\n- ')}`
        : `Liked ${likedCount} ${selection === 'first' ? 'visible' : 'random'} posts in ${surface === 'feed' ? 'your home feed' : targetGroup.name}.`;
    }

    if (tool === 'comment_random_posts') {
      const requestedCount = Math.max(1, Math.min(Number(args.count || 1), 10));
      const selection = String(args.selection || 'random').toLowerCase() === 'first' ? 'first' : 'random';
      const surface = String(args.surface || '').toLowerCase() === 'feed' ? 'feed' : 'group';
      let targetGroup = surface === 'group' ? (await resolveTargetGroup(args)) || context.currentGroup || null : null;

      const allowed = await maybeConfirm(
        `Post comments on up to ${requestedCount} random posts in ${surface === 'feed' ? 'your home feed' : targetGroup?.name}`
      );
      if (!allowed) {
        return `Cancelled random comments for ${surface === 'feed' ? 'your home feed' : targetGroup?.name}.`;
      }

      if (surface === 'feed') {
        await lock.runExclusive('operator:open-feed-for-random-comments', async () => {
          await openHomeFeed();
        });
      } else if (!targetGroup?.url) {
        return 'I need a valid joined group first. Open one first, or include the group name more clearly.';
      } else {
        await lock.runExclusive('operator:open-group-for-random-comments', async () => {
          await visitGroup(page, targetGroup.url);
        });
        context.currentPlatform = 'facebook';
        context.currentSurface = 'group';
        context.currentGroup = targetGroup;
        context.lastPosts = [];
      }

      let visiblePosts = await lock.runExclusive('operator:list-visible-posts-for-random-comments', async () =>
        (typeof listVisiblePosts === 'function'
          ? listVisiblePosts({ limit: Math.max(requestedCount * 2, 10), scrollRounds: 2, validationMode: 'engagement' })
          : scrapeGroupFeed(page, { limit: Math.max(requestedCount * 2, 10), scrollRounds: 2, validationMode: 'engagement' }))
      );

      if (visiblePosts.length < requestedCount) {
        visiblePosts = await lock.runExclusive('operator:list-visible-posts-for-random-comments-more', async () =>
          (typeof listVisiblePosts === 'function'
            ? listVisiblePosts({ limit: Math.max(requestedCount * 3, 15), scrollRounds: 5, validationMode: 'engagement' })
            : scrapeGroupFeed(page, { limit: Math.max(requestedCount * 3, 15), scrollRounds: 5, validationMode: 'engagement' }))
        );
      }

      if (!visiblePosts.length) {
        await persistOperatorContext(state, upsertAgentState);
        return `I opened ${surface === 'feed' ? 'your home feed' : targetGroup.name}, but I couldn't find visible original posts to comment on right now.`;
      }

      const candidatePosts = selection === 'first'
        ? [...visiblePosts].sort((left, right) => Number(left.visibleIndex || 0) - Number(right.visibleIndex || 0))
        : [...visiblePosts].sort(() => Math.random() - 0.5);
      candidatePosts.forEach((post) => {
        logDebug(
          context,
          `comment candidate ${post.postId || post.visibleIndex}: visibleIndex=${post.visibleIndex} selection=${selection} controls=${(post.controlNames || []).join(',') || 'none'}`
        );
      });
      let commentedCount = 0;
      const errors = [];

      for (const post of candidatePosts) {
        if (commentedCount >= requestedCount) {
          break;
        }

        const candidate = {
          post_id: post.postId || `visible-post-${post.visibleIndex}`,
          post_url: post.postUrl || '',
          content: post.postText || '',
          author: post.authorName || 'Unknown',
          group: targetGroup.name,
          visible_index: post.visibleIndex,
        };

        try {
          const draft = await draftCommentForCandidate(candidate, {
            phaseOverride: 1,
            tone: 'helpful, concise, light, non-spammy',
          });

          await lock.runExclusive(`operator:random-comment:${candidate.post_id}`, async () => {
            if (Number.isFinite(Number(candidate.visible_index)) && typeof commentAnchoredPost === 'function') {
              await runAnchoredActionWithRecovery('Comment on random anchored post', Number(candidate.visible_index), () =>
                commentAnchoredPost(Number(candidate.visible_index), draft.reply, { selectorId: post.selectorId || '' })
              );
            } else {
              await commentOnQualifiedPost(candidate, {
                draft,
                phaseOverride: 1,
                onStall: handleStall,
              });
            }
          });

          commentedCount += 1;
          console.log(`Finished ${commentedCount}/${requestedCount}, looking for the next post.`);
          await humanJitter(page, { logLabel: 'Random comment jitter' });
        } catch (error) {
          errors.push(`${candidate.post_id}: ${error.message}`);
        }
      }

      await persistOperatorContext(state, upsertAgentState);
      return errors.length
        ? `Commented on ${commentedCount}/${requestedCount} ${selection === 'first' ? 'visible' : 'random'} posts in ${surface === 'feed' ? 'your home feed' : targetGroup.name}.\nErrors:\n- ${errors.slice(0, 3).join('\n- ')}`
        : `Commented on ${commentedCount} ${selection === 'first' ? 'visible' : 'random'} posts in ${surface === 'feed' ? 'your home feed' : targetGroup.name}.`;
    }

    if (tool === 'draft_comment') {
      const post = currentPosts()[Number(args.post_index) - 1];
      if (!post) {
        if (context.currentGroup?.name) {
          return `That post number is not in the current post list for ${context.currentGroup.name}.`;
        }
        return 'That post number is not in the current post list.';
      }

      const draft = await draftCommentForCandidate(post, {
        phaseOverride: 1,
        tone: args.instructions ? `helpful, concise, ${args.instructions}` : 'helpful, consultative, concise',
      });
      await storeDraft({
        kind: 'comment',
        target: {
          post_index: Number(args.post_index),
          post_id: post.post_id,
          visible_index: post.visible_index,
        },
        text: draft.reply,
      });
      return `Draft comment for post ${args.post_index}:\n${draft.reply}`;
    }

    if (tool === 'comment_post') {
      const post = currentPosts()[Number(args.post_index) - 1];
      if (!post) {
        return 'That post number is not in the current post list.';
      }

      const draft = await draftCommentForCandidate(post, {
        phaseOverride: 1,
        tone: args.instructions ? `helpful, concise, ${args.instructions}` : 'helpful, consultative, concise',
      });
      await storeDraft({
        kind: 'comment',
        target: {
          post_index: Number(args.post_index),
          post_id: post.post_id,
          visible_index: post.visible_index,
        },
        text: draft.reply,
      });

      const allowed = await maybeConfirm(`Post this comment on post ${args.post_index}`);
      if (!allowed) {
        return `Draft kept for post ${args.post_index}:\n${draft.reply}`;
      }

      if (context.currentPlatform === 'reddit') {
        return `Reddit live commenting is not wired yet.\n\nDraft comment for post ${args.post_index}:\n${draft.reply}`;
      }

      await lock.runExclusive('operator:comment-post', async () => {
        if (Number.isFinite(Number(post.visible_index)) && typeof commentAnchoredPost === 'function') {
          await runAnchoredActionWithRecovery('Comment on anchored post', Number(post.visible_index), () =>
            commentAnchoredPost(Number(post.visible_index), draft.reply, { selectorId: post.selector_id || '' })
          );
        } else {
          await commentOnQualifiedPost(post, {
            draft,
            phaseOverride: 1,
            onStall: handleStall,
          });
        }
      });
      await humanJitter(page, { logLabel: 'Manual comment jitter' });
      return `Comment posted on post ${args.post_index}.`;
    }

    if (tool === 'check_notifications') {
      const commentsOnly = Boolean(args.comments_only);
      const unreadOnly = Boolean(args.unread_only);
      const withinHours = Number.isFinite(Number(args.within_hours))
        ? Number(args.within_hours)
        : null;
      const notifications = await lock.runExclusive('operator:notifications', async () =>
        (typeof listVisibleNotifications === 'function'
          ? listVisibleNotifications({
              limit: Math.max(1, Math.min(Number(args.limit || 12), 20)),
              unreadOnly,
              withinHours,
            })
          : scrapeNotifications(page, { limit: Math.max(1, Math.min(Number(args.limit || 12), 20)) }))
      );
      let filteredNotifications = commentsOnly
        ? notifications.filter((item) => /commented on your post|commented on your|replied to your comment/i.test(item.text))
        : notifications;
      if (unreadOnly && typeof listVisibleNotifications !== 'function') {
        filteredNotifications = filteredNotifications.filter((item) => item.unread);
      }
      if (withinHours != null && typeof listVisibleNotifications !== 'function') {
        filteredNotifications = filteredNotifications.filter((item) =>
          item.age_hours == null ? true : item.age_hours <= withinHours
        );
      }
      context.lastNotifications = filteredNotifications;
      let markedCount = 0;
      if (args.mark_read && filteredNotifications.length && typeof markNotificationsRead === 'function') {
        markedCount = await lock.runExclusive('operator:mark-notifications-read', async () =>
          markNotificationsRead(filteredNotifications, { limit: filteredNotifications.length })
        );
      }
      await persistOperatorContext(state, upsertAgentState);
      const rendered = formatNotifications(
        context.lastNotifications,
        commentsOnly ? 'Comments on our posts' : 'Latest notifications'
      );
      return markedCount
        ? `${rendered}\nMarked as read: ${markedCount}`
        : rendered;
    }

    if (tool === 'reply_notification') {
      const notification = currentNotifications()[Number(args.notification_index) - 1];
      if (!notification) {
        return 'That notification number is not in the current notification list.';
      }

      const allowed = await maybeConfirm(`Reply to notification ${args.notification_index}`);
      if (!allowed) {
        return `Reply cancelled for notification ${args.notification_index}.`;
      }

      await lock.runExclusive('operator:reply-notification', async () => {
        await replyToNotificationItem(notification);
      });
      return `Replied to notification ${args.notification_index}.`;
    }

    if (tool === 'draft_post') {
      const target = String(args.target || 'feed').toLowerCase() === 'group' ? 'group' : 'feed';
        if (target === 'group') {
        if (Number.isFinite(Number(args.group_index))) {
          context.currentGroup = context.lastListedGroups[Number(args.group_index) - 1] || context.currentGroup;
        } else if (args.group_name) {
          context.currentGroup = (await resolveTargetGroup(args)) || context.currentGroup;
        }
      }
      const prompt = [
        `Write a short Facebook post for the ${target === 'feed' ? 'personal feed' : 'current Facebook group'}.`,
        'Keep it natural, clear, and useful.',
        'No hype. No AI mention. Simple English.',
        'Aim for 4 short sentences max.',
        args.topic
          ? `Main topic: ${args.topic}`
          : 'Main topic: Amazon sellers losing money through fees, inventory issues, reimbursements, or settlement confusion.',
        '',
        'Business skill context:',
        skill.content,
        '',
        'Post:',
      ].join('\n');

      const draftText = await callOllama(prompt, {
        model,
        timeoutMs: 30_000,
        generationOptions: {
          temperature: 0.4,
          num_ctx: 2048,
          num_predict: 220,
        },
      });

      await storeDraft({
        kind: 'post',
        target: { surface: target, group: target === 'group' ? context.currentGroup : null },
        text: draftText,
      });
      return [
        `Draft ${target} post:`,
        draftText,
        '',
        'If you want, say "post the last draft" when you are ready.',
      ].join('\n');
    }

    if (tool === 'post_last_draft') {
      const draft = context.lastDraft;
      if (!draft?.text) {
        return 'There is no saved draft right now.';
      }

      const allowed = await maybeConfirm('Post the last saved draft');
      if (!allowed) {
        return 'Posting cancelled.';
      }

      if (draft.kind === 'post') {
        if (draft.target?.surface === 'feed') {
          await lock.runExclusive('operator:post-last-feed-draft', async () => {
            await createFeedPost(page, draft.text, null);
          });
          return 'Posted the last draft to your feed.';
        }

        const draftGroup = draft.target?.group || context.currentGroup;
        if (!draftGroup?.group_id && !draftGroup?.id) {
          return 'The last draft is for a group, but no current group is selected.';
        }

        await lock.runExclusive('operator:post-last-group-draft', async () => {
          if (draftGroup?.url) {
            await visitGroup(page, draftGroup.url);
          }
          await createNewPost(page, draftGroup.group_id || draftGroup.id, draft.text, null);
        });
        context.currentGroup = draftGroup;
        return `Posted the last draft to ${draftGroup.name || 'the current group'}.`;
      }

      if (draft.kind === 'comment') {
        const post = currentPosts()[Number(draft.target?.post_index) - 1];
        if (!post) {
          return 'The saved draft comment no longer matches the current post list.';
        }

        await lock.runExclusive('operator:post-last-comment-draft', async () => {
          if (Number.isFinite(Number(post.visible_index)) && typeof commentAnchoredPost === 'function') {
            await runAnchoredActionWithRecovery('Post saved comment on anchored post', Number(post.visible_index), () =>
              commentAnchoredPost(Number(post.visible_index), draft.text, { selectorId: post.selector_id || '' })
            );
          } else {
            await commentOnQualifiedPost(post, {
              draft: {
                reply: draft.text,
                phase: 1,
              },
              phaseOverride: 1,
            });
          }
        });
        return `Posted the saved comment on post ${draft.target?.post_index}.`;
      }

      return 'I found a draft, but I do not know how to post it safely.';
    }

    if (tool === 'sync_groups') {
      const result = await lock.runExclusive('operator:sync-groups', async () => syncGroups());
      return `Sync complete. Joined approvals updated: ${result.approvalsUpdated}. Account-level groups seen: ${result.joinedGroupsSynced}.`;
    }

    if (tool === 'verify_pending_groups') {
      const verified = await lock.runExclusive('operator:verify-pending', async () => verifyPendingGroups());
      return `Verified pending groups marked joined: ${verified}`;
    }

    if (tool === 'exit') {
      rl.close();
      process.exit(0);
    }

    return `Tool not implemented: ${tool}`;
  }

  async function fallbackPlan(raw) {
    const platformScoped = inferPlatformScopedIntent(raw, context);
    if (platformScoped) {
      return {
        assistantReply: '',
        actions: [platformScoped],
      };
    }

    const routed = await routeOperatorIntent(raw, {
      callOllama,
      model,
    });

    if (routed.type === 'help') {
      return { assistantReply: '', actions: [{ tool: 'help', args: {} }] };
    }

    if (routed.type === 'exit') {
      return { assistantReply: '', actions: [{ tool: 'exit', args: {} }] };
    }

    if (routed.type === 'list_groups') {
      return {
        assistantReply: '',
        actions: [{
          tool: 'list_groups',
          args: {
            status: 'joined',
            amazon_only: routed.amazon_only || /amazon|fba|private label|seller/i.test(raw),
            sort_by: routed.sort_by || undefined,
            limit: routed.limit || 300,
          },
        }],
      };
    }

    if (routed.type === 'check_notifications') {
      return {
        assistantReply: '',
        actions: [{
          tool: 'check_notifications',
          args: {
            comments_only: false,
            unread_only: routed.unread_only || false,
            within_hours: routed.within_hours,
            mark_read: routed.mark_read || false,
            limit: routed.limit || 12,
          },
        }],
      };
    }

    if (routed.type === 'debug_mode') {
      return {
        assistantReply: '',
        actions: [{
          tool: 'debug_mode',
          args: {
            enabled: routed.enabled,
          },
        }],
      };
    }

    if (routed.type === 'switch_platform') {
      return {
        assistantReply: '',
        actions: [{
          tool: 'switch_platform',
          args: {
            platform: routed.platform || 'facebook',
          },
        }],
      };
    }

    if (routed.type === 'reddit_show_posts') {
      return {
        assistantReply: '',
        actions: [{
          tool: 'reddit_show_posts',
          args: {
            subreddit: routed.subreddit,
            limit: routed.limit || 10,
          },
        }],
      };
    }

    if (routed.type === 'reddit_search_posts') {
      return {
        assistantReply: '',
        actions: [{
          tool: 'reddit_search_posts',
          args: {
            query: routed.query,
            limit: routed.limit || 10,
          },
        }],
      };
    }

    if (routed.type === 'like_random_posts') {
      return {
        assistantReply: '',
        actions: [{
          tool: 'like_random_posts',
          args: {
            count: routed.count,
            selection: routed.selection || 'random',
            group_index: routed.group_index,
            group_name: routed.group_name || '',
            surface: routed.surface || 'group',
          },
        }],
      };
    }

    if (routed.type === 'comment_random_posts') {
      return {
        assistantReply: '',
        actions: [{
          tool: 'comment_random_posts',
          args: {
            count: routed.count,
            selection: routed.selection || 'random',
            group_index: routed.group_index,
            group_name: routed.group_name || '',
            surface: routed.surface || 'group',
          },
        }],
      };
    }

    if (routed.type === 'draft_comment') {
      return {
        assistantReply: '',
        actions: [{
          tool: 'draft_comment',
          args: {
            post_index: routed.post_index,
          },
        }],
      };
    }

    if (routed.type === 'draft_post') {
      return {
        assistantReply: '',
        actions: [{
          tool: 'draft_post',
          args: {
            target: routed.target || 'feed',
            group_index: routed.group_index,
            group_name: routed.group_name || '',
            topic: routed.topic || '',
          },
        }],
      };
    }

    if (routed.type === 'post_last_draft') {
      return {
        assistantReply: '',
        actions: [{ tool: 'post_last_draft', args: {} }],
      };
    }

    if (routed.type === 'show_posts') {
      return {
        assistantReply: '',
        actions: [{
          tool: 'show_posts',
          args: {
            source: 'current',
            group_index: routed.group_index,
            group_name: routed.group_name || '',
            limit: routed.limit,
            random: routed.random || false,
            surface: routed.surface || 'group',
          },
        }],
      };
    }

    if (/go to group\s+\d+|open group\s+\d+/i.test(raw) && /find|scan|post/i.test(raw)) {
      const match = raw.match(/(?:go to|open)\s+group\s+(\d+)/i);
      const groupIndex = match ? Number(match[1]) : null;
      if (groupIndex) {
        return {
          assistantReply: '',
          actions: [
            { tool: 'open_group', args: { group_index: groupIndex } },
            { tool: 'scan_current_group', args: { topic: /amazon/i.test(raw) ? 'amazon hidden money leads for our business' : '' } },
            { tool: 'show_posts', args: { source: 'current' } },
          ],
        };
      }
    }

    if (routed.type === 'scan') {
      return { assistantReply: '', actions: [{ tool: 'scan_joined_groups', args: {} }] };
    }

    if (routed.type === 'scan_current_group') {
      return { assistantReply: '', actions: [{ tool: 'scan_current_group', args: {} }] };
    }

    if (routed.type === 'search') {
      return {
        assistantReply: '',
        actions: [{
          tool: 'search_groups',
          args: {
            keyword: routed.keyword || '',
          },
        }],
      };
    }

    if (routed.type === 'question') {
      return {
        assistantReply: await answerOperatorQuestion(raw, {
          getGroupsByStatus,
          scrapeNotifications,
          page,
          getCollections,
          callOllama,
          model,
          isRelevantAmazonGroupName,
        }),
        actions: [],
      };
    }

    return { assistantReply: 'I understood part of that, but I need a more specific request.', actions: [] };
  }

  async function handleMessage(raw) {
    const outputs = [];
    const observations = [];
    const executed = new Set();
    const stopAfterTools = new Set([
      'list_groups',
      'check_notifications',
      'like_random_posts',
      'comment_random_posts',
      'draft_comment',
      'draft_post',
    ]);
    let objectivePlan = null;
    const platformScopedIntent = inferPlatformScopedIntent(raw, context);
    const directIntent = inferDirectActionIntent(raw);

    if (platformScopedIntent || directIntent) {
      const plan = platformScopedIntent
        ? { assistantReply: '', actions: [platformScopedIntent] }
        : await fallbackPlan(raw);
      if (plan.assistantReply) {
        console.log(plan.assistantReply);
        outputs.push(plan.assistantReply);
      }
      for (const action of plan.actions) {
        const result = await executeTool(action);
        if (result) {
          console.log(result);
          outputs.push(result);
        }
      }
      return outputs;
    }

    try {
      objectivePlan = await planObjective({
        objective: raw,
        context: {
          current_group: context.currentGroup?.name || null,
          last_groups: (context.lastListedGroups || []).slice(0, 10).map((group) => group.name),
          last_posts: (context.lastPosts || []).slice(0, 5).map((post) => excerpt(post.content || post.postText || '', 120)),
        },
      }, {
        model,
      });
    } catch (_error) {
      objectivePlan = null;
    }

    if (objectivePlan?.steps?.length) {
      const planText = [
        `Objective: ${objectivePlan.objective || raw} [${objectivePlan.family || 'general_engagement'}]`,
        ...objectivePlan.steps.slice(0, 5).map((step, index) => `${index + 1}. ${step}`),
      ].join('\n');
      console.log(planText);
      outputs.push(planText);
      observations.push({
        type: 'objective_plan',
        result: planText,
      });
    }

    if (objectivePlan?.needsNewSkill && objectivePlan.topic && typeof saveNewSkill === 'function') {
      const brief = (await ask(`Quick brief for ${objectivePlan.topic}> `)).trim();
      if (brief) {
        const saved = await saveNewSkill(objectivePlan.topic, brief);
        const learnedMessage = saved.existed
          ? `I already knew ${objectivePlan.topic}, so I refreshed that skill and kept it as ${saved.skillId}.`
          : `I've learned the goals for ${objectivePlan.topic} and saved them to my memory as ${saved.skillId}.`;
        console.log(learnedMessage);
        outputs.push(learnedMessage);
        observations.push({
          type: 'new_skill',
          result: learnedMessage,
        });
        objectivePlan = {
          ...objectivePlan,
          relevantSkill: saved.skillId,
          needsNewSkill: false,
        };
      }
    }

    let loopFailed = false;

    for (let step = 1; step <= 5; step += 1) {
      let decision;
      try {
        decision = await decideNextToolStep({
          userMessage: raw,
          deps: {
            callOllama,
            model,
            state,
            taskInput,
          },
          observations,
          stepNumber: step,
          objectivePlan,
        });
      } catch (_error) {
        loopFailed = true;
        break;
      }

      if (decision.assistantReply && step === 1 && !decision.done) {
        console.log(decision.assistantReply);
        outputs.push(decision.assistantReply);
      }

      if (decision.done) {
        if (decision.assistantReply) {
          console.log(decision.assistantReply);
          outputs.push(decision.assistantReply);
        }
        return outputs;
      }

      if (!decision.action) {
        loopFailed = true;
        break;
      }

      const signature = JSON.stringify({
        tool: decision.action.tool,
        args: decision.action.args,
      });
      if (executed.has(signature)) {
        observations.push({
          type: 'warning',
          message: `Repeated action prevented: ${signature}`,
        });
        break;
      }
      executed.add(signature);

      const result = await executeTool(decision.action);
      if (result) {
        console.log(result);
        outputs.push(result);
      }
      observations.push({
        tool: decision.action.tool,
        args: decision.action.args,
        result: String(result || ''),
      });

      if (stopAfterTools.has(decision.action.tool)) {
        return outputs;
      }
    }

    if (!loopFailed && outputs.length) {
      return outputs;
    }

    let plan;
    try {
      plan = await planOperatorMessage(raw, {
        callOllama,
        model,
        state,
        taskInput,
        objectivePlan,
      });
    } catch (_error) {
      plan = await fallbackPlan(raw);
    }

    if (!plan.actions.length && !plan.assistantReply) {
      plan = await fallbackPlan(raw);
    }

    if (plan.assistantReply) {
      console.log(plan.assistantReply);
      outputs.push(plan.assistantReply);
    }

    for (const action of plan.actions) {
      const result = await executeTool(action);
      if (result) {
        console.log(result);
        outputs.push(result);
      }
    }

    return outputs;
  }

  rl.on('line', async (line) => {
    const raw = line.trim();
    if (!raw) {
      rl.prompt();
      return;
    }

    if (busy) {
      console.log('I am still working on the last request. Please wait a moment.');
      rl.prompt();
      return;
    }

    busy = true;
    addConversationTurn(state, 'user', raw);

    try {
      const outputs = await handleMessage(raw);
      addConversationTurn(state, 'assistant', outputs.join('\n\n') || 'Handled operator request.');
    } catch (error) {
      console.log(`Request failed: ${error.message}`);
      addConversationTurn(state, 'assistant', `Request failed: ${error.message}`);
    } finally {
      await persistOperatorContext(state, upsertAgentState);
      busy = false;
      rl.prompt();
    }
  });

  rl.on('close', () => {
    console.log('Operator console closed.');
  });

  console.log('Operator console ready. Speak naturally and I will plan the steps.');
  rl.prompt();
  return rl;
}

module.exports = {
  answerOperatorQuestion,
  buildDashboard,
  inferIntentHeuristically,
  inferPlatformScopedIntent,
  planOperatorMessage,
  resolveNamedGroup,
  routeOperatorIntent,
  startOperatorConsole,
  summarizeRecentPostsFromDb,
};
