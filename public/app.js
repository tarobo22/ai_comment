const byId = (id) => document.getElementById(id);
const nav = [...document.querySelectorAll('[data-screen]')];
const dialog = byId('review-dialog');
const generateDialog = byId('generate-dialog');
const aiSettingsDialog = byId('ai-settings-dialog');
const editor = byId('inline-reply');
const replyText = byId('reply-text');
const privateVideoOptions = byId('private-video-options');
const brandPositionInput = byId('brand-position');
const brandPositionKey = 'unmyeongwon-studio.brand-position';
const date = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeZone: 'Asia/Seoul' });
const dateTime = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' });
const imageHosts = new Set(['i.ytimg.com', 'i9.ytimg.com', 'img.youtube.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com', 'lh3.googleusercontent.com']);
const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const statusLabels = {
  draft: '작성 기록', posting: '게시 중', posted: '게시 완료', failed: '실패', uncertain: '확인 보류'
};
const toneTypeLabels = { neutral: '중립', female: '여성 말투', male: '남성 말투' };
const draftVariantLabels = { clean: '깔끔한 버전', expressive: '의성어·의태어 버전' };
const draftPartLabels = { video: '영상', empathy: '공감', cta: '운명원 연결' };
const state = {
  video: null, screen: 'video', threads: new Map(), cursor: null, loaded: false,
  loadingLatest: false, analyzingVideo: false, videoAnalysis: null,
  catalog: 0, loadingVideo: false, loadingThreads: false, saving: false,
  posting: false, selected: null, confirmation: null, history: [], limits: null,
  drafts: new Map(), unknown: new Set(), generations: new Map(), ready: null,
  generating: false, generationSelectionChanged: false, generationPrompt: '',
  generationMode: 'reply',
  generationSettings: { tone: 4, message: 2, audience: 'neutral' }
};

function node(tag, className = '', value = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value) element.textContent = value;
  return element;
}

function status(id, message = '', type = '') {
  const element = byId(id);
  element.textContent = message;
  element.dataset.type = type;
  element.hidden = !message;
}

function formatted(value, formatter) {
  if (!value) return '';
  const time = new Date(value);
  return Number.isNaN(time.valueOf()) ? '' : formatter.format(time);
}

function allowedLink(value, hosts) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.has(url.hostname) ? url.href : '';
  } catch {
    return '';
  }
}

function watchLink(videoId, parentId) {
  const url = new URL('https://www.youtube.com/watch');
  url.searchParams.set('v', videoId);
  if (parentId) url.searchParams.set('lc', parentId);
  return url.href;
}

function isVideoLink(value) {
  try {
    const url = new URL(value.includes('://') ? value : 'https://' + value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return false;
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.hostname === 'youtu.be') return parts.length === 1 && videoIdPattern.test(parts[0]);
    if (!youtubeHosts.has(url.hostname)) return false;
    if (url.pathname === '/watch') return videoIdPattern.test(url.searchParams.get('v') || '');
    return parts.length === 2 && ['shorts', 'live', 'embed'].includes(parts[0]) && videoIdPattern.test(parts[1]);
  } catch {
    return false;
  }
}

async function api(path, body) {
  let response;
  try {
    response = await fetch(path, body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error('로컬 앱과 연결이 끊겼습니다. 실행 상태를 확인해 주세요.'), { transportError: true });
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) {
    const error = new Error(result?.error?.message || '요청을 처리하지 못했습니다.');
    error.code = result?.error?.code;
    error.httpStatus = response.status;
    error.record = result?.record;
    error.transportError = !result;
    throw error;
  }
  return result;
}

byId('open-ai-settings').addEventListener('click', async () => {
  const form = byId('ai-settings-form');
  form.hidden = true;
  status('ai-settings-status', 'Gemini 설정을 확인하고 있습니다…');
  aiSettingsDialog.showModal();
  try {
    const result = await api('/api/ai/settings');
    form.hidden = !result.editable;
    status('ai-settings-status', result.configured ? 'Gemini 키가 등록되어 있습니다.'
      : result.editable ? 'AI 작성에 사용할 키를 등록해 주세요.' : '이 환경에서는 Gemini 키를 서버 환경변수로 설정합니다.');
  } catch (error) {
    status('ai-settings-status', error.message, 'error');
  }
});

byId('close-ai-settings').addEventListener('click', () => aiSettingsDialog.close());
aiSettingsDialog.addEventListener('close', () => { byId('gemini-key').value = ''; });
byId('ai-settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const field = byId('gemini-key');
  const submit = byId('save-ai-settings');
  field.disabled = submit.disabled = true;
  try {
    await api('/api/ai/settings', { key: field.value });
    field.value = '';
    status('ai-settings-status', 'Gemini 키를 저장했습니다.', 'success');
  } catch (error) {
    status('ai-settings-status', error.message, 'error');
  } finally {
    field.disabled = submit.disabled = false;
  }
});

function showScreen(screen) {
  if (state.loadingVideo || state.loadingLatest || state.analyzingVideo || state.generating) return;
  if (screen === 'comments' && (!state.video || state.video.privateDraft)) return;
  if (screen === 'generate' && !selectedGenerations().length) return;
  const entering = screen !== state.screen;
  state.screen = screen;
  for (const button of nav) {
    const active = button.dataset.screen === screen;
    byId('screen-' + button.dataset.screen).hidden = !active;
    if (active) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
  if (screen === 'comments' && !state.loaded && !state.loadingThreads) void loadThreads();
  if (screen === 'generate') {
    renderGeneration();
    if (state.generationSelectionChanged || !entering) openGenerationDialog();
  }
  if (screen === 'history') {
    renderReplyControls();
    if (!state.video?.privateDraft) void loadHistory();
  }
}

function resetVideo() {
  ++state.catalog;
  closeComposer();
  state.video = null;
  state.videoAnalysis = null;
  state.loadingThreads = false;
  state.loaded = false;
  state.cursor = null;
  state.threads.clear();
  state.generations.clear();
  state.ready = null;
  state.generationSelectionChanged = false;
  state.generationPrompt = '';
  state.generationMode = 'reply';
  status('generate-status');
  status('video-analysis-status');
  byId('video-analysis').hidden = true;
  byId('video-card').hidden = true;
  byId('video-media').replaceChildren();
  byId('thread-list').replaceChildren();
  nav.find((button) => button.dataset.screen === 'comments').disabled = true;
  byId('more-threads').hidden = true;
}

function displayVideo(video) {
  const privateDraft = video.privateDraft === true;
  const card = byId('video-card');
  card.dataset.privateDraft = String(privateDraft);
  byId('selected-video-title').textContent = video.title;
  byId('selected-video-meta').textContent = privateDraft ? '자막으로 분석한 내 영상' :
    [video.channelTitle, formatted(video.publishedAt, date)].filter(Boolean).join(' · ');
  byId('thread-video-title').textContent = video.title;
  const videoId = video.id;
  if (!videoIdPattern.test(videoId)) throw new Error('동영상 정보를 읽을 수 없습니다.');
  byId('watch-video').href = watchLink(videoId);
  const media = byId('video-media');
  media.replaceChildren();
  media.hidden = privateDraft;
  byId('selected-video-actions').hidden = privateDraft;
  const thumbnail = !privateDraft && allowedLink(video.thumbnailUrl, imageHosts);
  if (thumbnail) {
    const image = node('img');
    image.src = thumbnail;
    image.alt = '';
    media.append(image);
  }
  if (!privateDraft && video.embeddable) {
    const preview = node('button', 'button play-preview', '▶ 미리보기');
    preview.type = 'button';
    preview.addEventListener('click', () => {
      const frame = node('iframe');
      frame.src = 'https://www.youtube-nocookie.com/embed/' + videoId + '?autoplay=1';
      frame.title = video.title;
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      frame.allowFullscreen = true;
      media.replaceChildren(frame);
    });
    media.append(preview);
  }
  card.hidden = false;
}

function latestVideoRow(video) {
  const row = node('li');
  const button = node('button', 'latest-video');
  button.type = 'button';
  button.dataset.videoId = video.id;
  const media = node('span', 'latest-thumbnail');
  const thumbnail = allowedLink(video.thumbnailUrl, imageHosts);
  if (thumbnail) {
    const image = node('img');
    image.src = thumbnail;
    image.alt = '';
    image.loading = 'lazy';
    media.append(image);
  }
  const details = node('span', 'latest-video-details');
  const meta = [video.channelTitle, formatted(video.publishedAt, date) || video.publishedText].filter(Boolean).join(' · ');
  details.append(node('strong', '', video.title), node('span', 'muted', meta));
  button.append(media, details);
  button.addEventListener('click', () => void loadVideo(watchLink(video.id)));
  row.append(button);
  return row;
}

function videoReadBlocked() {
  return state.loadingLatest || state.loadingVideo || state.analyzingVideo || state.loadingThreads ||
    state.posting || state.saving || state.generating;
}

async function loadLatestVideos() {
  if (privateVideoOptions.open || videoReadBlocked()) return;
  state.loadingLatest = true;
  renderReplyControls();
  status('latest-status', '최근 공개 영상을 찾고 있습니다…');
  try {
    const result = await api('/api/public/latest');
    if (!Array.isArray(result.videos)) throw new Error('최신 영상 목록을 읽을 수 없습니다.');
    const videos = result.videos.filter((video) => videoIdPattern.test(video?.id) && typeof video.title === 'string' && video.title);
    byId('latest-videos').replaceChildren(...videos.map(latestVideoRow));
    status('latest-status', videos.length ? '' : '최근 공개 영상이 없습니다.', 'warn');
  } catch (error) {
    status('latest-status', error.message, 'error');
  } finally {
    state.loadingLatest = false;
    renderReplyControls();
  }
}

async function loadVideo(url) {
  if (privateVideoOptions.open || videoReadBlocked() || !url) return;
  state.loadingVideo = true;
  renderReplyControls();
  status('video-status', 'YouTube 영상 정보를 확인하고 있습니다…');
  try {
    const result = await api('/api/public/video?' + new URLSearchParams({ url }));
    if (!videoIdPattern.test(result?.video?.id)) throw new Error('영상 정보를 읽을 수 없습니다.');
    if (state.video?.id !== result.video.id || state.video?.privateDraft) resetVideo();
    state.video = result.video;
    byId('video-url').value = url;
    displayVideo(state.video);
    status('video-status');
  } catch (error) {
    status('video-status', error.message, 'error');
  } finally {
    state.loadingVideo = false;
    renderReplyControls();
  }
}

function displayVideoAnalysis(result) {
  byId('analysis-summary').textContent = result.summary;
  const providedCaptions = result.sources?.providedCaptions === true;
  const transcript = result.sources?.transcript === 'available' ? '자막 확인' : '자막 미확인 · 제목·설명 사용';
  const commentCount = result.popularCommentCount ?? 0;
  const comments = result.sources?.popularComments === 'top' ? '인기 댓글 ' + commentCount + '개' : '인기 댓글 미확인';
  byId('analysis-sources').textContent = providedCaptions ? '제공한 자막' : [transcript, comments].join(' · ');
  const evidence = result.evidence;
  byId('analysis-evidence').hidden = !evidence?.text;
  byId('analysis-evidence-label').textContent = evidence?.source === 'transcript'
    ? [providedCaptions ? '제공한 자막 근거' : '자막 근거', evidence.timestamp].filter(Boolean).join(' · ')
    : '제목·설명 근거';
  byId('analysis-evidence-text').textContent = evidence?.text ?? '';
  byId('video-analysis').hidden = false;
}

async function analyzeVideo() {
  if (!state.video || state.video.privateDraft || videoReadBlocked()) return;
  state.analyzingVideo = true;
  renderReplyControls();
  status('video-analysis-status', '자막과 인기 댓글을 확인하고 있습니다…');
  try {
    const result = await api('/api/ai/video-analysis', { videoId: state.video.id });
    if (typeof result.summary !== 'string' || !result.summary.trim()) throw new Error('영상 분석 결과를 읽을 수 없습니다.');
    state.videoAnalysis = result;
    displayVideoAnalysis(result);
    status('video-analysis-status');
  } catch (error) {
    status('video-analysis-status', error.message, 'error');
  } finally {
    state.analyzingVideo = false;
    renderReplyControls();
  }
}

async function analyzePrivateVideo() {
  if (!privateVideoOptions.open || videoReadBlocked()) return;
  const urlInput = byId('video-url');
  const url = urlInput.value.trim();
  if (!isVideoLink(url)) {
    status('private-video-status', '위에 내 영상의 YouTube 링크를 입력해 주세요.', 'error');
    urlInput.focus();
    return;
  }
  const title = byId('private-video-title').value.trim();
  if (!title || Array.from(title).length > 250) {
    status('private-video-status', '영상 제목을 1~250자로 입력해 주세요.', 'error');
    byId('private-video-title').focus();
    return;
  }
  const srt = byId('private-video-captions').files[0];
  if (!srt || !/\.srt$/i.test(srt.name) || !srt.size || srt.size > 32 * 1024) {
    status('private-video-status', '내용이 있고 32KB 이하인 SRT 자막 파일을 선택해 주세요.', 'error');
    return;
  }
  state.analyzingVideo = true;
  renderReplyControls();
  status('private-video-status', '제공한 자막을 분석하고 있습니다…');
  try {
    const result = await api('/api/ai/private-video-analysis', { url, title, captions: await srt.text() });
    const { video, analysis } = result;
    if (video?.privateDraft !== true || !videoIdPattern.test(video.id) || !analysis?.sources?.providedCaptions ||
        typeof analysis.summary !== 'string' || !analysis.summary.trim()) {
      throw new Error('내 영상의 자막 분석 결과를 읽을 수 없습니다.');
    }
    resetVideo();
    state.video = video;
    state.videoAnalysis = analysis;
    displayVideo(video);
    displayVideoAnalysis(analysis);
    status('private-video-status');
  } catch (error) {
    status('private-video-status', error.message, 'error');
    return;
  } finally {
    state.analyzingVideo = false;
    renderReplyControls();
  }
  byId('write-video-comment').focus();
}

function avatar(author, avatarUrl) {
  const fallback = Array.from(String(author || '').replace(/^@/, ''))[0] || '•';
  const badge = node('span', 'avatar', fallback);
  badge.setAttribute('aria-hidden', 'true');
  const src = allowedLink(avatarUrl, imageHosts);
  if (src) {
    const image = node('img');
    image.alt = '';
    image.loading = 'lazy';
    image.addEventListener('error', () => image.remove());
    image.src = src;
    badge.append(image);
  }
  return badge;
}

function commentRow(comment, clickable) {
  const row = node(clickable ? 'button' : 'div', 'thread-row');
  if (clickable) row.type = 'button';
  const body = node('span', 'thread-body');
  const meta = node('span', 'comment-meta');
  meta.append(node('strong', '', comment.author || 'YouTube 사용자'));
  const published = formatted(comment.publishedAt, date) || comment.publishedText;
  if (published) meta.append(node('span', '', published));
  if (comment.likeCount > 0) meta.append(node('span', '', '좋아요 ' + Number(comment.likeCount).toLocaleString('ko-KR')));
  body.append(meta, node('span', 'comment-text', comment.text));
  row.append(avatar(comment.author, comment.avatarUrl), body);
  return { row, body };
}

function renderReplyList(item) {
  const entries = Array.from(item.replies.values(), (reply) => {
    const li = node('li');
    li.append(commentRow(reply, false).row);
    return li;
  });
  item.replyList.replaceChildren(...entries);
  item.replySummary.textContent = '답글 ' + item.thread.replyCount + '개';
  item.retryReplies.hidden = item.repliesLoaded || item.repliesBusy;
}

function replyDetails(item) {
  if (item.replyDetails) return;
  item.replyDetails = node('details', 'reply-details');
  item.replySummary = node('summary', '', '답글 ' + item.thread.replyCount + '개');
  item.replyList = node('ul', 'reply-list');
  item.replyNotice = node('p', 'hint');
  item.replyNotice.setAttribute('role', 'status');
  item.retryReplies = node('button', 'button', '답글 다시 불러오기');
  item.retryReplies.type = 'button';
  item.retryReplies.hidden = true;
  item.retryReplies.addEventListener('click', () => void loadReplies(item));
  item.replyDetails.addEventListener('toggle', () => {
    if (item.replyDetails.open && !item.repliesLoaded) void loadReplies(item);
  });
  item.replyDetails.append(item.replySummary, item.replyList, item.replyNotice, item.retryReplies);
  item.element.append(item.replyDetails);
}

function addThread(thread) {
  if (state.threads.has(thread.id)) return;
  const element = node('li', 'thread-item');
  const { row, body } = commentRow(thread, thread.canReply);
  const action = node('span', thread.canReply ? 'comment-action' : 'comment-action muted', thread.canReply ? '답글' : '답글 작성 불가');
  body.append(action);
  const line = node('div', 'thread-select-row');
  line.append(row);
  element.append(line);
  const item = { thread, row, action, element, replies: new Map(), repliesLoaded: false, repliesBusy: false };
  if (thread.canReply) {
    const select = node('label', 'generation-select');
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.generations.get(thread.parentId)?.selected || false;
    checkbox.setAttribute('aria-label', (thread.author || 'YouTube 사용자') + ' 댓글을 AI 작성 대상으로 선택');
    checkbox.addEventListener('change', () => setGenerationSelected(item, checkbox.checked));
    select.append(checkbox, node('span', '', '선택'));
    line.append(select);
    item.checkbox = checkbox;
    row.setAttribute('aria-expanded', 'false');
    row.setAttribute('aria-controls', 'inline-reply');
    row.addEventListener('click', () => selectThread(item));
  }
  if (thread.replyCount > 0) replyDetails(item);
  state.threads.set(thread.id, item);
  byId('thread-list').append(element);
}

async function loadThreads(append = false) {
  if (state.loadingVideo || state.loadingThreads || state.posting || state.saving || !state.video || state.video.privateDraft || (append && !state.cursor)) return;
  const catalog = state.catalog;
  state.loadingThreads = true;
  byId('reload-comments').disabled = true;
  byId('more-threads').disabled = true;
  renderReplyControls();
  status('thread-status', 'YouTube 댓글을 불러오는 중입니다…');
  try {
    const result = await api('/api/public/videos/' + state.video.id + '/threads' + (append ? '?more=1' : ''));
    if (catalog !== state.catalog) return;
    applyThreads(result, append);
  } catch (error) {
    if (catalog === state.catalog) status('thread-status', error.message, 'error');
  } finally {
    if (catalog === state.catalog) {
      state.loadingThreads = false;
      renderReplyControls();
    }
  }
}

function applyThreads(result, append = false) {
  if (!Array.isArray(result?.threads)) throw new Error('댓글 정보를 읽을 수 없습니다.');
  if (!append) {
    closeComposer();
    state.threads.clear();
    byId('thread-list').replaceChildren();
  }
  for (const thread of result.threads) addThread(thread);
  state.cursor = result.nextPageToken || null;
  state.loaded = true;
  byId('more-threads').hidden = !state.cursor;
  status('thread-status', result.commentsUnavailable || (!state.threads.size ? '표시할 댓글이 없습니다.' : ''), result.commentsUnavailable ? 'warn' : '');
}

async function loadReplies(item) {
  if (!state.video || state.loadingVideo || state.posting || item.repliesBusy) return;
  item.repliesBusy = true;
  item.retryReplies.hidden = true;
  item.replyNotice.textContent = '답글을 불러오는 중입니다…';
  try {
    const result = await api('/api/public/videos/' + state.video.id + '/comments/' + encodeURIComponent(item.thread.parentId) + '/replies');
    if (!Array.isArray(result?.replies)) throw new Error('답글 정보를 읽을 수 없습니다.');
    for (const reply of result.replies) item.replies.set(reply.id, reply);
    item.repliesLoaded = true;
    item.replyNotice.textContent = item.replies.size ? '' : '표시할 답글이 없습니다.';
  } catch (error) {
    item.replyNotice.textContent = error.message;
  } finally {
    item.repliesBusy = false;
    renderReplyList(item);
  }
}

function draftKey(item) {
  return state.video.id + ':' + item.thread.parentId;
}

function closeComposer() {
  if (state.selected) {
    state.selected.row.setAttribute('aria-expanded', 'false');
    state.selected.action.textContent = '답글';
  }
  state.selected = null;
  editor.hidden = true;
  byId('screen-comments').append(editor);
}

function selectThread(item) {
  if (state.posting || state.saving) return;
  if (state.selected !== item) {
    closeComposer();
    state.selected = item;
    item.row.setAttribute('aria-expanded', 'true');
    item.action.textContent = '답글 작성 중';
    item.row.parentElement.after(editor);
    editor.hidden = false;
    const existing = state.history.find((record) => record.videoId === state.video.id && record.parentId === item.thread.parentId && record.status === 'draft');
    replyText.value = state.drafts.get(draftKey(item)) ?? existing?.text ?? '';
    status('reply-status');
  }
  setGenerationSelected(item, true);
  replyText.focus();
}

function selectedGenerations(mode = state.generationMode) {
  return [...state.generations.values()].filter((entry) => entry.selected &&
    Boolean(entry.thread.topLevel) === (mode === 'topLevel'));
}

function setGenerationSelected(item, selected, text = '') {
  const { thread } = item;
  let entry = state.generations.get(thread.parentId);
  if (Boolean(entry?.selected) !== selected) state.generationSelectionChanged = true;
  if (!entry && selected) {
    entry = { thread, selected, text, approach: '', settings: null, optionsOpen: false, overrideSettings: null, candidate: null };
    state.generations.set(thread.parentId, entry);
  }
  if (entry) {
    entry.thread = thread;
    entry.selected = selected;
    if (!entry.text && text) entry.text = text;
    if (!selected && state.ready === entry) state.ready = null;
  }
  if (item.checkbox) item.checkbox.checked = selected;
  renderReplyControls();
}

function chooseGenerationMode(mode) {
  if (state.generationMode === mode) return;
  state.generationMode = mode;
  state.generationSelectionChanged = true;
  state.ready = null;
}

function openVideoComment() {
  if (!state.videoAnalysis || videoReadBlocked()) return;
  chooseGenerationMode('topLevel');
  const thread = {
    id: 'video-top-level', parentId: '', author: '영상에 남길 새 댓글',
    text: state.videoAnalysis.summary, topLevel: true,
  };
  setGenerationSelected({ thread }, true);
  showScreen('generate');
}

function generationButton(label, handler, primary = false) {
  const button = node('button', primary ? 'button primary' : 'button', label);
  button.type = 'button';
  button.addEventListener('click', handler);
  button.disabled = state.generating;
  return button;
}

function settingsLabel(settings) {
  return '말투 온도 ' + settings.tone + ' / 5 · 답변 방향 ' + settings.message + ' / 5 · 말투 유형 ' + toneTypeLabels[settings.audience];
}

function scoreSetting(label, start, end, value, change) {
  const field = node('label', 'score-control');
  const heading = node('span', 'score-heading');
  const number = node('output', '', String(value));
  heading.append(node('span', '', label), number);
  const slider = node('input');
  slider.type = 'range';
  slider.min = '1';
  slider.max = '5';
  slider.value = value;
  slider.disabled = state.generating;
  slider.setAttribute('aria-label', start + '에서 ' + end + '까지');
  slider.addEventListener('input', () => {
    number.value = slider.value;
    change(Number(slider.value));
  });
  const ends = node('span', 'score-track');
  ends.append(node('span', '', start), slider, node('span', '', end));
  field.append(heading, ends);
  return field;
}

function individualSettings(entry) {
  const options = entry.overrideSettings ?? state.generationSettings;
  const settings = node('div', 'generation-settings generation-card-settings');
  const toneType = node('fieldset', 'generation-audience');
  const choices = node('div', 'choice-row');
  const useCommon = generationButton('공통 설정 사용', () => {
    entry.overrideSettings = null;
    focusDraftCard(entry, '.generation-card-settings input');
  });
  useCommon.disabled ||= !entry.overrideSettings;
  function setOverride(key, value) {
    const current = entry.overrideSettings ?? state.generationSettings;
    if (current[key] === value) return;
    entry.overrideSettings = { ...current, [key]: value };
    useCommon.disabled = false;
  }

  for (const [value, label] of Object.entries(toneTypeLabels)) {
    const choice = node('label');
    const radio = node('input');
    radio.type = 'radio';
    radio.name = 'audience-' + entry.thread.parentId;
    radio.value = value;
    radio.checked = options.audience === value;
    radio.disabled = state.generating;
    radio.addEventListener('change', () => setOverride('audience', value));
    choice.append(radio, node('span', '', label));
    choices.append(choice);
  }
  toneType.append(node('legend', '', '말투 유형'), choices);
  const actions = node('div', 'actions');
  actions.append(useCommon);
  settings.append(
    scoreSetting('말투 온도', '냉정함', '따뜻함', options.tone, (value) => setOverride('tone', value)),
    scoreSetting('답변 방향', '공감', '해결', options.message, (value) => setOverride('message', value)),
    toneType,
    actions
  );
  return settings;
}

function focusDraftCard(entry, selector) {
  renderGeneration();
  const card = [...byId('generation-list').children].find((element) => element.dataset.parentId === entry.thread.parentId);
  card?.querySelector(selector)?.focus();
}

function setDraftText(entry, text) {
  if (entry.text !== text && state.ready === entry) state.ready = null;
  entry.text = text;
}

function applyDraft(entry, draft) {
  setDraftText(entry, draft.text);
  entry.summary = draft.summary;
  entry.variants = draft.variants;
  entry.variant = draft.variant;
  entry.parts = draft.parts;
  entry.approach = draft.approach;
  entry.settings = draft.settings;
  entry.candidate = null;
  entry.error = '';
  if (state.ready === entry) state.ready = null;
}

function draftVariantSelector(entry, draft) {
  const isCandidate = draft !== entry;
  const selector = node('fieldset', 'generation-audience');
  selector.dataset.draftVariants = isCandidate ? 'candidate' : 'current';
  selector.disabled = state.generating || entry.editText !== undefined;
  const choices = node('div', 'choice-row');
  for (const [value, label] of Object.entries(draftVariantLabels)) {
    const choice = node('label');
    const radio = node('input');
    radio.type = 'radio';
    radio.name = 'draft-' + selector.dataset.draftVariants + '-' + entry.thread.parentId;
    radio.value = value;
    radio.checked = draft.variant === value;
    radio.addEventListener('change', () => {
      draft.variant = value;
      setDraftText(draft, draft.variants[value]);
      focusDraftCard(entry, '[data-draft-variants="' + selector.dataset.draftVariants + '"] input:checked');
    });
    choice.append(radio, node('span', '', label));
    choices.append(choice);
  }
  selector.append(node('legend', '', entry.thread.topLevel ? '댓글 버전' : '답글 버전'), choices);
  return selector;
}

function draftParts(parts, variants) {
  const byVariant = {};
  for (const [variant, text] of Object.entries(variants ?? {})) {
    const segments = Object.keys(draftPartLabels).map((key) => parts?.[variant]?.[key]);
    if (segments.some((segment) => typeof segment !== 'string' || !segment.trim())) continue;
    const normalized = segments.map((segment) => segment.trim());
    if (normalized.join(' ') === text) byVariant[variant] = normalized;
  }
  return byVariant;
}

function draftBody(draft) {
  const segments = draft.parts?.[draft.variant];
  if (!segments) return node('p', draft.text ? 'reply-body' : 'hint', draft.text || '아직 작성한 답글이 없습니다.');
  const list = node('dl', 'draft-parts');
  Object.values(draftPartLabels).forEach((label, index) => {
    list.append(node('dt', '', label), node('dd', '', segments[index]));
  });
  return list;
}

function generationCard(entry) {
  const card = node('li', 'generation-card');
  card.dataset.parentId = entry.thread.parentId;
  const head = node('div', 'generation-card-head');
  head.append(node('strong', '', entry.thread.author || 'YouTube 사용자'));
  if (state.ready === entry) head.append(node('span', 'badge', '실행 대상'));
  const original = node('div', 'quoted');
  original.append(node('strong', '', entry.thread.topLevel ? '영상 속 고민' : '원댓글'), node('p', '', entry.thread.text));
  card.append(head, original);
  if (entry.summary && !entry.thread.topLevel) card.append(node('p', 'hint', '원댓글 요약 · ' + entry.summary));
  if (entry.approach) card.append(node('p', 'hint', '작성 방향 · ' + entry.approach));
  if (entry.settings) card.append(node('p', 'hint', '적용 설정 · ' + settingsLabel(entry.settings)));
  if (entry.variants) card.append(draftVariantSelector(entry, entry));
  card.append(draftBody(entry));

  const actions = node('div', 'actions');
  const edit = generationButton('문구 바꾸기', () => {
    entry.editText = entry.text;
    focusDraftCard(entry, 'textarea');
  });
  edit.dataset.action = 'edit';
  edit.disabled ||= entry.editText !== undefined;
  const settings = generationButton(entry.optionsOpen ? '개별 설정 닫기' : '개별 설정', () => {
    entry.optionsOpen = !entry.optionsOpen;
    focusDraftCard(entry, entry.optionsOpen ? '.generation-card-settings input' : '[data-action="settings"]');
  });
  settings.dataset.action = 'settings';
  settings.setAttribute('aria-expanded', String(entry.optionsOpen));
  const regenerate = generationButton(entry.text ? '재생성' : '제작', () => {
    void generateDrafts([entry], true);
  });
  regenerate.disabled ||= entry.editText !== undefined;
  actions.append(edit, settings, regenerate);
  const issue = entry.text ? draftIssue(entry.text) : '';
  if (entry.text) {
    const confirm = generationButton(state.ready === entry ? '실행 대상으로 확정됨' : '실행 대상으로 확정', () => {
      state.ready = entry;
      renderGeneration();
      byId('generate-to-history').focus();
    }, true);
    confirm.disabled ||= Boolean(issue) || state.ready === entry || entry.editText !== undefined;
    actions.append(confirm);
    if (issue) card.append(node('p', 'hint', issue));
  }
  card.append(actions);
  if (entry.optionsOpen) card.append(individualSettings(entry));
  if (entry.editText !== undefined) {
    const editor = node('div', 'generation-card-editor');
    const field = node('textarea');
    field.rows = 3;
    field.maxLength = 2000;
    field.value = entry.editText;
    field.setAttribute('aria-label', (entry.thread.author || '원댓글') + ' 답글 문구');
    field.addEventListener('input', () => { entry.editText = field.value; });
    const buttons = node('div', 'actions');
    buttons.append(
      generationButton('편집 취소', () => {
        delete entry.editText;
        focusDraftCard(entry, '[data-action="edit"]');
      }),
      generationButton('문구 적용', () => {
        const text = entry.editText.trim();
        if (entry.text !== text) {
          if (entry.variants) entry.variants[entry.variant] = text;
          if (entry.parts) delete entry.parts[entry.variant];
          setDraftText(entry, text);
          entry.approach = '';
          entry.candidate = null;
          entry.error = '';
        }
        delete entry.editText;
        focusDraftCard(entry, '[data-action="edit"]');
      }, true)
    );
    editor.append(field, buttons);
    card.append(editor);
  }
  if (entry.candidate) {
    const privateComment = state.video?.privateDraft && entry.thread.topLevel;
    const candidate = node('div', 'generation-card-previous');
    candidate.append(node('strong', '', privateComment ? '새로 만든 댓글' : '새로 만든 답글'));
    if (entry.candidate.approach) candidate.append(node('p', 'hint', '작성 방향 · ' + entry.candidate.approach));
    candidate.append(node('p', 'hint', '개별 설정 · ' + settingsLabel(entry.candidate.settings)));
    if (entry.candidate.variants) candidate.append(draftVariantSelector(entry, entry.candidate));
    candidate.append(draftBody(entry.candidate));
    const buttons = node('div', 'actions');
    buttons.append(
      generationButton(privateComment ? '기존 댓글 유지' : '기존 답글 유지', () => {
        entry.candidate = null;
        focusDraftCard(entry, '[data-action="settings"]');
      }),
      generationButton(privateComment ? '새 댓글 적용' : '새 답글 적용', () => {
        applyDraft(entry, entry.candidate);
        entry.optionsOpen = false;
        focusDraftCard(entry, '[data-action="edit"]');
      }, true)
    );
    candidate.append(buttons);
    card.append(candidate);
  }
  if (entry.running || entry.error) {
    const notice = node('p', 'generation-card-status status', entry.running ? '이 댓글의 답글을 작성하고 있습니다…' : entry.error);
    notice.setAttribute('role', 'status');
    notice.dataset.type = entry.error ? 'error' : '';
    card.append(notice);
  }
  return card;
}

function renderGeneration() {
  const entries = selectedGenerations();
  byId('generate-count').textContent = state.generationMode === 'topLevel' ? '영상에 남길 새 댓글' : '선택한 댓글 ' + entries.length + '개';
  byId('generate-open').disabled = state.generating || !entries.length;
  byId('generation-list').replaceChildren(...entries.map(generationCard));
  renderReplyControls();
}

function openGenerationDialog(settingsOnly = false) {
  const entries = selectedGenerations();
  if (!entries.length || generateDialog.open || state.generating) return;
  const count = entries.filter((entry) => !entry.text).length;
  const topLevel = state.generationMode === 'topLevel';
  const countLabel = byId('generate-dialog-count');
  countLabel.hidden = settingsOnly;
  countLabel.textContent = topLevel ? '영상 분석 결과를 바탕으로 새 댓글을 작성합니다.' : count
    ? '선택한 댓글 중 ' + count + '개에 답글을 작성합니다.'
    : '선택한 댓글 ' + entries.length + '개의 새 답글을 만들고 기존 초안은 남겨둡니다.';
  if (!settingsOnly) state.generationSelectionChanged = false;
  generateDialog.dataset.mode = settingsOnly ? 'settings' : 'generation';
  byId('generate-dialog-title').textContent = settingsOnly ? '공통 설정' : topLevel ? '새 댓글 제작' : '답글 제작';
  byId('generate-dialog-hint').hidden = !settingsOnly;
  byId('generate-prompt-field').hidden = settingsOnly;
  byId('generate-prompt').value = state.generationPrompt;
  byId('generate-settings').hidden = !settingsOnly;
  const toggle = byId('generate-settings-toggle');
  toggle.hidden = settingsOnly;
  toggle.setAttribute('aria-expanded', 'false');
  byId('generate-now').textContent = settingsOnly ? '설정 저장' : '바로 제작';
  const { tone, message, audience } = state.generationSettings;
  byId('generate-tone').value = tone;
  byId('generate-tone-value').value = tone;
  byId('generate-intent').value = message;
  byId('generate-intent-value').value = message;
  for (const radio of generateDialog.querySelectorAll('[name="generate-audience"]')) {
    radio.checked = radio.value === audience;
  }
  generateDialog.showModal();
  if (settingsOnly) byId('generate-tone').focus();
}

async function generateDrafts(entries, individual = false) {
  if (!entries.length || state.generating) return;
  state.generating = true;
  status('generate-status', 'AI로 답글을 작성하고 있습니다…');
  const prompt = state.generationPrompt;
  const brandPosition = brandPositionInput.value.trim();
  let completed = 0;
  let stoppedAtLimit = false;
  for (const entry of entries) {
    entry.running = true;
    entry.error = '';
    renderGeneration();
    try {
      const settings = entry.overrideSettings ?? state.generationSettings;
      const { threadId, channelTitle, text, ...target } = replyPayload(entry.thread, entry.text);
      const previous = entry.text ? { previousText: entry.text } : {};
      const commentMode = entry.thread.topLevel ? 'topLevel' : undefined;
      const result = await api('/api/ai/draft', {
        ...target, ...previous, videoDescription: state.video.description, videoAnalysis: state.videoAnalysis,
        ...(state.video.privateDraft ? { privateDraft: true } : {}),
        commentMode, settings, prompt, brandPosition, variants: true
      });
      if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('AI가 답글을 반환하지 않았습니다.');
      const { clean, expressive } = result.variants ?? {};
      const variants = typeof clean === 'string' && typeof expressive === 'string' && clean.trim() && expressive.trim()
        ? { clean: clean.trim(), expressive: expressive.trim() } : null;
      const variant = variants ? entry.variant ?? 'clean' : null;
      const draft = {
        text: variants ? variants[variant] : result.text.trim(),
        summary: typeof result.summary === 'string' ? result.summary.trim() : '',
        approach: typeof result.approach === 'string' ? result.approach : '',
        settings: { ...settings },
        variants,
        variant,
        parts: draftParts(result.parts, variants)
      };
      if (entry.text) entry.candidate = draft;
      else applyDraft(entry, draft);
      completed++;
    } catch (error) {
      entry.error = error.message;
      if (error.code === 'aiLimit') {
        stoppedAtLimit = true;
        break;
      }
    } finally {
      entry.running = false;
    }
  }
  state.generating = false;
  if (stoppedAtLimit) {
    const summary = (completed ? completed + '개 제작 완료 · ' : '') + 'AI 사용량 한도로 제작을 멈췄습니다.';
    status('generate-status', summary, 'warn');
  } else if (completed) {
    const summary = individual && entries[0].candidate
      ? '새 답글을 확인한 뒤 적용할 수 있습니다.'
      : completed + '개 제작 완료' + (completed < entries.length ? ' · ' + (entries.length - completed) + '개 제작 실패' : '');
    status('generate-status', summary, completed === entries.length ? 'success' : 'warn');
  } else {
    status('generate-status', '답글을 제작하지 못했습니다. 카드에서 오류를 확인해 주세요.', 'error');
  }
  renderGeneration();
}

function draftIssue(value) {
  const length = Array.from(value).length;
  if (length < 40 || length > 120) return '게시하려면 공백을 포함해 40~120자로 작성하세요.';
  if (/#|https?:\/\/|www\.|\b(?:[a-z0-9-]+\.)+[a-z]{2,24}(?=[/?#:\s.,!)]|$)/i.test(value)) return '링크와 해시태그를 지워 주세요.';
  if (!value.includes('운명원')) return '답글에 운명원을 넣어 주세요.';
  return '';
}

function publishIssue(value) {
  if (state.unknown.has(state.video?.id)) return '게시 요청의 결과를 확인할 수 없습니다. 게시 및 기록을 확인하세요.';
  const existing = state.history.find((record) => record.videoId === state.video?.id && ['posting', 'posted', 'uncertain'].includes(record.status));
  if (existing) {
    if (existing.status === 'posted') return '이 영상에 게시한 기록이 있습니다. 영상당 답글은 1개까지입니다.';
    return '이 영상에 게시 진행 또는 확인 보류 기록이 있습니다.';
  }
  if (state.limits && state.limits.used >= state.limits.max) return '오늘 게시 한도에 도달했습니다.';
  return draftIssue(value);
}

function renderReplyControls() {
  const length = Array.from(replyText.value.trim()).length;
  byId('reply-count').textContent = length + ' / 120자';
  const locked = state.loadingVideo || state.loadingLatest || state.analyzingVideo ||
    state.posting || state.saving || state.generating;
  const privateDraft = state.video?.privateDraft === true;
  const count = selectedGenerations().length;
  const replyCount = selectedGenerations('reply').length;
  for (const button of nav) {
    button.disabled = locked || (button.dataset.screen === 'comments' && (!state.video || privateDraft)) ||
      (button.dataset.screen === 'generate' && !count);
  }
  const videoLocked = locked || state.loadingThreads;
  byId('load-video').disabled = videoLocked || privateVideoOptions.open;
  byId('video-url').readOnly = locked || state.loadingThreads;
  byId('load-latest').disabled = videoLocked || privateVideoOptions.open;
  byId('analyze-private-video').disabled = videoLocked;
  byId('private-video-title').readOnly = videoLocked;
  byId('private-video-captions').disabled = videoLocked;
  byId('analyze-video').disabled = videoLocked || privateDraft;
  byId('write-video-comment').disabled = locked || state.loadingThreads || !state.videoAnalysis;
  byId('show-comments').disabled = locked || privateDraft;
  for (const button of byId('latest-videos').querySelectorAll('button[data-video-id]')) {
    button.disabled = locked || state.loadingThreads;
    button.setAttribute('aria-pressed', String(button.dataset.videoId === state.video?.id));
  }
  byId('open-generation').disabled = !replyCount || locked;
  byId('generation-selection-count').textContent = '선택한 댓글 ' + replyCount + '개';
  byId('generate-to-history').disabled = !state.ready || locked;
  const issue = state.ready && !privateDraft ? publishIssue(state.ready.text) : '';
  byId('reply-guidance').textContent = length ? draftIssue(replyText.value.trim()) || '작성한 답글을 03번으로 가져갈 수 있습니다.' : '40~120자 · 운명원 언급 · 링크와 해시태그 없이';
  byId('save-reply').disabled = !state.selected || !length || state.saving || state.posting;
  byId('review-reply').disabled = !state.selected || locked;
  const publishDisabled = privateDraft || !state.ready || Boolean(issue) || locked || state.loadingThreads;
  byId('start-publish').disabled = publishDisabled || Boolean(state.ready?.thread.topLevel);
  byId('profile-publish').disabled = publishDisabled;
  byId('start-publish').hidden = privateDraft;
  byId('profile-publish').hidden = privateDraft;
  byId('refresh-history').hidden = privateDraft;
  byId('history-records').hidden = privateDraft;
  byId('history-title').textContent = privateDraft ? '초안 미리보기' : '실행하기';
  byId('history-intro').textContent = privateDraft ? '확정한 댓글 문구를 확인합니다.' : '확정한 답글 한 건을 게시하고 결과를 기록합니다.';
  byId('publish-target-caption').textContent = privateDraft ? '댓글 초안' : '게시 대상';
  byId('choose-publish-target').disabled = locked;
  byId('choose-publish-target').textContent = privateDraft ? '초안으로 돌아가기' : '선택하기';
  byId('publish-target-label').textContent = state.ready
    ? state.video.title + ' · ' + state.ready.thread.author
    : privateDraft ? '03번에서 댓글 초안을 확정하세요.' : '03번에서 게시할 답글을 확정하세요.';
  byId('publish-target-text').textContent = state.ready?.text ?? '';
  byId('publish-target-text').hidden = !state.ready;
  status('publish-target-hint', issue);
  byId('close-reply').disabled = state.saving || state.posting;
  byId('reload-comments').disabled = state.loadingThreads || state.posting;
  byId('more-threads').disabled = state.loadingThreads || state.posting;
  replyText.readOnly = state.saving || state.posting;
}

function replyPayload(thread, text) {
  const { video } = state;
  return {
    videoId: video.id,
    videoTitle: video.title,
    channelTitle: video.channelTitle || '',
    threadId: thread.id,
    parentId: thread.parentId,
    parentAuthor: thread.author || '',
    parentText: thread.text || '',
    text
  };
}

function updateRecord(record) {
  if (!record) return;
  state.history = [record, ...state.history.filter((item) => item.id !== record.id)];
  renderHistory();
}

function historyItem(record, opened) {
  const item = node('li', 'history-item');
  const details = node('details');
  details.dataset.recordId = record.id;
  details.open = opened;
  const summary = node('summary');
  const label = record.source === 'public' && record.status === 'posting' ? '게시 확인 대기' : statusLabels[record.status];
  const badge = node('span', 'badge', label || '기록');
  badge.dataset.status = record.status;
  const when = node('time', '', formatted(record.updatedAt || record.createdAt, dateTime));
  summary.append(badge, when, node('span', '', record.videoTitle || record.videoId));
  const body = node('div', 'record-body');
  const context = [record.channelTitle, record.accountTitle && '게시 계정 ' + record.accountTitle].filter(Boolean).join(' · ');
  if (context) body.append(node('p', 'muted', context));
  if (record.parentAuthor || record.parentText) {
    const quote = node('div', 'quoted');
    quote.append(node('strong', '', record.parentAuthor ? '원댓글 · ' + record.parentAuthor : '원댓글'));
    if (record.parentText) quote.append(node('p', '', record.parentText));
    body.append(quote);
  }
  body.append(node('p', 'reply-body', record.text));
  if (record.message) body.append(node('p', 'hint', record.message));
  const link = allowedLink(record.replyUrl, new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']));
  if (link) {
    const anchor = node('a', '', 'YouTube에서 게시한 답글 보기 ↗');
    anchor.href = link;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    body.append(anchor);
  }
  if (record.source === 'public' && ['posting', 'uncertain'].includes(record.status)) {
    const actions = node('div', 'actions');
    const check = node('button', 'button', '게시 확인 열기');
    check.type = 'button';
    check.addEventListener('click', () => {
      if (state.posting || state.saving) return;
      const item = state.video?.id === record.videoId ? state.threads.get(record.threadId) : null;
      openReview({ payload: record, item, record, handedOff: true });
    });
    actions.append(check);
    body.append(actions);
  }
  details.append(summary, body);
  item.append(details);
  return item;
}

function renderHistory() {
  const list = byId('history-list');
  const open = new Set([...list.querySelectorAll('details[open]')].map((details) => details.dataset.recordId));
  list.replaceChildren(...state.history.map((record) => historyItem(record, open.has(String(record.id)))));
  byId('quota-label').textContent = state.limits ? state.limits.used + ' / ' + state.limits.max + '건' : '—';
  renderReplyControls();
}

let historyRequest = 0;
async function loadHistory() {
  const request = ++historyRequest;
  byId('refresh-history').disabled = true;
  try {
    const result = await api('/api/history');
    if (request !== historyRequest) return;
    state.history = result.records;
    state.limits = result.limits;
    renderHistory();
    status('history-status', state.history.length ? '' : '아직 작성하거나 게시한 기록이 없습니다.');
  } catch (error) {
    if (request === historyRequest) status('history-status', error.message, 'error');
  } finally {
    if (request === historyRequest) byId('refresh-history').disabled = false;
  }
}

for (const button of nav) button.addEventListener('click', () => showScreen(button.dataset.screen));
byId('load-latest').addEventListener('click', () => void loadLatestVideos());
byId('analyze-video').addEventListener('click', () => void analyzeVideo());
byId('write-video-comment').addEventListener('click', openVideoComment);
byId('show-comments').addEventListener('click', () => showScreen('comments'));
byId('reload-comments').addEventListener('click', () => void loadThreads());
byId('more-threads').addEventListener('click', () => void loadThreads(true));
byId('open-generation').addEventListener('click', () => {
  chooseGenerationMode('reply');
  showScreen('generate');
});
byId('generate-open').addEventListener('click', () => openGenerationDialog(true));
byId('generate-to-history').addEventListener('click', () => {
  if (!state.ready) return;
  showScreen('history');
  (byId('start-publish').disabled ? byId('choose-publish-target') : byId('start-publish')).focus();
});
byId('generate-cancel').addEventListener('click', () => generateDialog.close());
byId('generate-settings-toggle').addEventListener('click', (event) => {
  const settings = byId('generate-settings');
  settings.hidden = !settings.hidden;
  event.currentTarget.setAttribute('aria-expanded', String(!settings.hidden));
  byId('generate-now').textContent = settings.hidden ? '바로 제작' : '이 설정으로 제작';
  if (!settings.hidden) byId('generate-tone').focus();
});
for (const name of ['tone', 'intent']) {
  byId('generate-' + name).addEventListener('input', (event) => {
    byId('generate-' + name + '-value').value = event.currentTarget.value;
  });
}
byId('generate-now').addEventListener('click', () => {
  if (!byId('generate-settings').hidden) {
    state.generationSettings = {
      tone: Number(byId('generate-tone').value),
      message: Number(byId('generate-intent').value),
      audience: generateDialog.querySelector('[name="generate-audience"]:checked').value
    };
  }
  generateDialog.close();
  if (generateDialog.dataset.mode === 'settings') {
    renderGeneration();
    status('generate-status', '공통 설정을 저장했습니다.', 'success');
    return;
  }
  state.generationPrompt = byId('generate-prompt').value.trim();
  const entries = selectedGenerations();
  const unwritten = entries.filter((entry) => !entry.text);
  void generateDrafts(unwritten.length ? unwritten : entries);
});
byId('refresh-history').addEventListener('click', () => void loadHistory());
byId('choose-publish-target').addEventListener('click', () => {
  if (!state.video) {
    showScreen('video');
    byId('video-url').focus();
    return;
  }
  if (selectedGenerations().length) {
    showScreen('generate');
    return;
  }
  if (state.video.privateDraft) {
    showScreen('video');
    byId('write-video-comment').focus();
    return;
  }
  showScreen('comments');
  (state.selected?.row ?? byId('thread-list').querySelector('button.thread-row') ?? byId('reload-comments')).focus();
});
byId('close-reply').addEventListener('click', () => {
  const row = state.selected?.row;
  closeComposer();
  renderReplyControls();
  row?.focus();
});
replyText.addEventListener('input', () => {
  if (state.selected) state.drafts.set(draftKey(state.selected), replyText.value);
  status('reply-status');
  renderReplyControls();
});

byId('video-url').addEventListener('paste', (event) => {
  const field = event.currentTarget;
  setTimeout(() => {
    if (!privateVideoOptions.open && isVideoLink(field.value.trim())) field.form.requestSubmit();
  }, 0);
});

byId('video-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void loadVideo(byId('video-url').value.trim());
});

privateVideoOptions.addEventListener('toggle', () => {
  const privateMode = privateVideoOptions.open;
  byId('latest-public').hidden = privateMode;
  byId('load-video').hidden = privateMode;
  byId('video-hint').textContent = privateMode ? '내 영상의 링크를 입력한 뒤 아래에서 자막을 선택하세요.' :
    '링크를 붙여넣으면 공개 영상 정보가 표시됩니다.';
  if (privateMode) status('video-status');
  renderReplyControls();
});

byId('private-video-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void analyzePrivateVideo();
});

byId('save-reply').addEventListener('click', async () => {
  if (!state.selected || state.saving || state.posting) return;
  const text = replyText.value.trim();
  if (!text) return;
  state.saving = true;
  renderReplyControls();
  const item = state.selected;
  try {
    const result = await api('/api/chrome/drafts', replyPayload(item.thread, text));
    updateRecord(result.record);
    if (state.selected === item) status('reply-status', '작성 기록에 저장했습니다.', 'success');
    void loadHistory();
  } catch (error) {
    if (state.selected === item) status('reply-status', error.message, 'error');
  } finally {
    state.saving = false;
    renderReplyControls();
  }
});

byId('review-reply').addEventListener('click', () => {
  if (!state.selected) return;
  chooseGenerationMode('reply');
  setGenerationSelected(state.selected, true, replyText.value.trim());
  showScreen('generate');
});

function openReview(confirmation) {
  const { payload, record } = confirmation;
  state.confirmation = confirmation;
  byId('review-video').textContent = payload.videoTitle;
  byId('review-parent-author').textContent = payload.parentAuthor;
  byId('review-parent-text').textContent = payload.parentText;
  byId('review-text').textContent = payload.text;
  byId('open-original').href = watchLink(payload.videoId, payload.parentId);
  byId('manual-handoff').hidden = !record;
  byId('verify-publish').hidden = !record;
  byId('retry-publish').hidden = true;
  byId('cancel-publish').textContent = confirmation.handedOff ? '닫기' : '취소';
  status('global-status');
  status('publish-status', record?.message, record?.status === 'uncertain' ? 'warn' : '');
  dialog.showModal();
}

function setPublishing(busy) {
  state.posting = busy;
  byId('cancel-publish').disabled = busy;
  byId('retry-publish').disabled = busy;
  byId('verify-publish').disabled = busy;
  byId('copy-reply').disabled = busy;
  renderReplyControls();
}

function endPublishing() {
  setPublishing(false);
  void loadHistory();
}

async function prepareManualReply() {
  const confirmation = state.confirmation;
  if (!confirmation || confirmation.record || state.posting) return;
  const { payload } = confirmation;
  setPublishing(true);
  byId('retry-publish').hidden = true;
  status('publish-status', '원댓글과 기존 답글을 확인하는 중입니다…');
  try {
    const { record } = await api('/api/public/replies/start', payload).catch((error) => {
      if (error.code === 'requestInProgress' && error.record?.source === 'public') return { record: error.record };
      throw error;
    });
    state.unknown.delete(payload.videoId);
    updateRecord(record);
    if (!['posting', 'uncertain'].includes(record.status)) throw new Error('게시 요청의 상태는 게시 및 기록에서 확인해 주세요.');
    confirmation.record = record;
    if (record.status === 'uncertain') markHandoff();
    byId('manual-handoff').hidden = false;
    byId('verify-publish').hidden = false;
    status('publish-status', record.message, record.status === 'uncertain' ? 'warn' : '');
  } catch (error) {
    updateRecord(error.record);
    if (error.transportError) state.unknown.add(payload.videoId);
    byId('retry-publish').hidden = false;
    status('publish-status', error.message, error.transportError ? 'warn' : 'error');
  } finally {
    endPublishing();
    if (confirmation.record && dialog.open) byId('copy-reply').focus();
  }
}

function markHandoff() {
  if (!state.confirmation?.record) return;
  state.confirmation.handedOff = true;
  byId('cancel-publish').textContent = '닫기';
}

async function closeReview() {
  if (state.posting || !state.confirmation) return;
  const { record, handedOff } = state.confirmation;
  if (!record || handedOff) {
    dialog.close();
    return;
  }
  setPublishing(true);
  byId('manual-handoff').hidden = true;
  try {
    const result = await api('/api/chrome/replies/finish', {
      recordId: record.id,
      status: 'failed',
      message: 'YouTube에서 원댓글을 열기 전에 취소했습니다.'
    });
    updateRecord(result.record);
    dialog.close();
  } catch (error) {
    updateRecord(error.record);
    byId('manual-handoff').hidden = false;
    status('publish-status', error.message, 'error');
  } finally {
    endPublishing();
  }
}

byId('start-publish').addEventListener('click', () => {
  if (byId('start-publish').disabled || !state.ready) return;
  const { thread, text } = state.ready;
  const payload = { ...replyPayload(thread, text), requestId: crypto.randomUUID() };
  openReview({ payload, item: state.threads.get(thread.id) });
  void prepareManualReply();
});

const profileDialog = byId('profile-dialog');
const profileProgress = {
  opening: 'Chrome 프로필에서 영상 여는 중…',
  typing: '한 글자씩 입력하는 중…',
  verifying: 'YouTube에서 게시된 댓글을 확인하는 중…',
};

function chromeBridge(action, payload, showProgress) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => {
      window.removeEventListener('message', received);
      reject(new Error(action === 'ping'
        ? '선택한 Chrome 프로필에 작업실 확장을 연결한 뒤 이 페이지를 Chrome에서 열어 주세요.'
        : 'Chrome 응답이 지연됩니다. 해당 YouTube 탭의 게시 여부를 먼저 확인하세요.'));
    }, action === 'ping' ? 1800 : 90_000);
    function received(event) {
      const message = event.data;
      if (event.source !== window || event.origin !== location.origin ||
          message?.source !== 'unmyeongwon-chrome' || message.id !== id) return;
      if (typeof message.ok !== 'boolean') {
        if (Object.hasOwn(profileProgress, message.progress)) showProgress?.(profileProgress[message.progress]);
        return;
      }
      clearTimeout(timeout);
      window.removeEventListener('message', received);
      if (message.ok) resolve(message.result);
      else reject(new Error(message.error?.message || 'Chrome 게시 상태를 확인하지 못했습니다.'));
    }
    window.addEventListener('message', received);
    window.postMessage({ source: 'unmyeongwon-studio', id, action, payload }, location.origin);
  });
}

byId('profile-publish').addEventListener('click', () => {
  if (byId('profile-publish').disabled || !state.ready) return;
  const { thread, text } = state.ready;
  byId('profile-target').textContent = state.video.title + ' · ' + (thread.topLevel ? '새 댓글' : thread.author + '님에게 답글');
  byId('profile-text').textContent = text;
  profileDialog.showModal();
  byId('profile-cancel').focus();
});
byId('profile-cancel').addEventListener('click', () => profileDialog.close());
byId('profile-confirm').addEventListener('click', () => {
  if (state.ready && !state.posting) void publishInProfile();
});

async function publishInProfile() {
  if (state.video?.privateDraft) return;
  const { thread, text } = state.ready;
  const topLevel = thread.topLevel === true;
  const payload = { ...replyPayload(thread, text), topLevel, requestId: crypto.randomUUID() };
  profileDialog.close();
  setPublishing(true);
  status('profile-status', 'Chrome 프로필 연결을 확인하는 중…');
  let record;
  try {
    const connection = await chromeBridge('ping');
    if (!connection?.connected) throw new Error('Chrome 프로필 연결을 확인하지 못했습니다.');
    ({ record } = await api('/api/chrome/replies/start', payload));
    updateRecord(record);
    const result = await chromeBridge(topLevel ? 'postComment' : 'postReply', {
      recordId: record.id, videoId: payload.videoId, parentId: topLevel ? undefined : payload.parentId, text,
    }, (message) => status('profile-status', message));
    const finished = await api('/api/chrome/replies/finish', { ...result, recordId: record.id });
    record = null;
    updateRecord(finished.record);
    if (finished.record.status === 'posted') {
      state.ready = null;
      status('profile-status', '게시된 댓글을 확인해 기록했습니다.', 'success');
    } else {
      status('profile-status', finished.record.message || '게시 결과를 확인해 주세요.', 'warn');
    }
  } catch (error) {
    updateRecord(error.record);
    if (record) {
      try {
        const result = await api('/api/chrome/replies/finish', { recordId: record.id, status: 'uncertain', message: error.message });
        updateRecord(result.record);
      } catch {
        state.unknown.add(payload.videoId);
      }
    } else if (error.transportError) {
      state.unknown.add(payload.videoId);
    }
    status('profile-status', error.message, 'error');
  } finally {
    endPublishing();
  }
}

byId('retry-publish').addEventListener('click', () => void prepareManualReply());
byId('cancel-publish').addEventListener('click', () => void closeReview());
dialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  void closeReview();
});
dialog.addEventListener('close', () => { if (!dialog.open) state.confirmation = null; });

for (const event of ['click', 'auxclick', 'contextmenu', 'dragstart']) {
  byId('open-original').addEventListener(event, markHandoff);
}

byId('copy-reply').addEventListener('click', async () => {
  const confirmation = state.confirmation;
  if (!confirmation?.record || state.posting) return;
  markHandoff();
  try {
    await navigator.clipboard.writeText(confirmation.payload.text);
    if (state.confirmation === confirmation && !state.posting) status('publish-status', '답글을 복사했습니다.');
  } catch {
    if (state.confirmation !== confirmation || state.posting) return;
    const range = document.createRange();
    range.selectNodeContents(byId('review-text'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    status('publish-status', '선택된 답글을 복사해 주세요.');
  }
});

byId('verify-publish').addEventListener('click', async () => {
  const confirmation = state.confirmation;
  if (!confirmation?.record || state.posting) return;
  const { record, item } = confirmation;
  markHandoff();
  setPublishing(true);
  status('publish-status', 'YouTube에서 새 답글을 확인하는 중입니다…');
  try {
    const result = await api('/api/public/replies/verify', { recordId: record.id });
    confirmation.record = result.record;
    updateRecord(result.record);
    if (result.record.status !== 'posted') {
      status('publish-status', result.message || result.record.message || '아직 공개 답글에서 찾지 못했습니다. 잠시 뒤 다시 확인하세요.', 'warn');
      return;
    }
    const { reply } = result;
    if (item && reply && !item.replies.has(reply.id)) {
      item.replies.set(reply.id, reply);
      item.thread.replyCount = Math.max(item.thread.replyCount, item.replies.size);
      replyDetails(item);
      renderReplyList(item);
      item.replyDetails.open = true;
    }
    state.drafts.delete(record.videoId + ':' + record.parentId);
    if (state.video?.id === record.videoId && state.ready?.thread.parentId === record.parentId) state.ready = null;
    if (item && state.selected === item) closeComposer();
    dialog.close();
    status('global-status', 'YouTube에서 게시된 답글을 확인해 기록했습니다.', 'success');
  } catch (error) {
    updateRecord(error.record);
    status('publish-status', error.message, 'error');
  } finally {
    endPublishing();
  }
});

const brandPositionHint = byId('brand-position-hint');
const brandPositionStorageError = '이 브라우저에서는 입력이 저장되지 않습니다. 현재 페이지에서 AI 작성에 사용할 수 있습니다.';
try {
  const storedPosition = localStorage.getItem(brandPositionKey) ?? '';
  brandPositionInput.value = storedPosition.slice(0, brandPositionInput.maxLength);
} catch {
  brandPositionHint.textContent = brandPositionStorageError;
}
brandPositionInput.addEventListener('input', () => {
  try {
    localStorage.setItem(brandPositionKey, brandPositionInput.value);
  } catch {
    brandPositionHint.textContent = brandPositionStorageError;
  }
});

void loadHistory();
