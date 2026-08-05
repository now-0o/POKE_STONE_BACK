# poke-stone-server

포스스톤 로그인 + 세이브 동기화용 최소 백엔드. Express + Sequelize(MySQL).

## 1. MySQL에 DB/유저 만들기

EC2에서 MySQL 접속 후:

```sql
CREATE DATABASE poke_stone CHARACTER SET utf8mb4;
CREATE USER 'poke_stone_user'@'localhost' IDENTIFIED BY '강한비밀번호로교체';
GRANT ALL PRIVILEGES ON poke_stone.* TO 'poke_stone_user'@'localhost';
FLUSH PRIVILEGES;
```

테이블(User, SaveData)은 따로 만들 필요 없음 — 서버 처음 실행할 때 Sequelize가 `sequelize.sync()`로 자동 생성함.

## 2. 설치 & 환경변수

```bash
cd poke-stone-server
npm install
cp .env.example .env
# .env 열어서 DB_PASSWORD, JWT_SECRET 채우기
```

JWT_SECRET 랜덤 생성:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 3. 로컬 테스트

```bash
npm start
# ✅ poke-stone-server on :4000 이 뜨면 정상
curl http://localhost:4000/health
```

## 4. PM2로 상시 구동

```bash
pm2 start ecosystem.config.cjs
pm2 save          # 재부팅 후에도 자동 시작하려면
pm2 startup       # 안내되는 명령어 한 줄 그대로 실행 (최초 1회)
pm2 logs poke-stone-server   # 로그 확인
```

## 5. 보안그룹

EC2 보안그룹 인바운드에 TCP 4000번 포트가 열려있어야 함 (이미 확인함).

## 6. Netlify 쪽 연결

프론트엔드 레포의 `netlify.toml`에 아래 리다이렉트 추가 (이미 반영됨):

```toml
[[redirects]]
  from = "/api/*"
  to = "http://<EC2_퍼블릭_IP>:4000/api/:splat"
  status = 200
  force = true
```

`<EC2_퍼블릭_IP>` 부분을 실제 IP로 바꿔서 Netlify에 재배포하면 끝.

## 참고: EC2 IP가 바뀌면?

인스턴스를 중지했다 다시 시작하면 퍼블릭 IP가 바뀔 수 있음(탄력적 IP 안 붙였다면).
그러면 `netlify.toml`의 IP만 새 걸로 바꿔서 다시 배포하면 됨.
