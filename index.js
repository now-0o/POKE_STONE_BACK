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

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const CARD_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MATCHMAKING_IDLE_MS = 60_000;
const ONLINE_COMMAND_TYPES = new Set([
  'mulligan',
  'play',
  'attack',
  'attack_obstacle',
  'discard_redraw',
  'end_turn',
  'resolve_pending',
  'resolve_choose',
  'surrender',
]);

// 랜덤 매칭/전투방은 단일 EC2 프로세스 메모리에서 관리한다.
// 서버 재시작 시 큐/매치는 초기화된다. 이후 Redis + 서버 권위 엔진으로 이전할 수 있게
// command/stateRevision 프로토콜을 분리해 둔다.
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

async function onlineUser(req, res, next) {
  try {
    const user = await User.findByPk(req.user.uid, {
      attributes: ['id', 'username'],
    });
    if (!user) {
      return res.status(401).json({ error: 'invalid_token' });
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

function playerForUser(match, uid) {
  return match?.players?.find((player) => player.uid === uid) || null;
}

function opponentForUser(match, uid) {
  return match?.players?.find((player) => player.uid !== uid) || null;
}

function canonicalSide(match, uid) {
  const player = playerForUser(match, uid);
  if (!player) return null;
  return player.seat === 'A' ? 'player' : 'enemy';
}

function firstSideForMatch(match) {
  return canonicalSide(match, match.firstUid) || 'player';
}

function matchmakingStatus(uid) {
  const match = currentMatchForUser(uid);
  if (match) {
    const me = playerForUser(match, uid);
    const opponent = opponentForUser(match, uid);
    return {
      status: 'matched',
      matchId: match.id,
      seat: me?.seat || null,
      goesFirst: match.firstUid === uid,
      opponent: opponent ? { username: opponent.username } : null,
      matchedAt: match.matchedAt,
      phase: match.phase,
      stateRevision: match.stateRevision,
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
  const players = [
    { ...firstEntry, seat: 'A' },
    { ...secondEntry, seat: 'B' },
  ];
  const match = {
    id,
    matchedAt: Date.now(),
    lastActivityAt: Date.now(),
    firstUid,
    hostUid: players[0].uid,
    seed: crypto.randomBytes(12).toString('hex'),
    players,
    phase: 'waiting_host',
    state: null,
    stateRevision: 0,
    commandSeq: 0,
    pendingCommand: null,
    lastCommand: null,
    mulliganDone: Object.fromEntries(players.map((player) => [player.uid, false])),
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

function matchFromRequest(req, res) {
  const match = activeMatches.get(req.params.matchId);
  if (!match || !playerForUser(match, req.dbUser.id)) {
    res.status(404).json({
      error: 'match_not_found',
      message: '온라인 배틀 세션을 찾을 수 없습니다.',
    });
    return null;
  }
  match.lastActivityAt = Date.now();
  return match;
}

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function clientGameState(match, uid) {
  if (!match.state) return null;
  const game = cloneJson(match.state);
  if (uid === match.hostUid) return game;

  const mine = canonicalSide(match, uid);
  const hidden = mine === 'player' ? 'enemy' : 'player';
  const hiddenPlayer = game.players?.[hidden];
  if (hiddenPlayer) {
    const deckCount = Array.isArray(hiddenPlayer.deck) ? hiddenPlayer.deck.length : 0;
    const hand = Array.isArray(hiddenPlayer.hand) ? hiddenPlayer.hand : [];
    hiddenPlayer.deck = Array.from({ length: deckCount }, () => null);
    hiddenPlayer.hand = hand.map((entry) => ({
      uid: entry?.uid || null,
      hidden: true,
    }));
    hiddenPlayer._shinyDeckRemaining = {};
  }

  if (game.pendingChoose?.side === hidden) {
    game.pendingChoose = null;
  }
  return game;
}

function roomStatePayload(match, uid) {
  const me = playerForUser(match, uid);
  const opponent = opponentForUser(match, uid);
  return {
    status: 'active',
    matchId: match.id,
    phase: match.phase,
    revision: match.stateRevision,
    host: match.hostUid === uid,
    mySide: canonicalSide(match, uid),
    firstSide: firstSideForMatch(match),
    opponent: opponent ? { username: opponent.username } : null,
    me: me ? { username: me.username, seat: me.seat } : null,
    mulligan: {
      me: !!match.mulliganDone[uid],
      opponent: opponent ? !!match.mulliganDone[opponent.uid] : false,
    },
    lastCommand:
      match.lastCommand?.uid === uid
        ? match.lastCommand
        : null,
    game: clientGameState(match, uid),
  };
}

function normalizeOnlineCommand(body) {
  const type = typeof body?.type === 'string' ? body.type : '';
  if (!ONLINE_COMMAND_TYPES.has(type)) return null;

  if (type === 'mulligan') {
    const raw = Array.isArray(body.cardUids) ? body.cardUids : [];
    const cardUids = [...new Set(raw)]
      .filter((uid) => typeof uid === 'string' && uid.length <= 128)
      .slice(0, 10);
    return { type, cardUids };
  }

  if (type === 'play') {
    if (typeof body.handUid !== 'string' || body.handUid.length > 128) return null;
    const command = { type, handUid: body.handUid };
    if (typeof body.targetUid === 'string' && body.targetUid.length <= 128) {
      command.targetUid = body.targetUid;
    }
    if (Number.isInteger(body.fieldIndex) && body.fieldIndex >= 0 && body.fieldIndex <= 6) {
      command.fieldIndex = body.fieldIndex;
    }
    return command;
  }

  if (type === 'attack') {
    if (
      typeof body.attackerUid !== 'string' || body.attackerUid.length > 128 ||
      typeof body.targetUid !== 'string' || body.targetUid.length > 128
    ) return null;
    return { type, attackerUid: body.attackerUid, targetUid: body.targetUid };
  }

  if (type === 'attack_obstacle') {
    if (
      typeof body.attackerUid !== 'string' || body.attackerUid.length > 128 ||
      typeof body.obstacleId !== 'string' || body.obstacleId.length > 128
    ) return null;
    return { type, attackerUid: body.attackerUid, obstacleId: body.obstacleId };
  }

  if (type === 'discard_redraw') {
    if (typeof body.handUid !== 'string' || body.handUid.length > 128) return null;
    return { type, handUid: body.handUid };
  }

  if (type === 'resolve_pending') {
    if (typeof body.targetUid !== 'string' || body.targetUid.length > 128) return null;
    return { type, targetUid: body.targetUid };
  }

  if (type === 'resolve_choose') {
    const value = body.value;
    if (!['string', 'number'].includes(typeof value)) return null;
    if (typeof value === 'string' && value.length > 128) return null;
    return { type, value };
  }

  return { type };
}

function validateSubmittedGame(game) {
  if (!game || typeof game !== 'object' || Array.isArray(game)) return false;
  if (!game.players?.player || !game.players?.enemy) return false;
  if (!['player', 'enemy'].includes(game.turn)) return false;
  if (!Array.isArray(game.log)) return false;
  return true;
}

app.get('/health', (req, res) => res.json({ ok: true }));

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

app.post('/api/matchmaking/join', auth, onlineUser, async (req, res) => {
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

app.get('/api/matchmaking/status', auth, onlineUser, async (req, res) => {
  pruneStaleQueue();
  return res.json(matchmakingStatus(req.dbUser.id));
});

app.post('/api/matchmaking/leave', auth, onlineUser, async (req, res) => {
  leaveMatchmaking(req.dbUser.id);
  return res.json({ ok: true, status: 'idle' });
});

// ── 온라인 배틀방 ──
app.get('/api/online/match/:matchId/bootstrap', auth, onlineUser, async (req, res) => {
  const match = matchFromRequest(req, res);
  if (!match) return;
  const uid = req.dbUser.id;
  const me = playerForUser(match, uid);
  const opponent = opponentForUser(match, uid);
  const host = match.hostUid === uid;

  return res.json({
    matchId: match.id,
    seat: me?.seat || null,
    host,
    mySide: canonicalSide(match, uid),
    firstSide: firstSideForMatch(match),
    seed: match.seed,
    phase: match.phase,
    stateRevision: match.stateRevision,
    me: me ? { username: me.username } : null,
    opponent: opponent ? { username: opponent.username } : null,
    ...(host
      ? {
          playerDeck: {
            username: match.players[0].username,
            deck: match.players[0].deck,
            deckShiny: match.players[0].deckShiny,
          },
          enemyDeck: {
            username: match.players[1].username,
            deck: match.players[1].deck,
            deckShiny: match.players[1].deckShiny,
          },
        }
      : {}),
  });
});

app.post('/api/online/match/:matchId/initialize', auth, onlineUser, async (req, res) => {
  const match = matchFromRequest(req, res);
  if (!match) return;
  if (match.hostUid !== req.dbUser.id) {
    return res.status(403).json({ error: 'host_only', message: '전투 초기화는 호스트만 할 수 있습니다.' });
  }
  if (match.state) return res.json(roomStatePayload(match, req.dbUser.id));
  if (!validateSubmittedGame(req.body?.game)) {
    return res.status(400).json({ error: 'invalid_game_state' });
  }
  if (req.body.game.firstSide !== firstSideForMatch(match)) {
    return res.status(409).json({ error: 'first_side_mismatch' });
  }

  match.state = cloneJson(req.body.game);
  match.stateRevision = 1;
  match.phase = 'mulligan';
  match.lastActivityAt = Date.now();
  return res.json(roomStatePayload(match, req.dbUser.id));
});

app.get('/api/online/match/:matchId/state', auth, onlineUser, async (req, res) => {
  const match = matchFromRequest(req, res);
  if (!match) return;
  return res.json(roomStatePayload(match, req.dbUser.id));
});

app.get('/api/online/match/:matchId/host', auth, onlineUser, async (req, res) => {
  const match = matchFromRequest(req, res);
  if (!match) return;
  if (match.hostUid !== req.dbUser.id) {
    return res.status(403).json({ error: 'host_only' });
  }

  return res.json({
    ...roomStatePayload(match, req.dbUser.id),
    game: cloneJson(match.state),
    pendingCommand: match.pendingCommand,
  });
});

app.post('/api/online/match/:matchId/command', auth, onlineUser, async (req, res) => {
  const match = matchFromRequest(req, res);
  if (!match) return;
  const uid = req.dbUser.id;
  const side = canonicalSide(match, uid);
  const command = normalizeOnlineCommand(req.body);
  if (!command) {
    return res.status(400).json({ error: 'invalid_command' });
  }
  if (!match.state) {
    return res.status(409).json({ error: 'room_not_ready', message: '전투방 초기화를 기다리는 중입니다.' });
  }
  if (match.pendingCommand) {
    return res.status(409).json({ error: 'command_busy', message: '이전 행동을 처리 중입니다.' });
  }
  if (match.phase === 'finished') {
    return res.status(409).json({ error: 'match_finished' });
  }

  if (match.phase === 'mulligan') {
    if (command.type !== 'mulligan') {
      return res.status(409).json({ error: 'mulligan_required' });
    }
    if (match.mulliganDone[uid]) {
      return res.status(409).json({ error: 'mulligan_already_done' });
    }
  } else if (match.phase === 'battle') {
    if (command.type !== 'surrender' && match.state.turn !== side) {
      return res.status(409).json({ error: 'not_your_turn', message: '상대 턴입니다.' });
    }
  } else {
    return res.status(409).json({ error: 'room_not_ready' });
  }

  const id = ++match.commandSeq;
  match.pendingCommand = {
    id,
    uid,
    side,
    payload: command,
    createdAt: Date.now(),
    baseRevision: match.stateRevision,
  };
  match.lastActivityAt = Date.now();
  return res.json({ ok: true, commandId: id, revision: match.stateRevision });
});

app.post('/api/online/match/:matchId/host/commit', auth, onlineUser, async (req, res) => {
  const match = matchFromRequest(req, res);
  if (!match) return;
  if (match.hostUid !== req.dbUser.id) {
    return res.status(403).json({ error: 'host_only' });
  }

  const pending = match.pendingCommand;
  if (!pending || pending.id !== req.body?.commandId) {
    return res.status(409).json({ error: 'command_mismatch' });
  }
  if (req.body?.baseRevision !== match.stateRevision || pending.baseRevision !== match.stateRevision) {
    return res.status(409).json({ error: 'revision_mismatch', revision: match.stateRevision });
  }
  if (!validateSubmittedGame(req.body?.game)) {
    return res.status(400).json({ error: 'invalid_game_state' });
  }

  const ok = req.body?.ok !== false;
  const error = ok ? null : String(req.body?.error || 'invalid_action').slice(0, 160);
  match.state = cloneJson(req.body.game);
  match.stateRevision += 1;
  match.lastCommand = {
    id: pending.id,
    uid: pending.uid,
    ok,
    error,
    revision: match.stateRevision,
  };

  if (ok && pending.payload.type === 'mulligan') {
    match.mulliganDone[pending.uid] = true;
    if (match.players.every((player) => match.mulliganDone[player.uid])) {
      match.phase = 'battle';
    }
  }

  if (ok && pending.payload.type === 'surrender') {
    match.phase = 'finished';
  }
  if (match.state?.winner) {
    match.phase = 'finished';
  }

  match.pendingCommand = null;
  match.lastActivityAt = Date.now();
  return res.json({
    ok: true,
    phase: match.phase,
    revision: match.stateRevision,
  });
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