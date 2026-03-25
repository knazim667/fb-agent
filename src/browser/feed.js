'use strict';

function createFeedApi({
  FACEBOOK_BASE_URL,
  randomBetween,
}) {
  function extractPostIdFromHref(href) {
    if (!href) {
      return null;
    }

    const directPostMatch = href.match(/\/posts\/(\d+)/i);
    if (directPostMatch) {
      return directPostMatch[1];
    }

    const storyMatch = href.match(/[?&]story_fbid=(\d+)/i);
    if (storyMatch) {
      return storyMatch[1];
    }

    const permalinkMatch = href.match(/\/permalink\/(\d+)/i);
    if (permalinkMatch) {
      return permalinkMatch[1];
    }

    return null;
  }

  async function loadGroupFeedPosts(page, { scrollRounds = 5 } = {}) {
    for (let round = 0; round < scrollRounds; round += 1) {
      await page.evaluate(() => {
        window.scrollBy(0, 800);
      });
      await page.waitForTimeout(2000);
    }
  }

  async function extractVisiblePostAnchors(page, { limit = 20, scrollRounds = 2 } = {}) {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(randomBetween(1_000, 2_000));
    await loadGroupFeedPosts(page, { scrollRounds });

    const rawAnchors = await page.evaluate(({ limit }) => {
      const TIMESTAMP_PATTERN = /^(just now|now|today|yesterday|\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|y|yr|yrs|year|years))$/i;

      function normalize(text) {
        return (text || '').trim().replace(/\s+/g, ' ');
      }

      function isVisible(node) {
        if (!node) {
          return false;
        }
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      }

      function matchesControl(node, pattern) {
        const value = normalize(node?.innerText || node?.getAttribute?.('aria-label') || '');
        return pattern.test(value);
      }

      function domDepthFrom(root, node) {
        let depth = 0;
        let current = node;
        while (current && current !== root) {
          current = current.parentElement;
          depth += 1;
        }
        return depth;
      }

      function findAuthorNode(article) {
        const candidates = Array.from(article.querySelectorAll('h2 a, h3 a, strong span a, [role="link"]'));
        return candidates.find((node) => {
          if (!isVisible(node)) {
            return false;
          }
          const text = normalize(node.innerText);
          if (!text || text.length < 2) {
            return false;
          }
          return !TIMESTAMP_PATTERN.test(text) && !/follow|join|invite|share/i.test(text);
        }) || null;
      }

      function findTimestampNode(article) {
        const candidates = Array.from(article.querySelectorAll('a[href], span, div'))
          .filter((node) => isVisible(node))
          .map((node) => ({
            node,
            text: normalize(node.innerText),
          }))
          .filter((entry) => TIMESTAMP_PATTERN.test(entry.text));

        if (!candidates.length) {
          return null;
        }

        candidates.sort((left, right) =>
          left.node.getBoundingClientRect().top - right.node.getBoundingClientRect().top
        );
        return candidates[0].node;
      }

      function findActionButton(article, pattern) {
        return Array.from(article.querySelectorAll('button,[role="button"]'))
          .find((node) => isVisible(node) && matchesControl(node, pattern)) || null;
      }

      function extractMainBodyText(article, actionTop) {
        const chunks = [];
        const seen = new Set();
        const nodes = Array.from(article.querySelectorAll('[data-ad-preview="message"], div[dir="auto"], span[dir="auto"]'));

        for (const node of nodes) {
          if (!isVisible(node)) {
            continue;
          }

          if (node.closest('form, [role="textbox"], [aria-label*="Comment"], [aria-label*="Reply"]')) {
            continue;
          }

          const rect = node.getBoundingClientRect();
          if (rect.top >= actionTop - 6) {
            continue;
          }

          const text = normalize(node.innerText);
          if (!text || text.length < 3) {
            continue;
          }

          if (/^(like|reply|share|follow|see more|write a comment|leave a comment|comment|top contributor)$/i.test(text)) {
            continue;
          }

          if (TIMESTAMP_PATTERN.test(text)) {
            continue;
          }

          if (/\b(i'?m interested|interested|dm me|inbox me|available let'?s connect|available let's connect)\b/i.test(text) && text.length < 160) {
            continue;
          }

          if (domDepthFrom(article, node) > 12) {
            continue;
          }

          if (!seen.has(text)) {
            seen.add(text);
            chunks.push(text);
          }
        }

        return chunks.join('\n').trim();
      }

      const articles = Array.from(document.querySelectorAll('div[role="article"]'));
      const anchors = [];

      for (let articleIndex = 0; articleIndex < articles.length; articleIndex += 1) {
        const article = articles[articleIndex];
        if (!isVisible(article)) {
          continue;
        }

        const authorNode = findAuthorNode(article);
        const timestampNode = findTimestampNode(article);
        const likeButton = findActionButton(article, /^like$/i);
        const commentButton = findActionButton(article, /comment|leave a comment|write a comment/i);
        const replyButton = findActionButton(article, /^reply$/i);
        const shareButton = findActionButton(article, /^share$/i);

        if (!authorNode || !timestampNode || !likeButton || !commentButton) {
          continue;
        }

        const interactionNodes = [likeButton, commentButton, shareButton].filter(Boolean);
        const actionTop = interactionNodes.length
          ? Math.min(...interactionNodes.map((node) => node.getBoundingClientRect().top))
          : Number.POSITIVE_INFINITY;
        const mainBodyText = extractMainBodyText(article, actionTop);
        if (!mainBodyText || mainBodyText.length < 15) {
          continue;
        }

        const authorName = normalize(authorNode.innerText);
        const timestampText = normalize(timestampNode.innerText);
        const urlNode = timestampNode.closest('a[href]') || Array.from(article.querySelectorAll('a[href]'))
          .find((node) => /\/posts\/|story_fbid=|\/permalink\//i.test(node.getAttribute('href') || '')) || null;
        const postUrl = urlNode ? urlNode.getAttribute('href') || '' : '';
        const ignoreAsComment = Boolean(replyButton)
          && !shareButton
          && /\b(reply|replies)\b/i.test(normalize(article.innerText));

        if (ignoreAsComment) {
          continue;
        }

        anchors.push({
          articleIndex,
          authorName,
          timestampText,
          postText: mainBodyText,
          postUrl,
        });

        if (anchors.length >= limit) {
          break;
        }
      }

      return anchors;
    }, { limit: Math.max(limit * 2, 20) });

    const anchors = [];
    const seenPostIds = new Set();

    for (const rawAnchor of rawAnchors) {
      const href = String(rawAnchor.postUrl || '').trim();
      const normalizedUrl = href
        ? (href.startsWith('http') ? href : `${FACEBOOK_BASE_URL}${href}`)
        : '';
      const postId = extractPostIdFromHref(normalizedUrl);
      if (!postId || seenPostIds.has(postId)) {
        continue;
      }

      seenPostIds.add(postId);
      anchors.push({
        visibleIndex: anchors.length + 1,
        articleIndex: rawAnchor.articleIndex,
        postId,
        postText: rawAnchor.postText,
        authorName: rawAnchor.authorName,
        timestampText: rawAnchor.timestampText,
        postUrl: normalizedUrl,
        summary: rawAnchor.postText.split('\n')[0].slice(0, 180),
      });

      if (anchors.length >= limit) {
        break;
      }
    }

    return anchors;
  }

  async function scrapeGroupFeed(page, { limit = 20, scrollRounds = 5 } = {}) {
    return extractVisiblePostAnchors(page, { limit, scrollRounds });
  }

  async function listVisiblePosts(page, { limit = 20, scrollRounds = 2 } = {}) {
    return extractVisiblePostAnchors(page, { limit, scrollRounds });
  }

  return {
    extractVisiblePostAnchors,
    listVisiblePosts,
    loadGroupFeedPosts,
    scrapeGroupFeed,
  };
}

module.exports = {
  createFeedApi,
};
