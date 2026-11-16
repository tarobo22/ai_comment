(() => {
  'use strict';

  const allowedOrigins = new Set(['http://localhost:5000', 'http://127.0.0.1:5000']);
  const actions = new Set(['ping', 'openVideo', 'readThreads', 'readReplies', 'prepareReply', 'checkReply', 'postReply', 'postComment']);

  if (window !== window.top || !allowedOrigins.has(location.origin) || location.pathname !== '/') return;

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'studio-bridge-progress') return false;
    window.postMessage({
      source: 'unmyeongwon-chrome', id: message.requestId, progress: message.progress
    }, location.origin);
    return false;
  });

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const request = event.data;
    if (request?.source !== 'unmyeongwon-studio' ||
        typeof request.id !== 'string' || request.id.length < 1 || request.id.length > 128 ||
        !actions.has(request.action)) return;

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'studio-bridge',
        id: request.id,
        action: request.action,
        payload: request.payload
      });
      if (typeof response?.ok !== 'boolean') throw new Error('Missing bridge response');
    } catch {
      const replyWork = ['prepareReply', 'checkReply', 'postReply', 'postComment'].includes(request.action);
      response = {
        ok: false,
        error: {
          code: replyWork ? 'extensionTimeout' : 'extensionUnavailable',
          message: replyWork
            ? '답글 작업 상태를 확인하지 못했습니다. YouTube 탭을 확인해 주세요.'
            : 'Chrome 확장 연결이 끊겼습니다. 이 페이지를 새로고침해 주세요.'
        }
      };
    }
    window.postMessage({ ...response, source: 'unmyeongwon-chrome', id: request.id }, location.origin);
  });
})();
