module.exports = {
  apps: [{
    name: 'claude-monitor',
    script: '/home/dev/clawd/monitors/claude-monitor.sh',
    args: '--daemon',
    interpreter: '/bin/bash',
    cwd: '/home/dev/clawd/monitors',
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    watch: false,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: '/home/dev/clawd/monitors/logs/pm2-error.log',
    out_file: '/home/dev/clawd/monitors/logs/pm2-out.log',
    merge_logs: true,
    env: {
      NODE_ENV: 'production'
    }
  }]
};
