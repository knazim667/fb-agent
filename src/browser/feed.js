'use strict';

const ABSOLUTE_TIMESTAMP_PATTERN = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{1,2})(?:,\s*\d{4})?(?:\s+at\s+\d{1,2}:\d{2}(?:\s?[ap]m)?)?$/i;
const RELATIVE_TIMESTAMP_PATTERN = /^(?:just now|now|today|yesterday|\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|y|yr|yrs|year|years))(?:\s+ago)?$/i;

function looksLikeFacebookTimestamp(text = '') {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return false;
  }
  return RELATIVE_TIMESTAMP_PATTERN.test(normalized) || ABSOLUTE_TIMESTAMP_PATTERN.test(normalized);
}

function classifyFacebookPageMode({ articleCount = 0, bodyText = '', url = '' } = {}) {
  const normalizedUrl = String(url || '').toLowerCase();

  if (/\/posts\/|story_fbid=|\/permalink\//i.test(normalizedUrl)) {
    return 'post_detail';
  }

  if (/\/groups\//i.test(normalizedUrl)) {
    return 'group_feed';
  }

  return 'feed';
}

function isVisiblePostCandidate({
  authorName = '',
  bodyText = '',
  actionControlCount = 0,
  timestampText = '',
  validationMode = 'engagement',
  controlNames = [],
  pageMode = 'feed',
} = {}) {
  const normalizedAuthor = String(authorName || '').trim();
  const normalizedBody = String(bodyText || '').trim();
  const normalizedTimestamp = String(timestampText || '').trim();
  const names = Array.isArray(controlNames)
    ? controlNames.map((name) => String(name || '').toLowerCase()).filter(Boolean)
    : [];
  const hasLike = names.includes('like');
  const hasComment = names.includes('comment');
  const hasShare = names.includes('share');
  const hasReply = names.includes('reply');

  const minBodyLength = pageMode === 'search_results' ? 8 : 15;
  if (normalizedBody.length < minBodyLength) {
    return false;
  }

  if (String(validationMode || 'engagement') === 'business') {
    if (!hasLike) {
      return false;
    }
    if (!(hasComment || hasShare || hasReply || actionControlCount >= 2)) {
      return false;
    }
    return Boolean(normalizedAuthor || normalizedTimestamp);
  }

  if (!hasLike && actionControlCount < 1) {
    return false;
  }

  return Boolean(normalizedAuthor || normalizedTimestamp);
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

  async function extractVisiblePostAnchors(page, {
    limit = 20,
    scrollRounds = 2,
    returnMeta = false,
    validationMode = 'engagement',
  } = {}) {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(randomBetween(1_000, 2_000));
    await loadGroupFeedPosts(page, { scrollRounds });

    const extractInPage = async () => page.evaluate(({ limit, validationMode }) => {
      const RELATIVE_TIMESTAMP_PATTERN = /^(?:just now|now|today|yesterday|\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|y|yr|yrs|year|years))(?:\s+ago)?$/i;
      const ABSOLUTE_TIMESTAMP_PATTERN = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{1,2})(?:,\s*\d{4})?(?:\s+at\s+\d{1,2}:\d{2}(?:\s?[ap]m)?)?$/i;

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
        const directMatch = candidates.find((node) => {
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

        if (directMatch) {
          return directMatch;
        }

        const boldCandidates = Array.from(article.querySelectorAll('span, strong, div, a'))
          .filter((node) => {
            if (!isVisible(node)) {
              return false;
            }
            const text = normalize(node.innerText);
            if (!text || text.length < 2 || looksLikeTimestamp(text) || /like|comment|share|reply|follow/i.test(text)) {
              return false;
            }
            const style = window.getComputedStyle(node);
            const weight = Number(style.fontWeight || 400);
            const rect = node.getBoundingClientRect();
            return weight >= 600 && rect.top < article.getBoundingClientRect().top + 180;
          });

        return boldCandidates[0] || null;
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

      function describeControls({ likeButton, commentButton, shareButton, replyButton }) {
        return [
          likeButton ? 'like' : '',
          commentButton ? 'comment' : '',
          shareButton ? 'share' : '',
          replyButton ? 'reply' : '',
        ].filter(Boolean);
      }

      function fallbackTimestampText(article) {
        const articleText = normalize(article.innerText);
        const match = articleText.match(/\b(just now|now|today|yesterday|\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|y|yr|yrs|year|years)(?:\s+ago)?|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{1,2})(?:,\s*\d{4})?(?:\s+at\s+\d{1,2}:\d{2}(?:\s?[ap]m)?)?)\b/i);
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

      function extractDeepArticleText(article, actionTop) {
        const texts = [];
        const seen = new Set();
        const nodes = Array.from(article.querySelectorAll('div, span, p, a, strong'));

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
          if (!text || text.length < 6) {
            continue;
          }

          if (/^(like|comment|share|reply|follow|see more|top contributor|write a comment|leave a comment)$/i.test(text)) {
            continue;
          }

          if (looksLikeTimestamp(text)) {
            continue;
          }

          if (!seen.has(text)) {
            seen.add(text);
            texts.push(text);
          }
        }

        return texts.join('\n').trim();
      }

      function getTopLevelArticles(root) {
        const container = root || document.body;
        const articles = Array.from(container.querySelectorAll('div[role="article"]'));
        return articles.filter((article) => {
          const parentArticle = article.parentElement?.closest?.('div[role="article"]');
          return !parentArticle || !container.contains(parentArticle);
        });
      }

      function findBestFeedContainer() {
        const candidates = [
          ...Array.from(document.querySelectorAll('[role="feed"]')),
          ...Array.from(document.querySelectorAll('div[role="main"], main')),
        ]
          .filter((node, index, all) => node && isVisible(node) && all.indexOf(node) === index);

        let best = null;
        for (const candidate of candidates) {
          const articles = getTopLevelArticles(candidate).filter((article) => isVisible(article));
          const rect = candidate.getBoundingClientRect();
          const score = (articles.length * 10_000) + Math.max(0, Math.round(rect.width * rect.height));
          if (!best || score > best.score) {
            best = {
              container: candidate,
              articles,
              score,
            };
          }
        }

        return best;
      }

      function describeFeedContainer(choice) {
        if (!choice?.container) {
          return {
            found: false,
            tag: '',
            role: '',
            topLevelArticleCount: 0,
          };
        }

        return {
          found: true,
          tag: choice.container.tagName.toLowerCase(),
          role: choice.container.getAttribute('role') || '',
          topLevelArticleCount: choice.articles.length,
        };
      }

      const feedChoice = findBestFeedContainer();
      const feedContainerStatus = describeFeedContainer(feedChoice);
      const articles = (feedChoice?.articles?.length ? feedChoice.articles : getTopLevelArticles(document.body))
        .filter((article) => isVisible(article));
      const anchors = [];
      const rejections = [];
      const pageMode = (() => {
        const url = window.location.href || '';
        if (/\/posts\/|story_fbid=|\/permalink\//i.test(url)) {
        return 'post_detail';
      }
      if (/\/search\//i.test(url)) {
        return 'search_results';
      }
      if (/\/groups\//i.test(url)) {
        return 'group_feed';
      }
        return 'feed';
      })();

      function reject(articleIndex, reason, detail = '', article = null) {
        rejections.push({
          articleIndex,
          reason,
          detail,
          sampleText: article ? normalize((article.innerText || '').slice(0, 400)) : '',
        });
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
        const controlNames = describeControls({ likeButton, commentButton, shareButton, replyButton });
        const timestampText = normalize(timestampNode?.innerText || '') || fallbackTimestampText(article);
        const timestampConfidence = timestampText
          ? (timestampNode ? 'strict' : 'fallback')
          : 'missing';

        if (pageMode !== 'search_results' && String(validationMode || 'engagement') === 'business' && actionControls.length < 2 && !replyButton) {
          reject(articleIndex, 'weak_action_bar', `controls=${controlNames.join(',') || 'none'}`, article);
          continue;
        }

        const headerBottom = findHeaderBoundary(article, authorNode, timestampNode);
        const actionTop = findActionBarTop(article, actionControls);
        const mainBodyText = extractMainBodyText(article, headerBottom, actionTop)
          || extractDeepArticleText(article, actionTop);
        const minBodyLength = pageMode === 'search_results' ? 8 : 15;
        if (!mainBodyText || mainBodyText.length < minBodyLength) {
          reject(articleIndex, 'no_body_between_header_and_action_bar', '', article);
          continue;
        }

        const authorName = normalize(authorNode?.innerText || '') || 'Unknown';
        if (!isVisiblePostCandidate({
          authorName: authorName === 'Unknown' ? '' : authorName,
          bodyText: mainBodyText,
          actionControlCount: [...actionControls, replyButton].filter(Boolean).length,
          timestampText,
          validationMode,
          controlNames,
          pageMode,
        })) {
          reject(
            articleIndex,
            'invalid_visible_post_candidate',
            `mode=${validationMode};controls=${controlNames.join(',') || 'none'};body_len=${mainBodyText.length}`,
            article
          );
          continue;
        }
        const urlNode = (timestampNode?.closest('a[href]')) || Array.from(article.querySelectorAll('a[href]'))
          .find((node) => /\/posts\/|story_fbid=|\/permalink\//i.test(node.getAttribute('href') || '')) || null;
        const postUrl = urlNode ? urlNode.getAttribute('href') || '' : '';
        const selectorId = article.getAttribute('data-agent-visible-post-id')
          || `agent-visible-post-${articleIndex + 1}`;
        article.setAttribute('data-agent-visible-post-id', selectorId);

        anchors.push({
          articleIndex,
          authorName,
          timestampText,
          postText: mainBodyText,
          postUrl,
          anchorConfidence: timestampConfidence,
          selectorId,
          controlNames,
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
        url: window.location.href || '',
        feedContainerStatus,
        validationMode,
      };
    }, { limit: Math.max(limit * 2, 20), validationMode: String(validationMode || 'engagement') });

    const desiredCount = Math.min(Math.max(1, Number(limit || 1)), 5);
    const maxAttempts = Math.max(2, Math.min(Number(scrollRounds || 2) + 2, 6));
    const aggregateAnchors = [];
    const seenKeys = new Set();
    let extracted = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      extracted = await extractInPage();
      const rawAnchors = Array.isArray(extracted?.anchors) ? extracted.anchors : [];

      for (const rawAnchor of rawAnchors) {
        const href = String(rawAnchor.postUrl || '').trim();
        const normalizedUrl = href
          ? (href.startsWith('http') ? href : `${FACEBOOK_BASE_URL}${href}`)
          : '';
        const postId = extractPostIdFromHref(normalizedUrl) || '';
        const dedupeKey = postId
          || normalizedUrl
          || `${String(rawAnchor.selectorId || '').trim()}|${String(rawAnchor.timestampText || '').trim()}|${String(rawAnchor.postText || '').trim().slice(0, 120)}`;

        if (!dedupeKey || seenKeys.has(dedupeKey)) {
          continue;
        }

        seenKeys.add(dedupeKey);
        aggregateAnchors.push({
          ...rawAnchor,
          normalizedUrl,
          postId,
        });
      }

      if (aggregateAnchors.length >= desiredCount) {
        break;
      }

      if (attempt < maxAttempts - 1) {
        await page.mouse.wheel(0, 900).catch(() => null);
        await page.waitForTimeout(randomBetween(1_500, 2_200));
      }
    }

    const anchors = [];
    const seenPostIds = new Set();
    const normalizedRejections = Array.isArray(extracted?.rejections) ? extracted.rejections : [];
    const rawAnchors = aggregateAnchors;

    for (const rawAnchor of rawAnchors) {
      const normalizedUrl = String(rawAnchor.normalizedUrl || rawAnchor.postUrl || '').trim();
      const postId = String(rawAnchor.postId || '').trim() || `visible-${rawAnchor.articleIndex + 1}`;
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
        selectorId: rawAnchor.selectorId || '',
        controlNames: Array.isArray(rawAnchor.controlNames) ? rawAnchor.controlNames : [],
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
          url: String(extracted?.url || page.url() || ''),
          keptCount: anchors.length,
          pageMode: String(extracted?.pageMode || 'unknown'),
          validationMode: String(extracted?.validationMode || validationMode || 'engagement'),
          feedContainerStatus: extracted?.feedContainerStatus || {
            found: false,
            tag: '',
            role: '',
            topLevelArticleCount: 0,
          },
          scanAttempts: maxAttempts,
          rejections: normalizedRejections,
        },
      };
    }

    return anchors;
  }

  async function scrapeGroupFeed(page, { limit = 20, scrollRounds = 5, validationMode = 'business' } = {}) {
    return extractVisiblePostAnchors(page, { limit, scrollRounds, validationMode });
  }

  async function listVisiblePosts(page, {
    limit = 20,
    scrollRounds = 2,
    returnMeta = false,
    validationMode = 'engagement',
  } = {}) {
    return extractVisiblePostAnchors(page, { limit, scrollRounds, returnMeta, validationMode });
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
  isVisiblePostCandidate,
  looksLikeFacebookTimestamp,
};
