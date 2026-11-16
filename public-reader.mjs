import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const origin = 'https://www.youtube.com';
const videoPattern = /^[A-Za-z0-9_-]{11}$/;
const commentPattern = /^[A-Za-z0-9._-]{1,256}$/;
const discoveryQuery = '연애';
const failureStatus = {
  invalidVideo: 400, invalidComment: 400, threadMissing: 404, videoUnavailable: 404,
  consentRequired: 403, signInRequired: 403, blocked: 503, videoChanged: 502,
  busy: 429, timedOut: 504, readerUnavailable: 503,
  uploadFilterUnavailable: 503,
};

function failure(code, message) {
  return Object.assign(new Error(message), { code, status: failureStatus[code] ?? 502 });
}

function loadPlaywright() {
  const localCandidates = [process.env.STUDIO_PLAYWRIGHT, 'playwright',
    join(dirname(process.execPath), '..', 'node_modules', 'playwright')];
  for (const candidate of localCandidates.filter(Boolean)) {
    try { return require(candidate); } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  if (process.platform === 'win32') {
    const apps = join(process.env.ProgramFiles || 'C:/Program Files', 'WindowsApps');
    let packages;
    try { packages = readdirSync(apps); } catch { packages = []; }
    for (const name of packages.filter((item) => item.startsWith('OpenAI.CodexPrimaryRuntime.')).sort().reverse()) {
      const candidate = join(apps, name, 'dependencies', 'node', 'node_modules', 'playwright');
      if (existsSync(candidate)) return require(candidate);
    }
  }
  throw failure('readerUnavailable', '영상과 댓글을 읽는 데 필요한 Playwright를 찾을 수 없습니다.');
}

function browserOptions(executablePath) {
  if (executablePath) return { headless: true, executablePath, timeout: 8000 };
  return { headless: true, channel: 'chrome', timeout: 8000 };
}

function watchUrl(videoId, parentId) {
  const url = new URL('/watch', origin);
  url.searchParams.set('v', videoId);
  if (parentId) url.searchParams.set('lc', parentId);
  return url.href;
}

function isWatchPage(url, videoId) {
  return url.origin === origin && url.pathname === '/watch' && url.searchParams.get('v') === videoId;
}

function isDiscoveryPage(url) {
  return url.origin === origin && url.pathname === '/results' && url.searchParams.get('search_query') === discoveryQuery;
}

function discoveryResults() {
  const age = (value) => {
    const ko = /^(\d+)\s*(초|분|시간|일|주)\s*전$/.exec(value);
    if (ko) return Number(ko[1]) * { 초: 1, 분: 60, 시간: 3600, 일: 86400, 주: 604800 }[ko[2]];
    const en = /^(\d+)\s*(second|minute|hour|day|week)s? ago$/i.exec(value);
    return en ? Number(en[1]) * { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800 }[en[2].toLowerCase()] : Infinity;
  };
  const videos = new Map();
  for (const card of document.querySelectorAll('ytd-search ytd-video-renderer')) {
    const link = card.querySelector('a#video-title');
    if (!link?.href) continue;
    const url = new URL(link.href);
    const id = url.searchParams.get('v');
    if (url.origin !== location.origin || url.pathname !== '/watch' || !/^[A-Za-z0-9_-]{11}$/.test(id ?? '')) continue;
    const publishedText = [...card.querySelectorAll('#metadata-line span')].map((node) => node.innerText.trim())
      .find((value) => age(value) <= 604800);
    const title = link.innerText.trim() || link.getAttribute('title')?.trim();
    const channelTitle = card.querySelector('ytd-channel-name a')?.innerText.trim();
    if (!title || !channelTitle || !publishedText || videos.has(id)) continue;
    videos.set(id, { id, title, channelTitle, publishedText, publishedAt: null, age: age(publishedText),
      thumbnailUrl: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg', watchUrl: location.origin + '/watch?v=' + id });
  }
  return [...videos.values()].sort((a, b) => a.age - b.age).slice(0, 16).map(({ age, ...video }) => video);
}

function gateForUrl(url) {
  if (url.hostname.startsWith('consent.')) return failure('consentRequired', 'YouTube가 이 영상의 열람 전에 동의를 요청했습니다.');
  if (url.hostname === 'accounts.google.com') return failure('signInRequired', 'YouTube 로그인이 필요한 영상입니다.');
  return failure('blocked', 'YouTube에서 이 영상의 공개 열람을 허용하지 않았습니다.');
}

// Run the shared DOM reader only. The bridge below the marker handles account
// actions and is excluded from this read-only browser.
const extension = readFileSync(new URL('./chrome-extension/youtube.js', import.meta.url), 'utf8');
const readEnd = extension.indexOf('  // End of the shared public YouTube DOM reader.');
if (!extension.startsWith('(() => {') || readEnd < 0) {
  throw new Error('YouTube DOM reader boundary was not found.');
}
// Compile the trusted repository source as a function so Playwright can pass
// the validated IDs as structured arguments rather than JavaScript source.
const domReader = new Function(`return (async ({ videoId, operation, more, parentId, prime }) => {
  const reader = ${extension.slice(0, readEnd)}
    function assertPublic(verifyPlayer = true) {
      const visibleMatch = (selector) => [...document.querySelectorAll(selector)].some(visible);
      if (visibleMatch('ytd-consent-bump-v2-lightbox, form[action*="consent.youtube.com"], form[action*="consent.google.com"]')) {
        fail('consentRequired', 'YouTube가 이 영상의 열람 전에 동의를 요청했습니다.');
      }
      if (visibleMatch('#captcha-form, iframe[src*="/recaptcha/"]')) {
        fail('blocked', 'YouTube에서 영상이나 댓글의 공개 열람을 제한했습니다.');
      }
      const playerError = document.querySelector('yt-playability-error-supported-renderers, ytd-player-error-message-renderer');
      if (visible(playerError)) {
        const message = renderedText(playerError);
        if (/로그인|sign\\s*in/i.test(message)) {
          const blocked = /봇|bot/i.test(message);
          fail(blocked ? 'blocked' : 'signInRequired', blocked
            ? 'YouTube에서 영상이나 댓글의 공개 열람을 제한했습니다.'
            : 'YouTube 로그인이 필요한 영상입니다.');
        }
        if (message) fail('videoUnavailable', '공개 상태에서 이 YouTube 영상을 열 수 없습니다.');
      }
      if (verifyPlayer) requireVideo(videoId);
      else if (location.origin !== youtubeOrigin || location.pathname !== '/watch'
        || new URLSearchParams(location.search).get('v') !== videoId) {
        fail('videoChanged', 'YouTube에서 선택한 영상 페이지를 열 수 없습니다.');
      }
    }

    async function run() {
      assertPublic(false);
      if (operation === 'video') {
        const video = await waitFor(() => {
          assertPublic(false);
          return currentVideo(videoId) && readVideo(videoId);
        });
        if (!video) fail('videoUnavailable', '공개 상태에서 이 YouTube 영상을 열 수 없습니다.');
        assertPublic();
        return { video };
      }
      if (operation === 'context') return videoContext();
      if (operation === 'replies') {
        if (prime) {
          await readThreads();
          assertPublic();
        }
        const original = findThread(videoId, parentId);
        const hadReplies = original && (replyNodes(original, true).length || expandRepliesButton(original, true));
        const result = await getReplies({ videoId, parentId, publicOnly: true });
        assertPublic();
        const thread = findThread(videoId, parentId);
        if (!thread) fail('threadMissing', '원댓글을 찾을 수 없습니다. 댓글을 다시 불러와 주세요.');
        const timestamps = new Map(replyNodes(thread, true).map((node) => [
          permalink(node, videoId), renderedText(publishedElement(node)),
        ]));
        if (result.replies.length === 0 && (hadReplies || replyNodes(thread, true).length || expandRepliesButton(thread, true))) {
          fail('blocked', 'YouTube에서 이 댓글의 답글을 불러오지 못했습니다.');
        }
        for (const reply of result.replies) reply.publishedText = timestamps.get(reply.id) || null;
        return result;
      }
      return readThreads();
    }

    function transcriptRows() {
      const rows = [];
      let size = 0;
      for (const node of document.querySelectorAll('transcript-segment-view-model, ytd-transcript-segment-renderer, yt-transcript-segment-view-model')) {
        if (!visible(node)) continue;
        const timestamp = renderedText(node.querySelector('.segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp'));
        const text = renderedText(node.querySelector('.segment-text, [role="text"], .ytAttributedStringHost'));
        if (!/^[0-9]{1,3}(?::[0-9]{2}){1,2}$/.test(timestamp) || !text) continue;
        size += timestamp.length + text.length;
        if (size > 8000 || rows.length >= 150) return { rows, truncated: true };
        rows.push({ timestamp, text });
      }
      return { rows, truncated: false };
    }

    async function readTranscript() {
      const existing = transcriptRows();
      if (existing.rows.length) return existing;
      const expander = await waitFor(() => {
        assertPublic(false);
        return [...document.querySelectorAll('ytd-watch-metadata #expand, ytd-video-secondary-info-renderer #more')].find(enabled);
      }, 2600);
      expander?.click();
      const button = await waitFor(() => [...document.querySelectorAll('ytd-watch-metadata ' + buttonSelector.split(', ').join(', ytd-watch-metadata '))]
        .find((node) => enabled(node) && /^(?:스크립트 표시|스크립트 보기|Show transcript)$/i.test(renderedText(node))), 1800);
      if (!button) return existing;
      button.click();
      return await waitFor(() => {
        assertPublic();
        const rows = transcriptRows();
        return rows.rows.length && rows;
      }, 4300) || existing;
    }

    async function readTopComments() {
      const initial = await readThreads();
      if (!initial.threads.length) return [];
      const root = commentsRoot();
      const topOption = (scope, requireVisible) => [...scope.querySelectorAll('[aria-selected], [role="menuitemradio"]')].find((node) =>
        (!requireVisible || visible(node)) && /^(?:인기순|Top comments|Top)$/i.test(renderedText(node).split(String.fromCharCode(10))[0].trim()));
      const isSelected = (option) => option?.getAttribute('aria-selected') === 'true' || option?.getAttribute('aria-checked') === 'true';
      const sort = await waitFor(() =>
        [...(root?.querySelectorAll('#sort-menu ' + buttonSelector.split(', ').join(', #sort-menu ')) ?? [])].find(enabled), 1600);
      if (!sort) return [];
      sort.click();
      const top = await waitFor(() => topOption(root, true), 1500);
      if (!top) {
        sort.click();
        return [];
      }
      let threads = initial.threads;
      if (isSelected(top)) sort.click();
      else {
        const oldNodes = threadRoots(root).slice(0, 8);
        const before = initial.threads.slice(0, 8).map(({ id }) => id).join(',');
        top.click();
        const updated = await waitFor(() => {
          assertPublic();
          const currentRoot = commentsRoot();
          if (!currentRoot || !isSelected(topOption(currentRoot, false))) return false;
          const next = threadRoots(currentRoot).slice(0, 8);
          const after = next.map((node) => readThread(node, videoId, true)?.id);
          return next.length && after.every(Boolean) &&
            (before !== after.join(',') || next.some((node, index) => oldNodes[index] !== node));
        }, 4500);
        if (!updated) return [];
        threads = (await readThreads()).threads;
      }
      return threads.slice(0, 8).map(({ id, text, likeCount }) => ({ id, text: text.slice(0, 800), likeCount }));
    }

    async function videoContext() {
      const video = await waitFor(() => {
        assertPublic(false);
        return currentVideo(videoId) && readVideo(videoId);
      });
      if (!video) fail('videoUnavailable', '공개 상태에서 이 YouTube 영상을 열 수 없습니다.');
      const { rows, truncated } = await readTranscript();
      const description = renderedText(document.querySelector('ytd-watch-metadata #description-inline-expander #expanded'));
      if (description) video.description = description.slice(0, 5000);
      const popularComments = await readTopComments();
      assertPublic();
      return { video, transcript: rows, popularComments, sources: {
        transcript: rows.length ? 'available' : 'unavailable',
        transcriptTruncated: truncated,
        popularComments: popularComments.length ? 'top' : 'unavailable',
      } };
    }

    async function readThreads() {
      // A fresh page can mount an empty, collapsed comments host before the
      // viewport observer for comments becomes active.
      await waitFor(() => {
        assertPublic(false);
        const root = commentsRoot();
        return visible(root) && root.getBoundingClientRect().height > 0;
      }, 4500);
      const result = await getThreads({ videoId, more, publicOnly: true });
      assertPublic();
      if (!result.threads.length && result.nextPageToken && !result.commentsUnavailable) {
        result.commentsUnavailable = '공개 댓글이 아직 표시되지 않았습니다. 잠시 뒤 다시 불러오거나 YouTube에서 확인해 주세요.';
      }
      return result;
    }
    return { run };
  })();
  try {
    return { ok: true, value: await reader.run() };
  } catch (error) {
    return { ok: false, code: error.code };
  }
})`)();

const browserErrors = {
  consentRequired: 'YouTube가 이 영상의 열람 전에 동의를 요청했습니다.',
  signInRequired: 'YouTube 로그인이 필요한 영상입니다.',
  blocked: 'YouTube에서 영상이나 댓글의 공개 열람을 제한했습니다.',
  videoUnavailable: '공개 상태에서 이 YouTube 영상을 열 수 없습니다.',
  videoChanged: 'YouTube에서 선택한 영상 페이지를 열 수 없습니다.',
  threadMissing: '이 영상에서 해당 원댓글의 고유 주소를 확인할 수 없습니다.',
};

export function createPublicReader({ playwright, executablePath = process.env.STUDIO_CHROME_EXECUTABLE } = {}) {
  let browser;
  let session;
  let busy = false;
  let idleTimer;
  let closed = false;

  async function release() {
    clearTimeout(idleTimer);
    const previous = browser;
    session = undefined;
    browser = undefined;
    await previous?.close();
  }

  async function startBrowser() {
    if (!browser?.isConnected()) {
      try {
        browser = await (playwright ?? loadPlaywright()).chromium.launch(browserOptions(executablePath));
      } catch (error) {
        if (error.status) throw error;
        throw failure('readerUnavailable', 'Chrome을 시작하지 못했습니다. 이 컴퓨터에 설치된 Chrome을 확인해 주세요.');
      }
    }
    if (closed) {
      await release();
      throw failure('readerUnavailable', '공개 영상 읽기 서비스가 종료되었습니다.');
    }
    return browser;
  }

  async function navigate(current, address, allowed) {
    const { page } = current;
    let response;
    try {
      response = await page.goto(address, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    } catch (error) {
      if (current.gate) throw current.gate;
      if (error.name === 'TimeoutError') throw failure('timedOut', 'YouTube 응답이 지연되고 있습니다. 잠시 뒤 다시 시도해 주세요.');
      throw failure('blocked', 'YouTube의 공개 페이지를 열 수 없습니다.');
    }
    if (current.gate) throw current.gate;
    const actualUrl = new URL(page.url());
    if (!allowed(actualUrl)) throw gateForUrl(actualUrl);
    if (!response || response.status() >= 400) throw failure('blocked', 'YouTube의 공개 페이지를 열 수 없습니다.');
  }

  async function guardPage(current, allowed) {
    const { page } = current;
    await page.route('**/*', (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        const url = new URL(request.url());
        if (!allowed(url)) {
          current.gate = gateForUrl(url);
          return route.abort();
        }
      }
      return route.continue();
    });
  }

  async function getSession(videoId, parentId, fresh) {
    if (closed) throw failure('readerUnavailable', '공개 영상 읽기 서비스가 종료되었습니다.');
    if (session?.videoId === videoId && session.parentId === parentId && !fresh) return session;
    await session?.context.close();
    session = undefined;
    const browser = await startBrowser();
    const context = await browser.newContext({ locale: 'ko-KR' });
    const page = await context.newPage();
    const current = { videoId, parentId, context, page, gate: null, threadsRead: false };
    session = current;
    const allowed = (url) => isWatchPage(url, videoId);
    await guardPage(current, allowed);
    await navigate(current, watchUrl(videoId, parentId), allowed);
    return current;
  }

  async function searchRecentVideos() {
    const browser = await startBrowser();
    const context = await browser.newContext({ locale: 'ko-KR' });
    try {
      const page = await context.newPage();
      const current = { page, gate: null };
      const url = new URL('/results', origin);
      url.searchParams.set('search_query', discoveryQuery);
      await guardPage(current, isDiscoveryPage);
      await navigate(current, url.href, isDiscoveryPage);
      const consent = page.locator('ytd-consent-bump-v2-lightbox, form[action*="consent.youtube.com"]').first();
      if (await consent.isVisible()) throw failure('consentRequired', browserErrors.consentRequired);
      let href;
      try {
        await page.getByRole('button', { name: /검색 필터|^필터$|search filters/i }).first().click({ timeout: 5000 });
        href = await page.locator('ytd-search-filter-group-renderer').filter({ hasText: /업로드 날짜|upload date/i })
          .getByRole('link', { name: /^(?:이번 주|this week)$/i }).getAttribute('href', { timeout: 2500 });
      } catch {
        throw failure('uploadFilterUnavailable', 'YouTube에서 이번 주 업로드 필터를 확인할 수 없습니다.');
      }
      if (!href) throw failure('uploadFilterUnavailable', 'YouTube에서 이번 주 업로드 필터를 확인할 수 없습니다.');
      const filtered = new URL(href, url);
      if (!isDiscoveryPage(filtered)) throw failure('uploadFilterUnavailable', 'YouTube에서 이번 주 업로드 필터를 확인할 수 없습니다.');
      await navigate(current, filtered.href, isDiscoveryPage);
      if (await consent.isVisible()) throw failure('consentRequired', browserErrors.consentRequired);
      await page.locator('ytd-search ytd-video-renderer a#video-title').first().waitFor({ state: 'visible', timeout: 7000 }).catch(() => {});
      return { videos: await page.evaluate(discoveryResults), period: 'week' };
    } finally {
      await context.close();
    }
  }

  async function read(current, operation, data) {
    if (current.gate) throw current.gate;
    const result = await current.page.evaluate(domReader, { videoId: current.videoId, operation, ...data });
    if (current.gate) throw current.gate;
    if (!result.ok) throw failure(result.code ?? 'blocked', browserErrors[result.code] ?? browserErrors.blocked);
    if (operation === 'threads') current.threadsRead = true;
    return result.value;
  }

  async function runVideo(videoId, callback, timeoutMs) {
    if (typeof videoId !== 'string' || !videoPattern.test(videoId)) {
      throw failure('invalidVideo', '올바른 YouTube 영상이 필요합니다.');
    }
    return run(callback, timeoutMs);
  }

  async function run(callback, timeoutMs = 28_000) {
    if (closed) throw failure('readerUnavailable', '공개 영상 읽기 서비스가 종료되었습니다.');
    if (busy) throw failure('busy', '다른 YouTube 요청을 불러오는 중입니다. 잠시 뒤 다시 시도해 주세요.');
    busy = true;
    clearTimeout(idleTimer);
    let timeout;
    let timedOut = false;
    function finish() {
      busy = false;
      if (!closed && browser) {
        idleTimer = setTimeout(() => void release().catch(() => {}), 75_000);
        idleTimer.unref();
      }
    }
    const operation = Promise.resolve().then(callback);
    try {
      return await Promise.race([operation, new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          reject(failure('timedOut', 'YouTube 응답이 지연되고 있습니다. 잠시 뒤 다시 시도해 주세요.'));
        }, timeoutMs);
      })]);
    } catch (error) {
      void release().catch(() => {});
      throw error.status ? error : failure('blocked', browserErrors.blocked);
    } finally {
      clearTimeout(timeout);
      if (timedOut) void operation.then(finish, finish);
      else finish();
    }
  }

  return {
    latestVideos() {
      return run(searchRecentVideos, 37_000);
    },
    context(videoId) {
      return runVideo(videoId, async () => read(await getSession(videoId), 'context'), 37_000);
    },
    video(videoId) {
      return runVideo(videoId, async () => read(await getSession(videoId), 'video'));
    },
    openVideo(videoId) {
      return runVideo(videoId, async () => read(await getSession(videoId), 'threads'));
    },
    threads(videoId, more = false) {
      return runVideo(videoId, async () => {
        const refresh = !more && session?.videoId === videoId && session.threadsRead;
        const current = await getSession(videoId, undefined, refresh);
        return read(current, 'threads', { more: more === true && current.threadsRead });
      });
    },
    replies(videoId, parentId, { fresh = false } = {}) {
      if (typeof parentId !== 'string' || !commentPattern.test(parentId)) {
        return Promise.reject(failure('invalidComment', '원댓글의 고유 주소가 필요합니다.'));
      }
      return runVideo(videoId, async () => {
        if (!fresh && session?.videoId === videoId) {
          try { return await read(session, 'replies', { parentId }); } catch (error) {
            if (error.code !== 'threadMissing') throw error;
          }
        }
        const current = await getSession(videoId, parentId, true);
        return read(current, 'replies', { parentId, prime: true });
      });
    },
    async close() {
      closed = true;
      await release();
    },
  };
}
