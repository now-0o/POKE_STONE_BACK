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
}, {
  indexes: [{ unique: true, fields: ['userId'] }], // 유저당 세이브 1개
});

User.hasOne(SaveData, { onDelete: 'CASCADE' });
SaveData.belongsTo(User);
