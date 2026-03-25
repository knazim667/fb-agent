'use strict';

const ABSOLUTE_TIMESTAMP_PATTERN = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{1,2})(?:\s+at\s+\d{1,2}:\d{2}(?:\s?[ap]m)?)?$/i;
const RELATIVE_TIMESTAMP_PATTERN = /^(just now|now|today|yesterday|\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|y|yr|yrs|year|years))$/i;

function looksLikeFacebookTimestamp(text = '') {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return false;
  }
  return RELATIVE_TIMESTAMP_PATTERN.test(normalized) || ABSOLUTE_TIMESTAMP_PATTERN.test(normalized);
}

function classifyFacebookPageMode({ articleCount = 0, bodyText = '', url = '' } = {}) {
  const normalizedBody = String(bodyText || '').toLowerCase();
  const normalizedUrl = String(url || '').toLowerCase();

  if (
    /\/posts\/|story_fbid=|\/permalink\//i.test(normalizedUrl)
    || (articleCount <= 2 && /view more answers|write an answer|write a public comment|public comment|comments?\b/i.test(normalizedBody))
  ) {
    return 'post_detail';
  }

  if (/\/groups\//i.test(normalizedUrl)) {
    return 'group_feed';
  }

  return 'feed';
}

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
    await page.waitForTimeout(1_200);
    const initialArticles = await page.locator('div[role="article"]').count().catch(() => 0);
    if (!initialArticles) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await page.evaluate(() => {
          window.scrollBy(0, 500);
        });
        await page.waitForTimeout(1_500);
        const visibleArticles = await page.locator('div[role="article"]').count().catch(() => 0);
        if (visibleArticles) {
          break;
        }
      }
    }

    for (let round = 0; round < scrollRounds; round += 1) {
      await page.evaluate(() => {
        window.scrollBy(0, 800);
      });
      await page.waitForTimeout(2000);
    }
  }

  async function extractVisiblePostAnchors(page, { limit = 20, scrollRounds = 2, returnMeta = false } = {}) {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(randomBetween(1_000, 2_000));
    await loadGroupFeedPosts(page, { scrollRounds });

    const extracted = await page.evaluate(({ limit }) => {
      const RELATIVE_TIMESTAMP_PATTERN = /^(just now|now|today|yesterday|\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|y|yr|yrs|year|years))$/i;
      const ABSOLUTE_TIMESTAMP_PATTERN = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{1,2})(?:\s+at\s+\d{1,2}:\d{2}(?:\s?[ap]m)?)?$/i;

      function normalize(text) {
        return (text || '').trim().replace(/\s+/g, ' ');
      }

      function looksLikeTimestamp(text) {
        const normalized = normalize(text);
        return RELATIVE_TIMESTAMP_PATTERN.test(normalized) || ABSOLUTE_TIMESTAMP_PATTERN.test(normalized);
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
        const candidates = Array.from(article.querySelectorAll('h2 a, h3 a, strong span a, [role="link"], strong span, h2, h3'));
        return candidates.find((node) => {
          if (!isVisible(node)) {
            return false;
          }
          const text = normalize(node.innerText);
          if (!text || text.length < 2) {
            return false;
          }
          const rect = node.getBoundingClientRect();
          return !looksLikeTimestamp(text)
            && !/follow|join|invite|share/i.test(text)
            && rect.top < article.getBoundingClientRect().top + 180;
        }) || null;
      }

      function findTimestampNode(article) {
        const candidates = Array.from(article.querySelectorAll('a[href], span, div'))
          .filter((node) => isVisible(node))
          .map((node) => ({
            node,
            text: normalize(node.innerText),
          }))
          .filter((entry) => looksLikeTimestamp(entry.text));

        if (!candidates.length) {
          return null;
        }

        candidates.sort((left, right) =>
          left.node.getBoundingClientRect().top - right.node.getBoundingClientRect().top
        );
        return candidates[0].node;
      }

      function findActionButton(article, pattern) {
        return Array.from(article.querySelectorAll('button,[role="button"], a[href], span, div'))
          .find((node) => isVisible(node) && matchesControl(node, pattern)) || null;
      }

      function fallbackTimestampText(article) {
        const articleText = normalize(article.innerText);
        const match = articleText.match(/\b(just now|now|today|yesterday|\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|y|yr|yrs|year|years)|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{1,2})(?:\s+at\s+\d{1,2}:\d{2}(?:\s?[ap]m)?)?)\b/i);
        return match ? normalize(match[1]) : '';
      }

      function findHeaderBoundary(article, authorNode, timestampNode) {
        const articleTop = article.getBoundingClientRect().top;
        const authorBottom = authorNode ? authorNode.getBoundingClientRect().bottom : articleTop;
        const timestampBottom = timestampNode ? timestampNode.getBoundingClientRect().bottom : articleTop;
        return Math.max(authorBottom, timestampBottom, articleTop + 48) + 12;
      }

      function findActionBarTop(article, controls) {
        if (!controls.length) {
          return Number.POSITIVE_INFINITY;
        }
        return Math.min(...controls.map((node) => node.getBoundingClientRect().top));
      }

      function extractMainBodyText(article, headerBottom, actionTop) {
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
          if (rect.top <= headerBottom + 2) {
            continue;
          }
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

          if (looksLikeTimestamp(text)) {
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
      const rejections = [];
      const pageMode = (() => {
        const bodyText = normalize(document.body?.innerText || '');
        const url = window.location.href || '';
        if (
          /\/posts\/|story_fbid=|\/permalink\//i.test(url)
          || (articles.length <= 2 && /view more answers|write an answer|write a public comment|public comment|comments?\b/i.test(bodyText))
        ) {
          return 'post_detail';
        }
        if (/\/groups\//i.test(url)) {
          return 'group_feed';
        }
        return 'feed';
      })();

      function reject(articleIndex, reason, detail = '') {
        rejections.push({ articleIndex, reason, detail });
      }

      for (let articleIndex = 0; articleIndex < articles.length; articleIndex += 1) {
        const article = articles[articleIndex];
        if (!isVisible(article)) {
          reject(articleIndex, 'article_not_visible');
          continue;
        }

        if (pageMode === 'post_detail' && articleIndex > 0) {
          reject(articleIndex, 'detail_view_non_primary_article');
          continue;
        }

        const authorNode = findAuthorNode(article);
        const timestampNode = findTimestampNode(article);
        const likeButton = findActionButton(article, /^like$/i);
        const commentButton = findActionButton(article, /comment|leave a comment|write a comment/i);
        const replyButton = findActionButton(article, /^reply$/i);
        const shareButton = findActionButton(article, /^share$/i);
        const actionControls = [likeButton, commentButton, shareButton].filter(Boolean);
        const timestampText = normalize(timestampNode?.innerText || '') || fallbackTimestampText(article);

        if (!authorNode) {
          reject(articleIndex, 'missing_header_author');
          continue;
        }

        if (!timestampText) {
          reject(articleIndex, 'missing_header_timestamp');
          continue;
        }

        if (actionControls.length < 2) {
          reject(articleIndex, 'weak_action_bar', `controls=${actionControls.length}`);
          continue;
        }

        const headerBottom = findHeaderBoundary(article, authorNode, timestampNode);
        const actionTop = findActionBarTop(article, actionControls);
        const mainBodyText = extractMainBodyText(article, headerBottom, actionTop);
        if (!mainBodyText || mainBodyText.length < 15) {
          reject(articleIndex, 'no_body_between_header_and_action_bar');
          continue;
        }

        const authorName = normalize(authorNode.innerText);
        const urlNode = (timestampNode?.closest('a[href]')) || Array.from(article.querySelectorAll('a[href]'))
          .find((node) => /\/posts\/|story_fbid=|\/permalink\//i.test(node.getAttribute('href') || '')) || null;
        const postUrl = urlNode ? urlNode.getAttribute('href') || '' : '';
        const ignoreAsComment = Boolean(replyButton)
          && !shareButton
          && /\b(reply|replies)\b/i.test(normalize(article.innerText));

        if (ignoreAsComment) {
          reject(articleIndex, 'comment_thread_below_action_bar');
          continue;
        }

        anchors.push({
          articleIndex,
          authorName,
          timestampText,
          postText: mainBodyText,
          postUrl,
          anchorConfidence: timestampNode ? 'strict' : 'fallback',
        });

        if (anchors.length >= limit) {
          break;
        }
      }

      return {
        anchors,
        rejections,
        articleCount: articles.length,
        pageMode,
      };
    }, { limit: Math.max(limit * 2, 20) });

    const anchors = [];
    const seenPostIds = new Set();
    const normalizedRejections = Array.isArray(extracted?.rejections) ? extracted.rejections : [];
    const rawAnchors = Array.isArray(extracted?.anchors) ? extracted.anchors : [];

    for (const rawAnchor of rawAnchors) {
      const href = String(rawAnchor.postUrl || '').trim();
      const normalizedUrl = href
        ? (href.startsWith('http') ? href : `${FACEBOOK_BASE_URL}${href}`)
        : '';
      const postId = extractPostIdFromHref(normalizedUrl) || `visible-${rawAnchor.articleIndex + 1}`;
      if (seenPostIds.has(postId)) {
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
        anchorConfidence: rawAnchor.anchorConfidence || 'fallback',
        summary: rawAnchor.postText.split('\n')[0].slice(0, 180),
      });

      if (anchors.length >= limit) {
        break;
      }
    }

    if (returnMeta) {
      return {
        posts: anchors,
        debug: {
          articleCount: Number(extracted?.articleCount || 0),
          keptCount: anchors.length,
          pageMode: String(extracted?.pageMode || 'unknown'),
          rejections: normalizedRejections,
        },
      };
    }

    return anchors;
  }

  async function scrapeGroupFeed(page, { limit = 20, scrollRounds = 5 } = {}) {
    return extractVisiblePostAnchors(page, { limit, scrollRounds });
  }

  async function listVisiblePosts(page, { limit = 20, scrollRounds = 2, returnMeta = false } = {}) {
    return extractVisiblePostAnchors(page, { limit, scrollRounds, returnMeta });
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
  classifyFacebookPageMode,
  looksLikeFacebookTimestamp,
};
