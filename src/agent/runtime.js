'use strict';

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

async function scheduleStandardJobs({ enqueueUniqueJob, jobTypes }) {
  await enqueueUniqueJob({ type: jobTypes.HOUSEKEEPING });
  await enqueueUniqueJob({ type: jobTypes.SCAN_GROUPS, runAt: new Date(Date.now() + 20_000) });
  await enqueueUniqueJob({ type: jobTypes.ENGAGE, runAt: new Date(Date.now() + 45_000) });
}

async function executeJob(job, context) {
  const {
    jobTypes,
    runHousekeeping,
    syncGroups,
    verifyPendingGroups,
    scanJoinedGroups,
    engageQualifiedPosts,
    handleReplyLoop,
    summarizeInbox,
    searchAndJoinGroups,
    page,
    skill,
    state,
    taskInput,
  } = context;

  switch (job.type) {
    case jobTypes.HOUSEKEEPING:
      return runHousekeeping(page, skill, state);
    case jobTypes.SYNC_GROUPS:
      return syncGroups(page);
    case jobTypes.VERIFY_PENDING:
      return verifyPendingGroups(page);
    case jobTypes.SCAN_GROUPS:
      return scanJoinedGroups(page, taskInput, skill, state);
    case jobTypes.ENGAGE:
      return engageQualifiedPosts(page, skill, state);
    case jobTypes.REPLY:
      return handleReplyLoop(page, skill, state, state.briefing);
    case jobTypes.BRIEF:
      return summarizeInbox(page, skill, state);
    case jobTypes.SEARCH_GROUPS:
      return searchAndJoinGroups(page, job.payload?.keyword || '', skill, state);
    default:
      throw new Error(`Unsupported job type: ${job.type}`);
  }
}

async function runQueuedJobs(context) {
  const {
    lock,
    releaseExpiredJobs,
    leaseNextJob,
    completeJob,
    failJob,
    state,
  } = context;

  await releaseExpiredJobs();

  for (;;) {
    const job = await leaseNextJob('browser-worker-1');
    if (!job) {
      break;
    }

    try {
      const result = await lock.runExclusive(`job:${job.type}`, async () =>
        executeJob(job, context)
      );
      await completeJob(job._id, result || null);
    } catch (error) {
      state.errors.push(`Job ${job.type} failed: ${error.message}`);
      await failJob(job._id, error);
    }
  }
}

module.exports = {
  createBrowserLock,
  executeJob,
  runQueuedJobs,
  scheduleStandardJobs,
};
