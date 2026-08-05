module.exports = {
  apps: [
    {
      name: 'poke-stone-server',
      script: 'index.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
      // 죽으면 자동 재시작, 짧은 시간에 너무 자주 죽으면 재시작 중단
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
};
