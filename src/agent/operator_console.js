'use strict';

const readline = require('readline');
const fs = require('fs/promises');
const path = require('path');

const TOOL_NAMES = [
  'dashboard',
  'status',
  'list_groups',
  'search_groups',
  'open_group',
  'scan_current_group',
  'scan_joined_groups',
  'show_posts',
  'like_post',
  'like_random_posts',
  'draft_comment',
  'comment_post',
  'check_notifications',
  'reply_notification',
  'draft_post',
  'post_last_draft',
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
      currentGroup: null,
      lastListedGroups: [],
      lastPosts: [],
      lastNotifications: [],
      lastDraft: null,
      conversationHistory: [],
    };
  }

  if (!Array.isArray(state.operatorContext.conversationHistory)) {
    state.operatorContext.conversationHistory = [];
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
    currentGroup: context.currentGroup,
    lastListedGroups: context.lastListedGroups,
    lastPosts: context.lastPosts,
    lastNotifications: context.lastNotifications,
    lastDraft: context.lastDraft,
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
      return `${index + 1}. ${post.author || 'Unknown'}${score}\n   ${excerpt(post.content || post.postText || '', 220)}`;
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
      const author = post.author || 'Unknown';
      const summary = excerpt(post.content || post.postText || '', 220);
      return `Post #${number}: ${author}\n   ${summary}`;
    }),
  ].join('\n');
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

function addConversationTurn(state, role, text) {
  const context = ensureOperatorContext(state);
  context.conversationHistory.push({
    role,
    text: String(text || '').trim(),
    timestamp: new Date().toISOString(),
  });
  context.conversationHistory = context.conversationHistory.slice(-12);
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

  if (normalized === 'exit' || normalized === 'quit') {
    return { type: 'exit' };
  }

  if (
    (normalized.includes('group') || normalized.includes('groups')) &&
    /(list|show|give|which|what)/.test(normalized) &&
    /(joined|already|all|amazon|related)/.test(normalized)
  ) {
    const limitMatch = normalized.match(/(?:max(?:imum)?|at least|top|show|give me)\s+(\d+)/i)
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
    const limitMatch = normalized.match(/(?:max(?:imum)?|at least|top|show)\s+(\d+)/i);
    return {
      type: 'list_groups',
      amazon_only: /amazon|fba|private label|seller/.test(normalized),
      sort_by: 'activity',
      limit: Number(limitMatch?.[1] || 0) || undefined,
    };
  }

  const randomLikeMatch = String(input || '').match(/like(?:\s+at\s+least)?\s+(\d+)\s+random\s+posts?(?:\s+(?:in|on|for)\s+group\s+(.+))?/i)
    || String(input || '').match(/like(?:\s+at\s+least)?\s+(\d+)\s+posts?(?:\s+(?:in|on|for)\s+group\s+(.+))?/i);
  if (randomLikeMatch) {
    const maybeIndex = Number(randomLikeMatch[2]);
    return {
      type: 'like_random_posts',
      count: Number(randomLikeMatch[1]),
      group_index: Number.isFinite(maybeIndex) && maybeIndex > 0 ? maybeIndex : undefined,
      group_name: randomLikeMatch[2] && !(Number.isFinite(maybeIndex) && maybeIndex > 0)
        ? randomLikeMatch[2].trim()
        : '',
    };
  }

  if (/scan(?: the)? groups?|scan this group|look for leads|find posts?|go on that group and find posts?/i.test(normalized)) {
    return normalized.includes('this group')
      ? { type: 'scan_current_group' }
      : { type: 'scan' };
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
    'list_groups',
    'check_notifications',
    'like_random_posts',
    'draft_comment',
    'draft_post',
  ]);

  return directTypes.has(intent.type) ? intent : null;
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
    '- show_posts {"source":"current"}',
    '- like_post {"post_index":number}',
    '- like_random_posts {"count":number,"group_index":number,"group_name":"optional"}',
    '- draft_comment {"post_index":number,"instructions":"optional"}',
    '- comment_post {"post_index":number,"instructions":"optional"}',
    '- check_notifications {"comments_only":true|false,"unread_only":true|false,"within_hours":number,"mark_read":true|false,"limit":number}',
    '- reply_notification {"notification_index":number,"instructions":"optional"}',
    '- draft_post {"target":"feed|group","group_index":number,"group_name":"optional","topic":"optional"}',
    '- post_last_draft {}',
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
      user: excerpt(workspace.user || '', 600),
      memory: excerpt(workspace.memory || '', 800),
      today_memory: excerpt(workspace.todayMemory || '', 600),
      yesterday_memory: excerpt(workspace.yesterdayMemory || '', 600),
      tools: excerpt(workspace.tools || '', 800),
    },
    execution_mode: context.executionMode,
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
  } = deps;

  const prompt = [
    'You are the planner for a Facebook account manager agent.',
    'Read the user message, current context, and choose the smallest useful tool plan.',
    'Understand the meaning, not exact commands.',
    'If the user asks for Amazon-related groups only, use list_groups with amazon_only=true.',
    'If the user refers to a numbered group or post, use the current list indexes from context.',
    'If the user asks to go to a group and then find lead posts, use open_group then scan_current_group.',
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
    'Choose exactly one next tool action, or finish.',
    'Use the observations from previous tools to decide the next step.',
    'If the user is referring to a numbered group or post, use the indexes from current context and observations.',
    'Do not restart from the beginning if the needed list is already available in context.',
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
    postCommentOnVisiblePost,
    createNewPost,
    createFeedPost,
    scrapeNotificationReplies,
    replyToNotificationItem,
    upsertAgentState,
    humanJitter,
    appendRecoveryLesson,
  } = deps;

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

  async function executeTool(action) {
    const tool = action.tool;
    const args = action.args || {};

    if (tool === 'help') {
      return [
        'You can ask naturally, for example:',
        '- give me the list of joined groups',
        '- show only amazon groups',
        '- go to group 12 and find amazon lead posts',
        '- comment on post 2',
        '- draft a post for this group',
        '- check comments on our posts',
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
      return `Status: ${joined.length} joined, ${pending.length} pending, ${discovered.length} discovered. Mode: ${context.executionMode}. Current group: ${context.currentGroup?.name || 'none'}.`;
    }

    if (tool === 'list_groups') {
      const requestedStatus = String(args.status || 'all').toLowerCase();
      const limit = Math.max(1, Math.min(Number(args.limit || 200), 500));
      let groups = [];

      if ((requestedStatus === 'joined' || requestedStatus === 'all') && typeof listVisibleGroups === 'function') {
        const liveJoined = await lock.runExclusive('operator:list-visible-groups', async () =>
          listVisibleGroups({ limit, scrollRounds: 8 })
        );
        groups = liveJoined.map((group) => ({ ...group, status: 'joined' }));

        if (requestedStatus === 'all') {
          const [pending, discovered] = await Promise.all([
            getGroupsByStatus('pending', { limit }),
            getGroupsByStatus('discovered', { limit }),
          ]);
          groups = [
            ...groups,
            ...pending.map((group) => ({ ...group, status: 'pending' })),
            ...discovered.map((group) => ({ ...group, status: 'discovered' })),
          ];
        }
      } else if (requestedStatus === 'all') {
        const [joined, pending, discovered] = await Promise.all([
          getGroupsByStatus('joined', { limit }),
          getGroupsByStatus('pending', { limit }),
          getGroupsByStatus('discovered', { limit }),
        ]);
        groups = [
          ...joined.map((group) => ({ ...group, status: 'joined' })),
          ...pending.map((group) => ({ ...group, status: 'pending' })),
          ...discovered.map((group) => ({ ...group, status: 'discovered' })),
        ];
      } else {
        groups = (await getGroupsByStatus(requestedStatus, { limit }))
          .map((group) => ({ ...group, status: requestedStatus }));
      }

      if (args.amazon_only) {
        groups = filterAmazonGroups(groups, isRelevantAmazonGroupName);
      }

      if (args.sort_by === 'activity') {
        groups = groups.sort((left, right) => {
          const leftAge = activityAgeForGroup(left);
          const rightAge = activityAgeForGroup(right);
          return leftAge - rightAge;
        });
      }

      groups = groups.slice(0, limit);

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
      let group = null;
      if (Number.isFinite(Number(args.group_index))) {
        group = context.lastListedGroups[Number(args.group_index) - 1] || null;
      }

      if (!group && args.group_name) {
        const allJoined = await getGroupsByStatus('joined', { limit: 500 });
        group = allJoined.find((item) =>
          String(item.name || '').toLowerCase().includes(String(args.group_name).toLowerCase())
        ) || null;
      }

      if (!group) {
        return 'I could not find that group in the current list. Ask me to list groups first, or mention the group name more clearly.';
      }

      await lock.runExclusive('operator:open-group', async () => {
        await visitGroup(page, group.url);
      });
      context.currentGroup = group;
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
      context.lastPosts = await filterPostsByTopic(results, args.topic || '', callOllama, model);
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
      if (currentPosts().length) {
        return formatOriginalPosts(currentPosts(), 'Current posts');
      }
      if (context.currentGroup?.url && typeof listVisiblePosts === 'function') {
        const visiblePosts = await lock.runExclusive('operator:list-visible-posts', async () =>
          listVisiblePosts({ limit: 12, scrollRounds: 2 })
        );
        if (visiblePosts.length) {
          context.lastPosts = visiblePosts.map((post) => ({
            post_id: post.postId,
            post_url: post.postUrl,
            content: post.postText,
            author: post.authorName || 'Unknown',
            visible_index: post.visibleIndex,
            group: context.currentGroup?.name || context.currentGroup?.label || '',
          }));
          await persistOperatorContext(state, upsertAgentState);
          return formatOriginalPosts(context.lastPosts, `Visible posts in ${context.currentGroup.name || context.currentGroup.label}`);
        }
      }
      if (context.currentGroup?.name) {
        return `No matching posts are currently saved for ${context.currentGroup.name}.`;
      }
      return summarizeRecentPostsFromDb(getCollections, callOllama, model);
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
            likeAnchoredPost(Number(post.visible_index))
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
      let targetGroup = context.currentGroup || null;

      if (Number.isFinite(Number(args.group_index))) {
        targetGroup = context.lastListedGroups[Number(args.group_index) - 1] || null;
      }

      if (args.group_name) {
        const allJoined = await getGroupsByStatus('joined', { limit: 500 });
        targetGroup = allJoined.find((item) =>
          String(item.name || '').toLowerCase().includes(String(args.group_name).toLowerCase())
        ) || null;
      }

      if (!targetGroup?.url) {
        return 'I need a valid joined group first. Open one first, or include the group name more clearly.';
      }

      await lock.runExclusive('operator:open-group-for-random-likes', async () => {
        await visitGroup(page, targetGroup.url);
      });
      context.currentGroup = targetGroup;

      const recentPosts = await lock.runExclusive('operator:scrape-random-like-posts', async () =>
        (typeof listVisiblePosts === 'function'
          ? listVisiblePosts({ limit: Math.max(requestedCount * 2, 12), scrollRounds: 2 })
          : scrapeGroupFeed(page, { limit: Math.max(requestedCount * 2, 12), scrollRounds: 2 }))
      );

      if (!recentPosts.length) {
        await persistOperatorContext(state, upsertAgentState);
        return `I opened ${targetGroup.name}, but I couldn't find visible posts to like right now.`;
      }

      let likedCount = 0;
      const errors = [];
      const shuffled = [...recentPosts].sort(() => Math.random() - 0.5);

      for (const post of shuffled) {
        if (likedCount >= requestedCount) {
          break;
        }

        try {
          await lock.runExclusive(`operator:random-like:${post.postId || post.visibleIndex}`, async () => {
            if (Number.isFinite(Number(post.visibleIndex)) && typeof likeAnchoredPost === 'function') {
              await runAnchoredActionWithRecovery('Like random anchored post', Number(post.visibleIndex), () =>
                likeAnchoredPost(Number(post.visibleIndex))
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
          await humanJitter(page, { logLabel: 'Random like jitter' });
        } catch (error) {
          errors.push(`${post.postId}: ${error.message}`);
        }
      }

      await persistOperatorContext(state, upsertAgentState);
      return errors.length
        ? `Liked ${likedCount}/${requestedCount} random posts in ${targetGroup.name}.\nErrors:\n- ${errors.slice(0, 3).join('\n- ')}`
        : `Liked ${likedCount} random posts in ${targetGroup.name}.`;
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

      await lock.runExclusive('operator:comment-post', async () => {
        if (Number.isFinite(Number(post.visible_index)) && typeof commentAnchoredPost === 'function') {
          await runAnchoredActionWithRecovery('Comment on anchored post', Number(post.visible_index), () =>
            commentAnchoredPost(Number(post.visible_index), draft.reply)
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
          const allJoined = await getGroupsByStatus('joined', { limit: 500 });
          context.currentGroup = allJoined.find((item) =>
            String(item.name || '').toLowerCase().includes(String(args.group_name).toLowerCase())
          ) || context.currentGroup;
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

      const allowed = await maybeConfirm(
        target === 'feed' ? 'Post this to your feed' : 'Post this to the current group'
      );
      if (!allowed) {
        return `Draft ${target} post:\n${draftText}`;
      }

      if (target === 'feed') {
        await lock.runExclusive('operator:feed-post', async () => {
          await createFeedPost(page, draftText, null);
        });
        return 'Posted the draft to your feed.';
      }

      if (!context.currentGroup?.group_id && !context.currentGroup?.id) {
        return `Draft group post:\n${draftText}\n\nI need you to open a tracked group first before I can post it.`;
      }

      await lock.runExclusive('operator:group-post', async () => {
        await visitGroup(page, context.currentGroup.url);
        await createNewPost(page, context.currentGroup.group_id || context.currentGroup.id, draftText, null);
      });
      return 'Posted the draft to the current group.';
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

        if (!context.currentGroup?.group_id && !context.currentGroup?.id) {
          return 'The last draft is for a group, but no current group is selected.';
        }

        await lock.runExclusive('operator:post-last-group-draft', async () => {
          await createNewPost(page, context.currentGroup.group_id || context.currentGroup.id, draft.text, null);
        });
        return 'Posted the last draft to the current group.';
      }

      if (draft.kind === 'comment') {
        const post = currentPosts()[Number(draft.target?.post_index) - 1];
        if (!post) {
          return 'The saved draft comment no longer matches the current post list.';
        }

        await lock.runExclusive('operator:post-last-comment-draft', async () => {
          if (Number.isFinite(Number(post.visible_index)) && typeof commentAnchoredPost === 'function') {
            await runAnchoredActionWithRecovery('Post saved comment on anchored post', Number(post.visible_index), () =>
              commentAnchoredPost(Number(post.visible_index), draft.text)
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

    if (routed.type === 'like_random_posts') {
      return {
        assistantReply: '',
        actions: [{
          tool: 'like_random_posts',
          args: {
            count: routed.count,
            group_index: routed.group_index,
            group_name: routed.group_name || '',
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
  planOperatorMessage,
  routeOperatorIntent,
  startOperatorConsole,
  summarizeRecentPostsFromDb,
};
