'use strict';

const path = require('path');

function createInteractionsApi({
  FACEBOOK_BASE_URL,
  randomBetween,
  lightHumanPause,
  visitGroup,
}) {
  async function getBodyText(page) {
    return page.locator('body').innerText().catch(() => '');
  }

  async function isFacebookErrorPage(page) {
    const bodyText = await getBodyText(page);
    return /sorry,\s*something went wrong|page isn't available|this content isn't available|this page isn't available/i.test(
      bodyText
    );
  }

  async function resolveArticleByPostId(page, postId) {
    const articleSelectors = [
      `div[role="article"]:has(a[href*="/posts/${postId}"])`,
      `div[role="article"]:has(a[href*="story_fbid=${postId}"])`,
      `div[role="article"]:has(a[href*="/permalink/${postId}"])`,
      `div[role="article"]:has(a[href*="${postId}"])`,
    ];

    for (const selector of articleSelectors) {
      const match = page.locator(selector).first();
      if (await match.count()) {
        return match;
      }
    }

    return null;
  }

  async function findPostContainer(page, postId, options = {}) {
    if (options.postUrl) {
      if (page.url() !== options.postUrl) {
        await page.goto(options.postUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 90_000,
        });
        await page.waitForTimeout(1500);
      }

      if (await isFacebookErrorPage(page)) {
        throw new Error(`Facebook returned an error page for post ${postId}.`);
      }

      const matchedArticle = await resolveArticleByPostId(page, postId);
      if (matchedArticle) {
        return matchedArticle;
      }

      const visibleArticles = page.locator('div[role="article"]');
      const visibleCount = await visibleArticles.count();
      if (visibleCount === 1) {
        return visibleArticles.first();
      }
    }

    const candidates = [
      page.locator(`a[href*="/posts/${postId}"]`).first(),
      page.locator(`a[href*="story_fbid=${postId}"]`).first(),
      page.locator(`a[href*="/permalink/${postId}"]`).first(),
    ];

    for (const candidate of candidates) {
      if (await candidate.count()) {
        return candidate.locator('xpath=ancestor::div[@role="article"][1]');
      }
    }

    throw new Error(`Unable to locate post container for post ID ${postId}.`);
  }

  async function findVisiblePostContainer(page, visibleIndex) {
    const articles = page.locator('div[role="article"]');
    const count = await articles.count();
    if (!count || visibleIndex < 1 || visibleIndex > count) {
      throw new Error(`Visible post ${visibleIndex} is not available on the current page.`);
    }

    const article = articles.nth(visibleIndex - 1);
    await article.scrollIntoViewIfNeeded();
    await article.waitFor({ state: 'visible', timeout: 10_000 });
    return article;
  }

  async function clickLike(page, postId, options = {}) {
    const post = await findPostContainer(page, postId, options);
    const likeButton = post.getByRole('button', { name: /^like$/i }).first();
    if (!(await likeButton.count())) {
      throw new Error(`Like button not found for post ${postId}.`);
    }

    await likeButton.waitFor({ state: 'visible', timeout: 10_000 });
    await likeButton.scrollIntoViewIfNeeded();
    await lightHumanPause(page, 800, 1_800);
    await likeButton.click({ delay: randomBetween(60, 180) });
    await page.waitForTimeout(randomBetween(1_000, 2_500));
    return true;
  }

  async function clickLikeOnVisiblePost(page, visibleIndex) {
    const post = await findVisiblePostContainer(page, visibleIndex);
    const likeButton = post.getByRole('button', { name: /^like$/i }).first();
    if (!(await likeButton.count())) {
      throw new Error(`Like button not found for visible post ${visibleIndex}.`);
    }

    const beforeState = await likeButton.evaluate((element) => ({
      text: (element.innerText || '').trim(),
      ariaLabel: element.getAttribute('aria-label') || '',
      ariaPressed: element.getAttribute('aria-pressed') || '',
    })).catch(() => ({ text: '', ariaLabel: '', ariaPressed: '' }));

    await likeButton.waitFor({ state: 'visible', timeout: 10_000 });
    await likeButton.scrollIntoViewIfNeeded();
    await lightHumanPause(page, 800, 1_800);

    try {
      await likeButton.click({ delay: randomBetween(60, 180) });
    } catch (error) {
      if (/intercepts pointer events|another element/i.test(String(error.message || ''))) {
        await likeButton.click({ delay: randomBetween(60, 180), force: true });
      } else {
        throw error;
      }
    }

    await page.waitForTimeout(randomBetween(1_000, 2_500));
    const afterState = await likeButton.evaluate((element) => ({
      text: (element.innerText || '').trim(),
      ariaLabel: element.getAttribute('aria-label') || '',
      ariaPressed: element.getAttribute('aria-pressed') || '',
    })).catch(() => ({ text: '', ariaLabel: '', ariaPressed: '' }));

    const changed = beforeState.ariaPressed !== afterState.ariaPressed
      || beforeState.ariaLabel !== afterState.ariaLabel
      || /\bliked\b|remove like/i.test(`${afterState.text} ${afterState.ariaLabel}`);
    if (!changed) {
      throw new Error(`Like did not appear to register for visible post ${visibleIndex}.`);
    }

    return true;
  }

  async function postComment(page, postId, text, options = {}) {
    const post = await findPostContainer(page, postId, options);
    const commentBox = post
      .locator(
        '[aria-label*="Leave a comment"], [aria-label*="Write a comment"], [aria-label*="Comment"], div[role="textbox"][contenteditable="true"]'
      )
      .first();

    if (!(await commentBox.count())) {
      throw new Error(`Comment box not found for post ${postId}.`);
    }

    await commentBox.waitFor({ state: 'visible', timeout: 10_000 });
    await commentBox.scrollIntoViewIfNeeded();
    await lightHumanPause(page, 1_000, 2_200);
    await commentBox.click({ delay: randomBetween(60, 180) });
    await page.keyboard.type(text, { delay: randomBetween(35, 90) });
    await page.waitForTimeout(randomBetween(800, 1_600));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(randomBetween(1_500, 3_500));
    return true;
  }

  async function postCommentOnVisiblePost(page, visibleIndex, text) {
    const post = await findVisiblePostContainer(page, visibleIndex);
    const commentTrigger = post.getByRole('button', { name: /comment|leave a comment|write a comment/i }).first();
    if (!(await commentTrigger.count())) {
      throw new Error(`Comment button not found for visible post ${visibleIndex}.`);
    }

    await commentTrigger.scrollIntoViewIfNeeded();
    await lightHumanPause(page, 900, 1_900);
    try {
      await commentTrigger.click({ delay: randomBetween(60, 180) });
    } catch (error) {
      if (/intercepts pointer events|another element/i.test(String(error.message || ''))) {
        await commentTrigger.click({ delay: randomBetween(60, 180), force: true });
      } else {
        throw error;
      }
    }

    const commentBox = post.locator('div[role="textbox"][contenteditable="true"]').first();
    await commentBox.waitFor({ state: 'visible', timeout: 10_000 });
    await commentBox.click({ delay: randomBetween(60, 180) });
    await page.keyboard.type(text, { delay: randomBetween(35, 90) });
    await page.waitForTimeout(randomBetween(800, 1_600));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(randomBetween(1_500, 3_500));
    return true;
  }

  async function openPostComposer(page, { groupId = null } = {}) {
    if (groupId) {
      const groupUrl = `${FACEBOOK_BASE_URL}/groups/${groupId}`;
      await visitGroup(page, groupUrl);
    } else {
      await page.goto(FACEBOOK_BASE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 90_000,
      });
      await page.waitForTimeout(1_500);
    }

    const createPostTrigger = page
      .getByRole('button', { name: /write something|create public post|what's on your mind/i })
      .first();

    await createPostTrigger.waitFor({ state: 'visible', timeout: 15_000 });
    await createPostTrigger.scrollIntoViewIfNeeded();
    await lightHumanPause(page, 1_000, 2_000);
    await createPostTrigger.click({ delay: randomBetween(60, 180) });

    const composer = page
      .locator('div[role="dialog"] div[role="textbox"][contenteditable="true"]')
      .first();
    await composer.waitFor({ state: 'visible', timeout: 15_000 });
    return composer;
  }

  async function submitComposerPost(page, text, imagePath = null) {
    const composer = page
      .locator('div[role="dialog"] div[role="textbox"][contenteditable="true"]')
      .first();
    await composer.waitFor({ state: 'visible', timeout: 15_000 });
    await composer.click({ delay: randomBetween(50, 120) });
    await composer.evaluate((element, value) => {
      element.focus();
      element.textContent = value;
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: value,
      }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, text);
    await page.waitForTimeout(800);
    await page.keyboard.type(' ', { delay: 40 });
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(600);

    if (imagePath) {
      const fileInput = page.locator('div[role="dialog"] input[type="file"]').first();
      await fileInput.setInputFiles(path.resolve(imagePath));
      await page.waitForTimeout(randomBetween(2_000, 5_000));
    }

    const postButton = page.getByRole('button', { name: /^post$/i }).last();
    await page.waitForFunction(() => {
      const candidates = Array.from(document.querySelectorAll('[role="button"], button'));
      const button = candidates.find((node) => /^post$/i.test((node.innerText || node.getAttribute('aria-label') || '').trim()));
      if (!button) {
        return false;
      }
      return button.getAttribute('aria-disabled') !== 'true' && button.disabled !== true;
    }, { timeout: 15_000 }).catch(() => null);

    await lightHumanPause(page, 1_000, 2_200);
    await postButton.click({ delay: randomBetween(60, 180) });
    await page.waitForTimeout(randomBetween(4_000, 8_000));
    return true;
  }

  async function createNewPost(page, groupId, text, imagePath = null) {
    await openPostComposer(page, { groupId });
    return submitComposerPost(page, text, imagePath);
  }

  async function createFeedPost(page, text, imagePath = null) {
    await openPostComposer(page, { groupId: null });
    return submitComposerPost(page, text, imagePath);
  }

  return {
    clickLike,
    clickLikeOnVisiblePost,
    createFeedPost,
    createNewPost,
    findPostContainer,
    findVisiblePostContainer,
    openPostComposer,
    postComment,
    postCommentOnVisiblePost,
    submitComposerPost,
  };
}

module.exports = {
  createInteractionsApi,
};
