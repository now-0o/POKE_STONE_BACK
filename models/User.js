import { DataTypes } from 'sequelize';
import { sequelize } from '../db.js';

export const User = sequelize.define('User', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  username: {
    type: DataTypes.STRING(32),
    allowNull: false,
    unique: true,
  },
  passwordHash: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  isAdmin: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
});
