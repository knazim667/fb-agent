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
const DEFAULT_JOIN_EMAIL =
  process.env.JOIN_CONTACT_EMAIL || 'nandmonlinellc@gmail.com';
const DEFAULT_WHATSAPP_NUMBER =
  process.env.JOIN_WHATSAPP_NUMBER || '8032950456';
const DEFAULT_LOCATION = process.env.JOIN_LOCATION || 'USA';

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

async function visitGroup(page, groupUrl) {
  await page.goto(groupUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  await lightHumanPause(page, 2_000, 5_000);
  return page.url();
}

async function inspectGroupMembershipStatus(page) {
  const composerVisible = await isCreatePostComposerVisible(page);
  if (composerVisible) {
    return 'joined';
  }

  const pendingButton = page
    .getByRole('button', { name: /pending|requested|cancel request/i })
    .first();
  if (await pendingButton.count()) {
    return 'pending';
  }

  const joinButton = page
    .getByRole('button', { name: /join group|join/i })
    .first();
  if (await joinButton.count()) {
    return 'not_joined';
  }

  return 'joined';
}

async function isCreatePostComposerVisible(page) {
  const composerCandidates = [
    page.getByRole('button', { name: /write something|create post|what's on your mind/i }).first(),
    page.locator('[aria-label*="Write something"]').first(),
    page.locator('div[role="textbox"][contenteditable="true"]').first(),
  ];

  for (const candidate of composerCandidates) {
    if (await candidate.count()) {
      return true;
    }
  }

  return false;
}

async function scrapeJoinApprovalNotifications(page, { limit = 10 } = {}) {
  const notifications = await scrapeNotifications(page, { limit: 20 });
  const approvals = [];

  for (const notification of notifications) {
    const match = notification.text.match(
      /(?:approved|accepted)(?:\s+your)?\s+(?:request to join|join request(?:\s+for|\s+to)?)\s+(.+?)(?:\.|$)/i
    );

    if (!match) {
      continue;
    }

    approvals.push({
      groupName: match[1].trim(),
      text: notification.text,
      href: notification.href,
    });

    if (approvals.length >= limit) {
      break;
    }
  }

  return approvals;
}

async function waitForJoinDialogToSettle(page, joinDialog) {
  for (let index = 0; index < 10; index += 1) {
    const pending = await page
      .getByRole('button', { name: /pending|requested|cancel request/i })
      .count();
    if (pending) {
      return 'pending';
    }

    const visible = (await joinDialog.count()) && (await joinDialog.isVisible());
    if (!visible) {
      return 'closed';
    }

    await page.waitForTimeout(800);
  }

  return 'open';
}

async function scrapeNotifications(page, { limit = 5 } = {}) {
  await page.goto(`${FACEBOOK_BASE_URL}/notifications`, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  await lightHumanPause(page, 1_500, 3_000);
  await page.evaluate(() => {
    window.scrollBy(0, 700);
  });
  await page.waitForTimeout(1200);

  const rawNotifications = await page.evaluate((baseUrl, maxItems) => {
    const seen = new Set();
    const results = [];
    const linkNodes = Array.from(document.querySelectorAll('a[href], [role="link"]'));

    for (const node of linkNodes) {
      const href = node.getAttribute('href') || '';
      const nearestCard = node.closest('[role="row"], li, div[data-visualcompletion], div[role="listitem"], div[aria-label]');
      const text = (nearestCard?.innerText || node.innerText || '').trim().replace(/\s+/g, ' ');

      if (!text || text.length < 5) {
        continue;
      }

      if (!/approved|accepted|commented|replied|mentioned|reacted|liked|tagged|sent you a message|message/i.test(text)) {
        continue;
      }

      const normalizedHref = href
        ? (href.startsWith('http') ? href : `${baseUrl}${href}`)
        : null;
      const key = `${text}::${normalizedHref || 'none'}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      results.push({
        text,
        href: normalizedHref,
      });

      if (results.length >= maxItems) {
        break;
      }
    }

    return results;
  }, FACEBOOK_BASE_URL, Math.max(limit * 3, 12));

  return rawNotifications
    .slice(0, limit)
    .map((item) => ({
      text: item.text,
      href: item.href,
      postId: extractPostIdFromUrl(item.href || ''),
    }));
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

async function scrapeJoinedGroups(page, { limit = 40 } = {}) {
  await page.goto(`${FACEBOOK_BASE_URL}/groups/feed/`, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  await lightHumanPause(page, 2_000, 4_000);

  const results = [];
  const seenUrls = new Set();

  for (let round = 0; round < 4; round += 1) {
    const links = page.locator('a[href*="/groups/"]');
    const count = Math.min(await links.count(), 80);

    for (let index = 0; index < count; index += 1) {
      const link = links.nth(index);
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
        name,
        url: normalizedUrl,
        id: extractGroupIdFromUrl(normalizedUrl),
        status: 'joined',
        source: 'groups_feed',
      });

      if (results.length >= limit) {
        return results;
      }
    }

    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(1200);
  }

  return results;
}

function looksLikeEmailQuestion(text = '') {
  return /\bemail\b|\be-mail\b|\bcontact email\b/.test(text.toLowerCase());
}

function looksLikeWhatsappQuestion(text = '') {
  return /\bwhatsapp\b|\bphone number\b|\bmobile number\b|\bcontact number\b/.test(
    text.toLowerCase()
  );
}

function looksLikeLocationQuestion(text = '') {
  return /\bwhere do you live\b|\blocation\b|\bwhere are you from\b|\bcountry\b|\bwhere are you based\b/.test(
    text.toLowerCase()
  );
}

function pickJoinAnswer(questionText, answers = [], index = 0) {
  if (looksLikeEmailQuestion(questionText)) {
    return DEFAULT_JOIN_EMAIL;
  }

  if (looksLikeWhatsappQuestion(questionText)) {
    return DEFAULT_WHATSAPP_NUMBER;
  }

  if (looksLikeLocationQuestion(questionText)) {
    return DEFAULT_LOCATION;
  }

  return answers[index]
    || 'I work with Amazon sellers and would love to contribute and learn from the community.';
}

function pickCheckboxChoice(questionText) {
  const text = questionText.toLowerCase();

  if (
    /follow the rules|agree to the rules|not spam|no spam|abide by/i.test(text)
  ) {
    return 'yes';
  }

  return '';
}

async function completeRemainingJoinChoices(page, joinDialog) {
  const radioGroups = joinDialog.locator('[role="radiogroup"], fieldset');
  const radioGroupCount = await radioGroups.count();

  for (let index = 0; index < radioGroupCount; index += 1) {
    const group = radioGroups.nth(index);
    const checked = await group.locator('[aria-checked="true"], input[type="radio"]:checked').count();
    if (checked) {
      continue;
    }

    const options = group.locator('[role="radio"], input[type="radio"]');
    if (await options.count()) {
      const first = options.first();
      const clickable = first.locator(
        'xpath=ancestor::*[@role="radio" or self::label or self::div][1]'
      );
      if (await clickable.count()) {
        await clickable.click({ delay: randomBetween(40, 120) });
      } else {
        await first.click({ delay: randomBetween(40, 120) });
      }
      await page.waitForTimeout(300);
    }
  }

  const checkboxes = joinDialog.locator('input[type="checkbox"], [role="checkbox"]');
  const checkboxCount = await checkboxes.count();

  for (let index = 0; index < checkboxCount; index += 1) {
    const checkbox = checkboxes.nth(index);
    const ariaChecked = await checkbox.getAttribute('aria-checked').catch(() => null);
    const isChecked = ariaChecked === 'true'
      || await checkbox.evaluate((element) => Boolean(element.checked)).catch(() => false);

    if (isChecked) {
      continue;
    }

    const clickable = checkbox.locator(
      'xpath=ancestor::*[@role="checkbox" or self::label or self::div][1]'
    );
    if (await clickable.count()) {
      await clickable.click({ delay: randomBetween(40, 120) });
    } else {
      await checkbox.click({ delay: randomBetween(40, 120) });
    }
    await page.waitForTimeout(250);
  }
}

async function answerJoinQuestionsInModal(page, joinDialog, answerJoinQuestions) {
  for (let index = 0; index < 4; index += 1) {
    await joinDialog.evaluate((element, step) => {
      element.scrollTop = step * 500;
    }, index);
    await page.waitForTimeout(350);
  }

  await joinDialog.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.waitForTimeout(300);

  const questionEntries = await joinDialog.evaluate(() => {
    const containers = Array.from(
      document.querySelectorAll(
        'div, fieldset, [role="radiogroup"], [role="group"], form'
      )
    );
    const results = [];
    const seen = new Set();

    for (const container of containers) {
      const field = container.querySelector(
        'textarea, input[type="text"], input[type="email"], input:not([type]), div[role="textbox"][contenteditable="true"], input[type="radio"], [role="radio"], input[type="checkbox"], [role="checkbox"]'
      );

      if (!field) {
        continue;
      }

      const labelTexts = Array.from(
        container.querySelectorAll('label, span, legend, div[dir="auto"]')
      )
        .map((node) => (node.innerText || '').trim())
        .filter((text) => text && text.length > 2);

      const questionText = labelTexts[0] || (container.innerText || '').trim().split('\n')[0];
      if (!questionText) {
        continue;
      }

      const fieldId = field.id
        || field.getAttribute('name')
        || field.getAttribute('aria-label')
        || field.outerHTML.slice(0, 120);
      const key = `${questionText}::${fieldId}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      results.push({
        questionText,
        fieldType: field.getAttribute('type') || field.getAttribute('role') || field.tagName.toLowerCase(),
      });
    }

    return results.slice(0, 20);
  });

  const joinQuestions = questionEntries.map((entry) => entry.questionText);
  const structuredAnswers = await answerJoinQuestions(questionEntries);
  const answersUsed = [];

  for (let index = 0; index < questionEntries.length; index += 1) {
    const entry = questionEntries[index];
    const answerText = pickJoinAnswer(entry.questionText, structuredAnswers.answers, index);
    const candidateContainers = joinDialog.locator(
      'div:has(textarea), div:has(input[type="text"]), div:has(input[type="email"]), div:has(input[type="checkbox"]), div:has(input[type="radio"]), div:has([role="textbox"]), fieldset, [role="radiogroup"], [role="group"], form'
    );
    const containerCount = await candidateContainers.count();
    let matchedContainer = null;

    for (let containerIndex = 0; containerIndex < containerCount; containerIndex += 1) {
      const container = candidateContainers.nth(containerIndex);
      let text = '';
      try {
        text = ((await container.innerText()) || '').trim();
      } catch (_error) {
        text = '';
      }

      if (text && text.includes(entry.questionText)) {
        matchedContainer = container;
        break;
      }
    }

    if (!matchedContainer) {
      continue;
    }

    const textField = matchedContainer
      .locator('textarea, input[type="text"], input[type="email"], input:not([type]), div[role="textbox"][contenteditable="true"]')
      .first();

    if (await textField.count()) {
      await textField.waitFor({ state: 'visible', timeout: 10_000 });
      await textField.click({ delay: randomBetween(50, 120) });

      const tagName = await textField.evaluate((element) => element.tagName.toLowerCase());
      if (tagName === 'input' || tagName === 'textarea') {
        await textField.fill('');
        await textField.type(answerText, { delay: 100 });
      } else {
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
        await page.keyboard.type(answerText, { delay: 100 });
      }

      answersUsed.push(answerText);
      await page.waitForTimeout(randomBetween(300, 900));
      continue;
    }

    const radioOptions = matchedContainer.locator('[role="radio"], input[type="radio"]');
    const radioCount = await radioOptions.count();
    if (radioCount) {
      const hint = (
        structuredAnswers.optionHints[index]
        || pickCheckboxChoice(entry.questionText)
      ).toLowerCase();
      let selected = false;

      for (let optionIndex = 0; optionIndex < radioCount; optionIndex += 1) {
        const option = radioOptions.nth(optionIndex);
        const optionContainer = option.locator(
          'xpath=ancestor::*[@role="radio" or self::label or self::div][1]'
        );
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
        await radioOptions.first().click({ delay: randomBetween(40, 120) });
      }

      answersUsed.push(hint || 'selected first radio option');
      continue;
    }

    const checkboxOptions = matchedContainer.locator('input[type="checkbox"], [role="checkbox"]');
    const checkboxCount = await checkboxOptions.count();
    if (checkboxCount) {
      const hint = pickCheckboxChoice(entry.questionText);

      for (let optionIndex = 0; optionIndex < checkboxCount; optionIndex += 1) {
        const option = checkboxOptions.nth(optionIndex);
        const optionContainer = option.locator(
          'xpath=ancestor::*[@role="checkbox" or self::label or self::div][1]'
        );
        let optionText = '';

        try {
          optionText = ((await optionContainer.innerText()) || '').trim().toLowerCase();
        } catch (_error) {
          optionText = '';
        }

        if (!hint || !optionText || optionText.includes(hint)) {
          await optionContainer.click({ delay: randomBetween(40, 120) });
        }
      }

      answersUsed.push(hint || 'checked required checkbox');
    }
  }

  await completeRemainingJoinChoices(page, joinDialog);

  const submitButton = joinDialog
    .getByRole('button', { name: /submit|send|join group|apply/i })
    .first();
  await submitButton.waitFor({ state: 'visible', timeout: 15_000 });
  await submitButton.click({ delay: randomBetween(60, 180) });
  await page.waitForTimeout(randomBetween(2_000, 5_000));

  return {
    answeredQuestions: joinQuestions,
    answers: answersUsed,
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
    let modalHandled = false;
    let answeredQuestions = [];
    let answers = [];

    for (let step = 0; step < 6; step += 1) {
      if (!((await joinDialog.count()) && (await joinDialog.isVisible()))) {
        break;
      }

      const hasInputs = await joinDialog
        .locator(
          'textarea, input[type="text"], input[type="email"], input:not([type]), div[role="textbox"][contenteditable="true"], [role="radiogroup"], fieldset, input[type="checkbox"], [role="checkbox"]'
        )
        .count();

      if (hasInputs && typeof options.answerJoinQuestions === 'function') {
        const modalResult = await answerJoinQuestionsInModal(
          page,
          joinDialog,
          options.answerJoinQuestions
        );
        modalHandled = true;
        answeredQuestions = modalResult.answeredQuestions || answeredQuestions;
        answers = modalResult.answers || answers;
      }

      const nextButton = joinDialog
        .getByRole('button', { name: /next|continue|i agree|agree|got it|review/i })
        .first();
      if (await nextButton.count()) {
        await nextButton.waitFor({ state: 'visible', timeout: 10_000 });
        await nextButton.click({ delay: randomBetween(60, 180) });
        await page.waitForTimeout(randomBetween(1_500, 3_000));
        continue;
      }

      const submitButton = joinDialog
        .getByRole('button', { name: /submit|send|join group|apply|done/i })
        .first();
      if (await submitButton.count()) {
        await submitButton.waitFor({ state: 'visible', timeout: 15_000 });
        await submitButton.click({ delay: randomBetween(60, 180) });
        await page.waitForTimeout(randomBetween(2_000, 5_000));
        const dialogState = await waitForJoinDialogToSettle(page, joinDialog);
        return {
          joined: true,
          pendingApproval: dialogState === 'pending' || dialogState === 'closed',
          modalHandled: true,
          answeredQuestions,
          answers,
          submitted: true,
        };
      }

      break;
    }

    return {
      joined: true,
      pendingApproval: true,
      modalHandled,
      answeredQuestions,
      answers,
    };
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

async function loadGroupFeedPosts(page, { scrollRounds = 5 } = {}) {
  for (let round = 0; round < scrollRounds; round += 1) {
    await page.evaluate(() => {
      window.scrollBy(0, 800);
    });
    await page.waitForTimeout(2000);
  }
}

async function scrapeGroupFeed(page, { limit = 20 } = {}) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(randomBetween(2_000, 4_000));
  await loadGroupFeedPosts(page, { scrollRounds: 5 });

  const postLocator = page.locator('div[role="article"]');
  const count = Math.min(await postLocator.count(), limit * 3);
  const posts = [];

  for (let index = 0; index < count; index += 1) {
    const item = postLocator.nth(index);
    const authorLocator = item.locator('h2 a, h3 a, strong span a').first();

    let postText = '';
    let authorName = '';
    let postUrl = '';

    try {
      postText = ((await item.innerText()) || '').trim();
    } catch (_error) {
      postText = '';
    }

    try {
      authorName = ((await authorLocator.innerText()) || '').trim();
    } catch (_error) {
      authorName = '';
    }

    try {
      postUrl = await item.evaluate((element) => {
        const links = Array.from(element.querySelectorAll('a[href]'));
        const match = links.find((link) => {
          const href = link.getAttribute('href') || '';
          return /\/posts\/|story_fbid=|\/permalink\//i.test(href);
        });

        return match ? match.getAttribute('href') || '' : '';
      });
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
  inspectGroupMembershipStatus,
  isCreatePostComposerVisible,
  isCanonicalGroupUrl,
  isLikelyGroupName,
  extractPostIdFromUrl,
  handleJoinGroup,
  humanJitter,
  launchBrowser,
  loadGroupFeedPosts,
  lightHumanPause,
  openTaskGroups,
  postComment,
  readTaskInput,
  scrapeJoinApprovalNotifications,
  scrapeJoinedGroups,
  scrapeInboxPreviews,
  scrapeNotifications,
  scrapeGroupFeed,
  sendInboxReply,
  visitGroup,
};
