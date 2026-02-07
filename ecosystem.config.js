/**
 * PM2 Ecosystem Configuration for GHL MCP Tool Gateway
 * 
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2 startup
 * 
 * ⚠️ Security: This file contains credentials. Never commit to version control.
 * Add to .gitignore: ecosystem.config.js
 */

// Load .env file explicitly (required for PM2 to have access to env vars)
require('dotenv').config({ path: '.env' });

module.exports = {
  apps: [{
    name: 'ghl-api',
    script: './server.js',
    cwd: '/home/ec2-user/mcp-ghl', // Run from git repo directory
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '500M',
    env: {
      // Non-secret configuration only
      NODE_ENV: 'production',
      PORT: process.env.PORT || 3000,
      
      // All secrets must come from .env file (loaded by dotenv above)
      // server.js will load .env again as a safety measure
      MCP_API_KEY: process.env.MCP_API_KEY,
      GHL_PIT_TOKEN: process.env.GHL_PIT_TOKEN,
      GHL_LOCATION_ID: process.env.GHL_LOCATION_ID,
      GHL_API_BASE: process.env.GHL_API_BASE,
      GHL_API_VERSION: process.env.GHL_API_VERSION,
    },
    error_file: '/home/ec2-user/mcp-ghl/logs/pm2-error.log',
    out_file: '/home/ec2-user/mcp-ghl/logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
  }],
};
