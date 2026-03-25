'use strict';

function createGroupsApi({
  FACEBOOK_BASE_URL,
  randomBetween,
  lightHumanPause,
  extractGroupIdFromUrl,
  isCanonicalGroupUrl,
  isLikelyGroupName,
}) {
  function parseActivityToHours(activityText = '') {
    const normalized = String(activityText).toLowerCase().trim();
    if (!normalized) {
      return null;
    }

    if (/a few seconds|few seconds|just now/.test(normalized)) {
      return 0;
    }

    const minuteMatch = normalized.match(/(\d+|an?|few)\s+minutes?/);
    if (minuteMatch) {
      const raw = minuteMatch[1];
      const minutes = raw === 'a' || raw === 'an' ? 1 : raw === 'few' ? 3 : Number(raw);
      return minutes / 60;
    }

    if (/about an hour|an hour|a hour/.test(normalized)) {
      return 1;
    }

    const hourMatch = normalized.match(/(\d+)\s+hours?/);
    if (hourMatch) {
      return Number(hourMatch[1]);
    }

    const dayMatch = normalized.match(/(\d+|an?|few)\s+days?/);
    if (dayMatch) {
      const raw = dayMatch[1];
      const days = raw === 'a' || raw === 'an' ? 1 : raw === 'few' ? 3 : Number(raw);
      return days * 24;
    }

    const weekMatch = normalized.match(/(\d+|an?)\s+weeks?/);
    if (weekMatch) {
      const raw = weekMatch[1];
      const weeks = raw === 'a' || raw === 'an' ? 1 : Number(raw);
      return weeks * 24 * 7;
    }

    const monthMatch = normalized.match(/(\d+|an?)\s+months?/);
    if (monthMatch) {
      const raw = monthMatch[1];
      const months = raw === 'a' || raw === 'an' ? 1 : Number(raw);
      return months * 24 * 30;
    }

    const yearMatch = normalized.match(/(\d+|an?|a)\s+years?/);
    if (yearMatch) {
      const raw = yearMatch[1];
      const years = raw === 'a' || raw === 'an' ? 1 : Number(raw);
      return years * 24 * 365;
    }

    return null;
  }

  async function inspectGroupActivity(page) {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const match = bodyText.match(/Last active\s+([^\n]+)/i);
    const activityLabel = match ? match[1].trim() : null;
    const activityAgeHours = activityLabel ? parseActivityToHours(activityLabel) : null;
    return {
      activityLabel,
      activityAgeHours,
    };
  }

  async function visitGroup(page, groupUrl) {
    await page.goto(groupUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });
    await lightHumanPause(page, 1_000, 2_000);
    return page.url();
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
      return process.env.JOIN_CONTACT_EMAIL || 'nandmonlinellc@gmail.com';
    }

    if (looksLikeWhatsappQuestion(questionText)) {
      return process.env.JOIN_WHATSAPP_NUMBER || '8032950456';
    }

    if (looksLikeLocationQuestion(questionText)) {
      return process.env.JOIN_LOCATION || 'USA';
    }

    return answers[index]
      || 'I work with Amazon sellers and would love to contribute and learn from the community.';
  }

  function pickCheckboxChoice(questionText) {
    const text = questionText.toLowerCase();

    if (/follow the rules|agree to the rules|not spam|no spam|abide by/i.test(text)) {
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
        const clickable = first.locator('xpath=ancestor::*[@role="radio" or self::label or self::div][1]');
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

      const clickable = checkbox.locator('xpath=ancestor::*[@role="checkbox" or self::label or self::div][1]');
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
        document.querySelectorAll('div, fieldset, [role="radiogroup"], [role="group"], form')
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

        const labelTexts = Array.from(container.querySelectorAll('label, span, legend, div[dir="auto"]'))
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
        const hint = (structuredAnswers.optionHints[index] || pickCheckboxChoice(entry.questionText)).toLowerCase();
        let selected = false;

        for (let optionIndex = 0; optionIndex < radioCount; optionIndex += 1) {
          const option = radioOptions.nth(optionIndex);
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
          const optionContainer = option.locator('xpath=ancestor::*[@role="checkbox" or self::label or self::div][1]');
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

    const submitButton = joinDialog.getByRole('button', { name: /submit|send|join group|apply/i }).first();
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
    const joinButton = page.getByRole('button', { name: /join group|join/i }).first();

    if (!(await joinButton.count())) {
      return { joined: false, pendingApproval: false };
    }

    await joinButton.scrollIntoViewIfNeeded();
    await lightHumanPause(page, 800, 1800);
    await joinButton.click({ delay: randomBetween(60, 180) });
    await page.waitForTimeout(randomBetween(2_000, 5_000));

    const joinDialog = page.locator('div[role="dialog"]').last();
    if ((await joinDialog.count()) && (await joinDialog.isVisible())) {
      if (typeof options.dynamicJoinLoop === 'function') {
        const dynamicResult = await options.dynamicJoinLoop(page, joinDialog);
        if (dynamicResult) {
          return dynamicResult;
        }
      }

      let modalHandled = false;
      let answeredQuestions = [];
      let answers = [];

      for (let step = 0; step < 6; step += 1) {
        if (!((await joinDialog.count()) && (await joinDialog.isVisible()))) {
          break;
        }

        const hasInputs = await joinDialog
          .locator('textarea, input[type="text"], input[type="email"], input:not([type]), div[role="textbox"][contenteditable="true"], [role="radiogroup"], fieldset, input[type="checkbox"], [role="checkbox"]')
          .count();

        if (hasInputs && typeof options.answerJoinQuestions === 'function') {
          const modalResult = await answerJoinQuestionsInModal(page, joinDialog, options.answerJoinQuestions);
          modalHandled = true;
          answeredQuestions = modalResult.answeredQuestions || answeredQuestions;
          answers = modalResult.answers || answers;
        }

        const nextButton = joinDialog.getByRole('button', { name: /next|continue|i agree|agree|got it|review/i }).first();
        if (await nextButton.count()) {
          await nextButton.waitFor({ state: 'visible', timeout: 10_000 });
          await nextButton.click({ delay: randomBetween(60, 180) });
          await page.waitForTimeout(randomBetween(1_500, 3_000));
          continue;
        }

        const submitButton = joinDialog.getByRole('button', { name: /submit|send|join group|apply|done/i }).first();
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

      if (seenUrls.has(normalizedUrl) || !isCanonicalGroupUrl(normalizedUrl) || !isLikelyGroupName(name)) {
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

  async function scrapeJoinedGroups(page, { limit = 200, scrollRounds = 12 } = {}) {
    const candidateUrls = [
      `${FACEBOOK_BASE_URL}/groups/feed/`,
      `${FACEBOOK_BASE_URL}/groups/?category=membership`,
    ];
    const results = [];
    const seenUrls = new Set();

    for (const targetUrl of candidateUrls) {
      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 90_000,
      });
      await lightHumanPause(page, 2_000, 4_000);

      for (let round = 0; round < scrollRounds; round += 1) {
        const links = page.locator('a[href*="/groups/"]');
        const count = Math.min(await links.count(), 120);

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

          if (seenUrls.has(normalizedUrl) || !isCanonicalGroupUrl(normalizedUrl) || !isLikelyGroupName(name)) {
            continue;
          }

          seenUrls.add(normalizedUrl);
          results.push({
            name,
            url: normalizedUrl,
            id: extractGroupIdFromUrl(normalizedUrl),
            status: 'joined',
            source: 'groups_membership',
          });

          if (results.length >= limit) {
            return results;
          }
        }

        await page.mouse.wheel(0, 1500);
        await page.waitForTimeout(1200);
      }
    }

    return results;
  }

  async function listVisibleJoinedGroups(page, { limit = 100, scrollRounds = 8 } = {}) {
    return scrapeJoinedGroups(page, { limit, scrollRounds });
  }

  return {
    discoverGroups,
    handleJoinGroup,
    inspectGroupMembershipStatus,
    inspectGroupActivity,
    isCreatePostComposerVisible,
    listVisibleJoinedGroups,
    parseActivityToHours,
    scrapeJoinedGroups,
    visitGroup,
  };
}

module.exports = {
  createGroupsApi,
};
