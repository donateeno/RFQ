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
    // Google Workspace domains that may sign in, e.g. "eve.co.th, siammanor.com"
    allowedDomains: list(env.ALLOWED_DOMAIN || 'eve.co.th'),
    bootstrapAdmins: list(env.BOOTSTRAP_ADMINS),
    bootstrapSupervisors: list(env.BOOTSTRAP_SUPERVISORS),
    // The only people who may see cost, gain and exact %MU. Set on the server only — not editable in the app.
    costViewers: list(env.COST_VIEWERS),
    // Who manages users, permissions and the owner menus in the app. Defaults to the cost viewers.
    owners: list(env.OWNERS || env.COST_VIEWERS),
    integrationToken: env.INTEGRATION_TOKEN || '',
    notifyWebhookUrl: env.NOTIFY_WEBHOOK_URL || '',
    // n8n webhook that starts the SMG catalogue sync (cost file + Nationwide pricelist + SMG MASTER)
    syncWebhookUrl: env.SYNC_WEBHOOK_URL || '',
    devLogin: !production && env.DEV_LOGIN === '1',
    timezone: env.TZ || 'Asia/Bangkok'
  };
  if (!cfg.allowedDomains.length) throw new Error('ALLOWED_DOMAIN must name at least one domain');
  if (production) {
    const missing = [];
    if (cfg.sessionSecret.length < 32) missing.push('SESSION_SECRET (32+ chars)');
    if (!cfg.googleClientId) missing.push('GOOGLE_CLIENT_ID');
    if (!cfg.owners.length) missing.push('OWNERS or COST_VIEWERS (who manages users)');
    if (missing.length) throw new Error('Missing required configuration: ' + missing.join(', '));
  } else if (!cfg.sessionSecret) {
    cfg.sessionSecret = 'dev-only-session-secret-change-me-0123456789';
  }
  return cfg;
}

module.exports = { load };
