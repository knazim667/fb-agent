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

async function answerOperatorQuestion(input, deps) {
  const {
    page,
    getGroupsByStatus,
    scrapeNotifications,
    isRelevantAmazonGroupName,
    getCollections,
    callOllama,
    model,
  } = deps;
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
    'You can also use commands: status, groups, notifications, posts, brief, sync, verify, search [keyword], scan, engage, reply, exit',
  ].join('\n');
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
          answerOperatorQuestion('what notification we have now', {
            page,
            getGroupsByStatus,
            scrapeNotifications,
            isRelevantAmazonGroupName,
            getCollections,
            callOllama,
            model,
          })
        );
        console.log(answer);
      } else if (normalized === 'posts') {
        console.log(await summarizeRecentPostsFromDb(getCollections, callOllama, model));
      } else if (normalized === 'brief') {
        await enqueueUniqueJob({ type: jobTypes.BRIEF });
        console.log('Queued: brief');
        await runQueuedJobs();
      } else if (normalized === 'sync') {
        await enqueueUniqueJob({ type: jobTypes.SYNC_GROUPS });
        console.log('Queued: sync_groups');
        await runQueuedJobs();
      } else if (normalized === 'verify') {
        await enqueueUniqueJob({ type: jobTypes.VERIFY_PENDING });
        console.log('Queued: verify_pending');
        await runQueuedJobs();
      } else if (normalized === 'scan') {
        await enqueueUniqueJob({ type: jobTypes.SCAN_GROUPS });
        console.log('Queued: scan_groups');
        await runQueuedJobs();
      } else if (normalized === 'engage') {
        await enqueueUniqueJob({ type: jobTypes.ENGAGE });
        console.log('Queued: engage');
        await runQueuedJobs();
      } else if (normalized === 'reply') {
        await enqueueUniqueJob({ type: jobTypes.REPLY });
        console.log('Queued: reply');
        await runQueuedJobs();
      } else if (normalized.startsWith('search ')) {
        const keyword = raw.slice(7).trim();
        await enqueueUniqueJob({
          type: jobTypes.SEARCH_GROUPS,
          payload: { keyword },
        });
        console.log(`Queued: search_groups (${keyword})`);
        await runQueuedJobs();
      } else {
        const answer = await lock.runExclusive('operator:question', async () =>
          answerOperatorQuestion(raw, {
            page,
            getGroupsByStatus,
            scrapeNotifications,
            isRelevantAmazonGroupName,
            getCollections,
            callOllama,
            model,
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
  startOperatorConsole,
  summarizeRecentPostsFromDb,
};
