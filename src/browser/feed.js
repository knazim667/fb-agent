'use strict';

function createFeedApi({
  FACEBOOK_BASE_URL,
  randomBetween,
}) {
  async function loadGroupFeedPosts(page, { scrollRounds = 5 } = {}) {
    for (let round = 0; round < scrollRounds; round += 1) {
      await page.evaluate(() => {
        window.scrollBy(0, 800);
      });
      await page.waitForTimeout(2000);
    }
  }

  async function scrapeGroupFeed(page, { limit = 20, scrollRounds = 5 } = {}) {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(randomBetween(2_000, 4_000));
    await loadGroupFeedPosts(page, { scrollRounds });

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

      const postId = (() => {
        if (!postUrl) {
          return null;
        }
        const directPostMatch = postUrl.match(/\/posts\/(\d+)/i);
        if (directPostMatch) {
          return directPostMatch[1];
        }
        const storyMatch = postUrl.match(/[?&]story_fbid=(\d+)/i);
        if (storyMatch) {
          return storyMatch[1];
        }
        const permalinkMatch = postUrl.match(/\/permalink\/(\d+)/i);
        return permalinkMatch ? permalinkMatch[1] : null;
      })();

      if (!postText || !postId) {
        continue;
      }

      posts.push({
        postId,
        postText,
        authorName,
        postUrl: postUrl.startsWith('http') ? postUrl : `${FACEBOOK_BASE_URL}${postUrl}`,
      });

      if (posts.length >= limit) {
        break;
      }
    }

    return posts;
  }

  return {
    loadGroupFeedPosts,
    scrapeGroupFeed,
  };
}

module.exports = {
  createFeedApi,
};
