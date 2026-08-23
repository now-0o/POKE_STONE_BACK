import { DataTypes } from 'sequelize';
import { sequelize } from '../db.js';
import { User } from './User.js';

export const SaveData = sequelize.define('SaveData', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  // 클라이언트의 세이브 객체를 통째로 JSON으로 저장.
  // { money, collection, deck, wins, packsOpened } 구조가 바뀌어도
  // 여기 스키마는 손댈 필요 없음.
  data: {
    type: DataTypes.JSON,
    allowNull: false,
  },
  // 여러 기기가 같은 계정을 동시에 열어도 오래된 세이브가 최신 세이브를
  // 덮어쓰지 못하도록 사용하는 낙관적 잠금 버전.
  revision: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
}, {
  indexes: [{ unique: true, fields: ['userId'] }], // 유저당 세이브 1개
});

User.hasOne(SaveData, { onDelete: 'CASCADE' });
SaveData.belongsTo(User);
