'use strict';

function createActionsApi({
  listVisiblePosts,
  lightHumanPause,
  randomBetween,
}) {
  async function hoverAndRead(page, locator) {
    await locator.hover().catch(() => null);
    await page.waitForTimeout(randomBetween(1_000, 2_000));
  }

  async function anchorVisiblePost(page, visibleIndex, options = {}) {
    const explicitSelectorId = String(options.selectorId || '').trim();
    if (explicitSelectorId) {
      const explicitArticle = page.locator(`[data-agent-visible-post-id="${explicitSelectorId}"]`).first();
      if (await explicitArticle.count()) {
        await explicitArticle.waitFor({ state: 'visible', timeout: 10_000 });
        await explicitArticle.scrollIntoViewIfNeeded();
        return {
          anchor: {
            visibleIndex: Number(visibleIndex),
            selectorId: explicitSelectorId,
          },
          article: explicitArticle,
        };
      }
    }

    const anchors = await listVisiblePosts(page, {
      limit: options.limit || Math.max(Number(visibleIndex) + 8, 12),
      scrollRounds: options.scrollRounds ?? 2,
    });
    const anchor = anchors.find((item) =>
      explicitSelectorId
        ? String(item.selectorId || '').trim() === explicitSelectorId
        : Number(item.visibleIndex) === Number(visibleIndex)
    );
    if (!anchor) {
      throw new Error(`Visible post anchor ${visibleIndex} was not found on the current page.`);
    }

    const article = anchor.selectorId
      ? page.locator(`[data-agent-visible-post-id="${anchor.selectorId}"]`).first()
      : page.locator('div[role="article"]').nth(Number(anchor.articleIndex));
    await article.waitFor({ state: 'visible', timeout: 10_000 });
    await article.scrollIntoViewIfNeeded();

    return {
      anchor,
      article,
    };
  }

  async function extractAnchoredPostData(page, visibleIndex, options = {}) {
    const { anchor } = await anchorVisiblePost(page, visibleIndex, options);
    return anchor;
  }

  async function readLikeState(likeButton) {
    return likeButton.evaluate((element) => ({
      text: (element.innerText || '').trim(),
      ariaLabel: element.getAttribute('aria-label') || '',
      ariaPressed: element.getAttribute('aria-pressed') || '',
    })).catch(() => ({
      text: '',
      ariaLabel: '',
      ariaPressed: '',
    }));
  }

  async function verifyAnchoredAction(page, visibleIndex, actionType, baseline = {}, options = {}) {
    const verifyTimeoutMs = options.verifyTimeoutMs || 15_000;
    const start = Date.now();

    while (Date.now() - start < verifyTimeoutMs) {
      const { article } = await anchorVisiblePost(page, visibleIndex, {
        limit: options.limit,
        scrollRounds: 0,
      });

      if (actionType === 'like') {
        const likeButton = article.getByRole('button', { name: /^like$/i }).first();
        const currentState = await readLikeState(likeButton);
        const changed = baseline.ariaPressed !== currentState.ariaPressed
          || baseline.ariaLabel !== currentState.ariaLabel
          || /\bliked\b|remove like/i.test(`${currentState.text} ${currentState.ariaLabel}`);
        if (changed) {
          return { ok: true, state: currentState };
        }
      }

      if (actionType === 'comment') {
        const snippet = String(baseline.commentSnippet || '').trim();
        if (!snippet) {
          return { ok: true };
        }

        const visibleText = (await article.innerText().catch(() => '')).replace(/\s+/g, ' ');
        if (visibleText.toLowerCase().includes(snippet.toLowerCase())) {
          return { ok: true };
        }

        const textbox = article.locator('div[role="textbox"][contenteditable="true"]').first();
        const currentTextboxText = await textbox.innerText().catch(() => '');
        if (!currentTextboxText.trim()) {
          return { ok: true };
        }
      }

      await page.waitForTimeout(800);
    }

    return { ok: false };
  }

  async function clickWithFallback(locator) {
    try {
      await locator.click({ delay: randomBetween(60, 180) });
    } catch (error) {
      if (/intercepts pointer events|another element/i.test(String(error.message || ''))) {
        await locator.click({ delay: randomBetween(60, 180), force: true });
        return;
      }
      throw error;
    }
  }

  async function typeWithRecovery(page, textbox, text, submitButton = null) {
    await textbox.click({ delay: randomBetween(60, 180) });
    await page.waitForTimeout(200);
    await page.keyboard.type(text, { delay: randomBetween(50, 150) });
    await page.waitForTimeout(500);

    if (submitButton && await submitButton.count()) {
      const disabled = await submitButton.getAttribute('aria-disabled').catch(() => null);
      if (disabled === 'true') {
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await textbox.click({ delay: randomBetween(60, 180) }).catch(() => null);
        await page.keyboard.press(`${modifier}+A`).catch(() => null);
        await page.keyboard.press('Backspace').catch(() => null);
        await page.waitForTimeout(200);
        await page.keyboard.type(text, { delay: randomBetween(50, 150) });
        await page.waitForTimeout(500);
      }
    }
  }

  async function likeAnchoredPost(page, visibleIndex, options = {}) {
    const { article } = await anchorVisiblePost(page, visibleIndex, options);
    const likeButton = article.getByRole('button', { name: /^like$/i }).first();
    if (!(await likeButton.count())) {
      throw new Error(`Like button not found for anchored post ${visibleIndex}.`);
    }

    await likeButton.waitFor({ state: 'visible', timeout: 10_000 });
    await likeButton.scrollIntoViewIfNeeded();
    const beforeState = await readLikeState(likeButton);
    await hoverAndRead(page, likeButton);
    await lightHumanPause(page, 800, 1_800);
    await clickWithFallback(likeButton);

    const verification = await verifyAnchoredAction(page, visibleIndex, 'like', beforeState, options);
    if (!verification.ok) {
      throw new Error(`Like did not appear to register for visible post ${visibleIndex}.`);
    }

    return true;
  }

  async function commentAnchoredPost(page, visibleIndex, text, options = {}) {
    const { article } = await anchorVisiblePost(page, visibleIndex, options);
    const commentTrigger = article.getByRole('button', { name: /comment|leave a comment|write a comment/i }).first();
    if (!(await commentTrigger.count())) {
      throw new Error(`Comment button not found for anchored post ${visibleIndex}.`);
    }

    await commentTrigger.waitFor({ state: 'visible', timeout: 10_000 });
    await commentTrigger.scrollIntoViewIfNeeded();
    await hoverAndRead(page, commentTrigger);
    await lightHumanPause(page, 900, 1_900);
    await clickWithFallback(commentTrigger);

    const textbox = article.locator('div[role="textbox"][contenteditable="true"]').first();
    await textbox.waitFor({ state: 'visible', timeout: 10_000 });
    const submitButton = article.getByRole('button', { name: /comment|reply|post/i }).last();
    await typeWithRecovery(page, textbox, text, submitButton);

    if (await submitButton.count()) {
      try {
        const disabled = await submitButton.getAttribute('aria-disabled');
        if (disabled !== 'true') {
          await clickWithFallback(submitButton);
        } else {
          await page.keyboard.press('Enter');
        }
      } catch (_error) {
        await page.keyboard.press('Enter');
      }
    } else {
      await page.keyboard.press('Enter');
    }

    const verification = await verifyAnchoredAction(page, visibleIndex, 'comment', {
      commentSnippet: String(text || '').trim().slice(0, 80),
    }, options);
    if (!verification.ok) {
      throw new Error(`Comment did not appear to post for visible post ${visibleIndex}.`);
    }

    return true;
  }

  return {
    anchorVisiblePost,
    commentAnchoredPost,
    extractAnchoredPostData,
    likeAnchoredPost,
    verifyAnchoredAction,
  };
}

module.exports = {
  createActionsApi,
};
