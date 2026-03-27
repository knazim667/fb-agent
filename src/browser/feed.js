'use strict';

const {
  analyzeImageWithVision,
  buildVisionFilePath,
  detectLeadSignals,
  ensureVisionDir,
  mergePostReading,
  normalizeText,
  uniqueStrings,
} = require('./multimodal');

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

function extractPostDomText({
  structuredBodyText = '',
  deepBodyText = '',
} = {}) {
  return normalizeText(structuredBodyText || deepBodyText || '');
}

function extractVisibleArticleText(text = '') {
  return normalizeText(text);
}

function isVisiblePostCandidate({
  authorName = '',
  bodyText = '',
  actionControlCount = 0,
  timestampText = '',
  validationMode = 'engagement',
  controlNames = [],
  pageMode = 'feed',
  fallbackUsed = false,
  painSignalCount = 0,
  attachedImagesCount = 0,
  imageTextLength = 0,
  visibleTextLength = 0,
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
  const fallbackMinBodyLength = pageMode === 'search_results' ? 8 : 12;
  const bodyPasses = normalizedBody.length >= minBodyLength
    || (fallbackUsed && normalizedBody.length >= fallbackMinBodyLength)
    || (fallbackUsed && painSignalCount > 0 && normalizedBody.length >= 8)
    || visibleTextLength >= Math.max(8, fallbackMinBodyLength)
    || imageTextLength >= 8
    || attachedImagesCount > 0;
  if (!bodyPasses) {
    return false;
  }

  if (String(validationMode || 'engagement') === 'business') {
    if (!hasLike) {
      return false;
    }
    if (!(hasComment || hasShare || hasReply || actionControlCount >= 2)) {
      if (!(fallbackUsed && painSignalCount > 0 && actionControlCount >= 1) && !(attachedImagesCount > 0 && actionControlCount >= 1)) {
        return false;
      }
    }
    return Boolean(normalizedAuthor || normalizedTimestamp || painSignalCount > 0 || attachedImagesCount > 0 || visibleTextLength > 0);
  }

  if (!hasLike && actionControlCount < 1) {
    return visibleTextLength >= 24 || attachedImagesCount > 0 || imageTextLength >= 12;
  }

  return Boolean(normalizedAuthor || normalizedTimestamp || fallbackUsed || painSignalCount > 0 || attachedImagesCount > 0 || visibleTextLength > 0);
}

function createFeedApi({
  FACEBOOK_BASE_URL,
  randomBetween,
}) {
  async function capturePostScreenshot(page, selectorId = '') {
    const normalized = String(selectorId || '').trim();
    if (!normalized) {
      return null;
    }
    await ensureVisionDir().catch(() => null);
    const locator = page.locator(`[data-agent-visible-post-id="${normalized}"]`).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) {
      return null;
    }
    const screenshotPath = buildVisionFilePath('facebook-post', '.png');
    await locator.screenshot({ path: screenshotPath, type: 'png' }).catch(() => null);
    return screenshotPath;
  }

  async function captureAttachedImageScreenshots(page, imageSelectorIds = []) {
    const screenshots = [];
    await ensureVisionDir().catch(() => null);
    for (const selectorId of imageSelectorIds.slice(0, 3)) {
      const normalized = String(selectorId || '').trim();
      if (!normalized) {
        continue;
      }
      const locator = page.locator(`[data-agent-visible-image-id="${normalized}"]`).first();
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }
      const screenshotPath = buildVisionFilePath('facebook-image', '.png');
      await locator.screenshot({ path: screenshotPath, type: 'png' }).catch(() => null);
      screenshots.push(screenshotPath);
    }
    return screenshots;
  }

  async function analyzePostScreenshotWithVision(imagePath = '') {
    return analyzeImageWithVision(
      imagePath,
      'Read this Facebook post screenshot. Extract the post text, summarize what the seller is saying, and identify lead signals related to reimbursements, lost inventory, fee issues, payout confusion, settlement confusion, or profit leakage.'
    );
  }

  async function analyzeAttachedImagesWithVision(imagePaths = []) {
    const analyses = [];
    for (const imagePath of imagePaths.slice(0, 3)) {
      const result = await analyzeImageWithVision(
        imagePath,
        'Read this attached image from a social post. If it looks like Amazon Seller Central, inventory, settlement, payout, fee, reimbursement, or dashboard data, extract the useful text and summarize the money-loss signal.'
      );
      analyses.push(result);
    }

    const used = analyses.some((item) => item?.used);
    const text = uniqueStrings(analyses.map((item) => item?.text || '')).join('\n').trim();
    const summary = uniqueStrings(analyses.map((item) => item?.summary || '')).join('\n').trim();
    const signals = uniqueStrings(analyses.flatMap((item) => Array.isArray(item?.signals) ? item.signals : []));
    const confidence = analyses.length
      ? Number((analyses.reduce((sum, item) => sum + Number(item?.confidence || 0), 0) / analyses.length).toFixed(2))
      : 0;

    return {
      used,
      text,
      summary,
      signals,
      confidence,
    };
  }

  async function enrichAnchorsMultimodally(page, anchors = [], { validationMode = 'engagement' } = {}) {
    const enriched = [];
    for (const anchor of anchors) {
      const domText = normalizeText(anchor.textFromDom || '');
      const fallbackText = normalizeText(anchor.textFromVisibleFallback || '');
      const needsVision = domText.length < 24 || fallbackText.length < 24 || Number(anchor.attachedImagesCount || 0) > 0;

      let screenshotAnalysis = {
        used: false,
        text: '',
        summary: '',
        signals: [],
        confidence: 0,
      };
      let attachedImageAnalysis = {
        used: false,
        text: '',
        summary: '',
        signals: [],
        confidence: 0,
      };

      if (needsVision) {
        const postScreenshotPath = await capturePostScreenshot(page, anchor.selectorId);
        if (postScreenshotPath) {
          screenshotAnalysis = await analyzePostScreenshotWithVision(postScreenshotPath);
        }
      }

      if (Number(anchor.attachedImagesCount || 0) > 0) {
        const imageScreenshots = await captureAttachedImageScreenshots(page, anchor.attachedImageSelectorIds || []);
        if (imageScreenshots.length) {
          attachedImageAnalysis = await analyzeAttachedImagesWithVision(imageScreenshots);
        }
      }

      const imageText = uniqueStrings([
        anchor.imageAltText || '',
        screenshotAnalysis.text,
        attachedImageAnalysis.text,
      ]).join('\n').trim();
      const visualSummary = uniqueStrings([
        screenshotAnalysis.summary,
        attachedImageAnalysis.summary,
      ]).join('\n').trim();
      const reading = mergePostReading({
        author: anchor.authorName || '',
        textFromDom: domText,
        textFromVisibleFallback: fallbackText,
        textFromImages: imageText,
        visualSummary,
        attachedImagesCount: Number(anchor.attachedImagesCount || 0),
        existingSignals: [
          ...(Array.isArray(anchor.matchedLeadSignals) ? anchor.matchedLeadSignals : []),
          ...(Array.isArray(screenshotAnalysis.signals) ? screenshotAnalysis.signals : []),
          ...(Array.isArray(attachedImageAnalysis.signals) ? attachedImageAnalysis.signals : []),
        ],
      });

      enriched.push({
        ...anchor,
        postText: reading.merged_text || anchor.postText || '',
        textFromDom: reading.text_from_dom,
        textFromVisibleFallback: reading.text_from_visible_fallback,
        textFromImages: reading.text_from_images,
        visualSummary: reading.visual_summary,
        confidenceScore: reading.confidence_score,
        matchedLeadSignals: reading.lead_signals_matched,
        domTextLength: reading.text_from_dom.length,
        fallbackTextLength: reading.text_from_visible_fallback.length,
        imageTextLength: reading.text_from_images.length,
        visionUsed: Boolean(screenshotAnalysis.used || attachedImageAnalysis.used),
        attachedImagesCount: Number(anchor.attachedImagesCount || 0),
        extractionConfidence: reading.confidence_score >= 0.85
          ? 'structured'
          : reading.confidence_score >= 0.65
            ? 'partial'
            : 'visual',
        validationMode,
      });
    }
    return enriched;
  }

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

  async function retryRejectedArticlesInDetail(page, rejections = [], {
    limit = 3,
    validationMode = 'engagement',
  } = {}) {
    const candidates = (Array.isArray(rejections) ? rejections : [])
      .filter((item) => item
        && item.postUrl
        && (
          item.actionBarFound
          || item.headerFound
          || item.imageCount > 0
          || item.rawTextLength > 0
          || item.cleanedTextLength > 0
          || String(item.textPreview || '').trim().length > 0
        ))
      .slice(0, limit);

    const recovered = [];
    const debug = [];

    for (const candidate of candidates) {
      let tempPage = null;
      try {
        tempPage = await page.context().newPage();
        await tempPage.goto(candidate.postUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 60_000,
        });
        await tempPage.waitForLoadState('networkidle').catch(() => null);
        await tempPage.waitForTimeout(2_000);

        const result = await extractVisiblePostAnchors(tempPage, {
          limit: 1,
          scrollRounds: 1,
          returnMeta: true,
          validationMode,
          enableDetailFallback: false,
        });
        const posts = Array.isArray(result?.posts) ? result.posts : [];
        if (posts.length) {
          recovered.push({
            ...posts[0],
            recoveredFromDetail: true,
            detailSourceUrl: candidate.postUrl,
          });
        }
        debug.push({
          articleIndex: candidate.articleIndex,
          attempted: true,
          recovered: posts.length > 0,
          postUrl: candidate.postUrl,
        });
      } catch (error) {
        debug.push({
          articleIndex: candidate.articleIndex,
          attempted: true,
          recovered: false,
          postUrl: candidate.postUrl,
          error: error.message,
        });
      } finally {
        await tempPage?.close().catch(() => null);
      }
    }

    return { recovered, debug };
  }

  async function extractVisiblePostAnchors(page, {
    limit = 20,
    scrollRounds = 2,
    returnMeta = false,
    validationMode = 'engagement',
    enableDetailFallback = true,
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

      function extractCaptionFallbackText(article, headerBottom, actionTop) {
        const chunks = [];
        const seen = new Set();
        const nodes = Array.from(article.querySelectorAll('div, span, p, blockquote'));

        for (const node of nodes) {
          if (!isVisible(node)) {
            continue;
          }
          if (node.closest('form, [role="textbox"], [aria-label*="Comment"], [aria-label*="Reply"]')) {
            continue;
          }
          const rect = node.getBoundingClientRect();
          if (rect.top < headerBottom - 8) {
            continue;
          }
          if (rect.top >= actionTop - 4) {
            continue;
          }
          const text = normalize(node.innerText);
          if (!text || text.length < 6) {
            continue;
          }
          if (/^(like|comment|share|reply|follow|see more|top contributor|write a comment|leave a comment|sponsored|suggested for you)$/i.test(text)) {
            continue;
          }
          if (looksLikeTimestamp(text)) {
            continue;
          }
          const cleaned = stripUiNoiseFromText(text);
          if (!cleaned || cleaned.length < 6) {
            continue;
          }
          const key = cleaned.toLowerCase();
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          chunks.push(cleaned);
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

      function extractPostDomText(article, headerBottom, actionTop) {
        const structuredBodyText = extractMainBodyText(article, headerBottom, actionTop);
        const deepBodyText = structuredBodyText
          ? ''
          : extractDeepArticleText(article, actionTop);
        return {
          structuredBodyText,
          deepBodyText,
          domText: normalize(structuredBodyText || deepBodyText),
        };
      }

      function stripUiNoiseFromText(text) {
        return normalize(
          String(text || '')
            .replace(/\b(?:Like|Comment|Share|Reply|Follow|See more|Top contributor|Write a comment|Leave a comment|View more answers|Write an answer|Send message|Message)\b/gi, ' ')
            .replace(/\b(?:Most relevant|Public group|Suggested for you)\b/gi, ' ')
            .replace(/\s+/g, ' ')
        );
      }

      function cleanFallbackArticleText(text) {
        const lines = String(text || '')
          .split('\n')
          .map((line) => stripUiNoiseFromText(line))
          .filter(Boolean);
        const uniqueLines = [];
        const seen = new Set();
        for (const line of lines) {
          const key = line.toLowerCase();
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          uniqueLines.push(line);
        }
        return uniqueLines.join('\n').trim();
      }

      function extractFullVisibleArticleText(article) {
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
          const text = normalize(node.innerText);
          if (!text || text.length < 2) {
            continue;
          }
          if (looksLikeTimestamp(text)) {
            continue;
          }
          const cleaned = stripUiNoiseFromText(text);
          if (!cleaned || cleaned.length < 2) {
            continue;
          }
          const key = cleaned.toLowerCase();
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          texts.push(cleaned);
        }
        return texts.join('\n').trim();
      }

      function collectAttachedImages(article, headerBottom) {
        const images = [];
        const seen = new Set();
        const nodes = Array.from(article.querySelectorAll('img'));
        for (const node of nodes) {
          if (!isVisible(node)) {
            continue;
          }
          const rect = node.getBoundingClientRect();
          if (rect.width < 90 || rect.height < 90) {
            continue;
          }
          if (rect.top < headerBottom - 40) {
            continue;
          }
          const src = node.getAttribute('src') || '';
          const altText = normalize(node.getAttribute('alt') || node.getAttribute('aria-label') || '');
          const key = `${Math.round(rect.top)}|${Math.round(rect.left)}|${src.slice(0, 80)}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          const selectorId = node.getAttribute('data-agent-visible-image-id') || `agent-visible-image-${images.length + 1}-${Math.round(rect.top)}`;
          node.setAttribute('data-agent-visible-image-id', selectorId);
          images.push({
            selectorId,
            altText,
            src,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });
        }
        return images;
      }

      function countPainSignals(text) {
        const normalized = String(text || '').toLowerCase();
        if (!normalized) {
          return 0;
        }
        const patterns = [
          /\breimburse(?:ment|ments)?\b/g,
          /\blost inventory\b/g,
          /\bmissing inventory\b/g,
          /\bmissing units?\b/g,
          /\bfees?\b/g,
          /\blow profit\b/g,
          /\bmargins?\b/g,
          /\bsettlement\b/g,
          /\bpayout\b/g,
          /\bdiscrepanc(?:y|ies)\b/g,
          /\bowe(?:s|d)? me money\b/g,
          /\bprofit\b/g,
        ];
        return patterns.reduce((count, pattern) => count + ((normalized.match(pattern) || []).length > 0 ? 1 : 0), 0);
      }

      function getTopLevelArticles(root) {
        const container = root || document.body;
        const articles = Array.from(container.querySelectorAll('div[role="article"]'));
        return articles.filter((article) => {
          const parentArticle = article.parentElement?.closest?.('div[role="article"]');
          return !parentArticle || !container.contains(parentArticle);
        });
      }

      function countVisibleImages(node) {
        return Array.from(node.querySelectorAll('img')).filter((img) => {
          if (!isVisible(img)) {
            return false;
          }
          const rect = img.getBoundingClientRect();
          return rect.width >= 80 && rect.height >= 80;
        }).length;
      }

      function cleanedVisibleText(node) {
        return normalize(
          String(node?.innerText || node?.textContent || '')
            .replace(/\b(?:Like|Comment|Share|Reply|Follow|See more|Top contributor|Write a comment|Leave a comment|View more answers|Write an answer|Send message|Message|Sponsored|Suggested for you|Most relevant)\b/gi, ' ')
            .replace(/\s+/g, ' ')
        );
      }

      function countActionControls(node) {
        return Array.from(node.querySelectorAll('button,[role="button"],a[href],span,div'))
          .filter((child) => isVisible(child))
          .map((child) => normalize(child.innerText || child.getAttribute('aria-label') || child.getAttribute('title') || ''))
          .filter((text) => /(?:^|\b)(like|comment|share|reply)(?:\b|$)/i.test(text)).length;
      }

      function looksLikeUiOnlyText(text) {
        const normalized = normalize(text).toLowerCase();
        if (!normalized) {
          return true;
        }
        return /^(?:like|comment|share|reply|follow|see more|top contributor|sponsored|suggested for you|most relevant|write a comment|leave a comment|view more answers|write an answer|\d+\s*(?:likes?|comments?))+$/.test(
          normalized.replace(/\s+/g, ' ')
        );
      }

      function describeNode(node) {
        return {
          rootTag: node?.tagName ? node.tagName.toLowerCase() : '',
          role: node?.getAttribute?.('role') || '',
          classSnippet: normalize((node?.getAttribute?.('class') || '').slice(0, 140)),
          ariaLabel: normalize(node?.getAttribute?.('aria-label') || ''),
          childCount: Number(node?.children?.length || 0),
          textPreview: normalize(((node?.innerText || node?.textContent || '').slice(0, 300))),
        };
      }

      function readableRootScore(node) {
        const text = cleanedVisibleText(node).slice(0, 500);
        const textScore = Math.min(text.length, 180);
        const controlScore = countActionControls(node) * 80;
        const imageScore = countVisibleImages(node) * 50;
        const headerScore = Array.from(node.querySelectorAll('h2, h3, strong, a[role="link"], [role="link"]'))
          .filter((child) => isVisible(child) && normalize(child.innerText || '').length >= 2)
          .length * 12;
        const selfTextScore = Math.min(cleanedVisibleText(node).length, 140);
        return textScore + controlScore + imageScore + headerScore + selfTextScore;
      }

      function resolveReadableRoot(node) {
        let best = {
          root: node,
          score: readableRootScore(node),
        };

        const descendants = Array.from(node.querySelectorAll('div, article, section'))
          .filter((child) => isVisible(child))
          .slice(0, 180);

        for (const child of descendants) {
          const score = readableRootScore(child);
          if (score > best.score + 20) {
            best = {
              root: child,
              score,
            };
          }
        }

        return best.root;
      }

      function findPostRootFromActionControl(control, boundaryRoot) {
        let current = control?.parentElement || null;
        let best = null;
        let bestScore = 0;

        while (current && current !== boundaryRoot && current !== document.body) {
          if (isVisible(current)) {
            const rect = current.getBoundingClientRect();
            if (rect.width >= 240 && rect.height >= 96) {
              const score = readableRootScore(current);
              const controls = countActionControls(current);
              const textLen = cleanedVisibleText(current).length;
              if ((controls >= 1 || textLen >= 18 || countVisibleImages(current) > 0) && score > bestScore) {
                best = current;
                bestScore = score;
              }
            }
          }
          current = current.parentElement;
        }

        return best;
      }

      function findPostRootFromTextNode(node, boundaryRoot) {
        let current = node?.parentElement || null;
        let best = null;
        let bestScore = 0;

        while (current && current !== boundaryRoot && current !== document.body) {
          if (isVisible(current)) {
            const rect = current.getBoundingClientRect();
            const textLen = cleanedVisibleText(current).length;
            if (rect.width >= 240 && rect.height >= 96 && textLen >= 24) {
              const score = readableRootScore(current) + (countActionControls(current) * 40);
              if (score > bestScore) {
                best = current;
                bestScore = score;
              }
            }
          }
          current = current.parentElement;
        }

        return best;
      }

      function collectCandidateRoots(container) {
        const selectors = [
          'div[role="article"]',
          '[data-pagelet^="FeedUnit_"]',
          '[data-pagelet*="FeedUnit"]',
          '[aria-posinset]',
        ];
        const raw = selectors.flatMap((selector) => Array.from(container.querySelectorAll(selector)));
        const actionControls = Array.from(container.querySelectorAll('button,[role="button"],a[href],span,div'))
          .filter((node) => isVisible(node))
          .filter((node) => matchesControl(node, /(?:^|\b)(like|comment|share|reply)(?:\b|$)/i));
        const textBlocks = Array.from(container.querySelectorAll('div, span, p, a, strong, h2, h3'))
          .filter((node) => isVisible(node))
          .filter((node) => {
            const text = cleanedVisibleText(node);
            return text.length >= 28 && !looksLikeTimestamp(text) && !looksLikeUiOnlyText(text);
          });
        const mediaNodes = Array.from(container.querySelectorAll('img'))
          .filter((node) => isVisible(node))
          .filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width >= 100 && rect.height >= 100;
          });
        const roots = [];
        const seen = new Set();

        const combinedCandidates = [
          ...raw,
          ...actionControls.map((node) => findPostRootFromActionControl(node, container)).filter(Boolean),
          ...textBlocks.map((node) => findPostRootFromTextNode(node, container)).filter(Boolean),
          ...mediaNodes.map((node) => findPostRootFromTextNode(node, container)).filter(Boolean),
        ];

        for (const candidate of combinedCandidates) {
          if (!isVisible(candidate)) {
            continue;
          }
          const resolved = resolveReadableRoot(candidate);
          if (!resolved || !isVisible(resolved)) {
            continue;
          }
          const rect = resolved.getBoundingClientRect();
          const key = `${Math.round(rect.top)}|${Math.round(rect.left)}|${Math.round(rect.width)}|${Math.round(rect.height)}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          roots.push(resolved);
        }

        return roots;
      }

      function findBestFeedContainer() {
        const candidates = [
          ...Array.from(document.querySelectorAll('[role="feed"]')),
          ...Array.from(document.querySelectorAll('div[role="main"], main')),
          document.body,
        ].filter((node, index, all) => node && isVisible(node) && all.indexOf(node) === index);

        let best = null;
        const ranked = [];
        for (const candidate of candidates) {
          const articles = collectCandidateRoots(candidate);
          const rect = candidate.getBoundingClientRect();
          const score = (articles.length * 10_000) + Math.max(0, Math.round(rect.width * rect.height));
          ranked.push({
            container: candidate,
            articles,
            score,
          });
          if (!best || score > best.score) {
            best = {
              container: candidate,
              articles,
              score,
            };
          }
        }

        return {
          best,
          ranked: ranked.sort((left, right) => right.score - left.score),
        };
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

      function articleLooksSponsored(article) {
        const text = normalize((article.innerText || '').slice(0, 300));
        return /\bsponsored\b|\bsuggested for you\b|\bpaid partnership\b/i.test(text);
      }

      const feedChoice = findBestFeedContainer();
      const feedContainerStatus = describeFeedContainer(feedChoice?.best);
      const articles = [];
      const seenArticleKeys = new Set();
      for (const choice of (feedChoice?.ranked || [])) {
        for (const article of choice.articles || []) {
          if (!isVisible(article)) {
            continue;
          }
          const rect = article.getBoundingClientRect();
          const key = `${Math.round(rect.top)}|${Math.round(rect.left)}|${Math.round(rect.width)}|${Math.round(rect.height)}`;
          if (seenArticleKeys.has(key)) {
            continue;
          }
          seenArticleKeys.add(key);
          articles.push(article);
          if (articles.length >= Math.max(limit * 3, 24)) {
            break;
          }
        }
        if (articles.length >= Math.max(limit * 3, 24)) {
          break;
        }
      }
      if (!articles.length) {
        articles.push(...collectCandidateRoots(document.body).slice(0, Math.max(limit * 3, 24)));
      }
        const anchors = [];
      const rejections = [];
      let readableTextCount = 0;
      let extractionFailureCount = 0;
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

      function reject(articleIndex, reason, detail = '', article = null, extra = {}) {
        const selectorId = article?.getAttribute?.('data-agent-visible-post-id')
          || `agent-visible-post-${articleIndex + 1}`;
        if (article) {
          article.setAttribute('data-agent-visible-post-id', selectorId);
        }
        const nodeMeta = article ? describeNode(article) : {};
        rejections.push({
          articleIndex,
          selectorId,
          reason,
          detail,
          sampleText: article ? normalize((article.innerText || '').slice(0, 400)) : '',
          ...nodeMeta,
          ...extra,
        });
      }

      for (let articleIndex = 0; articleIndex < articles.length; articleIndex += 1) {
        const article = articles[articleIndex];
        if (!isVisible(article)) {
          reject(articleIndex, 'article_not_visible');
          continue;
        }

        const rootSelector = article.tagName
          ? [
              article.tagName.toLowerCase(),
              article.getAttribute('role') ? `[role="${article.getAttribute('role')}"]` : '',
              article.getAttribute('data-pagelet') ? `[data-pagelet="${article.getAttribute('data-pagelet')}"]` : '',
              article.getAttribute('class')
                ? `.${String(article.getAttribute('class') || '').trim().split(/\s+/).slice(0, 3).join('.')}`
                : '',
            ].join('')
          : 'unknown';

        if (articleLooksSponsored(article)) {
          reject(articleIndex, 'sponsored_or_suggested', '', article, {
            rootSelector,
            detailFallbackAttempted: false,
          });
          continue;
        }

        if (pageMode === 'post_detail' && articleIndex > 0) {
          reject(articleIndex, 'detail_view_non_primary_article', '', article, {
            rootSelector,
            detailFallbackAttempted: false,
          });
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
        const actionBarFound = actionControls.length > 0 || Boolean(replyButton);
        const timestampText = normalize(timestampNode?.innerText || '') || fallbackTimestampText(article);
        const timestampConfidence = timestampText
          ? (timestampNode ? 'strict' : 'fallback')
          : 'missing';
        const selectorId = article.getAttribute('data-agent-visible-post-id')
          || `agent-visible-post-${articleIndex + 1}`;
        article.setAttribute('data-agent-visible-post-id', selectorId);
        const permalinkNode = (timestampNode?.closest('a[href]')) || Array.from(article.querySelectorAll('a[href]'))
          .find((node) => /\/posts\/|story_fbid=|\/permalink\//i.test(node.getAttribute('href') || '')) || null;
        const rawPostUrl = permalinkNode ? permalinkNode.getAttribute('href') || '' : '';
        const postUrl = rawPostUrl
          ? (rawPostUrl.startsWith('http') ? rawPostUrl : `${window.location.origin}${rawPostUrl}`)
          : '';

        if (pageMode !== 'search_results' && String(validationMode || 'engagement') === 'business' && actionControls.length < 2 && !replyButton) {
          reject(articleIndex, 'weak_action_bar', `controls=${controlNames.join(',') || 'none'}`, article, {
            rootSelector,
            headerFound: Boolean(authorNode || timestampNode),
            actionBarFound,
            postUrl,
            imageCount: 0,
            rawTextLength: 0,
            cleanedTextLength: 0,
            detailFallbackAttempted: false,
          });
          continue;
        }

        const headerBottom = findHeaderBoundary(article, authorNode, timestampNode);
        const actionTop = findActionBarTop(article, actionControls);
        const rootInnerText = normalize(article.innerText || article.textContent || '');
        const rootVisibleText = extractVisibleArticleText(cleanFallbackArticleText(rootInnerText));
        const domExtraction = extractPostDomText(article, headerBottom, actionTop);
        const structuredBodyText = domExtraction.structuredBodyText;
        const deepBodyText = domExtraction.deepBodyText;
        const captionFallbackText = extractCaptionFallbackText(article, headerBottom, actionTop);
        const rawFallbackArticleText = extractFullVisibleArticleText(article);
        const rawText = rootVisibleText || domExtraction.domText || captionFallbackText || rawFallbackArticleText;
        const cleanedFallbackText = rawFallbackArticleText ? extractVisibleArticleText(cleanFallbackArticleText(rawFallbackArticleText)) : '';
        const tolerantFallbackText = cleanFallbackArticleText([
          rootVisibleText,
          captionFallbackText,
          cleanedFallbackText,
        ].filter(Boolean).join('\n'));
        const mainBodyText = rootVisibleText || domExtraction.domText || tolerantFallbackText;
        const attachedImages = collectAttachedImages(article, headerBottom);
        const imageAltText = attachedImages
          .map((item) => normalize(item.altText))
          .filter(Boolean)
          .join('\n')
          .trim();
        const fallbackUsed = !structuredBodyText && Boolean(deepBodyText || cleanedFallbackText);
        const minBodyLength = pageMode === 'search_results' ? 8 : 15;
        const rawTextLength = normalize(rawText).length;
        const cleanedTextLength = normalize(mainBodyText).length;
        const visibleFallbackLength = normalize(cleanedFallbackText).length;
        const imageTextLength = normalize(imageAltText).length;
        const painSignalCount = countPainSignals([mainBodyText, imageAltText].filter(Boolean).join('\n'));
        if (rawTextLength > 0 || cleanedTextLength > 0 || visibleFallbackLength > 0) {
          readableTextCount += 1;
        }
        const hasMeaningfulFallbackText = fallbackUsed
          && (cleanedTextLength >= Math.max(10, minBodyLength - 3) || painSignalCount > 0);
        const hasVisibleContent = rawTextLength > 0 || visibleFallbackLength > 0 || attachedImages.length > 0;
        if ((!mainBodyText || cleanedTextLength < minBodyLength) && !hasMeaningfulFallbackText && !hasVisibleContent) {
          extractionFailureCount += 1;
          reject(
            articleIndex,
            'no_body_between_header_and_action_bar',
            `root=${rootSelector};header=${authorNode || timestampNode ? 'yes' : 'no'};action_bar=${actionBarFound ? 'yes' : 'no'};raw_len=${rawTextLength};clean_len=${cleanedTextLength};fallback=${fallbackUsed ? 'yes' : 'no'};images=${attachedImages.length};signals=${painSignalCount}`,
            article,
            {
              rootSelector,
              headerFound: Boolean(authorNode || timestampNode),
              actionBarFound,
              postUrl,
              imageCount: attachedImages.length,
              rawTextLength,
              cleanedTextLength,
              detailFallbackAttempted: false,
            }
          );
          continue;
        }

        const authorName = normalize(authorNode?.innerText || '') || 'Unknown';
        const mergedVisibleText = [mainBodyText, imageAltText].filter(Boolean).join('\n').trim();
        const matchedLeadSignals = (() => {
          const text = String(mergedVisibleText || '').toLowerCase();
          const signals = [];
          if (/\breimburse(?:ment|ments)?\b/.test(text)) signals.push('reimbursement');
          if (/\blost inventory\b|\bmissing inventory\b|\bmissing units?\b|\breceived less than shipped\b/.test(text)) signals.push('inventory discrepancy');
          if (/\bfees?\b|\bfee error\b|\bovercharging fees\b/.test(text)) signals.push('high fees');
          if (/\bsettlement\b|\bpayout\b/.test(text)) signals.push('settlement or payout confusion');
          if (/\bprofit\b|\bmargins?\b|\bmoney is disappearing\b/.test(text)) signals.push('profit leakage');
          if (/\bseller central\b|\bsettlement report\b|\bmanage fba inventory\b/.test(text)) signals.push('amazon dashboard screenshot');
          return signals;
        })();
        if (!isVisiblePostCandidate({
          authorName: authorName === 'Unknown' ? '' : authorName,
          bodyText: mergedVisibleText || mainBodyText,
          actionControlCount: [...actionControls, replyButton].filter(Boolean).length,
          timestampText,
          validationMode,
          controlNames,
          pageMode,
          fallbackUsed,
          painSignalCount,
          attachedImagesCount: attachedImages.length,
          imageTextLength,
          visibleTextLength: Math.max(rawTextLength, visibleFallbackLength),
        })) {
          extractionFailureCount += 1;
          reject(
            articleIndex,
            'invalid_visible_post_candidate',
            `root=${rootSelector};header=${authorNode || timestampNode ? 'yes' : 'no'};action_bar=${actionBarFound ? 'yes' : 'no'};mode=${validationMode};controls=${controlNames.join(',') || 'none'};body_len=${cleanedTextLength};fallback_len=${visibleFallbackLength};image_len=${imageTextLength};raw_len=${rawTextLength};fallback=${fallbackUsed ? 'yes' : 'no'};images=${attachedImages.length};signals=${painSignalCount}`,
            article,
            {
              rootSelector,
              headerFound: Boolean(authorNode || timestampNode),
              actionBarFound,
              postUrl,
              imageCount: attachedImages.length,
              rawTextLength,
              cleanedTextLength,
              detailFallbackAttempted: false,
            }
          );
          continue;
        }

        anchors.push({
          articleIndex,
          authorName,
          timestampText,
          postText: mergedVisibleText || mainBodyText,
          postUrl,
          anchorConfidence: timestampConfidence,
          selectorId,
          controlNames,
          extractionConfidence: fallbackUsed ? 'partial' : 'structured',
          fallbackUsed,
          rawTextLength,
          cleanedTextLength,
          painSignalCount,
          textFromDom: domExtraction.domText,
          textFromVisibleFallback: tolerantFallbackText,
          textFromImages: imageAltText,
          domTextLength: normalize(domExtraction.domText).length,
          fallbackTextLength: visibleFallbackLength,
          imageTextLength,
          attachedImagesCount: attachedImages.length,
          attachedImageSelectorIds: attachedImages.map((item) => item.selectorId),
          imageAltText,
          matchedLeadSignals,
          visionUsed: false,
        });

        if (anchors.length >= limit) {
          break;
        }
      }

      return {
        anchors,
        rejections,
        candidateRootCount: articles.length,
        readableTextCount,
        extractionFailureCount,
        eligibleCount: anchors.length,
        articleCount: articles.length,
        pageMode,
        url: window.location.href || '',
        feedContainerStatus,
        validationMode,
      };
    }, { limit: Math.max(limit * 2, 20), validationMode: String(validationMode || 'engagement') });

    const desiredCount = Math.max(Math.max(1, Number(limit || 1)), 8);
    const maxAttempts = Math.max(4, Math.min(Number(scrollRounds || 2) + 4, 8));
    const aggregateAnchors = [];
    const aggregateRejections = [];
    const seenKeys = new Set();
    const seenRejections = new Set();
    let extracted = null;
    let inspectedArticleCount = 0;
    let detailFallbackDebug = [];

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      extracted = await extractInPage();
      const rawAnchors = Array.isArray(extracted?.anchors) ? extracted.anchors : [];
      const rawRejections = Array.isArray(extracted?.rejections) ? extracted.rejections : [];
      inspectedArticleCount += Number(extracted?.articleCount || 0);

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

      for (const rejection of rawRejections) {
        const key = `${rejection.articleIndex}|${rejection.reason}|${rejection.selectorId || ''}|${rejection.postUrl || ''}`;
        if (seenRejections.has(key)) {
          continue;
        }
        seenRejections.add(key);
        aggregateRejections.push(rejection);
      }

      if (aggregateAnchors.length >= desiredCount) {
        break;
      }

      if (attempt < maxAttempts - 1) {
        await page.mouse.wheel(0, attempt === 0 ? 500 : 1000).catch(() => null);
        await page.waitForTimeout(randomBetween(1_500, 2_200));
      }
    }

    const anchors = [];
    const seenPostIds = new Set();
    const normalizedRejections = aggregateRejections;
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
        extractionConfidence: rawAnchor.extractionConfidence || 'structured',
        fallbackUsed: Boolean(rawAnchor.fallbackUsed),
        rawTextLength: Number(rawAnchor.rawTextLength || 0),
        cleanedTextLength: Number(rawAnchor.cleanedTextLength || 0),
        painSignalCount: Number(rawAnchor.painSignalCount || 0),
        textFromDom: rawAnchor.textFromDom || '',
        textFromVisibleFallback: rawAnchor.textFromVisibleFallback || '',
        textFromImages: rawAnchor.textFromImages || '',
        domTextLength: Number(rawAnchor.domTextLength || 0),
        fallbackTextLength: Number(rawAnchor.fallbackTextLength || 0),
        imageTextLength: Number(rawAnchor.imageTextLength || 0),
        attachedImagesCount: Number(rawAnchor.attachedImagesCount || 0),
        attachedImageSelectorIds: Array.isArray(rawAnchor.attachedImageSelectorIds) ? rawAnchor.attachedImageSelectorIds : [],
        imageAltText: rawAnchor.imageAltText || '',
        matchedLeadSignals: Array.isArray(rawAnchor.matchedLeadSignals) ? rawAnchor.matchedLeadSignals : [],
        visionUsed: Boolean(rawAnchor.visionUsed),
      });

      if (anchors.length >= limit) {
        break;
      }
    }

    if (enableDetailFallback && anchors.length < Math.max(1, Number(limit || 1))) {
      const detailRetry = await retryRejectedArticlesInDetail(page, normalizedRejections, {
        limit: Math.min(3, Math.max(1, Number(limit || 1))),
        validationMode,
      });
      detailFallbackDebug = detailRetry.debug || [];
      for (const recovered of detailRetry.recovered || []) {
        const dedupeKey = String(recovered.postId || recovered.postUrl || recovered.selectorId || '').trim();
        if (!dedupeKey || seenPostIds.has(dedupeKey)) {
          continue;
        }
        seenPostIds.add(dedupeKey);
        anchors.push(recovered);
        if (anchors.length >= limit) {
          break;
        }
      }
      for (const attempt of detailFallbackDebug) {
        const rejection = normalizedRejections.find((item) => item.articleIndex === attempt.articleIndex && item.postUrl === attempt.postUrl);
        if (rejection) {
          rejection.detailFallbackAttempted = true;
          rejection.detailFallbackRecovered = Boolean(attempt.recovered);
        }
      }
    }

    const enrichedAnchors = await enrichAnchorsMultimodally(page, anchors, { validationMode });

    if (returnMeta) {
      return {
        posts: enrichedAnchors,
        debug: {
          candidateRootCount: Number(extracted?.candidateRootCount || extracted?.articleCount || 0),
          articleCount: Number(extracted?.articleCount || 0),
          readableTextCount: Number(extracted?.readableTextCount || 0),
          extractionFailureCount: Number(extracted?.extractionFailureCount || 0),
          eligibleCount: Number(extracted?.eligibleCount || 0),
          inspectedArticleCount,
          url: String(extracted?.url || page.url() || ''),
          keptCount: enrichedAnchors.length,
          pageMode: String(extracted?.pageMode || 'unknown'),
          validationMode: String(extracted?.validationMode || validationMode || 'engagement'),
          feedContainerStatus: extracted?.feedContainerStatus || {
            found: false,
            tag: '',
            role: '',
            topLevelArticleCount: 0,
          },
          scanAttempts: maxAttempts,
          detailFallbackDebug,
          rejections: normalizedRejections,
        },
      };
    }

    return enrichedAnchors;
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
  extractPostDomText,
  extractVisibleArticleText,
  isVisiblePostCandidate,
  looksLikeFacebookTimestamp,
};
