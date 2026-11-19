// pm2 config for production (Linux VPS or Windows). Build first: npm run build
module.exports = {
  apps: [
    {
      name: 'mb-wa-server',
      cwd: './server',
      script: 'dist/index.js',
      env: { NODE_ENV: 'production' },
      max_restarts: 20,
      restart_delay: 5000,
    },
  ],
};
