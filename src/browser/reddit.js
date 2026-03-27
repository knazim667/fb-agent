'use strict';

const {
  analyzeImageWithVision,
  buildVisionFilePath,
  ensureVisionDir,
  mergePostReading,
  normalizeText,
  uniqueStrings,
} = require('./multimodal');

const REDDIT_BASE_URL = 'https://www.reddit.com';

function classifyRedditPage({
  url = '',
  needsLogin = false,
} = {}) {
  const normalizedUrl = String(url || '');

  if (needsLogin || /\/login(?:\/|$)|\/register(?:\/|$)/i.test(normalizedUrl)) {
    return 'reddit_login';
  }

  if (/\/r\/[^/]+\/comments\//i.test(normalizedUrl)) {
    return 'reddit_post_detail';
  }

  if (/\/search(?:\/|\?|$)/i.test(normalizedUrl)) {
    return 'reddit_search_results';
  }

  if (/\/r\/[^/?#]+\/?$/i.test(normalizedUrl)) {
    return 'reddit_subreddit_feed';
  }

  if (/^https?:\/\/(?:www\.)?reddit\.com\/?(?:[?#].*)?$/i.test(normalizedUrl)) {
    return 'reddit_home';
  }

  return 'reddit_unknown';
}

function extractPostDomText({
  title = '',
  body = '',
} = {}) {
  return normalizeText([title, body].filter(Boolean).join('\n'));
}

function extractVisibleArticleText(text = '') {
  return normalizeText(text);
}

function createRedditApi({
  randomBetween,
}) {
  async function capturePostScreenshot(page, selectorId = '') {
    const normalized = String(selectorId || '').trim();
    if (!normalized) {
      return null;
    }
    await ensureVisionDir().catch(() => null);
    const locator = page.locator(`[data-agent-reddit-post-id="${normalized}"]`).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) {
      return null;
    }
    const screenshotPath = buildVisionFilePath('reddit-post', '.png');
    await locator.screenshot({ path: screenshotPath, type: 'png' }).catch(() => null);
    return screenshotPath;
  }

  async function captureAttachedImageScreenshots(page, imageSelectorIds = []) {
    const screenshots = [];
    await ensureVisionDir().catch(() => null);
    for (const selectorId of imageSelectorIds.slice(0, 3)) {
      const locator = page.locator(`[data-agent-reddit-image-id="${String(selectorId || '').trim()}"]`).first();
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }
      const screenshotPath = buildVisionFilePath('reddit-image', '.png');
      await locator.screenshot({ path: screenshotPath, type: 'png' }).catch(() => null);
      screenshots.push(screenshotPath);
    }
    return screenshots;
  }

  async function analyzePostScreenshotWithVision(imagePath = '') {
    return analyzeImageWithVision(
      imagePath,
      'Read this Reddit post screenshot. Extract visible text, summarize the seller problem, and identify Amazon reimbursement, inventory, fee, payout, settlement, or profit-leak signals.'
    );
  }

  async function analyzeAttachedImagesWithVision(imagePaths = []) {
    const analyses = [];
    for (const imagePath of imagePaths.slice(0, 3)) {
      analyses.push(await analyzeImageWithVision(
        imagePath,
        'Read this attached Reddit image. If it shows Amazon Seller Central, inventory, settlement, payout, reimbursement, or fee information, extract useful text and summarize the issue.'
      ));
    }
    return {
      used: analyses.some((item) => item?.used),
      text: uniqueStrings(analyses.map((item) => item?.text || '')).join('\n').trim(),
      summary: uniqueStrings(analyses.map((item) => item?.summary || '')).join('\n').trim(),
      signals: uniqueStrings(analyses.flatMap((item) => Array.isArray(item?.signals) ? item.signals : [])),
      confidence: analyses.length
        ? Number((analyses.reduce((sum, item) => sum + Number(item?.confidence || 0), 0) / analyses.length).toFixed(2))
        : 0,
    };
  }

  function normalizeSubredditName(value = '') {
    return String(value || '').trim().replace(/^r\//i, '').replace(/^\/?r\//i, '').replace(/^\/+|\/+$/g, '');
  }

  async function visitRedditHome(page) {
    await page.goto(REDDIT_BASE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });
    await page.waitForLoadState('networkidle').catch(() => null);
    await page.waitForTimeout(2_000);
    return page.url();
  }

  async function inspectRedditSession(page) {
    const url = page.url();
    const cookies = await page.context().cookies(REDDIT_BASE_URL).catch(() => []);
    const cookieNames = new Set(cookies.map((cookie) => String(cookie.name || '').toLowerCase()));
    const hasAuthCookie = ['reddit_session', 'token_v2']
      .some((name) => cookieNames.has(name));

    const bodyText = await page.locator('body').innerText().catch(() => '');
    const normalized = String(bodyText || '').toLowerCase();
    const loggedOutSignals = /\blog in\b|\bsign up\b|\bcontinue with google\b|\bcontinue with apple\b|\bcontinue with email\b/.test(normalized);
    const loginSurfaceVisible = await page.locator(
      'a[href*="/login"], a[href*="/register"], button:has-text("Log In"), button:has-text("Sign Up")'
    ).first().isVisible().catch(() => false);
    const accountSurfaceVisible = await page.locator(
      'a[href="/submit"], a[href^="/user/"], button[id*="USER_DROPDOWN"], button[aria-label*="Open user menu"]'
    ).first().isVisible().catch(() => false);

    const loginUrl = /\/login(?:\/|$)|\/register(?:\/|$)/i.test(url);
    const loggedIn = hasAuthCookie || accountSurfaceVisible;
    const needsLogin = !loggedIn && (loginUrl || loginSurfaceVisible || loggedOutSignals);

    return {
      loggedIn,
      needsLogin,
      uncertain: !loggedIn && !needsLogin,
    };
  }

  async function visitSubreddit(page, subreddit) {
    const normalized = normalizeSubredditName(subreddit);
    if (!normalized) {
      throw new Error('I need a subreddit name like r/FulfillmentByAmazon.');
    }

    const url = `${REDDIT_BASE_URL}/r/${normalized}/`;
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });
    await page.waitForLoadState('networkidle').catch(() => null);
    await page.waitForTimeout(2_000);
    return page.url();
  }

  async function searchPosts(page, query) {
    const normalized = String(query || '').trim();
    if (!normalized) {
      throw new Error('I need a Reddit search query.');
    }

    if (!/reddit\.com/i.test(page.url() || '')) {
      await visitRedditHome(page);
    } else {
      await page.waitForLoadState('domcontentloaded').catch(() => null);
      await page.waitForTimeout(1_500);
    }

    const searchSelectors = [
      'faceplate-search-input input',
      'input[type="search"]',
      'input[placeholder*="Search"]',
      'input[aria-label*="Search"]',
    ];

    let usedUiSearch = false;
    for (const selector of searchSelectors) {
      const input = page.locator(selector).first();
      const visible = await input.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      await input.click({ timeout: 10_000 }).catch(() => null);
      await page.waitForTimeout(randomBetween(150, 300));
      await input.fill('');
      await input.type(normalized, { delay: randomBetween(50, 120) }).catch(() => null);
      await page.waitForTimeout(randomBetween(200, 500));
      await input.press('Enter').catch(() => null);
      usedUiSearch = true;
      break;
    }

    if (!usedUiSearch) {
      const url = `${REDDIT_BASE_URL}/search/?q=${encodeURIComponent(normalized)}&sort=new`;
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 90_000,
      });
    }

    await page.waitForLoadState('networkidle').catch(() => null);
    await page.waitForTimeout(2_500);
    return page.url();
  }

  async function loadVisiblePosts(page, { scrollRounds = 2 } = {}) {
    await page.waitForTimeout(randomBetween(800, 1_500));
    for (let round = 0; round < scrollRounds; round += 1) {
      await page.mouse.wheel(0, 900).catch(() => null);
      await page.waitForTimeout(randomBetween(1_000, 1_800));
    }
  }

  async function listVisibleRedditPosts(page, { limit = 10, scrollRounds = 2, returnMeta = false } = {}) {
    await page.waitForLoadState('domcontentloaded');
    await loadVisiblePosts(page, { scrollRounds });

    const extracted = await page.evaluate(({ limit }) => {
      function normalize(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
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

      function getText(node, selectors) {
        for (const selector of selectors) {
          const match = node.querySelector(selector);
          const text = normalize(match?.innerText || '');
          if (text) {
            return text;
          }
        }
        return '';
      }

      function stripUiNoise(text) {
        return normalize(
          String(text || '')
            .replace(/\b(?:upvote|downvote|share|award|reply|comment|comments|sort by: best|best|top|new)\b/gi, ' ')
            .replace(/\s+/g, ' ')
        );
      }

      function extractVisibleArticleText(card) {
        const texts = [];
        const seen = new Set();
        const nodes = Array.from(card.querySelectorAll('h1, h2, h3, p, div, span, a'));
        for (const node of nodes) {
          if (!isVisible(node)) {
            continue;
          }
          const text = stripUiNoise(node.innerText || '');
          if (!text || text.length < 3) {
            continue;
          }
          const key = text.toLowerCase();
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          texts.push(text);
        }
        return texts.join('\n').trim();
      }

      function collectAttachedImages(card) {
        const images = [];
        const seen = new Set();
        const nodes = Array.from(card.querySelectorAll('img'));
        for (const node of nodes) {
          if (!isVisible(node)) {
            continue;
          }
          const rect = node.getBoundingClientRect();
          if (rect.width < 90 || rect.height < 90) {
            continue;
          }
          const src = node.getAttribute('src') || '';
          const altText = normalize(node.getAttribute('alt') || node.getAttribute('aria-label') || '');
          const key = `${src.slice(0, 80)}|${Math.round(rect.width)}|${Math.round(rect.height)}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          const selectorId = node.getAttribute('data-agent-reddit-image-id') || `agent-reddit-image-${images.length + 1}-${Math.round(rect.top)}`;
          node.setAttribute('data-agent-reddit-image-id', selectorId);
          images.push({
            selectorId,
            altText,
            src,
          });
        }
        return images;
      }

      const containers = Array.from(document.querySelectorAll(
        'shreddit-post, article[data-testid="post-container"], div[data-testid="post-container"], article'
      )).filter((node, index, all) => isVisible(node) && all.indexOf(node) === index);

      const posts = [];
      const rejections = [];
      const seen = new Set();

      for (let index = 0; index < containers.length; index += 1) {
        const card = containers[index];
        const commentLink = Array.from(card.querySelectorAll('a[href*="/comments/"]'))
          .find((node) => isVisible(node) && /\/comments\//i.test(node.getAttribute('href') || ''));
        const title = normalize(
          commentLink?.innerText
          || getText(card, ['h3', '[slot="title"]', 'faceplate-screen-reader-content', 'a[data-testid="post-title"]'])
        );
        const href = commentLink?.getAttribute('href') || '';
        const subreddit = getText(card, ['a[href^="/r/"]', 'faceplate-tracker[href^="/r/"]', '[data-testid="subreddit-name"]']);
        const author = getText(card, ['a[href^="/user/"]', '[data-testid="post_author_link"]']);
        const body = normalize(
          getText(card, ['[slot="text-body"]', 'div[data-click-id="text"]', '[data-testid="post-content"]'])
          || Array.from(card.querySelectorAll('p')).map((node) => normalize(node.innerText)).filter(Boolean).join(' ')
        );
        const visibleFallback = extractVisibleArticleText(card);
        const attachedImages = collectAttachedImages(card);
        const imageAltText = attachedImages.map((item) => item.altText).filter(Boolean).join('\n').trim();
        const dedupeKey = `${href}|${title}`;

        if (!title || !href) {
          rejections.push({
            articleIndex: index,
            reason: 'missing_title_or_href',
            sampleText: normalize((card.innerText || '').slice(0, 240)),
          });
          continue;
        }

        if (seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);

        const selectorId = card.getAttribute('data-agent-reddit-post-id') || `agent-reddit-post-${posts.length + 1}`;
        card.setAttribute('data-agent-reddit-post-id', selectorId);

        posts.push({
          visibleIndex: posts.length + 1,
          articleIndex: index,
          postId: href,
          postUrl: href.startsWith('http') ? href : `${window.location.origin}${href}`,
          title,
          authorName: author || 'Unknown',
          subreddit: subreddit || '',
          postText: normalize([title, body || visibleFallback || imageAltText].filter(Boolean).join('\n')),
          summary: title,
          selectorId,
          textFromDom: normalize([title, body].filter(Boolean).join('\n')),
          textFromVisibleFallback: visibleFallback,
          textFromImages: imageAltText,
          domTextLength: normalize([title, body].filter(Boolean).join('\n')).length,
          fallbackTextLength: visibleFallback.length,
          imageTextLength: imageAltText.length,
          attachedImagesCount: attachedImages.length,
          attachedImageSelectorIds: attachedImages.map((item) => item.selectorId),
          visionUsed: false,
          matchedLeadSignals: [],
        });

        if (posts.length >= limit) {
          break;
        }
      }

      return {
        posts,
        debug: {
          url: window.location.href || '',
          articleCount: containers.length,
          keptCount: posts.length,
          rejections,
        },
      };
    }, { limit: Math.max(1, limit) });

    const multimodalPosts = [];
    for (const post of Array.isArray(extracted?.posts) ? extracted.posts : []) {
      const domText = normalizeText(post.textFromDom || '');
      const fallbackText = normalizeText(post.textFromVisibleFallback || '');
      let screenshotAnalysis = {
        used: false,
        text: '',
        summary: '',
        signals: [],
        confidence: 0,
      };
      let imageAnalysis = {
        used: false,
        text: '',
        summary: '',
        signals: [],
        confidence: 0,
      };

      const needsVision = domText.length < 24 || fallbackText.length < 24 || Number(post.attachedImagesCount || 0) > 0;
      if (needsVision) {
        const screenshotPath = await capturePostScreenshot(page, post.selectorId);
        if (screenshotPath) {
          screenshotAnalysis = await analyzePostScreenshotWithVision(screenshotPath);
        }
      }

      if (Number(post.attachedImagesCount || 0) > 0) {
        const imagePaths = await captureAttachedImageScreenshots(page, post.attachedImageSelectorIds || []);
        if (imagePaths.length) {
          imageAnalysis = await analyzeAttachedImagesWithVision(imagePaths);
        }
      }

      const reading = mergePostReading({
        author: post.authorName || '',
        textFromDom: domText,
        textFromVisibleFallback: fallbackText,
        textFromImages: uniqueStrings([post.textFromImages || '', screenshotAnalysis.text, imageAnalysis.text]).join('\n'),
        visualSummary: uniqueStrings([screenshotAnalysis.summary, imageAnalysis.summary]).join('\n'),
        attachedImagesCount: Number(post.attachedImagesCount || 0),
        existingSignals: [
          ...(Array.isArray(screenshotAnalysis.signals) ? screenshotAnalysis.signals : []),
          ...(Array.isArray(imageAnalysis.signals) ? imageAnalysis.signals : []),
        ],
      });

      multimodalPosts.push({
        ...post,
        postText: reading.merged_text || post.postText || '',
        textFromDom: reading.text_from_dom,
        textFromVisibleFallback: reading.text_from_visible_fallback,
        textFromImages: reading.text_from_images,
        visualSummary: reading.visual_summary,
        confidenceScore: reading.confidence_score,
        matchedLeadSignals: reading.lead_signals_matched,
        visionUsed: Boolean(screenshotAnalysis.used || imageAnalysis.used),
        domTextLength: reading.text_from_dom.length,
        fallbackTextLength: reading.text_from_visible_fallback.length,
        imageTextLength: reading.text_from_images.length,
      });
    }

    if (returnMeta) {
      return {
        ...extracted,
        posts: multimodalPosts,
      };
    }

    return multimodalPosts;
  }

  async function observeRedditPage(page, { includePosts = false, limit = 10, scrollRounds = 1 } = {}) {
    await page.waitForLoadState('domcontentloaded').catch(() => null);
    await page.waitForTimeout(800);

    const session = await inspectRedditSession(page).catch(() => ({
      loggedIn: false,
      needsLogin: false,
      uncertain: true,
    }));

    const surface = await page.evaluate(() => {
      function normalize(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
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

      const searchVisible = Array.from(document.querySelectorAll(
        'faceplate-search-input input, input[type="search"], input[placeholder*="Search"], input[aria-label*="Search"]'
      )).some((node) => isVisible(node));

      const loginVisible = Array.from(document.querySelectorAll(
        'a[href*="/login"], a[href*="/register"], button'
      )).some((node) => {
        if (!isVisible(node)) {
          return false;
        }
        const text = normalize(node.innerText || node.getAttribute('aria-label') || '');
        return /log in|sign up|continue with google|continue with email|continue with apple/i.test(text);
      });

      const subredditLink = Array.from(document.querySelectorAll('a[href^="/r/"]'))
        .find((node) => isVisible(node) && /^\/r\/[^/]+\/?$/i.test(node.getAttribute('href') || ''));
      const subreddit = normalize(subredditLink?.getAttribute('href') || '').replace(/^\/r\//i, '').replace(/\/+$/g, '');

      const articleCount = Array.from(document.querySelectorAll(
        'shreddit-post, article[data-testid="post-container"], div[data-testid="post-container"], article'
      )).filter((node) => isVisible(node)).length;

      return {
        loginVisible,
        searchVisible,
        subreddit,
        articleCount,
        bodyPreview: normalize(document.body?.innerText || '').slice(0, 300),
      };
    }).catch(() => ({
      loginVisible: false,
      searchVisible: false,
      subreddit: '',
      articleCount: 0,
      bodyPreview: '',
    }));

    const state = classifyRedditPage({
      url: page.url(),
      needsLogin: session.needsLogin,
    });

    let posts = [];
    let postsDebug = null;
    if (includePosts && ['reddit_home', 'reddit_subreddit_feed', 'reddit_search_results', 'reddit_post_detail'].includes(state)) {
      const result = await listVisibleRedditPosts(page, {
        limit,
        scrollRounds,
        returnMeta: true,
      }).catch(() => ({ posts: [], debug: null }));
      posts = Array.isArray(result?.posts) ? result.posts : [];
      postsDebug = result?.debug || null;
    }

    return {
      platform: 'reddit',
      state,
      url: page.url(),
      loggedIn: session.loggedIn,
      needsLogin: session.needsLogin,
      uncertain: session.uncertain,
      searchVisible: surface.searchVisible,
      loginVisible: surface.loginVisible,
      subreddit: surface.subreddit || '',
      articleCount: surface.articleCount || 0,
      bodyPreview: surface.bodyPreview || '',
      posts,
      postsDebug,
    };
  }

  async function commentOnRedditPost(page, { postUrl, text }) {
    const normalizedText = String(text || '').trim();
    if (!postUrl) {
      throw new Error('I need a Reddit post URL before I can comment.');
    }
    if (!normalizedText) {
      throw new Error('I need comment text before I can post on Reddit.');
    }

    if (page.url() !== postUrl) {
      await page.goto(postUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 90_000,
      });
      await page.waitForLoadState('networkidle').catch(() => null);
      await page.waitForTimeout(2_000);
    }

    const session = await inspectRedditSession(page);
    if (session.needsLogin || !session.loggedIn) {
      throw new Error('Reddit is not logged in.');
    }

    const editorSelectors = [
      'faceplate-comment-composer textarea',
      'shreddit-composer textarea',
      'textarea[placeholder*="What are your thoughts"]',
      'div[contenteditable="true"][role="textbox"]',
      '[data-testid="comment-submission-form-richtext-input"] div[contenteditable="true"]',
    ];

    let editor = null;
    for (const selector of editorSelectors) {
      const candidate = page.locator(selector).first();
      const visible = await candidate.isVisible().catch(() => false);
      if (visible) {
        editor = candidate;
        break;
      }
    }

    if (!editor) {
      const trigger = page.locator('button:has-text("Comment"), button:has-text("Add a comment"), a:has-text("Comment")').first();
      if (await trigger.isVisible().catch(() => false)) {
        await trigger.click({ delay: randomBetween(60, 140) }).catch(() => null);
        await page.waitForTimeout(1_000);
      }

      for (const selector of editorSelectors) {
        const candidate = page.locator(selector).first();
        const visible = await candidate.isVisible().catch(() => false);
        if (visible) {
          editor = candidate;
          break;
        }
      }
    }

    if (!editor) {
      throw new Error('Reddit comment editor was not visible.');
    }

    await editor.scrollIntoViewIfNeeded().catch(() => null);
    await editor.click({ delay: randomBetween(60, 140) }).catch(() => null);
    await page.waitForTimeout(randomBetween(150, 300));

    const tagName = await editor.evaluate((node) => node.tagName.toLowerCase()).catch(() => 'div');
    if (tagName === 'textarea') {
      await editor.fill('');
      await editor.type(normalizedText, { delay: randomBetween(45, 110) });
    } else {
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => null);
      await page.keyboard.press('Backspace').catch(() => null);
      await page.keyboard.type(normalizedText, { delay: randomBetween(45, 110) });
    }

    await page.waitForTimeout(600);

    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Comment")',
      'faceplate-comment-composer button[type="submit"]',
    ];

    let submit = null;
    for (const selector of submitSelectors) {
      const candidate = page.locator(selector).filter({ hasText: /comment/i }).first();
      const visible = await candidate.isVisible().catch(() => false);
      const enabled = await candidate.isEnabled().catch(() => false);
      if (visible && enabled) {
        submit = candidate;
        break;
      }
    }

    if (!submit) {
      throw new Error('Reddit comment submit button was not enabled.');
    }

    await submit.click({ delay: randomBetween(60, 140) });
    await page.waitForLoadState('networkidle').catch(() => null);
    await page.waitForTimeout(2_000);

    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (!String(bodyText || '').includes(normalizedText.slice(0, Math.min(24, normalizedText.length)))) {
      throw new Error('Reddit comment did not appear after posting.');
    }

    return true;
  }

  return {
    REDDIT_BASE_URL,
    classifyRedditPage,
    commentOnRedditPost,
    inspectRedditSession,
    listVisibleRedditPosts,
    normalizeSubredditName,
    observeRedditPage,
    searchPosts,
    visitRedditHome,
    visitSubreddit,
  };
}

module.exports = {
  REDDIT_BASE_URL,
  classifyRedditPage,
  createRedditApi,
  extractPostDomText,
  extractVisibleArticleText,
};
