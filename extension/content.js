let running = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 &&
    s.visibility !== 'hidden' && s.display !== 'none';
}

function findComposer() {
  const selectors = [
    'textarea',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]'
  ];

  const candidates = selectors
    .flatMap(selector => [...document.querySelectorAll(selector)])
    .filter(isVisible);

  return candidates[candidates.length - 1] || null;
}

function setComposerValue(element, text) {
  element.focus();

  if (element.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;

    setter?.call(element, text);
  } else {
    element.textContent = text;
  }

  element.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    inputType: 'insertText',
    data: text
  }));

  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function findSendButton() {
  const selectors = [
    'button[data-testid*="send"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="Enviar"]',
    'button[type="submit"]'
  ];

  return selectors
    .flatMap(s => [...document.querySelectorAll(s)])
    .find(isVisible) || null;
}

function findNewChatButton() {
  const selectors = [
    'a[href="/"]',
    'button[aria-label*="New chat"]',
    'button[aria-label*="Nova conversa"]',
    'a[aria-label*="New chat"]'
  ];

  return selectors
    .flatMap(s => [...document.querySelectorAll(s)])
    .find(isVisible) || null;
}

async function startNewConversation() {
  const button = findNewChatButton();

  if (button) {
    button.click();
    await sleep(1200);
    return;
  }

  const home = [...document.querySelectorAll('a[href="/"]')].find(isVisible);

  if (home) {
    home.click();
    await sleep(1200);
  }
}

function extractMessages() {
  const selectors = [
    '[data-message-author-role="assistant"]',
    '[data-message-author-role="assistant"] .markdown',
    'article'
  ];

  const nodes = selectors
    .flatMap(s => [...document.querySelectorAll(s)])
    .filter(isVisible);

  const texts = nodes
    .map(n => (n.innerText || '').trim())
    .filter(Boolean);

  return [...new Set(texts)];
}

function sendDelta(taskId, content) {
  if (!content) return;

  chrome.runtime.sendMessage({
    type: 'task.delta',
    task_id: taskId,
    content
  }).catch(() => {});
}

async function waitForAssistantResponse(before, taskId, stream) {
  let stableText = '';
  let stableCount = 0;
  let lastSent = '';

  for (let i = 0; i < 180; i++) {
    await sleep(stream ? 500 : 1000);

    const messages = extractMessages();
    const candidates = messages.filter(x => !before.includes(x));
    const latest = candidates[candidates.length - 1] || '';

    if (stream && latest.length > lastSent.length && latest.startsWith(lastSent)) {
      sendDelta(taskId, latest.slice(lastSent.length));
      lastSent = latest;
    }

    if (latest && latest === stableText) {
      stableCount++;
    } else {
      stableText = latest;
      stableCount = 0;
    }

    const composer = findComposer();
    const sendButton = findSendButton();

    if (latest && stableCount >= 2 && composer && (!sendButton || !sendButton.disabled)) {
      return latest;
    }

    if (latest && stableCount >= 3) {
      return latest;
    }
  }

  throw new Error('Timeout waiting for ChatGPT response');
}

async function executeTask(message, newConversation, taskId, stream) {
  if (running) throw new Error('Browser agent is busy');
  running = true;

  try {
    if (newConversation) {
      await startNewConversation();
    }

    const before = extractMessages();
    const composer = findComposer();

    if (!composer) {
      throw new Error('ChatGPT composer not found. Verify chatgpt.com is loaded.');
    }

    setComposerValue(composer, message);
    await sleep(300);

    const send = findSendButton();

    if (send) {
      send.click();
    } else {
      composer.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true
      }));
    }

    const response = await waitForAssistantResponse(before, taskId, stream);
    return { ok: true, content: response };
  } finally {
    running = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'execute_task') return;

  executeTask(
    message.message,
    message.new_conversation,
    message.task_id,
    message.stream === true
  )
    .then(sendResponse)
    .catch(error => sendResponse({
      ok: false,
      error: error.message
    }));

  return true;
});
