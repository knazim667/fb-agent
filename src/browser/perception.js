'use strict';

function createPerceptionApi() {
  async function getSimplifiedDOM(page, options = {}) {
    const maxElements = options.maxElements || 120;
    const snapshot = await page.evaluate(({ maxElements }) => {
      const selectors = [
        'button',
        'a[href]',
        'input',
        'textarea',
        'select',
        '[role="button"]',
        '[role="link"]',
        '[role="textbox"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="option"]',
      ];

      const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
      const seen = new Set();
      const interactive = [];
      const idMap = new WeakMap();

      function isVisible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden'
          && style.display !== 'none'
          && rect.width > 0
          && rect.height > 0;
      }

      function getLabelText(element) {
        const ariaLabel = element.getAttribute('aria-label');
        if (ariaLabel) {
          return ariaLabel.trim();
        }

        const id = element.getAttribute('id');
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label?.innerText?.trim()) {
            return label.innerText.trim();
          }
        }

        const wrapped = element.closest('label');
        if (wrapped?.innerText?.trim()) {
          return wrapped.innerText.trim();
        }

        const container = element.closest('div, form, fieldset');
        const texts = Array.from(container?.querySelectorAll('label, legend, span, div[dir="auto"]') || [])
          .map((node) => node.innerText?.trim())
          .filter(Boolean);
        return texts[0] || '';
      }

      for (const element of nodes) {
        if (!isVisible(element)) {
          continue;
        }

        const rect = element.getBoundingClientRect();
        const tag = element.tagName.toLowerCase();
        const role = element.getAttribute('role') || '';
        const type = element.getAttribute('type') || '';
        const text = (element.innerText || element.value || '').trim().replace(/\s+/g, ' ');
        const label = getLabelText(element).replace(/\s+/g, ' ');
        const href = element.getAttribute('href') || '';
        const key = [
          tag,
          role,
          type,
          text.slice(0, 80),
          label.slice(0, 80),
          href.slice(0, 120),
          Math.round(rect.top),
          Math.round(rect.left),
        ].join('::');

        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        const agentId = `agent-${interactive.length + 1}`;
        element.setAttribute('data-agent-id', agentId);
        idMap.set(element, agentId);
        interactive.push({
          agent_id: agentId,
          tag,
          role,
          type,
          text,
          label,
          href,
          placeholder: element.getAttribute('placeholder') || '',
          checked: element.checked === true || element.getAttribute('aria-checked') === 'true',
          disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left),
          y: Math.round(rect.top),
        });

        if (interactive.length >= maxElements) {
          break;
        }
      }

      const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      const title = document.title || '';
      const posts = [];
      const articles = Array.from(document.querySelectorAll('div[role="article"]')).slice(0, 25);

      function extractPrimaryPostText(article) {
        function looksLikeUiChrome(text) {
          return /^(like|reply|share|follow|see more|write a comment|leave a comment|comment)$/i.test(text);
        }

        function looksLikeCommentSnippet(text) {
          return /\b(i'?m interested|interested|dm me|inbox me|sent you a message)\b/i.test(text)
            && /\b(like|reply)\b/i.test(text);
        }

        const articleRect = article.getBoundingClientRect();
        const maxTop = articleRect.top + (articleRect.height * 0.58);
        const nodes = Array.from(article.querySelectorAll('div[dir="auto"], span[dir="auto"], [data-ad-preview="message"]'));
        const chunks = [];
        const seen = new Set();

        for (const node of nodes) {
          if (!isVisible(node)) {
            continue;
          }
          if (node.closest('form, [role="textbox"], [aria-label*="Comment"]')) {
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

        return chunks.join('\n').trim();
      }

      for (const article of articles) {
        if (!isVisible(article)) {
          continue;
        }

        const rect = article.getBoundingClientRect();
        const articleId = idMap.get(article) || `agent-post-${posts.length + 1}`;
        article.setAttribute('data-agent-id', articleId);
        const text = extractPrimaryPostText(article) || (article.innerText || '').trim().replace(/\s+/g, ' ');
        if (!text || text.length < 15) {
          continue;
        }

        if (/\b(i'?m interested|interested|dm me|inbox me)\b/i.test(text) && text.length < 120) {
          continue;
        }

        const authorNode = article.querySelector('h2 a, h3 a, strong span a');
        const author = (authorNode?.innerText || '').trim();
        const likeButton = Array.from(article.querySelectorAll('button,[role="button"]'))
          .find((node) => /like/i.test((node.innerText || node.getAttribute('aria-label') || '').trim()));
        const commentButton = Array.from(article.querySelectorAll('button,[role="button"],div[role="textbox"]'))
          .find((node) => /comment|leave a comment|write a comment/i.test((node.innerText || node.getAttribute('aria-label') || '').trim()));
        const postLink = Array.from(article.querySelectorAll('a[href]'))
          .find((node) => /\/posts\/|story_fbid=|\/permalink\//i.test(node.getAttribute('href') || ''));

        if (likeButton && !idMap.get(likeButton)) {
          const newId = `agent-${interactive.length + 1}`;
          likeButton.setAttribute('data-agent-id', newId);
          idMap.set(likeButton, newId);
          interactive.push({
            agent_id: newId,
            tag: likeButton.tagName.toLowerCase(),
            role: likeButton.getAttribute('role') || '',
            type: likeButton.getAttribute('type') || '',
            text: (likeButton.innerText || '').trim().replace(/\s+/g, ' '),
            label: (likeButton.getAttribute('aria-label') || '').trim(),
            href: '',
            placeholder: '',
            checked: likeButton.getAttribute('aria-checked') === 'true',
            disabled: likeButton.disabled === true || likeButton.getAttribute('aria-disabled') === 'true',
            x: Math.round((likeButton.getBoundingClientRect() || rect).left),
            y: Math.round((likeButton.getBoundingClientRect() || rect).top),
          });
        }

        if (commentButton && !idMap.get(commentButton)) {
          const newId = `agent-${interactive.length + 1}`;
          commentButton.setAttribute('data-agent-id', newId);
          idMap.set(commentButton, newId);
          interactive.push({
            agent_id: newId,
            tag: commentButton.tagName.toLowerCase(),
            role: commentButton.getAttribute('role') || '',
            type: commentButton.getAttribute('type') || '',
            text: (commentButton.innerText || '').trim().replace(/\s+/g, ' '),
            label: (commentButton.getAttribute('aria-label') || '').trim(),
            href: '',
            placeholder: commentButton.getAttribute('placeholder') || '',
            checked: commentButton.getAttribute('aria-checked') === 'true',
            disabled: commentButton.disabled === true || commentButton.getAttribute('aria-disabled') === 'true',
            x: Math.round((commentButton.getBoundingClientRect() || rect).left),
            y: Math.round((commentButton.getBoundingClientRect() || rect).top),
          });
        }

        posts.push({
          agent_id: articleId,
          author,
          text: text.slice(0, 3000),
          like_button_id: likeButton ? idMap.get(likeButton) || likeButton.getAttribute('data-agent-id') || '' : '',
          comment_button_id: commentButton ? idMap.get(commentButton) || commentButton.getAttribute('data-agent-id') || '' : '',
          post_url: postLink ? postLink.getAttribute('href') || '' : '',
          x: Math.round(rect.left),
          y: Math.round(rect.top),
        });
      }

      return {
        url: window.location.href,
        title,
        body_excerpt: bodyText.slice(0, 1200),
        interactive,
        posts,
      };
    }, { maxElements });

    return snapshot;
  }

  function classifyPageState(snapshot = {}) {
    const url = String(snapshot.url || '').toLowerCase();
    const body = String(snapshot.body_excerpt || '').toLowerCase();
    const interactive = Array.isArray(snapshot.interactive) ? snapshot.interactive : [];
    const joinText = interactive.map((item) => `${item.text} ${item.label}`.toLowerCase()).join(' ');

    if (/checkpoint|login/.test(url) || /security code|6-digit code|checkpoint/.test(body)) {
      return 'login_or_checkpoint';
    }

    if (/sorry, something went wrong|this page isn'?t available|content isn'?t available/.test(body)) {
      return 'error_page';
    }

    if (interactive.some((item) => /join group|pending|requested/i.test(`${item.text} ${item.label}`)) && /dialog/.test(body + ' ' + joinText)) {
      return 'join_modal';
    }

    if (/\/notifications/.test(url)) {
      return 'notifications';
    }

    if (/\/messages/.test(url)) {
      return 'inbox';
    }

    if (/\/groups\//.test(url)) {
      return 'group_page';
    }

    if (/write something|what's on your mind|create post/.test(joinText)) {
      return 'composer';
    }

    return 'generic_page';
  }

  async function executeAgentAction(page, action = {}) {
    const { action: actionType, id, value } = action;

    if (actionType === 'complete') {
      return { ok: true, done: true };
    }

    if (actionType === 'wait') {
      const waitMs = Math.max(500, Math.min(Number(value) || 1500, 10_000));
      await page.waitForTimeout(waitMs);
      return { ok: true, waited: waitMs };
    }

    if (actionType === 'scroll') {
      await page.evaluate((scrollValue) => {
        window.scrollBy(0, Number(scrollValue) || 600);
      }, value || 600);
      await page.waitForTimeout(1000);
      return { ok: true, scrolled: Number(value) || 600 };
    }

    if (!id) {
      throw new Error('Agent action is missing an element id.');
    }

    const locator = page.locator(`[data-agent-id="${id}"]`).first();
    if (!(await locator.count())) {
      throw new Error(`Element ${id} is not present in the latest snapshot.`);
    }

    await locator.scrollIntoViewIfNeeded();
    await locator.waitFor({ state: 'visible', timeout: 10_000 });

    if (actionType === 'click') {
      try {
        await locator.click({ delay: 90 });
      } catch (error) {
        if (/intercepts pointer events|another element/i.test(String(error.message || ''))) {
          await locator.click({ delay: 90, force: true });
        } else {
          throw error;
        }
      }
      return { ok: true, clicked: id };
    }

    if (actionType === 'type') {
      const tag = await locator.evaluate((element) => element.tagName.toLowerCase());
      if (tag === 'input' || tag === 'textarea') {
        await locator.fill('');
        await locator.type(String(value || ''), { delay: 90 });
      } else {
        await locator.click({ delay: 90 });
        await page.keyboard.type(String(value || ''), { delay: 90 });
      }
      return { ok: true, typed: id };
    }

    if (actionType === 'check') {
      const checked = await locator.getAttribute('aria-checked').catch(() => null);
      if (checked !== 'true') {
        try {
          await locator.click({ delay: 90 });
        } catch (error) {
          if (/intercepts pointer events|another element/i.test(String(error.message || ''))) {
            await locator.click({ delay: 90, force: true });
          } else {
            throw error;
          }
        }
      }
      return { ok: true, checked: id };
    }

    throw new Error(`Unsupported agent action: ${actionType}`);
  }

  return {
    classifyPageState,
    executeAgentAction,
    getSimplifiedDOM,
  };
}

module.exports = {
  createPerceptionApi,
};
