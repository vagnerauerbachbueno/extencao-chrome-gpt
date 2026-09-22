let running = false;
let bridgeConversationActive = false;
let turnsSinceReset = 0;

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
    '#prompt-textarea',
    'textarea[data-id="root"]',
    'div[id="prompt-textarea"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'textarea'
  ];

  const candidates = selectors
    .flatMap(selector => [...document.querySelectorAll(selector)])
    .filter(isVisible);

  return candidates[0] || null;
}

function setComposerValue(element, text) {
  console.log('[ChatGPT-Bridge Content] Inserindo texto no composer:', text.slice(0, 40) + '...');
  element.focus();

  if (element.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    setter?.call(element, text);
  } else {
    // Para div contenteditable (ProseMirror do ChatGPT)
    element.innerHTML = `<p>${text.replace(/\n/g, '<br>')}</p>`;
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
    'button[data-testid="send-button"]',
    'button[data-testid*="send"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="Enviar"]',
    'button[type="submit"]',
    'form button'
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

async function deleteCurrentConversation() {
  try {
    const url = window.location.href;
    const match = url.match(/\/c\/([a-zA-Z0-9-]+)/);
    const convId = match ? match[1] : null;

    if (convId) {
      console.log('[ChatGPT-Bridge] Ocultando conversa atual via API:', convId);
      await fetch(`https://chatgpt.com/backend-api/conversation/${convId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ is_visible: false })
      }).catch(() => {});
    }
  } catch (err) {
  } finally {
    // Apenas clica em novo chat para resetar a tela sem fechar modais indesejados
    await startNewConversation();
  }
}

async function startNewConversation() {
  const button = findNewChatButton();

  if (button) {
    button.click();
    await sleep(1000);
    return;
  }

  const home = [...document.querySelectorAll('a[href="/"]')].find(isVisible);
  if (home) {
    home.click();
    await sleep(1000);
    return;
  }

  // Fallback garantido se não achar o botão: reseta via URL caso não esteja na raiz
  if (window.location.pathname !== '/') {
    window.location.href = 'https://chatgpt.com/';
    await sleep(1500);
  }
}

function extractAssistantTurnElements() {
  const turns = [
    ...document.querySelectorAll('[data-message-author-role="assistant"]'),
    ...document.querySelectorAll('article:has([data-message-author-role="assistant"])')
  ].filter(isVisible);

  return turns;
}

function extractTextFromElement(el) {
  if (!el) return '';
  // Se houver um container markdown, pega o texto dele
  const markdown = el.querySelector('.markdown');
  if (markdown) {
    return (markdown.innerText || '').trim();
  }
  return (el.innerText || '').trim();
}

function extractMessages() {
  // Pega todos os turnos de resposta do assistente na tela
  const assistantNodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')].filter(isVisible);
  
  if (assistantNodes.length > 0) {
    return assistantNodes.map(extractTextFromElement).filter(Boolean);
  }

  // Fallback caso mude a estrutura interna
  const articles = [...document.querySelectorAll('article')].filter(isVisible);
  return articles.map(a => (a.innerText || '').trim()).filter(Boolean);
}

function sendDelta(taskId, content) {
  if (!content) return;

  chrome.runtime.sendMessage({
    type: 'task.delta',
    task_id: taskId,
    content
  }).catch(() => {});
}

function isGenerating() {
  const stopButton = document.querySelector('button[aria-label*="Stop"], button[data-testid*="stop"], button[aria-label*="Parar"]');
  return isVisible(stopButton);
}

async function waitForAssistantResponse(beforeCount, taskId, stream) {
  let stableText = '';
  let stableCount = 0;
  let lastSent = '';
  let startedGenerating = false;

  // Aguarda até 3 minutos no total
  for (let i = 0; i < 450; i++) {
    await sleep(stream ? 250 : 500);

    const messages = extractMessages();
    const newMessages = messages.slice(beforeCount);
    const latest = newMessages[newMessages.length - 1] || '';

    const generating = isGenerating();
    if (generating || latest.length > 0) {
      startedGenerating = true;
    }

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

    if (startedGenerating && latest && !generating) {
      const t = latest.trim();
      const looksCompleteJson = t.startsWith('{') && t.endsWith('}') && t.includes('tool_call');

      // JSON de tool_call completo → não espera mais
      if (looksCompleteJson && stableCount >= 1) {
        if (stream && latest.length > lastSent.length) sendDelta(taskId, latest.slice(lastSent.length));
        return latest;
      }

      // Texto normal: 2 checagens estáveis (~0,5s) já bastam
      if (stableCount >= 2) {
        if (stream && latest.length > lastSent.length) sendDelta(taskId, latest.slice(lastSent.length));
        return latest;
      }

      if (stableCount >= 1 && composer && (!sendButton || !sendButton.disabled)) {
        if (stream && latest.length > lastSent.length) sendDelta(taskId, latest.slice(lastSent.length));
        return latest;
      }
    }
  }

  throw new Error('Timeout waiting for ChatGPT response');
}

async function executeTask(message, newConversation, taskId, stream) {
  if (running) throw new Error('Browser agent is busy');
  running = true;

  try {
    const MAX_TURNS = 40;
    const needFresh = newConversation === true || !bridgeConversationActive || turnsSinceReset >= MAX_TURNS;

    if (needFresh) {
      // Limpa o chat anterior só quando realmente troca de conversa
      if (bridgeConversationActive) {
        await deleteCurrentConversation();
      } else {
        await startNewConversation();
      }
      bridgeConversationActive = true;
      turnsSinceReset = 0;
    }

    const beforeCount = extractMessages().length;
    const composer = findComposer();

    if (!composer) {
      throw new Error('ChatGPT composer not found. Verify chatgpt.com is loaded.');
    }

    setComposerValue(composer, message);
    await sleep(200);

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

    const response = await waitForAssistantResponse(beforeCount, taskId, stream);
    turnsSinceReset++;

    // Não deleta a cada mensagem — reaproveita a conversa
    return { ok: true, content: response };
  } finally {
    running = false;
  }
}

async function reportAuthOnce() {
  try {
    const res = await fetch('https://chatgpt.com/api/auth/session', {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { data = null; }
    const token = data?.accessToken || '';
    const account = data?.user?.id || data?.auth?.account_id || data?.account_id || '';
    const prev = await chrome.storage.local.get('chatgpt_access_token');
    await chrome.storage.local.set({
      chatgpt_access_token: token,
      chatgpt_account_id: account,
      chatgpt_auth_status: token ? 'ok' : (res.ok ? 'no_token' : `http_${res.status}`),
      chatgpt_auth_at: new Date().toISOString(),
      chatgpt_auth_preview: (raw || '').slice(0, 80)
    });
    if (token && token !== prev.chatgpt_access_token) {
      chrome.runtime.sendMessage({
        type: 'auth.chatgpt',
        access_token: token,
        account_id: account
      }).catch(() => {});
      console.log('[ChatGPT-Bridge Content] accessToken capturado', token.slice(0, 12) + '...');
    } else if (!token) {
      console.warn('[ChatGPT-Bridge Content] session sem accessToken', res.status, raw.slice(0, 120));
    }
  } catch (e) {
    console.warn('[ChatGPT-Bridge Content] falha ao capturar accessToken:', e?.message);
    chrome.storage.local.set({
      chatgpt_auth_status: 'error',
      chatgpt_auth_error: e?.message || String(e)
    }).catch(() => {});
  }
}

reportAuthOnce();
setTimeout(reportAuthOnce, 2000);
setInterval(reportAuthOnce, 5 * 60 * 1000);

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
