(() => {
  'use strict';

  const youtubeOrigin = 'https://www.youtube.com';
  const videoPattern = /^[A-Za-z0-9_-]{11}$/;
  const commentPattern = /^[A-Za-z0-9._-]{1,256}$/;
  const recordPattern = /^[A-Za-z0-9_-]{8,128}$/;
  const commentsSelector = 'ytd-comments, yt-comments-view-model';
  const threadSelector = 'ytd-comment-thread-renderer, yt-comment-thread-view-model, ytd-comment-thread-view-model';
  const commentSelector = 'ytd-comment-view-model, ytd-comment-renderer, yt-comment-view-model';
  const repliesSelector = 'ytd-comment-replies-renderer, yt-comment-replies-view-model';
  const buttonSelector = 'button, [role="button"], tp-yt-paper-button';
  const composerSelector = 'ytd-comment-reply-dialog-renderer, ytd-comment-simplebox-renderer, yt-comment-composer-view-model, #reply-dialog';
  const submitSelector = '#submit-button, #submit-button-end';
  const cancelSelector = '#cancel-button, #cancel-button-end';
  const imageHosts = new Set(['i.ytimg.com', 'i9.ytimg.com', 'img.youtube.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com', 'lh3.googleusercontent.com']);
  const PAGE_WAIT = 10_000;
  const POST_WAIT = 30_000;
  let tracking = null;

  function fail(code, message) {
    throw Object.assign(new Error(message), { code });
  }

  function isId(value, pattern) {
    return typeof value === 'string' && pattern.test(value);
  }

  function currentVideo(videoId) {
    if (!isId(videoId, videoPattern) || location.origin !== youtubeOrigin
      || location.pathname !== '/watch' || new URLSearchParams(location.search).get('v') !== videoId) return false;
    const player = document.querySelector('ytd-watch-flexy[video-id]');
    return !player || player.getAttribute('video-id') === videoId;
  }

  function requireVideo(videoId) {
    if (!currentVideo(videoId)) fail('videoChanged', 'YouTube 탭의 영상이 바뀌었습니다. 영상을 다시 불러와 주세요.');
  }

  function visible(element) {
    return Boolean(element?.isConnected && !element.closest('[hidden], [aria-hidden="true"]')
      && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  }

  function plain(value) {
    return String(value ?? '').replace(/\r\n?/g, '\n').normalize('NFC').trim();
  }

  function renderedText(element) {
    return plain(element?.innerText ?? element?.textContent);
  }

  async function waitFor(get, timeout = PAGE_WAIT) {
    const deadline = Date.now() + timeout;
    do {
      const value = get();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 160));
    } while (Date.now() < deadline);
    return null;
  }

  function safeImage(value) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && !url.port && !url.username && !url.password && imageHosts.has(url.hostname)) return url.href;
    } catch {
      // The page may not expose an image URL.
    }
    return null;
  }

  function absoluteDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value ?? '')) return null;
    const date = new Date(value);
    return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
  }

  function readVideo(videoId) {
    const titleElement = document.querySelector('ytd-watch-metadata h1 yt-formatted-string, ytd-watch-metadata h1, ytd-video-primary-info-renderer h1');
    const title = renderedText(titleElement) || plain(document.querySelector('meta[property="og:title"]')?.content);
    if (!title || title === 'YouTube') return null;
    const channel = document.querySelector('ytd-watch-metadata #channel-name a, ytd-video-owner-renderer #channel-name a, ytd-watch-metadata #owner #channel-name');
    const description = document.querySelector('meta[property="og:description"], meta[name="description"]')?.content;
    const published = document.querySelector('meta[itemprop="datePublished"], meta[itemprop="uploadDate"]')?.content;
    const thumbnail = document.querySelector('meta[property="og:image"], link[itemprop="thumbnailUrl"]');
    return {
      id: videoId,
      title: title.slice(0, 500),
      description: plain(description).slice(0, 5000),
      channelTitle: renderedText(channel).slice(0, 200),
      publishedAt: absoluteDate(published),
      thumbnailUrl: safeImage(thumbnail?.content ?? thumbnail?.href),
      watchUrl: youtubeOrigin + '/watch?v=' + videoId,
      embeddable: false,
    };
  }

  function commentsRoot() {
    return document.querySelector(commentsSelector);
  }

  function originalNode(thread) {
    return [...thread.querySelectorAll(commentSelector)].find((node) =>
      node.closest(threadSelector) === thread && !node.closest(repliesSelector));
  }

  function owned(node, selector) {
    return [...node.querySelectorAll(selector)].filter((element) => element.closest(commentSelector) === node);
  }

  function permalink(node, videoId) {
    const links = owned(node, '#published-time-text a[href], a#published-time-text[href], time a[href]');
    for (const link of links) {
      try {
        const url = new URL(link.getAttribute('href'), location.href);
        const id = url.searchParams.get('lc');
        if (url.origin === youtubeOrigin && url.pathname === '/watch'
          && url.searchParams.get('v') === videoId && isId(id, commentPattern)) return id;
      } catch {
        // Ignore invalid links in rendered comments.
      }
    }
    for (const attribute of ['data-comment-id', 'comment-id']) {
      const id = node.getAttribute(attribute);
      if (isId(id, commentPattern)) return id;
    }
    return null;
  }

  function publishedElement(node) {
    return owned(node, '#published-time-text, time[datetime]')[0];
  }

  function count(value) {
    const match = value?.match(/([0-9]+(?:[,.][0-9]+)*)\s*([KkMm]|천|만)?/);
    if (!match) return 0;
    const scale = { k: 1000, m: 1_000_000, 천: 1000, 만: 10_000 }[match[2]?.toLowerCase()] ?? 1;
    return Math.max(0, Math.floor(Number(match[1].replace(/,/g, '')) * scale) || 0);
  }

  function readComment(node, videoId) {
    const id = permalink(node, videoId);
    const text = renderedText(owned(node, '#content-text, yt-attributed-string#content-text, #comment-content')[0]);
    if (!id || !text) return null;
    const author = owned(node, '#author-text, #author-name, #header-author a[href^="/@"]')[0];
    const avatar = owned(node, '#author-thumbnail img, #author-thumbnail-end img, #author-thumbnail img.yt-core-image')[0];
    const published = publishedElement(node);
    const likes = owned(node, '#vote-count-middle, #like-count')[0];
    return {
      id,
      author: (renderedText(author) || 'YouTube 사용자').slice(0, 200),
      avatarUrl: safeImage(avatar?.currentSrc || avatar?.src),
      text: text.slice(0, 10000),
      publishedAt: absoluteDate(published?.getAttribute('datetime') || published?.querySelector('time')?.dateTime),
      likeCount: count(renderedText(likes)),
    };
  }

  function enabled(button) {
    return visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  }

  function replyButton(node, requireVisible = true) {
    const buttons = owned(node, buttonSelector).filter((button) => requireVisible
      ? enabled(button)
      : !button.disabled && button.getAttribute('aria-disabled') !== 'true');
    return buttons.find((button) => !button.closest(composerSelector)
      && (button.closest('#reply-button-end, #reply-button') || /^(?:답글|답글 달기|reply)(?:\s+to\b.*)?$/i.test(
        plain(button.getAttribute('aria-label') || renderedText(button)),
      )));
  }

  function replyNodes(thread, publicOnly = false) {
    const replies = thread.querySelector(repliesSelector);
    if (!replies) return [];
    return [...replies.querySelectorAll(commentSelector)].filter((node) => {
      if (!visible(node) || node.parentElement?.closest(commentSelector)) return false;
      const owner = node.closest(threadSelector);
      if (owner === thread) return true;
      // The public layout can wrap each reply in its own nested thread.
      return publicOnly && owner?.parentElement?.closest(threadSelector) === thread
        && node.closest(repliesSelector) === replies;
    });
  }

  function replyList(thread, videoId, parentId, publicOnly = false) {
    return replyNodes(thread, publicOnly).map((node) => {
      const reply = readComment(node, videoId);
      return reply ? { ...reply, parentId } : null;
    }).filter(Boolean);
  }

  function expandRepliesButton(thread, publicOnly = false) {
    const replies = thread.querySelector(repliesSelector);
    if (!replies) return null;
    return [...replies.querySelectorAll(buttonSelector)].find((button) =>
      enabled(button) && !button.closest(commentSelector)
      && (!publicOnly || button.closest(repliesSelector) === replies)
      && (button.closest('#more-replies')
        || (publicOnly && button.closest('#more-replies-sub-thread'))
        || (button.closest('#expander') && button.getAttribute('aria-expanded') === 'false')));
  }

  function threadRoots(root) {
    return [...root.querySelectorAll(threadSelector)].filter((thread) => visible(thread)
      && !thread.parentElement?.closest(threadSelector));
  }

  function readThread(thread, videoId, publicOnly = false) {
    const node = originalNode(thread);
    const comment = node && readComment(node, videoId);
    if (!comment) return null;
    const expansion = expandRepliesButton(thread, publicOnly);
    return {
      ...comment,
      parentId: comment.id,
      canReply: Boolean(replyButton(node, !publicOnly)),
      replyCount: Math.max(replyNodes(thread, publicOnly).length, count(renderedText(expansion)), expansion ? 1 : 0),
    };
  }

  function findThread(videoId, parentId) {
    if (!isId(parentId, commentPattern)) return null;
    const root = commentsRoot();
    if (!root) return null;
    const matches = threadRoots(root).filter((thread) => {
      const node = originalNode(thread);
      return node && permalink(node, videoId) === parentId;
    });
    return matches.length === 1 ? matches[0] : null;
  }

  function unavailable(root) {
    const message = renderedText(root?.querySelector('#message, ytd-message-renderer, #message-text'));
    return /댓글.{0,12}(?:사용 중지|꺼져|비활성)|comments?.{0,16}(?:turned off|disabled|unavailable)/i.test(message);
  }

  function continuation(root) {
    return [...root.querySelectorAll('ytd-continuation-item-renderer')].find((node) =>
      !node.closest(threadSelector) && visible(node));
  }

  async function getThreads({ videoId, more = false, publicOnly = false }) {
    if (!isId(videoId, videoPattern)) fail('invalidVideo', '올바른 YouTube 영상이 필요합니다.');
    const video = await waitFor(() => currentVideo(videoId) && readVideo(videoId));
    if (!video) fail('videoUnavailable', '선택한 YouTube 영상을 확인하지 못했습니다. Chrome에서 영상이 열렸는지 확인해 주세요.');
    const root = await waitFor(() => currentVideo(videoId) && commentsRoot(), 4500);
    requireVideo(videoId);
    if (!root) return { video, threads: [], nextPageToken: null, commentsUnavailable: '이 영상의 댓글 영역을 찾을 수 없습니다.' };

    const initial = threadRoots(root).length;
    if (more || initial === 0 || (publicOnly && continuation(root) && initial < 2)) {
      const target = more ? continuation(root) || threadRoots(root).at(-1) : root;
      target?.scrollIntoView({ block: 'start', behavior: 'instant' });
      await waitFor(() => !currentVideo(videoId) || unavailable(root) || threadRoots(root).length > initial, 4200);
    }
    requireVideo(videoId);
    if (publicOnly && !unavailable(root)) {
      let lastCount = -1;
      let lastChange = Date.now();
      await waitFor(() => {
        if (!currentVideo(videoId) || unavailable(root)) return true;
        const rendered = threadRoots(root).slice(0, 200);
        if (rendered.length !== lastCount) {
          lastCount = rendered.length;
          lastChange = Date.now();
        }
        // YouTube adds the first batch incrementally. Wait for the next-page
        // control or a settled list before treating an early handful as final.
        return rendered.length > 0 && (continuation(root) || Date.now() - lastChange >= 850)
          && rendered.every((thread) => readThread(thread, videoId, true));
      }, 2700);
    }
    requireVideo(videoId);
    const threads = new Map();
    for (const thread of threadRoots(root)) {
      const item = readThread(thread, videoId, publicOnly);
      if (item && !threads.has(item.id)) threads.set(item.id, item);
      if (threads.size >= 200) break;
    }
    const nextPageToken = continuation(root) && threads.size < 200 ? 'visible-more' : null;
    if (unavailable(root)) return { video, threads: [], nextPageToken: null, commentsUnavailable: '이 영상은 댓글을 사용할 수 없습니다.' };
    if (!threads.size && threadRoots(root).length) {
      return { video, threads: [], nextPageToken, commentsUnavailable: '이 화면에서 원댓글의 고유 주소를 확인하지 못했습니다.' };
    }
    return { video, threads: [...threads.values()], nextPageToken };
  }

  async function getReplies({ videoId, parentId, publicOnly = false }) {
    requireVideo(videoId);
    const thread = findThread(videoId, parentId);
    if (!thread) fail('threadMissing', '원댓글을 찾을 수 없습니다. 댓글을 다시 불러와 주세요.');
    if (!replyNodes(thread, publicOnly).length) {
      const expand = expandRepliesButton(thread, publicOnly);
      if (expand) {
        expand.click();
        await waitFor(() => !currentVideo(videoId) || replyNodes(thread, publicOnly).length, 3500);
      }
    }
    requireVideo(videoId);
    return { replies: replyList(thread, videoId, parentId, publicOnly), nextPageToken: null };
  }

  // End of the shared public YouTube DOM reader.
  function editorIn(thread) {
    const selectors = '#contenteditable-root[contenteditable="true"], [role="textbox"][contenteditable="true"], [contenteditable="true"]';
    return [...thread.querySelectorAll(selectors)].find((editor) =>
      editor.closest(threadSelector) === thread && editor.closest(composerSelector) && visible(editor));
  }

  function editorButton(editor, selector) {
    let scope = editor.closest(composerSelector);
    while (scope) {
      const button = [...scope.querySelectorAll(buttonSelector)].find((item) => item.closest(selector) && visible(item));
      if (button) return button;
      scope = scope.parentElement?.closest(composerSelector);
    }
    return null;
  }

  function avatarIdentity(value) {
    const url = safeImage(value);
    return url ? new URL(url).pathname.replace(/=s\d+.*$/, '') : null;
  }

  function accountAvatar() {
    const button = document.querySelector('ytd-masthead #avatar-btn, ytd-masthead button[aria-label="Account menu"], ytd-masthead button[aria-label="계정 메뉴"]');
    if (!visible(button)) return null;
    const image = button.querySelector('img');
    return { avatar: avatarIdentity(image?.currentSrc || image?.src) };
  }

  function complete(state, status, message, reply) {
    state.outcome = { status, ...(message ? { message } : {}), ...(reply ? { reply } : {}) };
    document.removeEventListener('click', state.observe, true);
    return state.outcome;
  }

  function observeSubmit(state, event) {
    if (!event.isTrusted || state.outcome || !currentVideo(state.videoId)) return;
    const target = event.composedPath().find((part) => part instanceof Element && part.matches(buttonSelector));
    if (!target) return;
    if (target === editorButton(state.editor, cancelSelector) && !state.submittedAt) {
      complete(state, 'failed', 'YouTube에서 답글 작성을 취소했습니다.');
    } else if (target === editorButton(state.editor, submitSelector) && enabled(target) && !state.submittedAt) {
      if (renderedText(state.editor) !== state.text) {
        complete(state, 'uncertain', 'Chrome에서 답글 내용이 바뀌어 앱의 초안과 일치하는지 확인할 수 없습니다.');
        return;
      }
      for (const reply of replyList(state.thread, state.videoId, state.parentId)) state.baseline.add(reply.id);
      state.submittedAt = Date.now();
    }
  }

  async function prepareReply({ videoId, parentId, text, recordId }) {
    const beforeOpen = (message) => fail('notPrepared', message);
    if (!currentVideo(videoId) || !isId(parentId, commentPattern) || !isId(recordId, recordPattern)
      || typeof text !== 'string' || !plain(text) || [...text].length > 120) {
      beforeOpen('영상이나 답글 대상이 바뀌었습니다. 화면을 다시 확인해 주세요.');
    }
    if (tracking && !tracking.outcome) beforeOpen('이 탭에서 작성 중인 답글을 먼저 게시하거나 취소해 주세요.');
    const account = accountAvatar();
    if (!account) beforeOpen('이미 로그인한 Chrome 프로필에서 YouTube 영상을 열어 주세요.');
    const thread = findThread(videoId, parentId);
    if (!thread) beforeOpen('선택한 원댓글이 YouTube 화면에 없습니다. 댓글을 다시 불러와 주세요.');
    if (editorIn(thread)) beforeOpen('선택한 댓글에 열려 있는 기존 답글창을 먼저 닫아 주세요.');
    const button = replyButton(originalNode(thread));
    if (!button) beforeOpen('이 원댓글에서는 YouTube 답글창을 열 수 없습니다.');

    const baseline = new Set(replyList(thread, videoId, parentId).map((reply) => reply.id));
    button.scrollIntoView({ block: 'center', behavior: 'instant' });
    button.click();
    const editor = await waitFor(() => currentVideo(videoId) && editorIn(thread), 3800);
    requireVideo(videoId);
    if (!editor || findThread(videoId, parentId) !== thread || renderedText(editor)) {
      fail('editorUnconfirmed', '선택한 원댓글의 빈 답글창을 확인하지 못했습니다.');
    }
    editor.focus();
    document.execCommand('insertText', false, text);
    if (renderedText(editor) !== plain(text) || !editorButton(editor, submitSelector)) {
      fail('editorUnconfirmed', 'YouTube 답글창에서 초안이나 게시 버튼을 확인하지 못했습니다.');
    }
    const state = { videoId, parentId, recordId, text: plain(text), thread, editor, baseline, account, submittedAt: null, outcome: null };
    state.observe = (event) => observeSubmit(state, event);
    tracking = state;
    document.addEventListener('click', state.observe, true);
    return { prepared: true };
  }

  function recent(node) {
    const published = publishedElement(node);
    const exact = absoluteDate(published?.getAttribute('datetime') || published?.querySelector('time')?.dateTime);
    if (exact) return Math.abs(Date.now() - Date.parse(exact)) < 120_000;
    return /(?:just now|moments? ago|\b\d{1,2} seconds? ago\b|\b1 minute ago\b|방금|\d{1,2}\s*초 전|1\s*분 전)/i.test(renderedText(published));
  }

  function topLevelEditor(root) {
    const field = '[contenteditable="true"]';
    const composer = 'ytd-comment-simplebox-renderer, yt-comment-simplebox-view-model';
    return [...root.querySelectorAll(field)].find((editor) =>
      editor.closest(composer) && !editor.closest(threadSelector) && visible(editor));
  }

  function topLevelPlaceholder(root) {
    const placeholder = '#simplebox-placeholder, #placeholder-area, #placeholder-text';
    return [...root.querySelectorAll(placeholder)].find((item) =>
      !item.closest(threadSelector) && item.closest('ytd-comment-simplebox-renderer, yt-comment-simplebox-view-model') &&
      visible(item));
  }

  function typedSubmit(editor, root) {
    const scope = editor.closest('ytd-comment-simplebox-renderer, yt-comment-simplebox-view-model');
    if (!scope) return editorButton(editor, submitSelector);
    return [...scope.querySelectorAll(buttonSelector)].find((button) =>
      button.closest(submitSelector) && root.contains(button) && enabled(button));
  }

  function commentNodesForPublish(root, thread) {
    if (thread) return replyNodes(thread, true);
    return threadRoots(root).map(originalNode).filter(Boolean);
  }

  function publishStage(recordId, progress) {
    void chrome.runtime.sendMessage({ type: 'studio-youtube-progress', recordId, progress }).catch(() => {});
  }

  async function publishTypedComment({ videoId, parentId, text, recordId }) {
    const failed = (message) => ({ status: 'failed', message });
    const uncertain = (message) => ({ status: 'uncertain', message });
    if (!currentVideo(videoId) || !isId(recordId, recordPattern) ||
        (parentId !== undefined && !isId(parentId, commentPattern)) ||
        typeof text !== 'string' || !plain(text) || [...text].length > 120) {
      return failed('선택한 영상과 확인된 댓글 문구를 다시 확인해 주세요.');
    }
    const expected = plain(text);
    const account = await waitFor(() => currentVideo(videoId) && accountAvatar(), 2600);
    if (!account) return failed('YouTube에 로그인한 Chrome 프로필에서 시도해 주세요.');
    const root = await waitFor(() => currentVideo(videoId) && commentsRoot(), 3200);
    if (!root || !currentVideo(videoId) || unavailable(root)) {
      return failed('이 영상에 열린 댓글창을 찾을 수 없습니다.');
    }

    root.scrollIntoView({ block: 'start', behavior: 'instant' });
    const thread = parentId
      ? await waitFor(() => currentVideo(videoId) && findThread(videoId, parentId), 4600)
      : null;
    if (parentId && !thread) return failed('선택한 원댓글이 현재 영상에서 열리지 않았습니다.');
    const editorNow = () => thread ? editorIn(thread) : topLevelEditor(root);
    let editor = editorNow();
    if (editor && renderedText(editor)) return failed('이 영상에 먼저 작성 중인 댓글을 확인해 주세요.');
    const baseline = new Set(commentNodesForPublish(root, thread).map((node) => permalink(node, videoId)).filter(Boolean));
    if (!editor) {
      const open = thread
        ? replyButton(originalNode(thread))
        : await waitFor(() => currentVideo(videoId) && topLevelPlaceholder(root), 3400);
      if (!open || !currentVideo(videoId)) return failed('현재 영상에서 댓글 입력창을 열 수 없습니다.');
      open.scrollIntoView({ block: 'center', behavior: 'instant' });
      open.click();
      editor = await waitFor(() => currentVideo(videoId) && editorNow(), 3200);
    }
    const correctTarget = () => currentVideo(videoId) && commentsRoot() === root &&
      (!thread || findThread(videoId, parentId) === thread);
    if (!editor || !correctTarget() || renderedText(editor)) {
      return failed('선택한 대상의 빈 댓글 입력창을 확인하지 못했습니다.');
    }

    publishStage(recordId, 'typing');
    editor.focus();
    let typed = '';
    for (const character of expected) {
      const focused = document.activeElement === editor || editor.contains(document.activeElement);
      if (!correctTarget() || editorNow() !== editor || !focused || renderedText(editor) !== plain(typed)) {
        return failed('영상·입력 대상 또는 입력 문구가 바뀌어 게시 전에 중단했습니다.');
      }
      if (!document.execCommand('insertText', false, character)) {
        return failed('YouTube 입력창에 글자를 넣지 못했습니다.');
      }
      typed += character;
      await new Promise((resolve) => setTimeout(resolve, 32));
    }

    const submit = typedSubmit(editor, root);
    if (!correctTarget() || editorNow() !== editor || renderedText(editor) !== expected || !submit || !enabled(submit)) {
      return failed('완성된 문구와 게시 버튼을 함께 확인하지 못했습니다.');
    }
    for (const node of commentNodesForPublish(root, thread)) {
      const id = permalink(node, videoId);
      if (id) baseline.add(id);
    }
    publishStage(recordId, 'verifying');
    submit.click();

    return await waitFor(() => {
      if (!correctTarget()) return uncertain('게시 버튼을 누른 뒤 영상 또는 원댓글이 바뀌었습니다.');
      const matches = [];
      for (const node of commentNodesForPublish(root, thread)) {
        const reply = readComment(node, videoId);
        if (!reply?.author || reply.author === 'YouTube 사용자' || reply.id === parentId ||
            baseline.has(reply.id) || reply.text !== expected || !recent(node)) continue;
        if (account.avatar && avatarIdentity(reply.avatarUrl) !== account.avatar) continue;
        matches.push({ ...reply, ...(parentId ? { parentId } : {}) });
      }
      if (matches.length > 1) return uncertain('같은 문구의 댓글이 여러 개 보여 게시 결과를 확정할 수 없습니다.');
      if (matches.length === 1) return { status: 'posted', reply: matches[0] };
      return null;
    }, 9000) ?? uncertain('YouTube에서 새 댓글을 확인하지 못했습니다. 해당 영상에서 게시 결과를 확인해 주세요.');
  }

  function checkReply({ videoId, parentId, recordId }) {
    const state = tracking;
    if (!state || state.recordId !== recordId || state.parentId !== parentId || state.videoId !== videoId) {
      return { status: 'uncertain', message: 'YouTube 탭에서 이 답글의 게시 상태를 추적할 수 없습니다.' };
    }
    if (state.outcome) return state.outcome;
    if (!currentVideo(videoId) || findThread(videoId, parentId) !== state.thread) {
      return complete(state, 'uncertain', 'YouTube 영상이나 원댓글 화면이 바뀌어 게시 결과를 확인할 수 없습니다.');
    }
    if (!state.submittedAt) return { status: 'waiting' };

    const matches = [];
    for (const node of replyNodes(state.thread)) {
      const reply = readComment(node, videoId);
      if (!reply || state.baseline.has(reply.id) || reply.id === parentId || reply.text !== state.text || !recent(node)) continue;
      const avatar = avatarIdentity(reply.avatarUrl);
      if (state.account.avatar && avatar && state.account.avatar !== avatar) continue;
      matches.push({ ...reply, parentId });
    }
    if (matches.length === 1) return complete(state, 'posted', null, matches[0]);
    if (matches.length > 1 || Date.now() - state.submittedAt >= POST_WAIT) {
      return complete(state, 'uncertain', 'YouTube에서 새 답글을 확실히 확인하지 못했습니다. 원댓글 아래를 확인해 주세요.');
    }
    return { status: 'waiting' };
  }

  const actions = {
    openVideo: getThreads,
    readThreads: getThreads,
    readReplies: getReplies,
    prepareReply,
    checkReply,
    postReply: publishTypedComment,
    postComment: publishTypedComment,
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'studio-youtube' || !Object.hasOwn(actions, message.action)) return false;
    Promise.resolve().then(() => actions[message.action](message.payload ?? {})).then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({
        ok: false,
        error: error?.code ? { message: error.message, code: error.code } : { message: 'YouTube 화면에서 요청을 처리하지 못했습니다.', code: 'youtubeDomError' },
      }),
    );
    return true;
  });
})();
