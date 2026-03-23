'use strict';

const readline = require('readline');

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

  return [
    '=== Agent Dashboard ===',
    `Account-level joined groups: ${totalJoined}`,
    `Tracked groups in DB: ${joined.length} joined, ${pending.length} pending, ${discovered.length} discovered`,
    `Jobs: ${queuedJobs.length} queued, ${runningJobs.length} running`,
    `Leads: ${newLeads} new, ${warmLeads} warm, ${successfulLeads} successful`,
    `Today's interactions: ${todaysInteractions}`,
    `Last full group sync: ${lastSync}`,
  ].join('\n');
}

async function answerOperatorQuestion(input, deps) {
  const {
    page,
    getGroupsByStatus,
    scrapeNotifications,
    isRelevantAmazonGroupName,
    getCollections,
    callOllama,
    model,
    getAgentState,
  } = deps;
  const normalized = input.toLowerCase();

  if (/how many groups|total groups|groups joined/.test(normalized)) {
    const joined = await getGroupsByStatus('joined', { limit: 500 });
    const pending = await getGroupsByStatus('pending', { limit: 500 });
    const discovered = await getGroupsByStatus('discovered', { limit: 500 });
    const accountSummary = await getAgentState('account_group_summary');
    const totalJoined = accountSummary?.value?.totalJoinedGroups || joined.length;
    return `Account-level groups joined: ${totalJoined}. Tracked in DB: ${joined.length} joined, ${pending.length} pending, ${discovered.length} discovered.`;
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
    return summarizeRecentPostsFromDb(getCollections, callOllama, model);
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
    'You can also use commands: dashboard, status, groups, notifications, posts, brief, sync, verify, search [keyword], scan, engage, reply, exit',
  ].join('\n');
}

function inferIntentHeuristically(input) {
  const normalized = input.trim().toLowerCase();

  if (!normalized) {
    return { type: 'noop' };
  }

  if (normalized === 'help') {
    return { type: 'help' };
  }

  if (normalized === 'exit' || normalized === 'quit') {
    return { type: 'exit' };
  }

  if (normalized === 'dashboard' || /what happened today|overall health|show dashboard|health status/.test(normalized)) {
    return { type: 'dashboard' };
  }

  if (normalized === 'status' || normalized === 'stats' || /show status|current status/.test(normalized)) {
    return { type: 'status' };
  }

  if (normalized === 'groups' || /show groups|list groups/.test(normalized)) {
    return { type: 'groups' };
  }

  if (normalized === 'notifications' || /show notifications|check notifications|what notifications/.test(normalized)) {
    return { type: 'notifications' };
  }

  if (normalized === 'posts' || /what people are posting|summarize posts|what are people talking about/.test(normalized)) {
    return { type: 'posts' };
  }

  if (normalized === 'brief' || /morning briefing|give me a briefing/.test(normalized)) {
    return { type: 'brief' };
  }

  if (normalized === 'sync' || /sync groups|refresh groups|update joined groups/.test(normalized)) {
    return { type: 'sync' };
  }

  if (normalized === 'verify' || /verify pending|check pending groups/.test(normalized)) {
    return { type: 'verify' };
  }

  if (normalized === 'scan' || /scan(?: the)? groups|look for leads|find posts|check groups for leads/.test(normalized)) {
    return { type: 'scan' };
  }

  if (normalized === 'engage' || /engage leads|start engaging|do engagement|comment and like/.test(normalized)) {
    return { type: 'engage' };
  }

  if (normalized === 'reply' || /reply to notifications|reply to leads|answer replies/.test(normalized)) {
    return { type: 'reply' };
  }

  if (normalized.startsWith('search ')) {
    return { type: 'search', keyword: input.trim().slice(7).trim() };
  }

  const searchMatch = input.match(/(?:find|search|look for|join)\s+groups?\s+(?:about|for)?\s*(.+)$/i);
  if (searchMatch && searchMatch[1]) {
    return { type: 'search', keyword: searchMatch[1].trim() };
  }

  return { type: 'question', text: input.trim() };
}

async function inferIntentWithModel(input, deps) {
  const { callOllama, model } = deps;

  try {
    const raw = await callOllama([
      'Map this operator request to one console intent.',
      'Return JSON only.',
      'Valid intents:',
      'dashboard, status, groups, notifications, posts, brief, sync, verify, scan, engage, reply, search, question, exit',
      'If intent is search, include {"keyword":"..."}',
      'If intent is question, include {"question":"..."}',
      '',
      `REQUEST: "${input}"`,
      '',
      'JSON:',
    ].join('\n'), {
      model,
      timeoutMs: 15_000,
      generationOptions: {
        temperature: 0.1,
        num_ctx: 1024,
        num_predict: 120,
      },
    });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0].replace(/'/g, '"')) : null;
    if (!parsed?.intent) {
      return null;
    }

    if (parsed.intent === 'search') {
      return {
        type: 'search',
        keyword: String(parsed.keyword || '').trim(),
      };
    }

    if (parsed.intent === 'question') {
      return {
        type: 'question',
        text: String(parsed.question || input).trim(),
      };
    }

    return { type: String(parsed.intent).trim().toLowerCase() };
  } catch (_error) {
    return null;
  }
}

async function routeOperatorIntent(input, deps) {
  const heuristic = inferIntentHeuristically(input);

  if (heuristic.type !== 'question') {
    return heuristic;
  }

  const aiIntent = await inferIntentWithModel(input, deps);
  return aiIntent || heuristic;
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
    enqueueUniqueJob,
    runQueuedJobs,
    scrapeNotifications,
    isRelevantAmazonGroupName,
    getCollections,
    callOllama,
    model,
    jobTypes,
    getAgentState,
  } = deps;

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

    const intent = await routeOperatorIntent(raw, {
      callOllama,
      model,
    });

    if (intent.type === 'help') {
      console.log('Commands: dashboard, status, groups, notifications, posts, brief, sync, verify, search [keyword], scan, engage, reply, exit');
      return;
    }

    if (intent.type === 'exit') {
      rl.close();
      process.exit(0);
    }

    if (busy) {
      console.log('A task is already running. Please wait for it to finish.');
      return;
    }

    busy = true;

    try {
      if (intent.type === 'dashboard') {
        console.log(await buildDashboard({
          getGroupsByStatus,
          getJobsByStatus,
          getCollections,
          getAgentState,
        }));
      } else if (intent.type === 'status') {
        const joined = await getGroupsByStatus('joined', { limit: 500 });
        const pending = await getGroupsByStatus('pending', { limit: 500 });
        const discovered = await getGroupsByStatus('discovered', { limit: 500 });
        const queuedJobs = await getJobsByStatus('queued', { limit: 200 });
        const runningJobs = await getJobsByStatus('running', { limit: 50 });
        console.log(`Status: ${joined.length} joined, ${pending.length} pending, ${discovered.length} discovered, ${queuedJobs.length} queued jobs, ${runningJobs.length} running jobs.`);
      } else if (intent.type === 'groups') {
        const joined = await getGroupsByStatus('joined', { limit: 50 });
        if (!joined.length) {
          console.log('No joined groups are saved yet.');
        } else {
          console.log(`Joined groups (${joined.length}):`);
          for (const group of joined.slice(0, 25)) {
            console.log(`- ${group.name}`);
          }
        }
      } else if (intent.type === 'notifications') {
        const answer = await lock.runExclusive('operator:notifications', async () =>
          answerOperatorQuestion('what notification we have now', {
            page,
            getGroupsByStatus,
            scrapeNotifications,
            isRelevantAmazonGroupName,
            getCollections,
            callOllama,
            model,
            getAgentState,
          })
        );
        console.log(answer);
      } else if (intent.type === 'posts') {
        console.log(await summarizeRecentPostsFromDb(getCollections, callOllama, model));
      } else if (intent.type === 'brief') {
        await enqueueUniqueJob({ type: jobTypes.BRIEF });
        console.log('Queued: brief');
        await runQueuedJobs();
      } else if (intent.type === 'sync') {
        await enqueueUniqueJob({ type: jobTypes.SYNC_GROUPS });
        console.log('Queued: sync_groups');
        await runQueuedJobs();
      } else if (intent.type === 'verify') {
        await enqueueUniqueJob({ type: jobTypes.VERIFY_PENDING });
        console.log('Queued: verify_pending');
        await runQueuedJobs();
      } else if (intent.type === 'scan') {
        await enqueueUniqueJob({ type: jobTypes.SCAN_GROUPS });
        console.log('Queued: scan_groups');
        await runQueuedJobs();
      } else if (intent.type === 'engage') {
        await enqueueUniqueJob({ type: jobTypes.ENGAGE });
        console.log('Queued: engage');
        await runQueuedJobs();
      } else if (intent.type === 'reply') {
        await enqueueUniqueJob({ type: jobTypes.REPLY });
        console.log('Queued: reply');
        await runQueuedJobs();
      } else if (intent.type === 'search') {
        const keyword = String(intent.keyword || '').trim();
        if (!keyword) {
          console.log('Please include a group keyword after search.');
        } else {
          await enqueueUniqueJob({
            type: jobTypes.SEARCH_GROUPS,
            payload: { keyword },
          });
          console.log(`Queued: search_groups (${keyword})`);
          await runQueuedJobs();
        }
      } else {
        const answer = await lock.runExclusive('operator:question', async () =>
          answerOperatorQuestion(intent.text || raw, {
            page,
            getGroupsByStatus,
            scrapeNotifications,
            isRelevantAmazonGroupName,
            getCollections,
            callOllama,
            model,
            getAgentState,
          })
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

module.exports = {
  answerOperatorQuestion,
  buildDashboard,
  inferIntentHeuristically,
  routeOperatorIntent,
  startOperatorConsole,
  summarizeRecentPostsFromDb,
};
