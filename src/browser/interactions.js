'use strict';

const path = require('path');

function createInteractionsApi({
  FACEBOOK_BASE_URL,
  randomBetween,
  lightHumanPause,
  visitGroup,
}) {
  async function findPostContainer(page, postId) {
    const candidates = [
      page.locator(`a[href*="/posts/${postId}"]`).first(),
      page.locator(`a[href*="story_fbid=${postId}"]`).first(),
    ];

    for (const candidate of candidates) {
      if (await candidate.count()) {
        return candidate.locator('xpath=ancestor::div[@role="article"][1]');
      }
    }

    throw new Error(`Unable to locate post container for post ID ${postId}.`);
  }

  async function clickLike(page, postId) {
    const post = await findPostContainer(page, postId);
    const likeButton = post
      .getByRole('button', { name: /like/i })
      .filter({ hasNotText: /liked/i })
      .first();

    await likeButton.scrollIntoViewIfNeeded();
    await lightHumanPause(page, 800, 1_800);
    await likeButton.click({ delay: randomBetween(60, 180) });
    await page.waitForTimeout(randomBetween(1_000, 2_500));
    return true;
  }

  async function postComment(page, postId, text) {
    const post = await findPostContainer(page, postId);
    const commentBox = post
      .locator('[aria-label*="Comment"], div[role="textbox"][contenteditable="true"]')
      .first();

    await commentBox.scrollIntoViewIfNeeded();
    await lightHumanPause(page, 1_000, 2_200);
    await commentBox.click({ delay: randomBetween(60, 180) });
    await page.keyboard.type(text, { delay: randomBetween(35, 90) });
    await page.waitForTimeout(randomBetween(800, 1_600));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(randomBetween(1_500, 3_500));
    return true;
  }

  async function createNewPost(page, groupId, text, imagePath = null) {
    const groupUrl = `${FACEBOOK_BASE_URL}/groups/${groupId}`;
    await visitGroup(page, groupUrl);

    const createPostTrigger = page
      .getByRole('button', { name: /write something|create public post|what's on your mind/i })
      .first();

    await createPostTrigger.scrollIntoViewIfNeeded();
    await lightHumanPause(page, 1_000, 2_000);
    await createPostTrigger.click({ delay: randomBetween(60, 180) });

    const composer = page
      .locator('div[role="dialog"] div[role="textbox"][contenteditable="true"]')
      .first();
    await composer.waitFor({ state: 'visible', timeout: 15_000 });
    await composer.click({ delay: randomBetween(50, 120) });
    await page.keyboard.type(text, { delay: randomBetween(30, 85) });

    if (imagePath) {
      const fileInput = page.locator('div[role="dialog"] input[type="file"]').first();
      await fileInput.setInputFiles(path.resolve(imagePath));
      await page.waitForTimeout(randomBetween(2_000, 5_000));
    }

    const postButton = page.getByRole('button', { name: /^post$/i }).last();
    await lightHumanPause(page, 1_000, 2_200);
    await postButton.click({ delay: randomBetween(60, 180) });
    await page.waitForTimeout(randomBetween(4_000, 8_000));
    return true;
  }

  return {
    clickLike,
    createNewPost,
    findPostContainer,
    postComment,
  };
}

module.exports = {
  createInteractionsApi,
};
