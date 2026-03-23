'use strict';

function createNotificationsApi({
  FACEBOOK_BASE_URL,
  lightHumanPause,
  extractPostIdFromUrl,
}) {
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
    await composer.click({ delay: 90 });
    await page.keyboard.type(text, { delay: 45 });
    await page.waitForTimeout(1000);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    return true;
  }

  return {
    scrapeInboxPreviews,
    scrapeJoinApprovalNotifications,
    scrapeNotifications,
    sendInboxReply,
  };
}

module.exports = {
  createNotificationsApi,
};
