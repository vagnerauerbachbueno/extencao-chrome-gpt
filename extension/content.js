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

    console.log('[ChatGPT-Bridge] Tentando excluir conversa atual:', convId || 'pelo menu');

    // Se temos o ID da conversa na URL, podemos chamar a API interna autenticada do ChatGPT diretamente
    if (convId) {
      try {
        await fetch(`https://chatgpt.com/backend-api/conversation/${convId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ is_visible: false })
        });
        console.log('[ChatGPT-Bridge] ✅ Conversa ocultada/excluída via backend-api:', convId);
      } catch (err) {
        console.warn('[ChatGPT-Bridge] Falha ao excluir via API, tentando via interface:', err);
      }
    }

    // Procura o botão de opções da conversa ativa ou botão de excluir na interface
    const optionsButton = document.querySelector('nav button[data-testid*="options"], nav [aria-label*="Opções"], nav [aria-label*="Options"]');
    if (optionsButton && isVisible(optionsButton)) {
      optionsButton.click();
      await sleep(400);

      const deleteOption = [...document.querySelectorAll('[role="menuitem"], button')]
        .find(el => /Excluir|Delete/i.test(el.innerText || el.getAttribute('aria-label') || ''));

      if (deleteOption) {
        deleteOption.click();
        await sleep(400);

        const confirmBtn = [...document.querySelectorAll('button')]
          .find(el => el.classList.contains('btn-danger') || /Excluir|Delete|Confirm/i.test(el.innerText));

        if (confirmBtn) {
          confirmBtn.click();
          await sleep(600);
        }
      }
    }
  } catch (err) {
    console.error('[ChatGPT-Bridge] Erro ao tentar excluir conversa:', err);
  } finally {
    // Sempre limpa a tela e volta para um chat novo
    await startNewConversation();
  }
}

async function startNewConversation() {
  const button = findNewChatButton();

  if (button) {
    button.click();
    await sleep(800);
    return;
  }

  const home = [...document.querySelectorAll('a[href="/"]')].find(isVisible);

  if (home) {
    home.click();
    await sleep(800);
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

  for (let i = 0; i < 240; i++) {
    await sleep(stream ? 400 : 800);

    const messages = extractMessages();
    // Pega as mensagens geradas após a contagem anterior
    const newMessages = messages.slice(beforeCount);
    const latest = newMessages[newMessages.length - 1] || '';

    if (stream && latest.length > lastSent.length && latest.startsWith(lastSent)) {
      sendDelta(taskId, latest.slice(lastSent.length));
      lastSent = latest;
    }

    const generating = isGenerating();

    if (latest && latest === stableText) {
      stableCount++;
    } else {
      stableText = latest;
      stableCount = 0;
    }

    const composer = findComposer();
    const sendButton = findSendButton();

    // Se o botão de Stop sumiu e o texto estabilizou
    if (latest && !generating && stableCount >= 3) {
      // Garante enviar qualquer sobra de delta antes de fechar
      if (stream && latest.length > lastSent.length) {
        sendDelta(taskId, latest.slice(lastSent.length));
      }
      return latest;
    }

    // Fallback: botão de enviar habilitado de volta
    if (latest && !generating && stableCount >= 2 && composer && (!sendButton || !sendButton.disabled)) {
      if (stream && latest.length > lastSent.length) {
        sendDelta(taskId, latest.slice(lastSent.length));
      }
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

    const beforeCount = extractMessages().length;
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

    const response = await waitForAssistantResponse(beforeCount, taskId, stream);

    // Exclui a conversa para não acumular lixo no histórico do ChatGPT e reseta para nova aba limpa
    try {
      await deleteCurrentConversation();
    } catch (err) {
      console.warn('[ChatGPT-Bridge] Erro ao limpar conversa:', err);
    }

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
