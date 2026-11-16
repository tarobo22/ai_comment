import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const dailyMax = 10;
const apiSnapshotAge = 30 * 24 * 60 * 60 * 1000;
const dateInSeoul = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
});

export class StudioError extends Error {
  constructor(status, code, message, record) {
    super(message);
    this.status = status;
    this.code = code;
    this.record = record;
  }
}

export function publicRecord(row) {
  if (!row) return null;
  const { requestId, quotaDate, replyJson, apiStoredAt, ...record } = row;
  return requestId?.startsWith('public:') ? { ...record, source: 'public' } : record;
}

export function createStore(dataDir) {
  const db = new DatabaseSync(join(dataDir, 'history.sqlite3'));
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      videoId TEXT NOT NULL,
      videoTitle TEXT NOT NULL,
      channelTitle TEXT NOT NULL,
      threadId TEXT NOT NULL,
      parentId TEXT NOT NULL,
      parentAuthor TEXT NOT NULL,
      parentText TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft','posting','posted','failed','uncertain')),
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      replyId TEXT,
      replyUrl TEXT,
      replyJson TEXT,
      accountTitle TEXT NOT NULL,
      message TEXT,
      requestId TEXT UNIQUE,
      quotaDate TEXT,
      apiStoredAt TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_post_per_video ON records(videoId)
      WHERE status IN ('posting','posted','uncertain');
    DROP INDEX IF EXISTS one_draft_per_parent;
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_draft_per_parent ON records(videoId,parentId)
      WHERE status = 'draft' AND parentId <> '';
    CREATE INDEX IF NOT EXISTS daily_posting ON records(quotaDate,status);
    CREATE TABLE IF NOT EXISTS public_reply_checks (
      recordId TEXT PRIMARY KEY,
      baseline TEXT NOT NULL,
      startedAt TEXT NOT NULL
    );
  `);
  if (!db.prepare('PRAGMA table_info(records)').all().some((column) => column.name === 'apiStoredAt')) {
    db.exec(`ALTER TABLE records ADD COLUMN apiStoredAt TEXT;
      UPDATE records SET apiStoredAt = createdAt WHERE parentId <> '';`);
  }

  const byId = db.prepare('SELECT * FROM records WHERE id = ?');
  const byRequestId = db.prepare('SELECT * FROM records WHERE requestId = ?');
  const publicCheck = db.prepare('SELECT baseline, startedAt FROM public_reply_checks WHERE recordId = ?');
  const addPublicCheck = db.prepare('INSERT INTO public_reply_checks(recordId, baseline, startedAt) VALUES (?, ?, ?)');
  const removePublicCheck = db.prepare('DELETE FROM public_reply_checks WHERE recordId = ?');
  const draftAt = db.prepare(`SELECT * FROM records WHERE videoId = ? AND parentId = ? AND status = 'draft'`);
  const occupiedAt = db.prepare(`SELECT * FROM records WHERE videoId = ? AND status IN ('posting','posted','uncertain')`);
  const usage = db.prepare(`SELECT count(*) AS used FROM records WHERE quotaDate = ? AND status IN ('posting','posted','uncertain')`);
  const allRecords = db.prepare('SELECT * FROM records ORDER BY updatedAt DESC, rowid DESC');
  const insert = db.prepare(`INSERT INTO records
    (id, videoId, videoTitle, channelTitle, threadId, parentId, parentAuthor, parentText, text, status,
     createdAt, updatedAt, accountTitle, requestId, quotaDate, apiStoredAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateDraft = db.prepare(`UPDATE records SET
    videoTitle = ?, channelTitle = ?, threadId = ?, parentAuthor = ?, parentText = ?, text = ?,
    updatedAt = ?, accountTitle = ?, status = ?, requestId = ?, quotaDate = ?, apiStoredAt = ?
    WHERE id = ? AND status = 'draft'`);
  const finalize = db.prepare(`UPDATE records SET
    status = ?, updatedAt = ?, message = ?,
    accountTitle = CASE WHEN apiStoredAt IS NOT NULL THEN coalesce(?, accountTitle) ELSE accountTitle END,
    replyId = CASE WHEN apiStoredAt IS NOT NULL THEN ? END,
    replyUrl = CASE WHEN apiStoredAt IS NOT NULL THEN ? END,
    replyJson = CASE WHEN apiStoredAt IS NOT NULL THEN ? END
    WHERE id = ? AND status IN ('posting','uncertain')`);
  const removeApiFields = db.prepare(`UPDATE records SET
    videoTitle = '', channelTitle = '', threadId = '', parentId = '', parentAuthor = '', parentText = '',
    accountTitle = '', replyId = NULL, replyUrl = NULL, replyJson = NULL, apiStoredAt = NULL
    WHERE apiStoredAt IS NOT NULL AND (? IS NULL OR apiStoredAt <= ?)`);

  function scrubMetadata(before = null) {
    if (removeApiFields.run(before, before).changes > 0) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  function scrubExpired() {
    const cutoff = new Date(Date.now() - apiSnapshotAge).toISOString();
    scrubMetadata(cutoff);
    db.prepare('DELETE FROM public_reply_checks WHERE startedAt <= ?').run(cutoff);
  }

  function transact(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function writeDraftOrReservation(details, status, at, requestId = null, quotaDate = null) {
    const { videoId, videoTitle, channelTitle, threadId, parentId, parentAuthor, parentText, text, accountTitle } = details;
    const current = draftAt.get(videoId, parentId);
    const id = current?.id ?? randomUUID();
    if (current) {
      updateDraft.run(videoTitle, channelTitle, threadId, parentAuthor, parentText, text,
        at, accountTitle, status, requestId, quotaDate, at, id);
    } else {
      insert.run(id, videoId, videoTitle, channelTitle, threadId, parentId, parentAuthor, parentText, text,
        status, at, at, accountTitle, requestId, quotaDate, at);
    }
    return byId.get(id);
  }

  return {
    recover() {
      db.prepare(`UPDATE records SET status = 'uncertain', updatedAt = ?, message = ? WHERE status = 'posting'`)
        .run(new Date().toISOString(), '이전 실행에서 게시 확인이 중단됐습니다. YouTube에서 답글을 확인해 주세요.');
      scrubExpired();
    },
    scrubMetadata,
    findRequest(requestId) {
      return byRequestId.get(requestId);
    },
    findRecord(id) {
      return byId.get(id);
    },
    findPublicCheck(id) {
      return publicCheck.get(id);
    },
    saveDraft(details) {
      return transact(() => writeDraftOrReservation(details, 'draft', new Date().toISOString()));
    },
    reserve(details, requestId, baseline = null) {
      return transact(() => {
        const existing = byRequestId.get(requestId);
        if (existing) return { record: existing, created: false };
        const occupied = occupiedAt.get(details.videoId);
        if (occupied) {
          const message = occupied.status === 'posted'
            ? '이 영상에는 이미 답글을 게시했습니다. 영상당 한 건만 게시할 수 있습니다.'
            : '이 영상에 진행 중이거나 결과를 확인 중인 게시가 있습니다.';
          throw new StudioError(409, 'videoLimit', message, occupied);
        }
        const now = new Date();
        const quotaDate = dateInSeoul.format(now);
        if (usage.get(quotaDate).used >= dailyMax) {
          throw new StudioError(409, 'dailyLimit', '오늘 게시 한도 10건에 도달했습니다.');
        }
        const record = writeDraftOrReservation(details, 'posting', now.toISOString(), requestId, quotaDate);
        if (baseline !== null) addPublicCheck.run(record.id, JSON.stringify(baseline), now.toISOString());
        return { record, created: true };
      });
    },
    finish(id, status, message = null, reply = null, replyUrl = null, accountTitle = null) {
      finalize.run(status, new Date().toISOString(), message, accountTitle, reply?.id ?? null, replyUrl,
        reply ? JSON.stringify(reply) : null, id);
      if (status === 'posted' || status === 'failed') removePublicCheck.run(id);
      return byId.get(id);
    },
    history() {
      scrubExpired();
      return {
        records: allRecords.all().map(publicRecord),
        limits: { used: usage.get(dateInSeoul.format(new Date())).used, max: dailyMax },
      };
    },
    close() {
      db.close();
    },
  };
}
