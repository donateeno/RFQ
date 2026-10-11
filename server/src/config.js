'use strict';
/** All runtime configuration comes from environment variables (see deploy/.env.example). */

function list(v) {
  return String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function load(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const cfg = {
    production,
    port: Number(env.PORT) || 3000,
    databaseUrl: env.DATABASE_URL || 'postgres://rfq:rfq@localhost:5432/rfq',
    baseUrl: (env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
    sessionSecret: env.SESSION_SECRET || '',
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    allowedDomain: (env.ALLOWED_DOMAIN || 'eve.co.th').toLowerCase(),
    bootstrapAdmins: list(env.BOOTSTRAP_ADMINS),
    bootstrapSupervisors: list(env.BOOTSTRAP_SUPERVISORS),
    integrationToken: env.INTEGRATION_TOKEN || '',
    notifyWebhookUrl: env.NOTIFY_WEBHOOK_URL || '',
    devLogin: !production && env.DEV_LOGIN === '1',
    timezone: env.TZ || 'Asia/Bangkok'
  };
  if (production) {
    const missing = [];
    if (cfg.sessionSecret.length < 32) missing.push('SESSION_SECRET (32+ chars)');
    if (!cfg.googleClientId) missing.push('GOOGLE_CLIENT_ID');
    if (missing.length) throw new Error('Missing required configuration: ' + missing.join(', '));
  } else if (!cfg.sessionSecret) {
    cfg.sessionSecret = 'dev-only-session-secret-change-me-0123456789';
  }
  return cfg;
}

module.exports = { load };
