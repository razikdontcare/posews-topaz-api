/**
 * PM2 process definition for the video upscaler API.
 *
 *   npm install
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *
 * Fork mode with a single instance is a hard requirement, not a preference:
 * one Node process owns the queue, the SQLite database and the single GPU
 * renderer. Cluster mode would run two ffmpeg jobs at once and corrupt the
 * queue accounting.
 */
module.exports = {
  apps: [
    {
      name: 'video-upscaler-api',
      script: './src/server.js',

      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      watch: false,

      max_memory_restart: '512M',

      windowsHide: true,

      // Give the graceful shutdown (SIGINT -> stop queue -> terminate ffmpeg ->
      // close SQLite) enough time before PM2 kills the process.
      // Keep this above SHUTDOWN_TIMEOUT_MS + 15s.
      kill_timeout: 35000,
      listen_timeout: 15000,

      time: true,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',

      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
