'use strict';

const mongoose = require('mongoose');

const DEFAULT_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fb_agent';
const DEFAULT_DB_NAME = process.env.MONGODB_DB_NAME || 'fb_agent';

let isInitialized = false;

const postSchema = new mongoose.Schema(
  {
    post_id: { type: String, required: true, unique: true, index: true },
    group: { type: String, required: true, index: true },
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
    url: { type: String, required: true },
    group_id: { type: String, default: null },
    discovered_at: { type: Date, required: true, default: Date.now },
    last_seen_at: { type: Date, default: Date.now, index: true },
    source: { type: String, default: 'facebook_search' },
  },
  { collection: 'Discovered_Groups', versionKey: false }
);

discoveredGroupSchema.index({ keyword: 1, url: 1 }, { unique: true });

const Post = mongoose.models.Post || mongoose.model('Post', postSchema);
const Interaction =
  mongoose.models.Interaction || mongoose.model('Interaction', interactionSchema);
const ContextMemory =
  mongoose.models.ContextMemory ||
  mongoose.model('ContextMemory', contextMemorySchema);
const DiscoveredGroup =
  mongoose.models.DiscoveredGroup ||
  mongoose.model('DiscoveredGroup', discoveredGroupSchema);

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

async function setupCollections() {
  if (mongoose.connection.readyState !== 1) {
    throw new Error('Database not connected. Call connectDatabase() first.');
  }

  if (!isInitialized) {
    await Promise.all([
      Post.init(),
      Interaction.init(),
      ContextMemory.init(),
      DiscoveredGroup.init(),
    ]);
    isInitialized = true;
  }
}

function getCollections() {
  return {
    posts: Post,
    interactions: Interaction,
    contextMemory: ContextMemory,
    discoveredGroups: DiscoveredGroup,
  };
}

async function upsertPost(post) {
  const now = new Date();

  await Post.updateOne(
    { post_id: post.post_id },
    {
      $set: {
        group: post.group,
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
      { keyword, url: group.url },
      {
        $set: {
          name: group.name,
          group_id: group.id || null,
          source: group.source || 'facebook_search',
          last_seen_at: now,
        },
        $setOnInsert: {
          keyword,
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

module.exports = {
  DEFAULT_DB_NAME,
  DEFAULT_URI,
  appendThreadHistory,
  closeDatabase,
  connectDatabase,
  findPostById,
  getCollections,
  getContextMemory,
  getDb,
  getDiscoveredGroups,
  getInteractionCountsSince,
  hasInteraction,
  listPendingPosts,
  logInteraction,
  markPostStatus,
  saveDiscoveredGroups,
  setupCollections,
  updateContextPhase,
  updatePostScore,
  upsertContextMemory,
  upsertPost,
};
