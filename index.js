import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { DataTypes } from 'sequelize';
import { sequelize } from './db.js';
import { User } from './models/User.js';
import { SaveData } from './models/SaveData.js';

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('JWT_SECRET이 .env에 없습니다. 서버를 시작할 수 없어요.');
  process.exit(1);
}

// Netlify redirect(/api/*)를 통해서만 들어오므로 CORS는 넓게 열어도
// 실제로는 프록시를 거친 same-origin 요청이라 문제 없음.
app.use(cors());
app.use(express.json({ limit: '256kb' })); // 세이브 데이터는 작아서 넉넉히

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function signToken(user) {
  return jwt.sign({ uid: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
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

function sendSaveConflict(res, save) {
  return res.status(409).json({
    error: 'save_conflict',
    message: '다른 기기에서 더 최신 세이브가 저장되었습니다.',
    save: save ? save.data : null,
    revision: save ? save.revision : 0,
  });
}

// 기존 운영 DB에도 revision 컬럼이 자동으로 한 번 추가되도록 한다.
// sequelize.sync()만으로는 이미 존재하는 테이블에 새 컬럼이 생기지 않는다.
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
    res.json({ token, username: user.username, save: null, revision: 0 });
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
      save: save ? save.data : null,
      revision: save ? save.revision : 0,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── 세이브 불러오기 ──
app.get('/api/save', auth, async (req, res) => {
  try {
    const save = await SaveData.findOne({ where: { UserId: req.user.uid } });
    res.json({
      save: save ? save.data : null,
      revision: save ? save.revision : 0,
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

    // 아직 서버 세이브가 없는 신규 계정.
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
        // 두 기기가 신규 세이브를 동시에 만들었다면 unique 제약에 걸린 쪽은
        // 최신 서버 세이브를 받아 충돌 처리한다.
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

    // 조회 직후 다른 기기가 먼저 저장했어도 조건부 UPDATE가 0건이 되어
    // 오래된 데이터가 최신 데이터를 덮어쓰지 못한다.
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

sequelize.sync()
  .then(() => ensureSaveRevisionColumn())
  .then(() => {
    app.listen(PORT, () => console.log(`✅ poke-stone-server on :${PORT}`));
  })
  .catch((e) => {
    console.error('DB 연결/동기화 실패:', e.message);
    process.exit(1);
  });
