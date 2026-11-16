import { existsSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGoogleSession, createYouTube } from './google.mjs';
import { createStore, publicRecord, StudioError } from './store.mjs';
import { createPublicReader } from './public-reader.mjs';
import { createDraftGenerator, createVideoAnalyzer } from './ai.mjs';
import { canSaveLocalGeminiKey, loadLocalGeminiKey, saveLocalGeminiKey } from './local-gemini-key.mjs';

const appDir = fileURLToPath(new URL('.', import.meta.url));
const workspaceDataDir = resolve(appDir, '../../work/unmyeongwon-studio-data');
const defaultDataDir = basename(resolve(appDir, '..')) === 'outputs' && existsSync(workspaceDataDir)
  ? workspaceDataDir : resolve(appDir, '.studio-data');
const videoPattern = /^[A-Za-z0-9_-]{11}$/;
const commentPattern = /^[A-Za-z0-9._-]{1,256}$/;
const requestPattern = /^[A-Za-z0-9_-]{8,128}$/;
const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const maxBodyBytes = 64 * 1024;
const maxPrivateCaptionsBytes = 32 * 1024;
const maxPrivateContextCues = 16;
const srtTimeline = /^(\d{2}:[0-5]\d:[0-5]\d[,.]\d{3})[ \t]*-->[ \t]*(\d{2}:[0-5]\d:[0-5]\d[,.]\d{3})$/u;
const fileRoutes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const securityHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'",
    "img-src 'self' https://i.ytimg.com https://i9.ytimg.com https://img.youtube.com https://yt3.ggpht.com https://yt3.googleusercontent.com https://lh3.googleusercontent.com",
    'frame-src https://www.youtube-nocookie.com', "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; '),
};

function checkId(value, pattern, message) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new StudioError(400, 'invalidId', message);
  }
  return value;
}

export function parseVideoUrl(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  let url;
  try {
    if (!input || input.length > 2048) throw new Error();
    url = new URL(input.includes('://') ? input : `https://${input}`);
  } catch {
    throw new StudioError(400, 'invalidVideoUrl', 'YouTube 영상 링크를 입력해 주세요.');
  }
  let id;
  if (['https:', 'http:'].includes(url.protocol) && !url.port && !url.username && !url.password) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.hostname === 'youtu.be' && parts.length === 1) id = parts[0];
    if (youtubeHosts.has(url.hostname)) {
      if (url.pathname === '/watch') id = url.searchParams.get('v');
      else if (parts.length === 2 && ['shorts', 'live', 'embed'].includes(parts[0])) id = parts[1];
    }
  }
  if (typeof id !== 'string' || !videoPattern.test(id)) {
    throw new StudioError(400, 'invalidVideoUrl', '일반 영상, 공유 링크, 쇼츠 또는 라이브 영상의 YouTube 링크를 입력해 주세요.');
  }
  return id;
}

function readPrivateTranscript(captions) {
  if (typeof captions === 'string' && Buffer.byteLength(captions, 'utf8') > maxPrivateCaptionsBytes) {
    throw new StudioError(413, 'privateCaptionsTooLarge', '자막 파일은 32KB 이하로 올려 주세요.');
  }
  const invalid = new StudioError(400, 'invalidPrivateCaptions', '시작·종료 시간과 자막 문장이 있는 SRT 파일을 올려 주세요.');
  if (typeof captions !== 'string' || !captions.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(captions)) {
    throw invalid;
  }
  return captions.replace(/\r\n?/gu, '\n').trim().split(/\n(?:[ \t]*\n)+/u).map((block) => {
    const lines = block.split('\n');
    if (/^\d+$/u.test(lines[0].trim())) lines.shift();
    const timeline = srtTimeline.exec(lines.shift()?.trim() ?? '');
    const text = lines.join(' ').replace(/\s+/gu, ' ').trim();
    if (!timeline || !text || lines.some((line) => srtTimeline.test(line.trim()))) throw invalid;
    const start = timeline[1].replace('.', ',');
    const end = timeline[2].replace('.', ',');
    if (start >= end) throw invalid;
    return { timestamp: start, text };
  });
}

function privateCaptionContext(transcript) {
  const selected = transcript.length <= maxPrivateContextCues ? transcript : Array.from(
    { length: maxPrivateContextCues },
    (_, index) => transcript[Math.round(index * (transcript.length - 1) / (maxPrivateContextCues - 1))],
  );
  return selected.map(({ timestamp, text }) => ({ timestamp, text: [...text].slice(0, 240).join('') }));
}

function readCursor(url) {
  const cursor = url.searchParams.get('cursor');
  if (cursor && (cursor.length > 1024 || /[\x00-\x1f\x7f]/.test(cursor))) {
    throw new StudioError(400, 'invalidCursor', '댓글 목록을 처음부터 다시 불러와 주세요.');
  }
  return cursor || undefined;
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers['content-type'] ?? '')) {
    throw new StudioError(415, 'expectedJson', '요청은 JSON 형식이어야 합니다.');
  }
  if (Number(request.headers['content-length']) > maxBodyBytes) {
    request.resume();
    throw new StudioError(413, 'requestTooLarge', '요청 내용이 너무 큽니다.');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) {
      request.resume();
      throw new StudioError(413, 'requestTooLarge', '요청 내용이 너무 큽니다.');
    }
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    // The request body is untrusted and is never included in the response.
  }
  throw new StudioError(400, 'invalidJson', '요청 내용을 읽을 수 없습니다.');
}

function readReplyInput(body, publishing, allowTopLevel = false) {
  const videoId = checkId(body.videoId, videoPattern, '올바른 영상 ID가 필요합니다.');
  const topLevel = allowTopLevel && body.topLevel === true;
  const threadId = topLevel ? videoId : checkId(body.threadId, commentPattern, '답글을 달 원댓글을 선택해 주세요.');
  const parentId = topLevel ? '' : checkId(body.parentId, commentPattern, '답글을 달 원댓글을 선택해 주세요.');
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const length = [...text].length;
  if (!text || length > 5000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
    throw new StudioError(400, 'invalidReply', '답글 내용을 입력해 주세요.');
  }
  if (!publishing) return { videoId, threadId, parentId, text };
  validatePublishText(text);
  const requestId = checkId(body.requestId, requestPattern, '게시 요청 식별자가 올바르지 않습니다.');
  return { videoId, threadId, parentId, text, requestId };
}

function validatePublishText(text) {
  const length = [...text].length;
  if (length < 40 || length > 120) {
    throw new StudioError(400, 'replyLength', '게시할 답글은 40~120자로 입력해 주세요.');
  }
  if (!text.includes('운명원')) {
    throw new StudioError(400, 'brandRequired', '게시할 답글에 운명원을 포함해 주세요.');
  }
  if (/#|https?:\/\/|www\.|\b(?:[a-z0-9-]+\.)+[a-z]{2,24}(?=[/?#:\s.,!)]|$)/i.test(text)) {
    throw new StudioError(400, 'replyLinks', '링크와 해시태그를 지운 뒤 게시해 주세요.');
  }
}

function chromeText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function readChromeTarget(body, publishing, allowTopLevel = false) {
  const input = readReplyInput(body, publishing, allowTopLevel);
  return {
    ...input,
    videoTitle: chromeText(body.videoTitle, 250),
    channelTitle: chromeText(body.channelTitle, 250),
    parentAuthor: chromeText(body.parentAuthor, 250),
    parentText: chromeText(body.parentText, 5000),
    accountTitle: 'Chrome 프로필'
  };
}

function finishChromeReply(store, body) {
  const recordId = checkId(body.recordId, requestPattern, '게시 기록을 찾을 수 없습니다.');
  const record = store.findRecord(recordId);
  if (!record?.requestId?.startsWith('chrome:') &&
      !(record?.requestId?.startsWith('public:') && body.status === 'failed')) {
    throw new StudioError(404, 'recordNotFound', 'Chrome 게시 기록을 찾을 수 없습니다.');
  }
  const { status } = body;
  if (!['posted', 'failed', 'uncertain'].includes(status)) {
    throw new StudioError(400, 'invalidStatus', 'Chrome 게시 결과가 올바르지 않습니다.');
  }
  if (record.status === 'posted' && status === 'posted' && record.replyId === body.reply?.id) {
    return { record: publicRecord(record), reply: JSON.parse(record.replyJson) };
  }
  if (record.status === status && status !== 'posted') return { record: publicRecord(record) };
  if (record.status !== 'posting' && !(record.status === 'uncertain' && status === 'posted')) {
    throw new StudioError(409, 'recordClosed', '이 게시 기록은 이미 처리됐습니다.', record);
  }
  if (status !== 'posted') {
    const fallback = status === 'uncertain'
      ? 'Chrome에서 게시 결과를 확인하지 못했습니다. YouTube에서 답글을 확인해 주세요.'
      : 'Chrome 답글 작성이 게시 전에 중단됐습니다.';
    return { record: publicRecord(store.finish(record.id, status, chromeText(body.message, 400) || fallback)) };
  }
  const reply = body.reply;
  const replyId = checkId(reply?.id, commentPattern, '게시된 답글 ID를 확인할 수 없습니다.');
  const author = chromeText(reply?.author, 250);
  const parentMatches = record.parentId ? reply.parentId === record.parentId : reply.parentId === undefined || reply.parentId === '';
  if (replyId === record.parentId || !parentMatches || !author ||
      typeof reply.text !== 'string' || reply.text.trim() !== record.text) {
    throw new StudioError(409, 'replyMismatch', '게시된 답글과 선택한 원댓글 또는 작성 내용이 일치하지 않습니다.', record);
  }
  const verified = { id: replyId, parentId: record.parentId, author, text: record.text };
  const replyUrl = `https://www.youtube.com/watch?v=${record.videoId}&lc=${encodeURIComponent(replyId)}`;
  return { record: publicRecord(store.finish(record.id, 'posted', null, verified, replyUrl, author)), reply: verified };
}

function freshPublicReply(reply, startedAt) {
  const now = Date.now();
  const exact = Date.parse(reply.publishedAt ?? '');
  if (Number.isFinite(exact)) return exact >= startedAt - 5000 && exact <= now + 5000;
  const label = chromeText(reply.publishedText, 120);
  if (/방금|just now|moments? ago/i.test(label)) return true;
  const relative = /^(\d{1,3})\s*(초|분|seconds?|minutes?)(?:\s*전|\s+ago)/i.exec(label);
  if (!relative) return false;
  const multiplier = /^(초|sec)/i.test(relative[2]) ? 1000 : 60_000;
  return Number(relative[1]) * multiplier <= now - startedAt + 5000;
}

function reservedReply(store, details, source, baseline = null) {
  const { record, created } = store.reserve(details, source + ':' + details.requestId, baseline);
  if (!created && (record.videoId !== details.videoId || record.threadId !== details.threadId ||
      record.parentId !== details.parentId || record.text !== details.text)) {
    throw new StudioError(409, 'requestIdConflict', '이미 다른 답글에 사용된 요청입니다.');
  }
  if (!created) {
    throw new StudioError(409, 'requestInProgress', '이미 처리 중이거나 완료된 요청입니다. 기록을 확인해 주세요.', record);
  }
  return { record: publicRecord(record) };
}

async function verifyPublicReply(store, reader, body) {
  const recordId = checkId(body.recordId, requestPattern, '게시 기록을 찾을 수 없습니다.');
  let record = store.findRecord(recordId);
  if (!record?.requestId?.startsWith('public:')) {
    throw new StudioError(404, 'recordNotFound', '공개 댓글 게시 기록을 찾을 수 없습니다.');
  }
  if (record.status === 'posted') return { record: publicRecord(record), reply: JSON.parse(record.replyJson) };
  const check = store.findPublicCheck(recordId);
  if (!record.parentId || !check || !['posting', 'uncertain'].includes(record.status)) {
    throw new StudioError(409, 'recordClosed', '이 게시 기록은 다시 확인할 수 없습니다.', record);
  }
  const baseline = new Set(JSON.parse(check.baseline));
  let replies;
  try {
    ({ replies } = await reader.replies(record.videoId, record.parentId, { fresh: true }));
  } catch (error) {
    const message = errorForResponse(error).message;
    const updated = store.finish(recordId, 'uncertain', message);
    if (updated.status === 'posted') return { record: publicRecord(updated), reply: JSON.parse(updated.replyJson) };
    return { record: publicRecord(updated), message };
  }
  record = store.findRecord(recordId);
  if (record.status === 'posted') return { record: publicRecord(record), reply: JSON.parse(record.replyJson) };
  if (!['posting', 'uncertain'].includes(record.status)) {
    throw new StudioError(409, 'recordClosed', '이 게시 기록은 다시 확인할 수 없습니다.', record);
  }
  const matches = replies.filter((reply) => commentPattern.test(reply.id ?? '') && reply.id !== record.parentId &&
    reply.parentId === record.parentId && !baseline.has(reply.id) && chromeText(reply.author, 250) &&
    typeof reply.text === 'string' && reply.text.trim() === record.text &&
    freshPublicReply(reply, Date.parse(check.startedAt)));
  if (matches.length !== 1) {
    const message = matches.length > 1 ? '같은 본문의 새 답글이 여러 개 보여 게시를 확인할 수 없습니다.'
      : '아직 공개 댓글에서 새 답글을 확인하지 못했습니다. YouTube에 게시한 뒤 다시 확인하세요.';
    const updated = store.finish(recordId, 'uncertain', message);
    return { record: publicRecord(updated), message };
  }
  const reply = { ...matches[0], author: chromeText(matches[0].author, 250), text: record.text };
  const replyUrl = `https://www.youtube.com/watch?v=${record.videoId}&lc=${encodeURIComponent(reply.id)}`;
  return { record: publicRecord(store.finish(recordId, 'posted', null, reply, replyUrl, reply.author)), reply };
}

function output(response, status, body, type = 'application/json; charset=utf-8') {
  if (response.destroyed) return;
  response.writeHead(status, { ...securityHeaders, 'Content-Type': type });
  response.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function redirect(response, location) {
  response.writeHead(303, { ...securityHeaders, Location: location });
  response.end();
}

function errorForResponse(error) {
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 &&
      typeof error.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(error.code) &&
      typeof error.message === 'string') {
    return { status: error.status, code: error.code, message: error.message };
  }
  return { status: 500, code: 'internalError', message: '요청을 처리하지 못했습니다. 앱을 다시 열어 확인해 주세요.' };
}

function replay(record, input) {
  if (record.videoId !== input.videoId || record.threadId !== input.threadId ||
      record.parentId !== input.parentId || record.text !== input.text) {
    throw new StudioError(409, 'requestIdConflict', '이미 다른 답글에 사용된 요청입니다.');
  }
  if (record.status === 'posted') {
    return { record: publicRecord(record), reply: JSON.parse(record.replyJson) };
  }
  const status = record.status === 'posting' ? 'requestInProgress' : `request${record.status === 'failed' ? 'Failed' : 'Uncertain'}`;
  throw new StudioError(409, status, record.message ?? '같은 답글의 게시가 진행 중입니다.', record);
}

export async function startStudio({
  port = Number(process.env.STUDIO_PORT ?? 5000),
  dataDir = process.env.STUDIO_DATA_DIR ?? defaultDataDir,
  fetchImpl = fetch,
  publicReader = createPublicReader(),
  geminiKey,
  geminiOnly = false,
  saveGeminiKey,
} = {}) {
  // Keep the browser files on the same running version as the API routes.
  const staticFiles = new Map(await Promise.all(Array.from(fileRoutes, async ([route, [name, type]]) => {
    const body = await readFile(join(appDir, 'public', name));
    return [route, { body, type }];
  })));
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  let googleSession;
  const session = () => googleSession ??= createGoogleSession({ dataDir, fetchImpl });
  const youtube = createYouTube({ fetchImpl });
  const modelOptions = { fetchImpl, getGeminiKey: () => geminiKey, geminiOnly };
  const generateDraft = createDraftGenerator(modelOptions);
  const analyzeVideo = createVideoAnalyzer(modelOptions);
  const videoAnalyses = new Map();
  const store = createStore(dataDir);
  let origin;
  let host;
  let localhost;
  let connectionGeneration = 0;

  function cacheVideoAnalysis(key, analysis) {
    videoAnalyses.delete(key);
    if (videoAnalyses.size >= 32) videoAnalyses.delete(videoAnalyses.keys().next().value);
    videoAnalyses.set(key, analysis);
  }

  async function authorize() {
    try {
      return await session().authorize();
    } catch (error) {
      if (error?.code === 'invalid_grant' && !session.status().connected) {
        connectionGeneration++;
        store.scrubMetadata();
      }
      throw error;
    }
  }

  function requireCurrentConnection(generation) {
    if (generation !== connectionGeneration) {
      throw new StudioError(409, 'connectionChanged', 'Google 연결이 변경되었습니다. 영상을 다시 불러와 주세요.');
    }
  }

  async function loadTarget(input, publishing) {
    const generation = connectionGeneration;
    const { accessToken, channel } = await authorize();
    const [video, thread] = await Promise.all([
      youtube.video(accessToken, input.videoId), youtube.thread(accessToken, input.threadId),
    ]);
    if (video.id !== input.videoId || thread.id !== input.threadId ||
        thread.videoId !== input.videoId || thread.parentId !== input.parentId) {
      throw new StudioError(400, 'targetMismatch', '원댓글이 선택한 영상과 일치하지 않습니다. 댓글을 다시 선택해 주세요.');
    }
    if (publishing && !thread.canReply) {
      throw new StudioError(409, 'replyUnavailable', '이 댓글에는 답글을 달 수 없습니다.');
    }
    return { accessToken, generation, details: {
      videoId: video.id, videoTitle: video.title, channelTitle: video.channelTitle, threadId: thread.id,
      parentId: thread.parentId, parentAuthor: thread.author, parentText: thread.text,
      text: input.text, accountTitle: channel.title,
    } };
  }

  async function publish(input) {
    const existing = store.findRequest(input.requestId);
    if (existing) return replay(existing, input);
    const { accessToken, generation, details } = await loadTarget(input, true);
    requireCurrentConnection(generation);
    const { record, created } = store.reserve(details, input.requestId);
    if (!created) return replay(record, input);
    let reply;
    try {
      reply = await youtube.insertReply(accessToken, details.parentId, details.text);
      if (!reply?.id || !commentPattern.test(reply.id) || reply.parentId !== details.parentId) {
        throw new StudioError(502, 'unexpectedReply', 'YouTube의 답글 식별자를 확인할 수 없습니다.');
      }
    } catch (error) {
      const publicError = errorForResponse(error);
      const uncertain = error?.uncertain === true || publicError.status >= 500 ||
        publicError.status === 408 || publicError.code === 'processingFailure';
      const message = uncertain
        ? 'YouTube의 게시 결과를 확인할 수 없습니다. 같은 영상에 다시 게시하기 전에 YouTube에서 답글을 확인해 주세요.'
        : publicError.message;
      const result = store.finish(record.id, uncertain ? 'uncertain' : 'failed', message);
      throw new StudioError(uncertain ? 502 : publicError.status,
        uncertain ? 'publishUncertain' : publicError.code, message, result);
    }
    const replyUrl = `https://www.youtube.com/watch?v=${details.videoId}&lc=${encodeURIComponent(reply.id)}`;
    return { record: publicRecord(store.finish(record.id, 'posted', null, reply, replyUrl)), reply };
  }

  async function handle(request, response) {
    const requestHost = request.headers.host;
    if (requestHost !== host && requestHost !== localhost) {
      throw new StudioError(403, 'invalidHost', '로컬 앱 주소에서 열어 주세요.');
    }
    const requestOrigin = `http://${requestHost}`;
    if (!request.url?.startsWith('/') || request.url.startsWith('//')) {
      throw new StudioError(400, 'invalidPath', '요청 주소가 올바르지 않습니다.');
    }
    const url = new URL(request.url, requestOrigin);
    if (url.origin !== requestOrigin) throw new StudioError(400, 'invalidPath', '요청 주소가 올바르지 않습니다.');
    const method = request.method;
    if (method === 'POST' && request.headers.origin !== requestOrigin) {
      throw new StudioError(403, 'invalidOrigin', '로컬 앱 화면에서 다시 시도해 주세요.');
    }
    const staticFile = staticFiles.get(url.pathname);
    if (method === 'GET' && staticFile) {
      return output(response, 200, staticFile.body, staticFile.type);
    }
    if (method === 'GET' && url.pathname === '/oauth/callback') {
      let result = 'connected';
      try {
        const authResult = await session().callback(requestOrigin, url.searchParams);
        if (authResult?.denied) result = 'denied';
        else connectionGeneration++;
      } catch (error) {
        result = error?.code === 'access_denied' ? 'denied' : 'error';
      }
      return redirect(response, `/?auth=${result}`);
    }
    if (method === 'GET' && url.pathname === '/api/session') return output(response, 200, await session().status());
    if (method === 'GET' && url.pathname === '/api/history') return output(response, 200, store.history());
    if (url.pathname === '/api/ai/settings') {
      const externalKey = process.env.GEMINI_API_KEY?.trim();
      const editable = Boolean(saveGeminiKey && !externalKey);
      if (method === 'GET') return output(response, 200, { configured: Boolean(externalKey || geminiKey), editable });
      if (method === 'POST') {
        if (!editable) throw new StudioError(409, 'aiSettingsUnavailable', '이 환경에서는 앱에서 Gemini 키를 변경할 수 없습니다.');
        const body = await readBody(request);
        const key = typeof body.key === 'string' ? body.key.trim() : '';
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{15,255}$/.test(key)) {
          throw new StudioError(400, 'invalidAiKey', 'Google AI Studio에서 복사한 Gemini API 키를 입력해 주세요.');
        }
        try {
          await saveGeminiKey(key);
        } catch {
          throw new StudioError(500, 'aiKeySaveFailed', '이 Windows 계정에 Gemini 키를 저장하지 못했습니다.');
        }
        geminiKey = key;
        return output(response, 200, { configured: true, editable: true });
      }
    }
    if (method === 'GET' && url.pathname === '/api/public/latest') {
      return output(response, 200, await publicReader.latestVideos());
    }
    if (method === 'GET' && url.pathname === '/api/public/video') {
      return output(response, 200, await publicReader.video(parseVideoUrl(url.searchParams.get('url'))));
    }
    const publicThreads = /^\/api\/public\/videos\/([^/]+)\/threads$/.exec(url.pathname);
    if (method === 'GET' && publicThreads) {
      const videoId = checkId(publicThreads[1], videoPattern, '올바른 영상 ID가 필요합니다.');
      return output(response, 200, await publicReader.threads(videoId, url.searchParams.get('more') === '1'));
    }
    const publicReplies = /^\/api\/public\/videos\/([^/]+)\/comments\/([^/]+)\/replies$/.exec(url.pathname);
    if (method === 'GET' && publicReplies) {
      const videoId = checkId(publicReplies[1], videoPattern, '올바른 영상 ID가 필요합니다.');
      const parentId = checkId(publicReplies[2], commentPattern, '올바른 원댓글 ID가 필요합니다.');
      return output(response, 200, await publicReader.replies(videoId, parentId));
    }
    if (method === 'POST' && url.pathname === '/api/ai/video-analysis') {
      const body = await readBody(request);
      const videoId = checkId(body.videoId, videoPattern, '올바른 영상 ID가 필요합니다.');
      const context = await publicReader.context(videoId);
      if (context.video?.id !== videoId) {
        throw new StudioError(502, 'videoChanged', '선택한 영상의 자료를 확인하지 못했습니다.');
      }
      const result = await analyzeVideo(context);
      const analysis = { ...result, sources: context.sources, popularCommentCount: context.popularComments.length };
      cacheVideoAnalysis(videoId, analysis);
      return output(response, 200, analysis);
    }
    if (method === 'POST' && url.pathname === '/api/ai/private-video-analysis') {
      const body = await readBody(request);
      const id = parseVideoUrl(body.url);
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title || [...title].length > 250 || /[\x00-\x1f\x7f]/u.test(title)) {
        throw new StudioError(400, 'invalidPrivateTitle', '영상 제목을 250자 이하로 입력해 주세요.');
      }
      const transcript = readPrivateTranscript(body.captions);
      const video = {
        id, title, description: '', channelTitle: '', thumbnailUrl: '', publishedAt: '',
        watchUrl: `https://www.youtube.com/watch?v=${id}`, privateDraft: true,
      };
      const result = await analyzeVideo({ video, transcript, popularComments: [], providedCaptions: true });
      const analysis = {
        ...result,
        sources: { transcript: 'available', transcriptTruncated: false, popularComments: 'unavailable', providedCaptions: true },
        popularCommentCount: 0,
      };
      cacheVideoAnalysis(`private:${id}`, { ...analysis, captions: privateCaptionContext(transcript) });
      return output(response, 200, { video, analysis });
    }
    if (method === 'POST' && url.pathname === '/api/ai/draft') {
      const details = await readBody(request);
      const videoId = checkId(details.videoId, videoPattern, '올바른 영상 ID가 필요합니다.');
      const topLevel = details.commentMode === 'topLevel';
      const privateDraft = details.privateDraft === true;
      if (privateDraft && !topLevel) {
        throw new StudioError(400, 'privateDraftMode', '비공개 영상에서는 새 댓글 초안만 작성할 수 있습니다.');
      }
      if (!topLevel) checkId(details.parentId, commentPattern, '답글을 만들 원댓글을 선택해 주세요.');
      const analysisKey = privateDraft ? `private:${videoId}` : videoId;
      const analysis = (topLevel || details.videoAnalysis) ? videoAnalyses.get(analysisKey) : null;
      if (topLevel && !analysis) {
        throw new StudioError(409, 'videoAnalysisRequired', '1번에서 선택한 영상의 분석을 먼저 실행해 주세요.');
      }
      const videoContext = analysis ? {
        summary: analysis.summary, evidence: analysis.evidence,
        ...(privateDraft && { captions: analysis.captions }),
      } : null;
      return output(response, 200, await generateDraft({ ...details, videoContext }));
    }
    if (method === 'POST' && url.pathname === '/api/public/replies/start') {
      const details = readChromeTarget(await readBody(request), true);
      const { replies } = await publicReader.replies(details.videoId, details.parentId);
      const baseline = replies.map(({ id }) => id).filter((id) => typeof id === 'string' && commentPattern.test(id)).slice(0, 1000);
      return output(response, 200, reservedReply(store, { ...details, accountTitle: 'YouTube에서 게시' }, 'public', baseline));
    }
    if (method === 'POST' && url.pathname === '/api/public/replies/verify') {
      return output(response, 200, await verifyPublicReply(store, publicReader, await readBody(request)));
    }
    if (method === 'POST' && url.pathname === '/api/chrome/drafts') {
      const details = readChromeTarget(await readBody(request), false);
      return output(response, 200, { record: publicRecord(store.saveDraft(details)) });
    }
    if (method === 'POST' && url.pathname === '/api/chrome/replies/start') {
      const details = readChromeTarget(await readBody(request), true, true);
      return output(response, 200, reservedReply(store, details, 'chrome'));
    }
    if (method === 'POST' && url.pathname === '/api/chrome/replies/finish') {
      return output(response, 200, finishChromeReply(store, await readBody(request)));
    }
    if (method === 'POST' && url.pathname === '/api/config') {
      await session().configure(await readBody(request));
      return output(response, 200, await session().status());
    }
    if (method === 'POST' && url.pathname === '/api/auth/start') {
      return output(response, 200, { authorizationUrl: await session().start(origin) });
    }
    if (method === 'POST' && url.pathname === '/api/auth/disconnect') {
      connectionGeneration++;
      await session().revoke();
      store.scrubMetadata();
      return output(response, 200, await session().status());
    }
    if (method === 'GET' && url.pathname === '/api/videos') {
      const id = parseVideoUrl(url.searchParams.get('url'));
      const { accessToken } = await authorize();
      return output(response, 200, { video: await youtube.video(accessToken, id) });
    }
    const threads = /^\/api\/videos\/([^/]+)\/threads$/.exec(url.pathname);
    if (method === 'GET' && threads) {
      const videoId = checkId(threads[1], videoPattern, '올바른 영상 ID가 필요합니다.');
      const cursor = readCursor(url);
      const { accessToken } = await authorize();
      try {
        return output(response, 200, await youtube.threads(accessToken, videoId, cursor));
      } catch (error) {
        if (error?.code !== 'commentsDisabled') throw error;
        return output(response, 200, { threads: [], nextPageToken: null, commentsUnavailable: '이 영상은 댓글이 사용 중지되어 있습니다.' });
      }
    }
    const replies = /^\/api\/comments\/([^/]+)\/replies$/.exec(url.pathname);
    if (method === 'GET' && replies) {
      const parentId = checkId(replies[1], commentPattern, '올바른 원댓글 ID가 필요합니다.');
      const cursor = readCursor(url);
      const { accessToken } = await authorize();
      return output(response, 200, await youtube.replies(accessToken, parentId, cursor));
    }
    if (method === 'POST' && url.pathname === '/api/drafts') {
      const input = readReplyInput(await readBody(request), false);
      const { generation, details } = await loadTarget(input, false);
      requireCurrentConnection(generation);
      return output(response, 200, { record: publicRecord(store.saveDraft(details)) });
    }
    if (method === 'POST' && url.pathname === '/api/replies') {
      return output(response, 200, await publish(readReplyInput(await readBody(request), true)));
    }
    throw new StudioError(404, 'notFound', '요청한 화면이나 기능을 찾을 수 없습니다.');
  }

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, (request, response) => {
    handle(request, response).catch((error) => {
      const { status, code, message } = errorForResponse(error);
      output(response, status, { error: { code, message }, ...(error?.record ? { record: publicRecord(error.record) } : {}) });
    });
  });
  try {
    await new Promise((ready, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        ready();
      });
    });
    host = `127.0.0.1:${server.address().port}`;
    localhost = `localhost:${server.address().port}`;
    origin = `http://${host}`;
    store.recover();
  } catch (error) {
    if (server.listening) await new Promise((ready) => server.close(ready));
    store.close();
    throw error;
  }
  let closing;
  function close() {
    closing ??= new Promise((ready, reject) => server.close((error) => {
      store.close();
      Promise.resolve().then(() => publicReader.close()).then(() => {
        if (error) reject(error);
        else ready();
      }, reject);
    }));
    return closing;
  }
  return { server, origin, close };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const geminiKey = await loadLocalGeminiKey().catch(() => {
      console.warn('저장한 Gemini API 키를 읽을 수 없습니다. Windows 계정이나 키 설정을 확인해 주세요.');
    });
    const saveGeminiKey = canSaveLocalGeminiKey() ? saveLocalGeminiKey : undefined;
    const studio = await startStudio({ geminiKey, geminiOnly: true, saveGeminiKey });
    console.log(`운명원 댓글 작업실 ${studio.origin.replace('127.0.0.1', 'localhost')}`);
    const shutdown = () => {
      if (process.env.STUDIO_MANAGED_LAUNCHER === '1') process.stdin.pause();
      studio.close().catch(() => { process.exitCode = 1; });
    };
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown);
    if (process.env.STUDIO_MANAGED_LAUNCHER === '1') {
      process.stdin.once('end', shutdown);
      process.stdin.resume();
    }
  } catch (error) {
    const message = error?.code === 'EADDRINUSE'
      ? '이 포트는 이미 사용 중입니다. 이전 댓글 스튜디오가 열려 있다면 종료한 뒤 다시 실행해 주세요.'
      : '로컬 앱을 시작할 수 없습니다.';
    console.error(message);
    process.exitCode = 1;
  }
}
