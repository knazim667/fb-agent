'use strict';

const mongoose = require('mongoose');

const DEFAULT_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fb_agent';
const DEFAULT_DB_NAME = process.env.MONGODB_DB_NAME || 'fb_agent';

let isInitialized = false;

const postSchema = new mongoose.Schema(
  {
    post_id: { type: String, required: true, unique: true, index: true },
    group: { type: String, required: true, index: true },
    post_url: { type: String, default: null },
    content: { type: String, required: true },
    author: { type: String, required: true },
    status: { type: String, required: true, index: true },
    relevance_score: { type: Number, default: null },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
  },
  { collection: 'Posts', versionKey: false }
);

postSchema.index({ status: 1, relevance_score: -1 });
postSchema.index({ group: 1, created_at: -1 });

const leadSchema = new mongoose.Schema(
  {
    post_id: { type: String, required: true, unique: true, index: true },
    group: { type: String, required: true, index: true },
    content: { type: String, required: true },
    author: { type: String, required: true },
    category: { type: String, default: 'unknown' },
    confidence: { type: Number, default: 0 },
    reason: { type: String, default: '' },
    status: { type: String, default: 'New', index: true },
    interaction_result: {
      type: String,
      default: null,
      enum: [null, 'Success', 'Ignored', 'Blocked'],
      index: true,
    },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
  },
  { collection: 'Leads', versionKey: false }
);

leadSchema.index({ status: 1, confidence: -1 });

const interactionSchema = new mongoose.Schema(
  {
    target_id: { type: String, required: true },
    type: { type: String, required: true },
    content_sent: { type: String, default: null },
    timestamp: { type: Date, required: true, default: Date.now, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { collection: 'Interactions', versionKey: false }
);

interactionSchema.index({ target_id: 1, type: 1 }, { unique: true });

const threadEntrySchema = new mongoose.Schema(
  {
    role: { type: String, required: true },
    text: { type: String, required: true },
    phase: { type: Number, default: null },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const contextMemorySchema = new mongoose.Schema(
  {
    thread_id: { type: String, required: true, unique: true, index: true },
    summary_of_discussion: { type: String, required: true },
    related_post_id: { type: String, default: null },
    current_phase: { type: Number, default: null },
    thread_history: { type: [threadEntrySchema], default: [] },
    last_updated: { type: Date, default: Date.now },
  },
  { collection: 'Context_Memory', versionKey: false }
);

const discoveredGroupSchema = new mongoose.Schema(
  {
    keyword: { type: String, required: true, index: true },
    name: { type: String, required: true },
    url: { type: String, required: true, unique: true, index: true },
    group_id: { type: String, default: null },
    status: {
      type: String,
      default: 'discovered',
      enum: ['discovered', 'pending', 'joined'],
      index: true,
    },
    activity_label: { type: String, default: null },
    activity_age_hours: { type: Number, default: null, index: true },
    lastActivityCheckedAt: { type: Date, default: null, index: true },
    lastScanned: { type: Date, default: null, index: true },
    discovered_at: { type: Date, required: true, default: Date.now },
    last_seen_at: { type: Date, default: Date.now, index: true },
    source: { type: String, default: 'facebook_search' },
  },
  { collection: 'Discovered_Groups', versionKey: false }
);

discoveredGroupSchema.index({ keyword: 1, last_seen_at: -1 });

const jobSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, index: true },
    status: {
      type: String,
      default: 'queued',
      enum: ['queued', 'running', 'completed', 'failed'],
      index: true,
    },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    runAt: { type: Date, default: Date.now, index: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    lockedAt: { type: Date, default: null, index: true },
    lockedBy: { type: String, default: null, index: true },
    lastError: { type: String, default: null },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
  },
  { collection: 'Jobs', versionKey: false }
);

jobSchema.index({ status: 1, runAt: 1 });
jobSchema.index({ lockedBy: 1, lockedAt: 1 });

const agentStateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    updated_at: { type: Date, default: Date.now, index: true },
  },
  { collection: 'Agent_State', versionKey: false }
);

const Post = mongoose.models.Post || mongoose.model('Post', postSchema);
const Lead = mongoose.models.Lead || mongoose.model('Lead', leadSchema);
const Interaction =
  mongoose.models.Interaction || mongoose.model('Interaction', interactionSchema);
const ContextMemory =
  mongoose.models.ContextMemory ||
  mongoose.model('ContextMemory', contextMemorySchema);
const DiscoveredGroup =
  mongoose.models.DiscoveredGroup ||
  mongoose.model('DiscoveredGroup', discoveredGroupSchema);
const Job = mongoose.models.Job || mongoose.model('Job', jobSchema);
const AgentState = mongoose.models.AgentState || mongoose.model('AgentState', agentStateSchema);

async function connectDatabase({
  uri = DEFAULT_URI,
  dbName = DEFAULT_DB_NAME,
} = {}) {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  await mongoose.connect(uri, {
    dbName,
    maxPoolSize: 10,
  });

  return mongoose.connection;
}

function getDb() {
  if (mongoose.connection.readyState !== 1) {
    throw new Error('Database not connected. Call connectDatabase() first.');
  }

  return mongoose.connection.db;
}

async function closeDatabase() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

async function dedupeDiscoveredGroups() {
  const database = getDb();
  const collection = database.collection('Discovered_Groups');
  const duplicates = await collection.aggregate([
    {
      $group: {
        _id: '$url',
        ids: { $push: '$_id' },
        count: { $sum: 1 },
      },
    },
    {
      $match: {
        count: { $gt: 1 },
        _id: { $ne: null },
      },
    },
  ]).toArray();

  for (const duplicate of duplicates) {
    const idsToDelete = duplicate.ids.slice(1);
    if (idsToDelete.length) {
      await collection.deleteMany({ _id: { $in: idsToDelete } });
    }
  }
}

async function setupCollections() {
  if (mongoose.connection.readyState !== 1) {
    throw new Error('Database not connected. Call connectDatabase() first.');
  }

  if (!isInitialized) {
    await dedupeDiscoveredGroups();
    await Promise.all([
      Post.init(),
      Lead.init(),
      Interaction.init(),
      ContextMemory.init(),
      DiscoveredGroup.init(),
      Job.init(),
      AgentState.init(),
    ]);
    isInitialized = true;
  }
}

function getCollections() {
  return {
    posts: Post,
    leads: Lead,
    interactions: Interaction,
    contextMemory: ContextMemory,
    discoveredGroups: DiscoveredGroup,
    jobs: Job,
    agentState: AgentState,
  };
}

async function upsertPost(post) {
  const now = new Date();

  await Post.updateOne(
    { post_id: post.post_id },
    {
      $set: {
        group: post.group,
        post_url: post.post_url || null,
        content: post.content,
        author: post.author,
        status: post.status || 'pending',
        relevance_score: post.relevance_score ?? null,
        updated_at: now,
      },
      $setOnInsert: {
        post_id: post.post_id,
        created_at: post.created_at || now,
      },
    },
    { upsert: true }
  );

  return Post.findOne({ post_id: post.post_id }).lean();
}

async function listPendingPosts({ limit = 50 } = {}) {
  return Post.find({ status: 'pending' })
    .sort({ created_at: -1 })
    .limit(limit)
    .lean();
}

async function upsertLead(lead) {
  const now = new Date();

  await Lead.updateOne(
    { post_id: lead.post_id },
    {
      $set: {
        group: lead.group,
        content: lead.content,
        author: lead.author,
        category: lead.category || 'unknown',
        confidence: lead.confidence || 0,
        reason: lead.reason || '',
        status: lead.status || 'New',
        interaction_result: lead.interaction_result ?? null,
        updated_at: now,
      },
      $setOnInsert: {
        post_id: lead.post_id,
        created_at: now,
      },
    },
    { upsert: true }
  );

  return Lead.findOne({ post_id: lead.post_id }).lean();
}

async function updateLeadStatus(postId, status) {
  await Lead.updateOne(
    { post_id: postId },
    {
      $set: {
        status,
        updated_at: new Date(),
      },
    }
  );

  return Lead.findOne({ post_id: postId }).lean();
}

async function updateLeadInteractionResult(postId, interactionResult) {
  await Lead.updateOne(
    { post_id: postId },
    {
      $set: {
        interaction_result: interactionResult,
        updated_at: new Date(),
      },
    }
  );

  return Lead.findOne({ post_id: postId }).lean();
}

async function getLeadsByInteractionResult(interactionResult, { limit = 100 } = {}) {
  return Lead.find({ interaction_result: interactionResult })
    .sort({ updated_at: -1 })
    .limit(limit)
    .lean();
}

async function findLeadByPostId(postId) {
  return Lead.findOne({ post_id: postId }).lean();
}

async function updatePostScore(postId, relevanceScore, status = 'scored') {
  await Post.updateOne(
    { post_id: postId },
    {
      $set: {
        relevance_score: relevanceScore,
        status,
        updated_at: new Date(),
      },
    }
  );

  return Post.findOne({ post_id: postId }).lean();
}

async function markPostStatus(postId, status) {
  await Post.updateOne(
    { post_id: postId },
    {
      $set: {
        status,
        updated_at: new Date(),
      },
    }
  );

  return Post.findOne({ post_id: postId }).lean();
}

async function hasInteraction(targetId, type) {
  const existing = await Interaction.findOne({ target_id: targetId, type }).lean();
  return Boolean(existing);
}

async function logInteraction({
  target_id,
  type,
  content_sent = null,
  metadata = null,
  timestamp = new Date(),
}) {
  await Interaction.updateOne(
    { target_id, type },
    {
      $set: {
        content_sent,
        metadata,
        timestamp,
      },
      $setOnInsert: {
        target_id,
        type,
      },
    },
    { upsert: true }
  );

  return Interaction.findOne({ target_id, type }).lean();
}

async function getInteractionCountsSince(since) {
  const rows = await Interaction.aggregate([
    { $match: { timestamp: { $gte: since } } },
    { $group: { _id: '$type', count: { $sum: 1 } } },
  ]);

  return rows.reduce((accumulator, row) => {
    accumulator[row._id] = row.count;
    return accumulator;
  }, {});
}

async function upsertContextMemory({
  thread_id,
  summary_of_discussion,
  related_post_id = null,
  current_phase = null,
  thread_history = null,
}) {
  await ContextMemory.updateOne(
    { thread_id },
    {
      $set: {
        summary_of_discussion,
        related_post_id,
        current_phase,
        thread_history: thread_history ?? [],
        last_updated: new Date(),
      },
      $setOnInsert: {
        thread_id,
      },
    },
    { upsert: true }
  );

  return ContextMemory.findOne({ thread_id }).lean();
}

async function getContextMemory(threadId) {
  return ContextMemory.findOne({ thread_id: threadId }).lean();
}

async function saveDiscoveredGroups(keyword, groups = []) {
  const now = new Date();

  for (const group of groups) {
    await DiscoveredGroup.updateOne(
      { url: group.url },
      {
        $set: {
          keyword,
          name: group.name,
          group_id: group.id || null,
          status: group.status || 'discovered',
          lastScanned: group.lastScanned ?? null,
          source: group.source || 'facebook_search',
          last_seen_at: now,
        },
        $setOnInsert: {
          url: group.url,
          discovered_at: now,
        },
      },
      { upsert: true }
    );
  }

  return DiscoveredGroup.find({ keyword }).sort({ last_seen_at: -1 }).lean();
}

async function getDiscoveredGroups(keyword, { limit = 5 } = {}) {
  return DiscoveredGroup.find({ keyword })
    .sort({ last_seen_at: -1 })
    .limit(limit)
    .lean();
}

async function updateDiscoveredGroupStatus(url, status, extra = {}) {
  await DiscoveredGroup.updateOne(
    { url },
    {
      $set: {
        status,
        last_seen_at: new Date(),
        ...extra,
      },
    },
    { upsert: false }
  );

  return DiscoveredGroup.findOne({ url }).lean();
}

async function getGroupsByStatus(status, { limit = 100 } = {}) {
  return DiscoveredGroup.find({ status })
    .sort({ last_seen_at: -1 })
    .limit(limit)
    .lean();
}

async function updateGroupLastScanned(url, lastScanned = new Date()) {
  await DiscoveredGroup.updateOne(
    { url },
    {
      $set: {
        lastScanned,
      },
    }
  );

  return DiscoveredGroup.findOne({ url }).lean();
}

function escapeRegex(value = '') {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findGroupByName(name) {
  if (!name) {
    return null;
  }

  const exact = await DiscoveredGroup.findOne({
    name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' },
  }).lean();

  if (exact) {
    return exact;
  }

  return DiscoveredGroup.findOne({
    name: { $regex: escapeRegex(name), $options: 'i' },
  }).lean();
}

async function appendThreadHistory(threadId, entry, options = {}) {
  const timestamp = entry.timestamp || new Date();

  await ContextMemory.updateOne(
    { thread_id: threadId },
    {
      $push: {
        thread_history: {
          role: entry.role,
          text: entry.text,
          phase: entry.phase ?? null,
          timestamp,
        },
      },
      $set: {
        last_updated: timestamp,
        summary_of_discussion:
          options.summary_of_discussion || 'Discussion history in progress.',
        related_post_id: options.related_post_id || null,
        current_phase: options.current_phase ?? null,
      },
      $setOnInsert: {
        thread_id: threadId,
      },
    },
    { upsert: true }
  );

  return ContextMemory.findOne({ thread_id: threadId }).lean();
}

async function updateContextPhase(threadId, currentPhase) {
  await ContextMemory.updateOne(
    { thread_id: threadId },
    {
      $set: {
        current_phase: currentPhase,
        last_updated: new Date(),
      },
      $setOnInsert: {
        thread_id: threadId,
        summary_of_discussion: 'Discussion history in progress.',
      },
    },
    { upsert: true }
  );

  return ContextMemory.findOne({ thread_id: threadId }).lean();
}

async function findPostById(postId) {
  return Post.findOne({ post_id: postId }).lean();
}

async function enqueueJob({
  type,
  payload = {},
  runAt = new Date(),
  maxAttempts = 3,
}) {
  const job = await Job.create({
    type,
    payload,
    runAt,
    maxAttempts,
    status: 'queued',
  });

  return job.toObject();
}

async function findExistingQueuedJob(type, payload = {}) {
  return Job.findOne({
    type,
    status: { $in: ['queued', 'running'] },
    payload,
  }).lean();
}

async function enqueueUniqueJob({
  type,
  payload = {},
  runAt = new Date(),
  maxAttempts = 3,
}) {
  const existing = await findExistingQueuedJob(type, payload);
  if (existing) {
    return existing;
  }

  return enqueueJob({ type, payload, runAt, maxAttempts });
}

async function releaseExpiredJobs({
  staleMs = 30 * 60 * 1000,
} = {}) {
  const threshold = new Date(Date.now() - staleMs);
  await Job.updateMany(
    {
      status: 'running',
      lockedAt: { $lte: threshold },
    },
    {
      $set: {
        status: 'queued',
        lockedAt: null,
        lockedBy: null,
        updated_at: new Date(),
      },
      $inc: {
        attempts: 1,
      },
    }
  );
}

async function leaseNextJob(workerId, { allowedTypes = null } = {}) {
  const now = new Date();
  const query = {
    status: 'queued',
    runAt: { $lte: now },
  };

  if (Array.isArray(allowedTypes) && allowedTypes.length) {
    query.type = { $in: allowedTypes };
  }

  return Job.findOneAndUpdate(
    query,
    {
      $set: {
        status: 'running',
        lockedBy: workerId,
        lockedAt: now,
        updated_at: now,
      },
      $inc: {
        attempts: 1,
      },
    },
    {
      sort: { runAt: 1, created_at: 1 },
      new: true,
    }
  ).lean();
}

async function completeJob(jobId, result = null) {
  return Job.findByIdAndUpdate(
    jobId,
    {
      $set: {
        status: 'completed',
        result,
        lockedAt: null,
        lockedBy: null,
        updated_at: new Date(),
      },
    },
    { new: true }
  ).lean();
}

async function failJob(jobId, error, { retryDelayMs = 10 * 60 * 1000 } = {}) {
  const job = await Job.findById(jobId).lean();
  if (!job) {
    return null;
  }

  const shouldRetry = job.attempts < job.maxAttempts;
  return Job.findByIdAndUpdate(
    jobId,
    {
      $set: {
        status: shouldRetry ? 'queued' : 'failed',
        lastError: error?.message || String(error),
        runAt: shouldRetry ? new Date(Date.now() + retryDelayMs) : job.runAt,
        lockedAt: null,
        lockedBy: null,
        updated_at: new Date(),
      },
    },
    { new: true }
  ).lean();
}

async function getJobsByStatus(status, { limit = 100 } = {}) {
  return Job.find({ status })
    .sort({ updated_at: -1, runAt: 1 })
    .limit(limit)
    .lean();
}

async function clearJobs({
  types = null,
  statuses = ['queued', 'running'],
} = {}) {
  const query = {
    status: { $in: statuses },
  };

  if (Array.isArray(types) && types.length) {
    query.type = { $in: types };
  }

  return Job.deleteMany(query);
}

async function upsertAgentState(key, value) {
  await AgentState.updateOne(
    { key },
    {
      $set: {
        value,
        updated_at: new Date(),
      },
      $setOnInsert: {
        key,
      },
    },
    { upsert: true }
  );

  return AgentState.findOne({ key }).lean();
}

async function getAgentState(key) {
  return AgentState.findOne({ key }).lean();
}

module.exports = {
  DEFAULT_DB_NAME,
  DEFAULT_URI,
  appendThreadHistory,
  clearJobs,
  closeDatabase,
  connectDatabase,
  completeJob,
  enqueueJob,
  enqueueUniqueJob,
  failJob,
  getAgentState,
  findPostById,
  findExistingQueuedJob,
  getCollections,
  getContextMemory,
  getDb,
  getDiscoveredGroups,
  getGroupsByStatus,
  getInteractionCountsSince,
  getJobsByStatus,
  hasInteraction,
  leaseNextJob,
  listPendingPosts,
  logInteraction,
  markPostStatus,
  findGroupByName,
  findLeadByPostId,
  releaseExpiredJobs,
  saveDiscoveredGroups,
  setupCollections,
  getLeadsByInteractionResult,
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
};
