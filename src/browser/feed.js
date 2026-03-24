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
    await page.waitForTimeout(randomBetween(1_000, 2_000));
    await loadGroupFeedPosts(page, { scrollRounds });

    const postLocator = page.locator('div[role="article"]');
    const count = Math.min(await postLocator.count(), limit * 3);
    const posts = [];
    const seenPostIds = new Set();

    for (let index = 0; index < count; index += 1) {
      const item = postLocator.nth(index);
      const authorLocator = item.locator('h2 a, h3 a, strong span a').first();

      let postText = '';
      let authorName = '';
      let postUrl = '';

      try {
        const extracted = await item.evaluate((element) => {
          function isVisible(node) {
            const style = window.getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.height > 0 && rect.width > 0;
          }

          function looksLikeUiChrome(text) {
            return /^(like|reply|share|follow|see more|write a comment|leave a comment|comment)$/i.test(text);
          }

          function looksLikeCommentSnippet(text) {
            return /\b(i'?m interested|interested|dm me|inbox me|sent you a message)\b/i.test(text)
              && /\b(like|reply)\b/i.test(text);
          }

          const articleRect = element.getBoundingClientRect();
          const maxTop = articleRect.top + (articleRect.height * 0.58);
          const textNodes = Array.from(element.querySelectorAll('div[dir="auto"], span[dir="auto"], [data-ad-preview="message"]'));
          const chunks = [];
          const seen = new Set();

          for (const node of textNodes) {
            if (!isVisible(node)) {
              continue;
            }
            if (node.closest('form, [role="textbox"], [aria-label*="Comment"], [data-agent-comment-thread="true"]')) {
              continue;
            }

            const rect = node.getBoundingClientRect();
            if (rect.top > maxTop) {
              continue;
            }

            const text = (node.innerText || '').trim().replace(/\s+/g, ' ');
            if (!text || text.length < 3 || looksLikeUiChrome(text) || looksLikeCommentSnippet(text)) {
              continue;
            }

            if (!seen.has(text)) {
              seen.add(text);
              chunks.push(text);
            }
          }

          return chunks.join('\n');
        });
        postText = (extracted || '').trim();
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

      if (/\b(i'?m interested|interested|dm me|inbox me)\b/i.test(postText) && postText.length < 120) {
        continue;
      }

      if (seenPostIds.has(postId)) {
        continue;
      }

      seenPostIds.add(postId);

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
