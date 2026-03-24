'use strict';

function createNotificationsApi({
  FACEBOOK_BASE_URL,
  lightHumanPause,
  extractPostIdFromUrl,
}) {
  function parseNotificationAgeHours(text = '') {
    const normalized = String(text || '').toLowerCase();

    if (/\bjust now\b|\bfew seconds\b/.test(normalized)) {
      return 0;
    }
    if (/\btoday\b/.test(normalized)) {
      return 12;
    }
    if (/\byesterday\b/.test(normalized)) {
      return 24;
    }
    if (/\babout an hour\b|\ban hour\b|\ba hour\b/.test(normalized)) {
      return 1;
    }

    const minuteMatch = normalized.match(/\b(\d+)\s*m\b|\b(\d+)\s*minutes?\b/);
    if (minuteMatch) {
      return Number(minuteMatch[1] || minuteMatch[2]) / 60;
    }

    const hourMatch = normalized.match(/\b(\d+)\s*h\b|\b(\d+)\s*hours?\b/);
    if (hourMatch) {
      return Number(hourMatch[1] || hourMatch[2]);
    }

    const dayMatch = normalized.match(/\b(\d+)\s*d\b|\b(\d+)\s*days?\b/);
    if (dayMatch) {
      return Number(dayMatch[1] || dayMatch[2]) * 24;
    }

    const weekMatch = normalized.match(/\b(\d+)\s*w\b|\b(\d+)\s*weeks?\b/);
    if (weekMatch) {
      return Number(weekMatch[1] || weekMatch[2]) * 24 * 7;
    }

    return null;
  }

  function extractRelativeTimeLabel(text = '') {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    const patterns = [
      /\b\d+\s*m\b/i,
      /\b\d+\s*h\b/i,
      /\b\d+\s*d\b/i,
      /\b\d+\s*w\b/i,
      /\b\d+\s*minutes?\b/i,
      /\babout an hour\b/i,
      /\ban hour\b/i,
      /\ba hour\b/i,
      /\b\d+\s*hours?\b/i,
      /\b\d+\s*days?\b/i,
      /\b\d+\s*weeks?\b/i,
      /\btoday\b/i,
      /\byesterday\b/i,
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match) {
        return match[0];
      }
    }

    return '';
  }

  async function scrapeNotifications(page, { limit = 5 } = {}) {
    await page.goto(`${FACEBOOK_BASE_URL}/notifications`, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => null);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => null);
    await lightHumanPause(page, 1_500, 3_000);
    for (let round = 0; round < 2; round += 1) {
      await page.evaluate(() => {
        window.scrollBy(0, 700);
      });
      await page.waitForTimeout(1200);
    }

    const rawNotifications = await page.evaluate(({ baseUrl, maxItems }) => {
      const seen = new Set();
      const results = [];
      const linkNodes = Array.from(document.querySelectorAll('a[href], [role="link"]'));
      let notificationCounter = 0;

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
        notificationCounter += 1;
        const notificationId = `agent-notification-${notificationCounter}`;
        if (nearestCard) {
          nearestCard.setAttribute('data-agent-notification-id', notificationId);
        }
        const key = `${text}::${normalizedHref || 'none'}`;
        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        results.push({
          text,
          href: normalizedHref,
          notification_id: notificationId,
          unread: /\bunread\b/i.test(text),
          has_mark_read: /mark as read/i.test(text),
        });

        if (results.length >= maxItems) {
          break;
        }
      }

      return results;
    }, {
      baseUrl: FACEBOOK_BASE_URL,
      maxItems: Math.max(limit * 3, 12),
    });

    return rawNotifications
      .slice(0, limit)
      .map((item) => {
        const ageLabel = extractRelativeTimeLabel(item.text);
        return {
          text: item.text,
          href: item.href,
          postId: extractPostIdFromUrl(item.href || ''),
          notification_id: item.notification_id,
          unread: Boolean(item.unread),
          has_mark_read: Boolean(item.has_mark_read),
          age_label: ageLabel,
          age_hours: parseNotificationAgeHours(ageLabel || item.text),
        };
      });
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

  async function markNotificationsRead(page, notifications = [], { limit = 5 } = {}) {
    let marked = 0;

    for (const notification of notifications.slice(0, limit)) {
      if (!notification?.notification_id) {
        continue;
      }

      const card = page.locator(
        `[data-agent-notification-id="${notification.notification_id}"]`
      ).first();
      if (!(await card.count())) {
        continue;
      }

      const directMark = card.getByText(/mark as read/i).first();

      if (await directMark.count()) {
        try {
          await directMark.click({ delay: 80, timeout: 5_000 });
          marked += 1;
          await page.waitForTimeout(500);
          continue;
        } catch (_error) {
          // Fall through to the menu-based path.
        }
      }

      const menuButton = card.locator(
        '[aria-label="Actions for this notification"], [aria-label*="More options"], [aria-label*="Actions"], [role="button"][aria-haspopup="menu"]'
      ).first();

      if (!(await menuButton.count())) {
        continue;
      }

      try {
        await menuButton.click({ delay: 80, timeout: 5_000 });
        await page.waitForTimeout(400);
        const menuMark = page.getByText(/mark as read/i).first();
        await menuMark.click({ delay: 80, timeout: 5_000 });
        marked += 1;
        await page.waitForTimeout(500);
      } catch (_error) {
        // Skip this card if Facebook renders a different menu variant.
      }
    }

    return marked;
  }

  return {
    markNotificationsRead,
    scrapeInboxPreviews,
    scrapeJoinApprovalNotifications,
    scrapeNotifications,
    sendInboxReply,
  };
}

module.exports = {
  createNotificationsApi,
};
