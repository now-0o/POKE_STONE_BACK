import { Sequelize } from 'sequelize';
import 'dotenv/config';

// MySQL 접속 정보는 .env에서 읽음 (예시는 .env.example 참고)
export const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    dialect: 'mysql',
    logging: false, // SQL 로그 끔 (디버깅 필요하면 console.log로 바꾸세요)
  }
);
