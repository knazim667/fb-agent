'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  closeDatabase,
  completeJob,
  connectDatabase,
  enqueueUniqueJob,
  failJob,
  getAgentState,
  getGroupsByStatus,
  getJobsByStatus,
  leaseNextJob,
  releaseExpiredJobs,
  saveDiscoveredGroups,
  setupCollections,
  upsertAgentState,
} = require('../src/database');

function createDbName(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

test('job queue leases uniquely and completes work', async () => {
  const dbName = createDbName('fb_agent_jobs_test');
  await connectDatabase({ dbName });
  await setupCollections();

  try {
    await enqueueUniqueJob({
      type: 'scan_groups',
      payload: { keyword: 'amazon' },
    });
    await enqueueUniqueJob({
      type: 'scan_groups',
      payload: { keyword: 'amazon' },
    });

    const queuedBefore = await getJobsByStatus('queued', { limit: 10 });
    assert.equal(queuedBefore.length, 1);

    const leased = await leaseNextJob('test-worker');
    assert.ok(leased);
    assert.equal(leased.type, 'scan_groups');
    assert.equal(leased.status, 'running');

    await completeJob(leased._id, { ok: true });
    const queuedAfter = await getJobsByStatus('queued', { limit: 10 });
    const runningAfter = await getJobsByStatus('running', { limit: 10 });
    assert.equal(queuedAfter.length, 0);
    assert.equal(runningAfter.length, 0);
  } finally {
    await closeDatabase();
  }
});

test('job failures can retry and agent state/group state persist', async () => {
  const dbName = createDbName('fb_agent_state_test');
  await connectDatabase({ dbName });
  await setupCollections();

  try {
    await saveDiscoveredGroups('__joined_sync__', [
      {
        name: 'General Business Owners',
        url: 'https://www.facebook.com/groups/111111111111111/',
        id: '111111111111111',
        status: 'joined',
        source: 'groups_membership',
      },
      {
        name: 'Amazon FBA Sellers',
        url: 'https://www.facebook.com/groups/222222222222222/',
        id: '222222222222222',
        status: 'joined',
        source: 'groups_membership',
      },
    ]);

    const joinedGroups = await getGroupsByStatus('joined', { limit: 10 });
    assert.equal(joinedGroups.length, 2);

    await upsertAgentState('account_group_summary', {
      totalJoinedGroups: 2,
      lastFullSyncAt: new Date(),
    });
    const summary = await getAgentState('account_group_summary');
    assert.equal(summary.value.totalJoinedGroups, 2);

    const job = await enqueueUniqueJob({
      type: 'reply',
      payload: { threadId: 'abc123' },
      maxAttempts: 1,
    });
    const leased = await leaseNextJob('test-worker');
    assert.equal(leased._id.toString(), job._id.toString());

    await failJob(leased._id, new Error('temporary issue'), { retryDelayMs: 0 });
    await releaseExpiredJobs({ staleMs: 0 });

    const failedJobs = await getJobsByStatus('failed', { limit: 10 });
    assert.equal(failedJobs.length, 1);
    assert.match(failedJobs[0].lastError, /temporary issue/);
  } finally {
    await closeDatabase();
  }
});
