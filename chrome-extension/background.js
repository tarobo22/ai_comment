'use strict';

const localOrigins = new Set(['http://localhost:5000', 'http://127.0.0.1:5000']);
const youtubeHosts = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const videoPattern = /^[A-Za-z0-9_-]{11}$/;
const identifierPattern = /^[A-Za-z0-9._-]{1,256}$/;
const publishActions = new Set(['postReply', 'postComment']);
const actions = new Set(['ping', 'openVideo', 'readThreads', 'readReplies', 'prepareReply', 'checkReply', ...publishActions]);
const opening = new Map();
const publishing = new Map();

function problem(code, message) {
  return Object.assign(new Error(message), { code });
}

function allowedSender(sender) {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) return false;
  try {
    const url = new URL(sender.url);
    return localOrigins.has(url.origin) && url.pathname === '/' &&
      (!sender.origin || sender.origin === url.origin);
  } catch {
    return false;
  }
}

function videoIdFromLink(value) {
  let url;
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input || input.length > 2048) {
    throw problem('invalidVideoUrl', '올바른 YouTube 영상 링크를 입력해 주세요.');
  }
  try {
    url = new URL(input.includes('://') ? input : `https://${input}`);
  } catch {
    throw problem('invalidVideoUrl', '올바른 YouTube 영상 링크를 입력해 주세요.');
  }
  if (!youtubeHosts.has(url.hostname) || !['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password || url.port) {
    throw problem('invalidVideoUrl', '올바른 YouTube 영상 링크를 입력해 주세요.');
  }

  let id;
  if (url.hostname === 'youtu.be') {
    id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v');
  } else {
    id = /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  }
  if (typeof id !== 'string' || !videoPattern.test(id)) {
    throw problem('invalidVideoUrl', '동영상 ID가 포함된 YouTube 링크를 입력해 주세요.');
  }
  return id;
}

function validatePayload(action, input) {
  if (action === 'openVideo') return { videoId: videoIdFromLink(input?.url) };
  if (typeof input?.videoId !== 'string' || !videoPattern.test(input.videoId)) {
    throw problem('invalidVideoId', '영상 링크를 다시 불러와 주세요.');
  }
  const payload = { videoId: input.videoId };
  if (action === 'readThreads') return { ...payload, more: input.more === true };

  if (action !== 'postComment') {
    if (typeof input.parentId !== 'string' || !identifierPattern.test(input.parentId)) {
      throw problem('invalidCommentId', '원댓글을 다시 선택해 주세요.');
    }
    payload.parentId = input.parentId;
  }
  if (action === 'readReplies') return payload;

  if (typeof input.recordId !== 'string' || !identifierPattern.test(input.recordId)) {
    throw problem('invalidRecordId', '답글 작업 기록을 찾을 수 없습니다.');
  }
  payload.recordId = input.recordId;
  if (action === 'prepareReply' || publishActions.has(action)) {
    if (typeof input.text !== 'string' || input.text.length > 1024 || !input.text.trim()) {
      throw problem('invalidReplyText', '답글 내용을 확인해 주세요.');
    }
    payload.text = input.text;
  }
  return payload;
}

function exactWatch(urlValue, videoId) {
  try {
    const url = new URL(urlValue);
    return url.origin === 'https://www.youtube.com' && url.pathname === '/watch' &&
      url.searchParams.get('v') === videoId;
  } catch {
    return false;
  }
}

function watchTabMatches(tab, videoId) {
  return exactWatch(tab?.url, videoId) && (!tab.pendingUrl || exactWatch(tab.pendingUrl, videoId));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(operation, milliseconds) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(problem('extensionTimeout', 'Chrome 응답을 확인하지 못했습니다. YouTube 탭을 확인해 주세요.')), milliseconds);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

const tabKey = (appTabId, videoId) => `watch:${appTabId}:${videoId}`;

async function getTab(tabId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function findWatchTab(key, videoId) {
  const saved = await chrome.storage.session.get(key);
  const tab = await getTab(saved[key]);
  return watchTabMatches(tab, videoId) ? tab : null;
}

async function openWatchTab(sender, key, videoId) {
  const existing = opening.get(key);
  if (existing) return existing;
  const open = (async () => {
    const current = await findWatchTab(key, videoId);
    if (current) return current;
    const tab = await chrome.tabs.create({
      windowId: sender.tab.windowId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      active: false
    });
    await chrome.storage.session.set({ [key]: tab.id });
    return tab;
  })();
  opening.set(key, open);
  try {
    return await open;
  } finally {
    opening.delete(key);
  }
}

async function sendToYouTube(tabId, action, payload) {
  const publish = publishActions.has(action);
  const allowStartupWait = action === 'openVideo' || publish;
  const deadline = Date.now() + (allowStartupWait ? 12000 : 0);
  while (true) {
    const tab = await getTab(tabId);
    if (!tab) throw problem('videoTabUnavailable', '연결된 YouTube 탭이 닫혔습니다. 영상 링크를 다시 불러와 주세요.');
    if (!watchTabMatches(tab, payload.videoId)) {
      if (!allowStartupWait || Date.now() >= deadline) {
        throw problem('videoTabUnavailable', 'YouTube 탭이 선택한 영상으로 열리지 않았습니다. 탭을 확인해 주세요.');
      }
      await wait(250);
      continue;
    }
    try {
      const milliseconds = publish ? 30000 : action === 'checkReply' ? 4500 : action === 'openVideo' ? 26000 : 19000;
      const response = await withTimeout(
        chrome.tabs.sendMessage(tabId, { type: 'studio-youtube', action, payload }, { frameId: 0 }),
        milliseconds
      );
      if (response?.ok === true) return response;
      if (response?.ok === false) return response;
      throw problem('extensionTimeout', 'YouTube에서 작업 결과를 받지 못했습니다. 해당 탭을 확인해 주세요.');
    } catch (error) {
      if (error.code === 'extensionTimeout') throw error;
      const receiverMissing = String(error.message).includes('Receiving end does not exist');
      if (allowStartupWait && receiverMissing && Date.now() < deadline) {
        await wait(250);
        continue;
      }
      if (receiverMissing) {
        throw problem('videoTabUnavailable', 'YouTube 탭에 연결할 수 없습니다. 영상 링크를 다시 불러와 주세요.');
      }
      throw problem('extensionTimeout', 'YouTube 작업 결과를 확인하지 못했습니다. 해당 탭을 확인해 주세요.');
    }
  }
}

function publishProgress(appTabId, requestId, progress) {
  return chrome.tabs.sendMessage(appTabId, { type: 'studio-bridge-progress', requestId, progress }, { frameId: 0 })
    .catch(() => {});
}

async function publishThroughWatchTab(sender, request, payload) {
  const storageKey = 'publish:' + payload.recordId;
  if (publishing.size) throw problem('profileBusy', '이 Chrome 프로필에서 진행 중인 게시가 끝난 뒤 다시 시도해 주세요.');
  const job = { appTabId: sender.tab.id, requestId: request.id, watchTabId: null };
  publishing.set(payload.recordId, job);
  try {
    const previous = (await chrome.storage.session.get(storageKey))[storageKey];
    if (previous) {
      return previous !== 'started' ? previous : {
        ok: true, result: { status: 'uncertain', message: '같은 게시 요청의 이전 결과를 YouTube에서 확인해 주세요.' }
      };
    }
    await chrome.storage.session.set({ [storageKey]: 'started' });
    void publishProgress(job.appTabId, job.requestId, 'opening');
    const url = new URL('https://www.youtube.com/watch');
    url.searchParams.set('v', payload.videoId);
    if (payload.parentId) url.searchParams.set('lc', payload.parentId);
    let tab;
    try {
      tab = await chrome.tabs.create({ windowId: sender.tab.windowId, url: url.href, active: true });
    } catch {
      throw problem('profileOpenFailed', '현재 Chrome 프로필에서 YouTube 탭을 열지 못했습니다.');
    }
    job.watchTabId = tab.id;
    const result = await sendToYouTube(tab.id, request.action, payload);
    try {
      await chrome.storage.session.set({ [storageKey]: result });
    } catch {
      // The saved start marker still stops a duplicate submission.
    }
    return result;
  } finally {
    publishing.delete(payload.recordId);
  }
}

async function handle(request, sender) {
  if (!allowedSender(sender)) throw problem('invalidOrigin', '댓글 스튜디오 페이지에서 다시 시도해 주세요.');
  if (!actions.has(request.action)) throw problem('invalidAction', '지원하지 않는 Chrome 연결 요청입니다.');
  if (request.action === 'ping') return { ok: true, result: { connected: true } };

  const payload = validatePayload(request.action, request.payload);
  if (publishActions.has(request.action)) {
    if (typeof request.id !== 'string' || request.id.length < 1 || request.id.length > 128) {
      throw problem('invalidRecordId', '게시 진행 상태를 받을 화면 요청을 확인할 수 없습니다.');
    }
    return publishThroughWatchTab(sender, request, payload);
  }
  const key = tabKey(sender.tab.id, payload.videoId);
  const tab = request.action === 'openVideo'
    ? await openWatchTab(sender, key, payload.videoId)
    : await findWatchTab(key, payload.videoId);
  if (!tab) {
    throw problem('videoTabUnavailable', '선택한 영상의 YouTube 탭을 찾을 수 없습니다. 영상 링크를 다시 불러와 주세요.');
  }
  if (request.action === 'prepareReply') {
    await chrome.tabs.update(tab.id, { active: true });
  }
  return sendToYouTube(tab.id, request.action, payload);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.type === 'studio-youtube-progress') {
    const job = publishing.get(request.recordId);
    if (job && sender.id === chrome.runtime.id && sender.frameId === 0 &&
        sender.tab?.id === job.watchTabId && ['typing', 'verifying'].includes(request.progress)) {
      void publishProgress(job.appTabId, job.requestId, request.progress);
    }
    return false;
  }
  if (request?.type !== 'studio-bridge') return false;
  handle(request, sender).then(sendResponse, (error) => {
    const code = typeof error.code === 'string' ? error.code : 'extensionUnavailable';
    const message = typeof error.code === 'string' ? error.message : 'Chrome에서 작업을 완료하지 못했습니다. 해당 탭을 확인해 주세요.';
    sendResponse({ ok: false, error: { code, message } });
  });
  return true;
});

chrome.tabs.onRemoved.addListener(async (closedId) => {
  try {
    const values = await chrome.storage.session.get(null);
    const prefix = `watch:${closedId}:`;
    const keys = Object.keys(values).filter((key) =>
      key.startsWith('watch:') && (key.startsWith(prefix) || values[key] === closedId)
    );
    if (keys.length) await chrome.storage.session.remove(keys);
  } catch {
    // A stale mapping is checked again before it can be used.
  }
});
