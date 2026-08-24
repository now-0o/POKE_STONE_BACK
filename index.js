import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { DataTypes } from 'sequelize';
import { sequelize } from './db.js';
import { User } from './models/User.js';
import { SaveData } from './models/SaveData.js';

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_CODE = process.env.ADMIN_CODE || 'stonemaster';
if (!JWT_SECRET) {
  console.error('JWT_SECRET이 .env에 없습니다. 서버를 시작할 수 없어요.');
  process.exit(1);
}

// Netlify redirect(/api/*)를 통해서만 들어오므로 CORS는 넓게 열어도
// 실제로는 프록시를 거친 same-origin 요청이라 문제 없음.
app.use(cors());
app.use(express.json({ limit: '256kb' }));

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const CARD_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MATCHMAKING_IDLE_MS = 60_000;

// 안정성 테스트 단계의 랜덤 매칭은 단일 EC2 프로세스 메모리에서 관리한다.
// 서버 재시작 시 큐/매치는 초기화된다. 이후 다중 인스턴스/랭크전 단계에서 Redis로 이전한다.
const matchmakingQueue = [];
const activeMatches = new Map();
const matchByUser = new Map();

function signToken(user) {
  return jwt.sign(
    { uid: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: '30d' },
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no_token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

async function adminOnly(req, res, next) {
  try {
    const user = await User.findByPk(req.user.uid, {
      attributes: ['id', 'username', 'isAdmin'],
    });
    if (!user || !user.isAdmin) {
      return res.status(403).json({
        error: 'admin_only',
        message: '온라인 배틀은 안정성 테스트 중입니다. 관리자 계정만 이용할 수 있습니다.',
      });
    }
    req.dbUser = user;
    next();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
}

function sendSaveConflict(res, save) {
  return res.status(409).json({
    error: 'save_conflict',
    message: '다른 기기에서 더 최신 세이브가 저장되었습니다.',
    save: save ? save.data : null,
    revision: save ? save.revision : 0,
  });
}

async function ensureSaveRevisionColumn() {
  const queryInterface = sequelize.getQueryInterface();
  const tableName = SaveData.getTableName();
  const columns = await queryInterface.describeTable(tableName);

  if (!columns.revision) {
    await queryInterface.addColumn(tableName, 'revision', {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    console.log('✅ SaveData.revision 컬럼 추가 완료');
  }
}

async function ensureUserAdminColumn() {
  const queryInterface = sequelize.getQueryInterface();
  const tableName = User.getTableName();
  const columns = await queryInterface.describeTable(tableName);

  if (!columns.isAdmin) {
    await queryInterface.addColumn(tableName, 'isAdmin', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    console.log('✅ User.isAdmin 컬럼 추가 완료');
  }
}

function sanitizeDeckSnapshot(deck, deckShiny = {}) {
  if (!Array.isArray(deck) || deck.length !== 30) return null;
  if (!deck.every((cardId) => typeof cardId === 'string' && CARD_ID_RE.test(cardId))) {
    return null;
  }

  const shiny = {};
  if (deckShiny && typeof deckShiny === 'object' && !Array.isArray(deckShiny)) {
    const deckCounts = deck.reduce((acc, cardId) => {
      acc[cardId] = (acc[cardId] || 0) + 1;
      return acc;
    }, {});
    for (const [cardId, rawCount] of Object.entries(deckShiny)) {
      if (!CARD_ID_RE.test(cardId) || !deckCounts[cardId]) continue;
      const count = Number(rawCount);
      if (!Number.isInteger(count) || count <= 0) continue;
      shiny[cardId] = Math.min(count, deckCounts[cardId]);
    }
  }

  return { deck: [...deck], deckShiny: shiny };
}

function removeQueuedUser(uid) {
  const index = matchmakingQueue.findIndex((entry) => entry.uid === uid);
  if (index >= 0) matchmakingQueue.splice(index, 1);
}

function pruneStaleQueue() {
  const cutoff = Date.now() - MATCHMAKING_IDLE_MS;
  for (let i = matchmakingQueue.length - 1; i >= 0; i -= 1) {
    if (matchmakingQueue[i].lastSeenAt < cutoff) matchmakingQueue.splice(i, 1);
  }
}

function currentMatchForUser(uid) {
  const matchId = matchByUser.get(uid);
  if (!matchId) return null;
  const match = activeMatches.get(matchId);
  if (!match) {
    matchByUser.delete(uid);
    return null;
  }
  return match;
}

function matchmakingStatus(uid) {
  const match = currentMatchForUser(uid);
  if (match) {
    const me = match.players.find((player) => player.uid === uid);
    const opponent = match.players.find((player) => player.uid !== uid);
    return {
      status: 'matched',
      matchId: match.id,
      seat: me?.seat || null,
      goesFirst: match.firstUid === uid,
      opponent: opponent ? { username: opponent.username } : null,
      matchedAt: match.matchedAt,
    };
  }

  const queueIndex = matchmakingQueue.findIndex((entry) => entry.uid === uid);
  if (queueIndex >= 0) {
    matchmakingQueue[queueIndex].lastSeenAt = Date.now();
    return {
      status: 'searching',
      joinedAt: matchmakingQueue[queueIndex].joinedAt,
      queuePosition: queueIndex + 1,
    };
  }

  return { status: 'idle' };
}

function createMatch(firstEntry, secondEntry) {
  const id = crypto.randomUUID();
  const firstUid = Math.random() < 0.5 ? firstEntry.uid : secondEntry.uid;
  const match = {
    id,
    matchedAt: Date.now(),
    firstUid,
    players: [
      { ...firstEntry, seat: 'A' },
      { ...secondEntry, seat: 'B' },
    ],
  };
  activeMatches.set(id, match);
  matchByUser.set(firstEntry.uid, id);
  matchByUser.set(secondEntry.uid, id);
  return match;
}

function leaveMatchmaking(uid) {
  removeQueuedUser(uid);
  const match = currentMatchForUser(uid);
  if (!match) return;
  activeMatches.delete(match.id);
  for (const player of match.players) {
    if (matchByUser.get(player.uid) === match.id) matchByUser.delete(player.uid);
  }
}

app.get('/health', (req, res) => res.json({ ok: true }));

// ── 회원가입 ──
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!USERNAME_RE.test(username || '')) {
      return res.status(400).json({ error: 'bad_username', message: '아이디는 영문/숫자/밑줄 3~20자여야 해요.' });
    }
    if (!password || password.length < 4) {
      return res.status(400).json({ error: 'bad_password', message: '비밀번호는 4자 이상이어야 해요.' });
    }
    const exists = await User.findOne({ where: { username } });
    if (exists) return res.status(409).json({ error: 'username_taken', message: '이미 있는 아이디예요.' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, passwordHash });
    const token = signToken(user);
    res.json({
      token,
      username: user.username,
      isAdmin: !!user.isAdmin,
      save: null,
      revision: 0,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── 로그인 ──
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = await User.findOne({ where: { username } });
    if (!user) return res.status(401).json({ error: 'invalid_credentials', message: '아이디 또는 비밀번호가 틀렸어요.' });
    const ok = await bcrypt.compare(password || '', user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials', message: '아이디 또는 비밀번호가 틀렸어요.' });

    const token = signToken(user);
    const save = await SaveData.findOne({ where: { UserId: user.id } });
    res.json({
      token,
      username: user.username,
      isAdmin: !!user.isAdmin,
      save: save ? save.data : null,
      revision: save ? save.revision : 0,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// stonemaster를 입력한 로그인 계정만 서버 관리자 플래그를 얻는다.
app.post('/api/admin/unlock', auth, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (code !== ADMIN_CODE) {
      return res.status(403).json({
        error: 'invalid_admin_code',
        message: '관리자 코드가 올바르지 않습니다.',
      });
    }

    const user = await User.findByPk(req.user.uid);
    if (!user) return res.status(401).json({ error: 'invalid_token' });
    if (!user.isAdmin) await user.update({ isAdmin: true });
    return res.json({ ok: true, isAdmin: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ── 세이브 불러오기 ──
app.get('/api/save', auth, async (req, res) => {
  try {
    const [save, user] = await Promise.all([
      SaveData.findOne({ where: { UserId: req.user.uid } }),
      User.findByPk(req.user.uid, { attributes: ['isAdmin'] }),
    ]);
    res.json({
      save: save ? save.data : null,
      revision: save ? save.revision : 0,
      isAdmin: !!user?.isAdmin,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── 세이브 저장 (revision 기반 낙관적 잠금) ──
app.put('/api/save', auth, async (req, res) => {
  try {
    const { data, revision } = req.body || {};
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'bad_data' });
    }
    if (!Number.isInteger(revision) || revision < 0) {
      return res.status(400).json({
        error: 'bad_revision',
        message: '세이브 버전 정보가 없습니다. 페이지를 새로고침해주세요.',
      });
    }

    const row = await SaveData.findOne({ where: { UserId: req.user.uid } });

    if (!row) {
      if (revision !== 0) return sendSaveConflict(res, null);

      try {
        const created = await SaveData.create({
          data,
          revision: 1,
          UserId: req.user.uid,
        });
        return res.json({ ok: true, revision: created.revision });
      } catch (e) {
        if (e?.name === 'SequelizeUniqueConstraintError') {
          const latest = await SaveData.findOne({ where: { UserId: req.user.uid } });
          return sendSaveConflict(res, latest);
        }
        throw e;
      }
    }

    if (row.revision !== revision) {
      return sendSaveConflict(res, row);
    }

    const nextRevision = revision + 1;
    const [updated] = await SaveData.update(
      { data, revision: nextRevision },
      {
        where: {
          id: row.id,
          UserId: req.user.uid,
          revision,
        },
      },
    );

    if (updated !== 1) {
      const latest = await SaveData.findOne({ where: { UserId: req.user.uid } });
      return sendSaveConflict(res, latest);
    }

    return res.json({ ok: true, revision: nextRevision });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── 관리자 전용 랜덤 매칭 ──
app.post('/api/matchmaking/join', auth, adminOnly, async (req, res) => {
  try {
    pruneStaleQueue();
    const snapshot = sanitizeDeckSnapshot(req.body?.deck, req.body?.deckShiny);
    if (!snapshot) {
      return res.status(400).json({
        error: 'invalid_deck',
        message: '온라인 배틀은 30장 덱이 필요합니다.',
      });
    }

    const uid = req.dbUser.id;
    const existingMatch = currentMatchForUser(uid);
    if (existingMatch) return res.json(matchmakingStatus(uid));

    const queued = matchmakingQueue.find((entry) => entry.uid === uid);
    if (queued) {
      queued.deck = snapshot.deck;
      queued.deckShiny = snapshot.deckShiny;
      queued.lastSeenAt = Date.now();
      return res.json(matchmakingStatus(uid));
    }

    const opponentIndex = matchmakingQueue.findIndex((entry) => entry.uid !== uid);
    if (opponentIndex >= 0) {
      const [opponent] = matchmakingQueue.splice(opponentIndex, 1);
      createMatch(opponent, {
        uid,
        username: req.dbUser.username,
        ...snapshot,
        joinedAt: Date.now(),
        lastSeenAt: Date.now(),
      });
      return res.json(matchmakingStatus(uid));
    }

    matchmakingQueue.push({
      uid,
      username: req.dbUser.username,
      ...snapshot,
      joinedAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    return res.json(matchmakingStatus(uid));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/matchmaking/status', auth, adminOnly, async (req, res) => {
  pruneStaleQueue();
  return res.json(matchmakingStatus(req.dbUser.id));
});

app.post('/api/matchmaking/leave', auth, adminOnly, async (req, res) => {
  leaveMatchmaking(req.dbUser.id);
  return res.json({ ok: true, status: 'idle' });
});

sequelize.sync()
  .then(() => ensureSaveRevisionColumn())
  .then(() => ensureUserAdminColumn())
  .then(() => {
    app.listen(PORT, () => console.log(`✅ poke-stone-server on :${PORT}`));
  })
  .catch((e) => {
    console.error('DB 연결/동기화 실패:', e.message);
    process.exit(1);
  });
