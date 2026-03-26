'use strict';

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

function createRedditApi({
  randomBetween,
}) {
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

        posts.push({
          visibleIndex: posts.length + 1,
          articleIndex: index,
          postId: href,
          postUrl: href.startsWith('http') ? href : `${window.location.origin}${href}`,
          title,
          authorName: author || 'Unknown',
          subreddit: subreddit || '',
          postText: normalize([title, body].filter(Boolean).join('\n')),
          summary: title,
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

    if (returnMeta) {
      return extracted;
    }

    return extracted.posts || [];
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

  return {
    REDDIT_BASE_URL,
    classifyRedditPage,
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
};
