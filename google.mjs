import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const authorizationEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const revocationEndpoint = 'https://oauth2.googleapis.com/revoke';
const apiEndpoint = 'https://www.googleapis.com/youtube/v3/';
const youtubeScope = 'https://www.googleapis.com/auth/youtube.force-ssl';
const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const resourceIdPattern = /^[A-Za-z0-9_.-]{1,200}$/;

function issue(status, code, message, uncertain = false) {
  const error = Object.assign(new Error(message), { status, code });
  if (uncertain) error.uncertain = true;
  return error;
}

const youtubeMessages = {
  accessNotConfigured: 'Google Cloud 프로젝트에서 YouTube Data API v3를 사용 설정해 주세요.',
  SERVICE_DISABLED: 'Google Cloud 프로젝트에서 YouTube Data API v3를 사용 설정해 주세요.',
  commentsDisabled: '이 영상은 댓글이 꺼져 있습니다.',
  commentThreadNotFound: '원댓글을 찾을 수 없습니다. 댓글 목록을 새로 불러와 주세요.',
  commentNotFound: '댓글을 찾을 수 없습니다. 댓글 목록을 새로 불러와 주세요.',
  parentCommentNotFound: '원댓글을 찾을 수 없습니다. 댓글 목록을 새로 불러와 주세요.',
  parentCommentIsPrivate: '공개되지 않은 원댓글에는 답글을 달 수 없습니다.',
  operationNotSupported: '이 원댓글에는 답글을 달 수 없습니다.',
  commentTextTooLong: '답글이 YouTube에서 허용하는 길이를 초과했습니다.',
  dailyLimitExceeded: '이 Google Cloud 프로젝트의 YouTube API 사용 한도에 도달했습니다.',
  quotaExceeded: '이 Google Cloud 프로젝트의 YouTube API 사용 한도에 도달했습니다.',
  rateLimitExceeded: 'YouTube API 요청이 일시적으로 제한됐습니다.',
  userRateLimitExceeded: 'YouTube API 요청이 일시적으로 제한됐습니다.',
  forbidden: '이 작업에 필요한 YouTube 권한을 확인해 주세요.',
  insufficientPermissions: 'YouTube 댓글 권한이 필요합니다. Google 연결을 다시 설정해 주세요.',
  youtubeSignupRequired: '연결한 Google 계정에 YouTube 채널을 만든 뒤 다시 연결해 주세요.',
  ineligibleAccount: '댓글을 게시할 수 있는 YouTube 채널로 연결해 주세요.',
  authError: 'YouTube 연결이 만료되었습니다. Google 계정을 다시 연결해 주세요.',
  invalidCredentials: 'YouTube 연결이 만료되었습니다. Google 계정을 다시 연결해 주세요.',
};

function errorCode(value, fallback) {
  return typeof value === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(value) ? value : fallback;
}

async function requestJson(fetchImpl, url, options, { tokenRequest = false, write = false } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch {
    throw issue(502, 'upstreamUnavailable', tokenRequest ? 'Google 인증 서버에 연결할 수 없습니다.' : 'YouTube API에 연결할 수 없습니다.', write);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw issue(502, 'invalidUpstreamResponse', 'Google 서버의 응답을 확인할 수 없습니다.', write);
  }

  if (response.ok) return body;

  if (tokenRequest) {
    const code = errorCode(body?.error, 'oauthTokenError');
    const message = code === 'invalid_grant' ? 'Google 인증이 만료되었습니다. 다시 연결해 주세요.'
      : code === 'invalid_client' ? 'Google OAuth 클라이언트를 확인하고 JSON을 다시 가져와 주세요.'
      : 'Google 연결을 완료하지 못했습니다. OAuth 클라이언트와 동의 화면을 확인해 주세요.';
    throw issue(response.status, code, message);
  }

  const upstream = body?.error;
  const code = errorCode(upstream?.errors?.[0]?.reason ?? upstream?.details?.[0]?.reason ?? upstream?.status, 'youtubeApiError');
  const uncertain = write && (response.status >= 500 || response.status === 408 || code === 'processingFailure');
  const message = Object.hasOwn(youtubeMessages, code) ? youtubeMessages[code]
    : response.status === 401 ? 'YouTube 연결을 다시 설정해 주세요.'
    : 'YouTube API 요청을 처리하지 못했습니다.';
  throw issue(response.status, code, message, uncertain);
}

function requireId(value, pattern, message) {
  if (typeof value !== 'string' || !pattern.test(value)) throw issue(400, 'invalidId', message);
}

function pageToken(value) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw issue(400, 'invalidCursor', '댓글 페이지 정보가 올바르지 않습니다.');
  }
  return value;
}

function imageUrl(value) {
  try {
    const url = new URL(value);
    const allowed = ['ytimg.com', 'googleusercontent.com', 'ggpht.com'];
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port
      && allowed.some((host) => url.hostname === host || url.hostname.endsWith('.' + host))) return url.href;
  } catch {
    return null;
  }
  return null;
}

function thumbnail(thumbnails) {
  for (const size of ['maxres', 'standard', 'high', 'medium', 'default']) {
    const url = imageUrl(thumbnails?.[size]?.url);
    if (url) return url;
  }
  return null;
}

function normalizeComment(resource) {
  const snippet = resource.snippet;
  return {
    id: resource.id,
    parentId: snippet.parentId ?? null,
    author: snippet.authorDisplayName ?? 'YouTube 사용자',
    avatarUrl: imageUrl(snippet.authorProfileImageUrl),
    text: snippet.textOriginal ?? snippet.textDisplay ?? '',
    publishedAt: snippet.publishedAt ?? null,
    likeCount: snippet.likeCount ?? 0,
  };
}

function normalizeThread(resource) {
  const snippet = resource.snippet;
  const comment = normalizeComment(snippet.topLevelComment);
  return {
    id: resource.id,
    parentId: comment.id,
    videoId: snippet.videoId,
    author: comment.author,
    avatarUrl: comment.avatarUrl,
    text: comment.text,
    publishedAt: comment.publishedAt,
    likeCount: comment.likeCount,
    canReply: snippet.canReply === true,
    replyCount: snippet.totalReplyCount ?? 0,
  };
}

export function createYouTube({ fetchImpl = fetch } = {}) {
  function api(resource, token, params, body) {
    const url = new URL(resource, apiEndpoint);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
    const options = { headers };
    if (body) {
      headers['Content-Type'] = 'application/json';
      options.method = 'POST';
      options.body = JSON.stringify(body);
    }
    return requestJson(fetchImpl, url, options, { write: Boolean(body) });
  }

  return {
    async video(token, id) {
      requireId(id, videoIdPattern, 'YouTube 영상 ID가 올바르지 않습니다.');
      const { items } = await api('videos', token, { part: 'snippet,status', id });
      const item = items?.find((video) => video.id === id);
      if (!item?.snippet) throw issue(404, 'videoNotFound', '영상을 찾을 수 없습니다. 주소나 공개 설정을 확인해 주세요.');
      const snippet = item.snippet;
      return {
        id,
        title: snippet.title,
        description: snippet.description ?? '',
        channelTitle: snippet.channelTitle,
        publishedAt: snippet.publishedAt ?? null,
        thumbnailUrl: thumbnail(snippet.thumbnails),
        watchUrl: 'https://www.youtube.com/watch?v=' + id,
        embeddable: item.status?.embeddable === true && item.status?.madeForKids !== true,
      };
    },
    async threads(token, videoId, cursor) {
      requireId(videoId, videoIdPattern, 'YouTube 영상 ID가 올바르지 않습니다.');
      const params = { part: 'snippet', videoId, textFormat: 'plainText', order: 'relevance', maxResults: 30, pageToken: pageToken(cursor) };
      try {
        const data = await api('commentThreads', token, params);
        return { threads: (data.items ?? []).map(normalizeThread), nextPageToken: data.nextPageToken ?? null };
      } catch (error) {
        if (error.code !== 'commentsDisabled') throw error;
        return { threads: [], nextPageToken: null, commentsUnavailable: error.message };
      }
    },
    async thread(token, id) {
      requireId(id, resourceIdPattern, '원댓글 ID가 올바르지 않습니다.');
      const { items } = await api('commentThreads', token, { part: 'snippet', id, textFormat: 'plainText' });
      const item = items?.find((thread) => thread.id === id);
      if (!item?.snippet?.topLevelComment) throw issue(404, 'commentThreadNotFound', youtubeMessages.commentThreadNotFound);
      return normalizeThread(item);
    },
    async replies(token, parentId, cursor) {
      requireId(parentId, resourceIdPattern, '원댓글 ID가 올바르지 않습니다.');
      const data = await api('comments', token, { part: 'snippet', parentId, textFormat: 'plainText', maxResults: 30, pageToken: pageToken(cursor) });
      return { replies: (data.items ?? []).map(normalizeComment), nextPageToken: data.nextPageToken ?? null };
    },
    async insertReply(token, parentId, text) {
      requireId(parentId, resourceIdPattern, '원댓글 ID가 올바르지 않습니다.');
      if (typeof text !== 'string' || !text.trim()) throw issue(400, 'commentTextRequired', '게시할 답글을 작성해 주세요.');
      const data = await api('comments', token, { part: 'snippet' }, { snippet: { parentId, textOriginal: text } });
      if (!resourceIdPattern.test(data?.id ?? '') || data?.snippet?.parentId !== parentId) {
        throw issue(502, 'replyUnconfirmed', 'YouTube가 답글 게시 결과를 명확히 반환하지 않았습니다.', true);
      }
      return normalizeComment(data);
    },
    async channel(token) {
      const { items, nextPageToken } = await api('channels', token, { part: 'snippet', mine: true, maxResults: 2 });
      if (!items?.length) throw issue(409, 'youtubeChannelRequired', youtubeMessages.youtubeSignupRequired);
      if (items.length !== 1 || nextPageToken) {
        throw issue(409, 'multipleYouTubeChannels', '게시 채널을 하나로 확인할 수 없습니다. Google 연결에서 게시할 YouTube 채널을 선택해 주세요.');
      }
      const item = items[0];
      requireId(item.id, resourceIdPattern, '연결한 YouTube 채널을 확인할 수 없습니다.');
      return { id: item.id, title: item.snippet?.title ?? 'YouTube 채널', avatarUrl: thumbnail(item.snippet?.thumbnails) };
    },
  };
}

function parseClient(raw) {
  const isWeb = Boolean(raw?.web);
  const client = isWeb ? raw.web : raw?.installed;
  if (isWeb && raw?.installed) throw issue(400, 'invalidWebClient', 'OAuth 클라이언트 유형이 하나인 Google Cloud JSON을 선택해 주세요.');
  if (typeof client?.client_id !== 'string' || !/^[A-Za-z0-9_-]{8,180}\.apps\.googleusercontent\.com$/.test(client.client_id)
    || ((isWeb || client.client_secret != null) && (typeof client.client_secret !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(client.client_secret)))) {
    throw issue(400, isWeb ? 'invalidWebClient' : 'invalidDesktopClient', 'Google Cloud에서 만든 웹 또는 데스크톱 앱 OAuth 클라이언트 JSON을 확인해 주세요.');
  }
  return { type: isWeb ? 'web' : 'desktop', id: client.client_id, secret: client.client_secret ?? '' };
}

function readState(path) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error();
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { client: null, token: null, channel: null };
    throw issue(500, 'localAuthReadFailed', '로컬 Google 연결 설정을 읽을 수 없습니다.');
  }
}

function writeState(path, value) {
  const temporary = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } catch {
    try { rmSync(temporary, { force: true }); } catch { /* Preserve the original storage error. */ }
    throw issue(500, 'localAuthWriteFailed', '로컬 Google 연결 설정을 저장할 수 없습니다.');
  }
}

function callbackUrl(origin, hostname) {
  const match = typeof origin === 'string' && /^http:\/\/(127\.0\.0\.1|localhost):([1-9][0-9]{0,4})$/.exec(origin);
  if (!match || Number(match[2]) > 65_535) {
    throw issue(400, 'invalidLoopback', '로컬 실행 주소에서 Google 연결을 시작해 주세요.');
  }
  return 'http://' + (hostname ?? match[1]) + ':' + match[2] + '/oauth/callback';
}

function normalizeToken(body, oldRefreshToken = null) {
  const expirySeconds = Number(body?.expires_in);
  const validToken = (value) => typeof value === 'string' && /^[!-~]{1,8192}$/.test(value);
  if (!validToken(body?.access_token) || !Number.isFinite(expirySeconds) || expirySeconds <= 0
    || (body.refresh_token != null && !validToken(body.refresh_token))) {
    throw issue(502, 'invalidOAuthResponse', 'Google이 발급한 연결 정보를 확인할 수 없습니다.');
  }
  if (typeof body.scope === 'string' && !body.scope.split(/\s+/).includes(youtubeScope)) {
    throw issue(403, 'youtubeScopeRequired', 'Google 연결에서 YouTube 댓글 권한을 허용해 주세요.');
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? oldRefreshToken,
    expiresAt: Date.now() + expirySeconds * 1000,
  };
}

export function createGoogleSession({ dataDir, fetchImpl = fetch }) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, 'google-session.json');
  const youtube = createYouTube({ fetchImpl });
  let current = readState(file);
  let version = 0;
  let loginSequence = 0;
  let pending = null;
  let refreshing = null;
  let revoking = null;

  function status() {
    const connected = Boolean(current.channel && current.token
      && (current.token.refreshToken || current.token.expiresAt > Date.now()));
    const result = { configured: Boolean(current.client), connected, channel: connected ? current.channel : null };
    if (current.client?.type === 'web') result.clientType = 'web';
    return result;
  }

  function store(next) {
    writeState(file, next);
    current = next;
  }

  function reset(client) {
    store({ client, token: null, channel: null });
    version++;
    pending = null;
    return status();
  }

  function requireConnection() {
    return issue(401, 'googleNotConnected', 'Google 계정을 연결해 주세요.');
  }

  function requireIdleConnection() {
    if (revoking) throw issue(409, 'googleDisconnecting', 'Google 연결을 해제하는 중입니다. 잠시 후 다시 시도해 주세요.');
  }

  function tokenRequest(client, params) {
    const body = new URLSearchParams({ ...params, client_id: client.id });
    if (client.secret) body.set('client_secret', client.secret);
    return requestJson(fetchImpl, new URL(tokenEndpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    }, { tokenRequest: true });
  }

  async function refreshSession(snapshot, expectedVersion) {
    let body;
    try {
      body = await tokenRequest(snapshot.client, { grant_type: 'refresh_token', refresh_token: snapshot.token.refreshToken });
    } catch (error) {
      if (error.code === 'invalid_grant' && version === expectedVersion) reset(snapshot.client);
      throw error;
    }
    const token = normalizeToken(body, snapshot.token.refreshToken);
    if (version !== expectedVersion) throw requireConnection();
    store({ ...snapshot, token });
    return { accessToken: token.accessToken, channel: snapshot.channel };
  }

  async function revokeSession() {
    if (refreshing) {
      // An in-flight refresh may replace the refresh token we need to revoke.
      try { await refreshing.promise; } catch { /* Use the current stored token. */ }
    }
    const token = current.token?.refreshToken ?? current.token?.accessToken;
    if (!token) return reset(current.client);
    const failed = () => issue(502, 'googleRevokeFailed', 'Google 연결을 해제하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    let response;
    try {
      response = await fetchImpl(new URL(revocationEndpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-store' },
        body: new URLSearchParams({ token }),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw failed();
    }
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      if (response.status !== 400 || !['invalid_token', 'invalid_grant'].includes(result?.error)) throw failed();
    }
    return reset(current.client);
  }

  return {
    status,
    configure(raw) {
      requireIdleConnection();
      const client = parseClient(raw);
      if (current.client?.id === client.id && current.client.secret === client.secret
        && (current.client.type ?? 'desktop') === client.type) return status();
      if (status().connected) throw issue(409, 'googleDisconnectRequired', '기존 Google 연결을 해제한 뒤 다른 OAuth 클라이언트를 등록해 주세요.');
      return reset(client);
    },
    start(origin) {
      requireIdleConnection();
      if (!current.client) throw issue(409, 'desktopClientRequired', 'Google OAuth 클라이언트 JSON을 먼저 등록해 주세요.');
      const redirectUri = callbackUrl(origin, current.client.type === 'web' ? 'localhost' : '127.0.0.1');
      const verifier = randomBytes(48).toString('base64url');
      const state = randomBytes(32).toString('base64url');
      pending = { state, verifier, redirectUri, expiresAt: Date.now() + 10 * 60_000, sequence: ++loginSequence };
      const url = new URL(authorizationEndpoint);
      url.search = new URLSearchParams({
        client_id: current.client.id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: youtubeScope,
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent select_account',
      }).toString();
      return url.href;
    },
    async callback(origin, params) {
      const flow = pending;
      if (!flow || flow.state !== params.get('state') || flow.redirectUri !== callbackUrl(origin) || flow.expiresAt <= Date.now()) {
        throw issue(400, 'invalidOAuthState', 'Google 연결 요청이 만료되었거나 일치하지 않습니다. 다시 시작해 주세요.');
      }
      pending = null;
      if (params.has('error')) {
        const code = params.get('error') === 'access_denied' ? 'access_denied' : 'oauthDenied';
        throw issue(403, code, 'Google 연결을 승인하지 않았습니다. 필요하면 다시 연결해 주세요.');
      }
      const code = params.get('code');
      if (!code || code.length > 4096) throw issue(400, 'missingOAuthCode', 'Google 인증 코드가 없습니다. 다시 연결해 주세요.');
      const expectedVersion = version;
      const client = current.client;
      const body = await tokenRequest(client, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: flow.redirectUri,
        code_verifier: flow.verifier,
      });
      const token = normalizeToken(body);
      const channel = await youtube.channel(token.accessToken);
      if (version !== expectedVersion || loginSequence !== flow.sequence) throw requireConnection();
      store({ client, token, channel });
      version++;
      return { channel };
    },
    disconnect() {
      requireIdleConnection();
      return reset(current.client);
    },
    revoke() {
      if (revoking) return revoking;
      pending = null;
      loginSequence++;
      revoking = revokeSession().finally(() => { revoking = null; });
      return revoking;
    },
    async authorize() {
      requireIdleConnection();
      if (!status().connected) throw requireConnection();
      const token = current.token;
      if (token.expiresAt > Date.now() + 60_000 || (!token.refreshToken && token.expiresAt > Date.now())) {
        return { accessToken: token.accessToken, channel: current.channel };
      }
      if (refreshing?.version === version) return refreshing.promise;
      const expectedVersion = version;
      const promise = refreshSession(current, expectedVersion).finally(() => {
        if (refreshing?.promise === promise) refreshing = null;
      });
      refreshing = { version: expectedVersion, promise };
      return promise;
    },
  };
}
