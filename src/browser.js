'use strict';

const fs = require('fs/promises');
const path = require('path');

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createActionsApi } = require('./browser/actions');
const { createFeedApi } = require('./browser/feed');
const { createGroupsApi } = require('./browser/groups');
const { createInteractionsApi } = require('./browser/interactions');
const { createNotificationsApi } = require('./browser/notifications');
const { createPerceptionApi } = require('./browser/perception');
const { REDDIT_BASE_URL, createRedditApi } = require('./browser/reddit');

chromium.use(StealthPlugin());

const FACEBOOK_BASE_URL = 'https://www.facebook.com';
const DEFAULT_TASK_INPUT_PATH = path.join(__dirname, '..', 'task_input.json');
const DEFAULT_USER_DATA_DIR = path.join(__dirname, '..', 'user_data');
const DEFAULT_HUMAN_JITTER_MIN_MS = Number(process.env.HUMAN_JITTER_MIN_MS || 30_000);
const DEFAULT_HUMAN_JITTER_MAX_MS = Number(process.env.HUMAN_JITTER_MAX_MS || 120_000);
function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readTaskInput(taskInputPath = DEFAULT_TASK_INPUT_PATH) {
  const raw = await fs.readFile(taskInputPath, 'utf8');
  return JSON.parse(raw);
}

function normalizeGroupUrl(groupEntry) {
  if (!groupEntry) {
    return null;
  }

  if (typeof groupEntry === 'string') {
    return groupEntry;
  }

  if (typeof groupEntry === 'object') {
    return groupEntry.url || null;
  }

  return null;
}

function extractPostIdFromUrl(url) {
  if (!url) {
    return null;
  }

  const directPostMatch = url.match(/\/posts\/(\d+)/i);
  if (directPostMatch) {
    return directPostMatch[1];
  }

  const storyMatch = url.match(/[?&]story_fbid=(\d+)/i);
  if (storyMatch) {
    return storyMatch[1];
  }

  const permalinkMatch = url.match(/\/permalink\/(\d+)/i);
  if (permalinkMatch) {
    return permalinkMatch[1];
  }

  return null;
}

function extractGroupIdFromUrl(url) {
  if (!url) {
    return null;
  }

  const match = url.match(/\/groups\/([^/?]+)/i);
  return match ? match[1] : null;
}

function isCanonicalGroupUrl(url) {
  if (!url) {
    return false;
  }

  const normalizedUrl = url.split('?')[0];
  return /^https?:\/\/(?:www\.)?facebook\.com\/groups\/[^/]+\/?$/i.test(normalizedUrl);
}

function isLikelyGroupName(name) {
  if (!name) {
    return false;
  }

  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 120) {
    return false;
  }

  return !/(like your post|approved your post|mark as read|welcome to|unread|commented on|shared your post|reacted to your post)/i.test(
    normalizedName
  );
}

async function humanJitter(page, options = {}) {
  const width = page.viewportSize()?.width || 1366;
  const height = page.viewportSize()?.height || 900;
  const movements = options.movements || randomBetween(2, 5);

  for (let index = 0; index < movements; index += 1) {
    await page.mouse.move(
      randomBetween(40, Math.max(60, width - 40)),
      randomBetween(80, Math.max(120, height - 80)),
      { steps: randomBetween(8, 25) }
    );
    await page.waitForTimeout(randomBetween(120, 650));
  }

  const minDelay = options.minMs || DEFAULT_HUMAN_JITTER_MIN_MS;
  const maxDelay = options.maxMs || DEFAULT_HUMAN_JITTER_MAX_MS;
  const delayMs = options.delayMs || randomBetween(minDelay, maxDelay);

  if (options.logLabel) {
    console.log(`${options.logLabel}: waiting ${Math.round(delayMs / 1000)}s`);
  }

  await page.waitForTimeout(delayMs);
}

async function lightHumanPause(page, minMs = 500, maxMs = 2_500) {
  await page.mouse.move(
    randomBetween(40, 480),
    randomBetween(80, 720),
    { steps: randomBetween(5, 18) }
  );
  await page.waitForTimeout(randomBetween(minMs, maxMs));
}

const {
  listVisibleNotifications,
  markNotificationsRead,
  scrapeInboxPreviews,
  scrapeJoinApprovalNotifications,
  scrapeNotifications,
  sendInboxReply,
} = createNotificationsApi({
  FACEBOOK_BASE_URL,
  lightHumanPause,
  extractPostIdFromUrl,
});
const {
  discoverGroups,
  handleJoinGroup,
  inspectGroupActivity,
  inspectGroupMembershipStatus,
  isCreatePostComposerVisible,
  listVisibleJoinedGroups,
  parseActivityToHours,
  scrapeJoinedGroups,
  visitGroup,
} = createGroupsApi({
  FACEBOOK_BASE_URL,
  randomBetween,
  lightHumanPause,
  extractGroupIdFromUrl,
  isCanonicalGroupUrl,
  isLikelyGroupName,
});
const {
  extractVisiblePostAnchors,
  listVisiblePosts,
  loadGroupFeedPosts,
  scrapeGroupFeed,
} = createFeedApi({
  FACEBOOK_BASE_URL,
  randomBetween,
});
const {
  anchorVisiblePost,
  commentAnchoredPost,
  extractAnchoredPostData,
  likeAnchoredPost,
  verifyAnchoredAction,
} = createActionsApi({
  listVisiblePosts: (page, options) => listVisiblePosts(page, options),
  lightHumanPause,
  randomBetween,
});
const {
  clickLike,
  clickLikeOnVisiblePost,
  createFeedPost,
  createNewPost,
  findVisiblePostContainer,
  postComment,
  postCommentOnVisiblePost,
} = createInteractionsApi({
  FACEBOOK_BASE_URL,
  randomBetween,
  lightHumanPause,
  visitGroup,
});
const {
  classifyPageState,
  executeAgentAction,
  getSimplifiedDOM,
} = createPerceptionApi();
const {
  classifyRedditPage,
  commentOnRedditPost,
  inspectRedditSession,
  listVisibleRedditPosts,
  normalizeSubredditName,
  observeRedditPage,
  searchPosts: searchRedditPosts,
  visitRedditHome,
  visitSubreddit,
} = createRedditApi({
  randomBetween,
});

async function launchBrowser({
  headless = false,
  userDataDir = DEFAULT_USER_DATA_DIR,
} = {}) {
  await ensureDirectory(userDataDir);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
    ],
  });

  let page = context.pages()[0];
  if (!page) {
    page = await context.newPage();
  }

  return { context, page, userDataDir };
}

async function closeBrowser(context) {
  if (context) {
    await context.close();
  }
}

async function ensureLoggedIn(page, options = {}) {
  await page.goto(FACEBOOK_BASE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: options.timeout || 90_000,
  });

  await lightHumanPause(page, 1_000, 2_000);

  const loginIndicators = [
    page.getByLabel(/email or phone/i),
    page.getByLabel(/password/i),
    page.locator('input[name="email"]'),
    page.locator('input[name="pass"]'),
  ];

  for (const indicator of loginIndicators) {
    if (await indicator.count()) {
      console.log(
        'Facebook login required. Please complete login in the opened browser window. The session will be saved in ./user_data.'
      );
      const loginTimeout = options.loginTimeout || 10 * 60 * 1000;
      const startTime = Date.now();
      let securityAlertShown = false;

      while (Date.now() - startTime < loginTimeout) {
        await page.waitForTimeout(2_000);

        const cookies = await page.context().cookies();
        const hasSessionCookie = cookies.some(
          (cookie) => cookie.name === 'c_user' || cookie.name === 'xs'
        );
        const currentUrl = page.url();
        const checkpointVisible =
          /checkpoint/i.test(currentUrl) ||
          (await page.getByText(/6-digit code|security code|enter code|checkpoint/i).count()) > 0;
        const stillOnLoginPage =
          /login|checkpoint|recover|device-based/i.test(currentUrl) ||
          (await page.locator('input[name="email"], input[name="pass"]').count()) > 0;

        if (checkpointVisible && !securityAlertShown) {
          console.log(
            'ALERT: Facebook needs a security code. Please type it in the browser window now.'
          );
          securityAlertShown = true;
        }

        if (hasSessionCookie && !stillOnLoginPage) {
          await page.waitForLoadState('domcontentloaded');
          await lightHumanPause(page, 1_000, 2_000);
          console.log('Facebook session detected. Continuing automation.');
          return true;
        }
      }

      throw new Error(
        'Facebook login did not complete within 10 minutes. Finish the login/checkpoint flow in the browser, then run npm start again.'
      );
    }
  }

  return true;
}

async function openTaskGroups(page, taskInputPath = DEFAULT_TASK_INPUT_PATH) {
  const taskInput = await readTaskInput(taskInputPath);
  const groupUrls = (taskInput.facebook_groups || taskInput.target_groups || [])
    .map(normalizeGroupUrl)
    .filter(Boolean);

  const visited = [];

  for (const groupUrl of groupUrls) {
    await page.goto(groupUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });
    await lightHumanPause(page, 2_000, 5_000);
    await page.mouse.wheel(0, randomBetween(250, 700));
    await page.waitForTimeout(randomBetween(1_000, 3_000));
    visited.push(groupUrl);
  }

  return visited;
}

module.exports = {
  DEFAULT_TASK_INPUT_PATH,
  DEFAULT_USER_DATA_DIR,
  REDDIT_BASE_URL,
  classifyRedditPage,
  closeBrowser,
  commentOnRedditPost,
  anchorVisiblePost,
  clickLike,
  clickLikeOnVisiblePost,
  commentAnchoredPost,
  createFeedPost,
  createNewPost,
  discoverGroups,
  ensureLoggedIn,
  extractGroupIdFromUrl,
  extractAnchoredPostData,
  inspectGroupActivity,
  inspectGroupMembershipStatus,
  isCreatePostComposerVisible,
  isCanonicalGroupUrl,
  isLikelyGroupName,
  extractPostIdFromUrl,
  findVisiblePostContainer,
  executeAgentAction,
  getSimplifiedDOM,
  handleJoinGroup,
  humanJitter,
  inspectRedditSession,
  likeAnchoredPost,
  launchBrowser,
  extractVisiblePostAnchors,
  listVisibleGroups: listVisibleJoinedGroups,
  listVisibleNotifications,
  listVisiblePosts,
  listVisibleRedditPosts,
  loadGroupFeedPosts,
  markNotificationsRead,
  lightHumanPause,
  normalizeSubredditName,
  observeRedditPage,
  openTaskGroups,
  parseActivityToHours,
  postComment,
  postCommentOnVisiblePost,
  readTaskInput,
  classifyPageState,
  scrapeJoinApprovalNotifications,
  scrapeJoinedGroups,
  scrapeInboxPreviews,
  scrapeNotifications,
  scrapeGroupFeed,
  searchRedditPosts,
  sendInboxReply,
  verifyAnchoredAction,
  visitGroup,
  visitRedditHome,
  visitSubreddit,
};
