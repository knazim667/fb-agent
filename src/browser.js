'use strict';

const fs = require('fs/promises');
const path = require('path');

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

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

      while (Date.now() - startTime < loginTimeout) {
        await page.waitForTimeout(2_000);

        const cookies = await page.context().cookies();
        const hasSessionCookie = cookies.some(
          (cookie) => cookie.name === 'c_user' || cookie.name === 'xs'
        );
        const currentUrl = page.url();
        const stillOnLoginPage =
          /login|checkpoint|recover|device-based/i.test(currentUrl) ||
          (await page.locator('input[name="email"], input[name="pass"]').count()) > 0;

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

async function visitGroup(page, groupUrl) {
  await page.goto(groupUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  await lightHumanPause(page, 2_000, 5_000);
  return page.url();
}

async function scrapeNotifications(page, { limit = 5 } = {}) {
  await page.goto(`${FACEBOOK_BASE_URL}/notifications`, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  await lightHumanPause(page, 1_500, 3_000);

  const links = page.locator('a[href*="/posts/"], a[href*="story_fbid="], a[role="link"]');
  const count = Math.min(await links.count(), 40);
  const notifications = [];
  const seen = new Set();

  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    let text = '';
    let href = '';

    try {
      text = ((await link.innerText()) || '').trim();
      href = (await link.getAttribute('href')) || '';
    } catch (_error) {
      continue;
    }

    if (!text || text.length < 5) {
      continue;
    }

    const url = href
      ? href.startsWith('http') ? href : `${FACEBOOK_BASE_URL}${href}`
      : null;
    const key = `${text}::${url || 'none'}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    notifications.push({
      text,
      href: url,
      postId: extractPostIdFromUrl(url || ''),
    });

    if (notifications.length >= limit) {
      break;
    }
  }

  return notifications;
}

async function scrapeInboxPreviews(page, { limit = 3 } = {}) {
  await page.goto('https://www.facebook.com/messages', {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  await lightHumanPause(page, 2_000, 4_000);

  const threadLinks = page.locator('a[href*="/messages/t/"], a[role="link"][href*="/t/"]');
  const count = Math.min(await threadLinks.count(), 30);
  const previews = [];
  const seen = new Set();

  for (let index = 0; index < count; index += 1) {
    const link = threadLinks.nth(index);
    let text = '';
    let href = '';

    try {
      text = ((await link.innerText()) || '').trim();
      href = (await link.getAttribute('href')) || '';
    } catch (_error) {
      continue;
    }

    if (!text || text.length < 3) {
      continue;
    }

    const url = href.startsWith('http') ? href : `${FACEBOOK_BASE_URL}${href}`;
    if (seen.has(url)) {
      continue;
    }

    seen.add(url);
    previews.push({
      text,
      href: url,
    });

    if (previews.length >= limit) {
      break;
    }
  }

  return previews;
}

async function sendInboxReply(page, threadUrl, text) {
  await page.goto(threadUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  await lightHumanPause(page, 1_500, 3_000);

  const composer = page
    .locator('div[role="textbox"][contenteditable="true"], div[aria-label*="Message"][contenteditable="true"]')
    .first();
  await composer.waitFor({ state: 'visible', timeout: 20_000 });
  await composer.click({ delay: randomBetween(50, 120) });
  await page.keyboard.type(text, { delay: randomBetween(25, 80) });
  await page.waitForTimeout(randomBetween(700, 1_400));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(randomBetween(1_200, 3_000));
  return true;
}

async function answerJoinQuestionsInModal(page, joinDialog, answerJoinQuestions) {
  const questionBlocks = joinDialog.locator('label, div[dir="auto"], span[dir="auto"], legend');
  const textareas = joinDialog.locator('textarea, div[role="textbox"][contenteditable="true"]');
  const radioGroups = joinDialog.locator('[role="radiogroup"], fieldset');
  const questionTexts = [];

  const questionCount = Math.min(await questionBlocks.count(), 30);
  for (let index = 0; index < questionCount; index += 1) {
    try {
      const text = ((await questionBlocks.nth(index).innerText()) || '').trim();
      if (text && text.length > 6) {
        questionTexts.push(text);
      }
    } catch (_error) {
      continue;
    }
  }

  const joinQuestions = [...new Set(questionTexts)].slice(0, 8);
  const structuredAnswers = await answerJoinQuestions(joinQuestions);

  const textareaCount = Math.min(await textareas.count(), structuredAnswers.answers.length);
  for (let index = 0; index < textareaCount; index += 1) {
    const field = textareas.nth(index);
    await field.waitFor({ state: 'visible', timeout: 10_000 });
    await field.click({ delay: randomBetween(50, 120) });
    await page.keyboard.type(structuredAnswers.answers[index] || '', {
      delay: randomBetween(25, 70),
    });
    await page.waitForTimeout(randomBetween(300, 900));
  }

  const radioCount = Math.min(await radioGroups.count(), structuredAnswers.optionHints.length);
  for (let index = 0; index < radioCount; index += 1) {
    const group = radioGroups.nth(index);
    const options = group.locator('[role="radio"], input[type="radio"]');
    const optionCount = await options.count();
    if (!optionCount) {
      continue;
    }

    const hint = (structuredAnswers.optionHints[index] || '').toLowerCase();
    let selected = false;

    for (let optionIndex = 0; optionIndex < optionCount; optionIndex += 1) {
      const option = options.nth(optionIndex);
      const optionContainer = option.locator('xpath=ancestor::*[@role="radio" or self::label or self::div][1]');
      let optionText = '';
      try {
        optionText = ((await optionContainer.innerText()) || '').trim().toLowerCase();
      } catch (_error) {
        optionText = '';
      }

      if (!hint || (optionText && optionText.includes(hint))) {
        await optionContainer.click({ delay: randomBetween(40, 120) });
        selected = true;
        break;
      }
    }

    if (!selected) {
      await options.first().click({ delay: randomBetween(40, 120) });
    }
  }

  const submitButton = joinDialog
    .getByRole('button', { name: /submit|send|join group|apply/i })
    .first();
  await submitButton.waitFor({ state: 'visible', timeout: 15_000 });
  await submitButton.click({ delay: randomBetween(60, 180) });
  await page.waitForTimeout(randomBetween(2_000, 5_000));

  return {
    answeredQuestions: joinQuestions,
    answers: structuredAnswers.answers,
    submitted: true,
  };
}

async function handleJoinGroup(page, options = {}) {
  const joinButton = page
    .getByRole('button', { name: /join group|join/i })
    .first();

  if (!(await joinButton.count())) {
    return { joined: false, pendingApproval: false };
  }

  await joinButton.scrollIntoViewIfNeeded();
  await lightHumanPause(page, 800, 1800);
  await joinButton.click({ delay: randomBetween(60, 180) });
  await page.waitForTimeout(randomBetween(2_000, 5_000));

  const joinDialog = page.locator('div[role="dialog"]').last();
  if ((await joinDialog.count()) && (await joinDialog.isVisible())) {
    if (typeof options.answerJoinQuestions === 'function') {
      const modalResult = await answerJoinQuestionsInModal(
        page,
        joinDialog,
        options.answerJoinQuestions
      );
      return {
        joined: true,
        pendingApproval: true,
        modalHandled: true,
        ...modalResult,
      };
    }

    const submitButton = joinDialog
      .getByRole('button', { name: /submit|send|join group|apply/i })
      .first();
    if (await submitButton.count()) {
      await submitButton.waitFor({ state: 'visible', timeout: 15_000 });
      await submitButton.click({ delay: randomBetween(60, 180) });
      await page.waitForTimeout(randomBetween(2_000, 5_000));
    }
  }

  return { joined: true, pendingApproval: true, modalHandled: false };
}

async function discoverGroups(page, keyword, options = {}) {
  const maxResults = options.maxResults || 5;
  const searchUrl = `${FACEBOOK_BASE_URL}/search/groups/?q=${encodeURIComponent(keyword)}`;

  await page.goto(searchUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  await lightHumanPause(page, 2_000, 4_000);

  const resultLinks = page.locator('a[href*="/groups/"]');
  const count = Math.min(await resultLinks.count(), 40);
  const results = [];
  const seenUrls = new Set();

  for (let index = 0; index < count; index += 1) {
    const link = resultLinks.nth(index);
    let href = '';
    let name = '';

    try {
      href = (await link.getAttribute('href')) || '';
      name = ((await link.innerText()) || '').trim();
    } catch (_error) {
      continue;
    }

    if (!href || !name) {
      continue;
    }

    const url = href.startsWith('http') ? href : `${FACEBOOK_BASE_URL}${href}`;
    const normalizedUrl = url.split('?')[0];

    if (
      seenUrls.has(normalizedUrl) ||
      !isCanonicalGroupUrl(normalizedUrl) ||
      !isLikelyGroupName(name)
    ) {
      continue;
    }

    seenUrls.add(normalizedUrl);
    results.push({
      keyword,
      name,
      url: normalizedUrl,
      id: extractGroupIdFromUrl(normalizedUrl),
      source: 'facebook_search',
    });

    if (results.length >= maxResults) {
      break;
    }
  }

  return results;
}

async function scrapeGroupFeed(page, { limit = 20 } = {}) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(randomBetween(2_000, 4_000));

  const postLocator = page.locator('div[role="feed"] > div, div[aria-posinset]');
  const count = Math.min(await postLocator.count(), limit * 2);
  const posts = [];

  for (let index = 0; index < count; index += 1) {
    const item = postLocator.nth(index);
    const textLocator = item.locator('div[data-ad-preview="message"], div[dir="auto"]');
    const authorLocator = item.locator('h2 a, h3 a, strong span a');
    const linkLocator = item.locator('a[href*="/posts/"], a[href*="story_fbid="]').first();

    let postText = '';
    let authorName = '';
    let postUrl = '';

    try {
      postText = ((await textLocator.first().innerText()) || '').trim();
    } catch (_error) {
      postText = '';
    }

    try {
      authorName = ((await authorLocator.first().innerText()) || '').trim();
    } catch (_error) {
      authorName = '';
    }

    try {
      postUrl = (await linkLocator.getAttribute('href')) || '';
    } catch (_error) {
      postUrl = '';
    }

    const postId = extractPostIdFromUrl(postUrl);

    if (!postText || !postId) {
      continue;
    }

    posts.push({
      postId,
      postText,
      authorName,
      postUrl: postUrl.startsWith('http')
        ? postUrl
        : `${FACEBOOK_BASE_URL}${postUrl}`,
    });

    if (posts.length >= limit) {
      break;
    }
  }

  return posts;
}

async function findPostContainer(page, postId) {
  const candidates = [
    page.locator(`a[href*="/posts/${postId}"]`).first(),
    page.locator(`a[href*="story_fbid=${postId}"]`).first(),
  ];

  for (const candidate of candidates) {
    if (await candidate.count()) {
      return candidate.locator('xpath=ancestor::div[@role="article"][1]');
    }
  }

  throw new Error(`Unable to locate post container for post ID ${postId}.`);
}

async function clickLike(page, postId) {
  const post = await findPostContainer(page, postId);
  const likeButton = post
    .getByRole('button', { name: /like/i })
    .filter({ hasNotText: /liked/i })
    .first();

  await likeButton.scrollIntoViewIfNeeded();
  await lightHumanPause(page, 800, 1_800);
  await likeButton.click({ delay: randomBetween(60, 180) });
  await page.waitForTimeout(randomBetween(1_000, 2_500));
  return true;
}

async function postComment(page, postId, text) {
  const post = await findPostContainer(page, postId);
  const commentBox = post
    .locator('[aria-label*="Comment"], div[role="textbox"][contenteditable="true"]')
    .first();

  await commentBox.scrollIntoViewIfNeeded();
  await lightHumanPause(page, 1_000, 2_200);
  await commentBox.click({ delay: randomBetween(60, 180) });
  await page.keyboard.type(text, { delay: randomBetween(35, 90) });
  await page.waitForTimeout(randomBetween(800, 1_600));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(randomBetween(1_500, 3_500));
  return true;
}

async function createNewPost(page, groupId, text, imagePath = null) {
  const groupUrl = `${FACEBOOK_BASE_URL}/groups/${groupId}`;
  await visitGroup(page, groupUrl);

  const createPostTrigger = page
    .getByRole('button', { name: /write something|create public post|what's on your mind/i })
    .first();

  await createPostTrigger.scrollIntoViewIfNeeded();
  await lightHumanPause(page, 1_000, 2_000);
  await createPostTrigger.click({ delay: randomBetween(60, 180) });

  const composer = page
    .locator('div[role="dialog"] div[role="textbox"][contenteditable="true"]')
    .first();
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await composer.click({ delay: randomBetween(50, 120) });
  await page.keyboard.type(text, { delay: randomBetween(30, 85) });

  if (imagePath) {
    const fileInput = page
      .locator('div[role="dialog"] input[type="file"]')
      .first();
    await fileInput.setInputFiles(path.resolve(imagePath));
    await page.waitForTimeout(randomBetween(2_000, 5_000));
  }

  const postButton = page
    .getByRole('button', { name: /^post$/i })
    .last();
  await lightHumanPause(page, 1_000, 2_200);
  await postButton.click({ delay: randomBetween(60, 180) });
  await page.waitForTimeout(randomBetween(4_000, 8_000));
  return true;
}

module.exports = {
  DEFAULT_TASK_INPUT_PATH,
  DEFAULT_USER_DATA_DIR,
  closeBrowser,
  clickLike,
  createNewPost,
  discoverGroups,
  ensureLoggedIn,
  extractGroupIdFromUrl,
  isCanonicalGroupUrl,
  isLikelyGroupName,
  extractPostIdFromUrl,
  handleJoinGroup,
  humanJitter,
  launchBrowser,
  lightHumanPause,
  openTaskGroups,
  postComment,
  readTaskInput,
  scrapeInboxPreviews,
  scrapeNotifications,
  scrapeGroupFeed,
  sendInboxReply,
  visitGroup,
};
