'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cookieSession = require('cookie-session');
const rateLimit = require('express-rate-limit');
const { OAuth2Client } = require('google-auth-library');
const { UserError } = require('./pricing');
const service = require('./rfq/service');
const { importData } = require('./rfq/importers');
const { createNotifier } = require('./rfq/notifications');

const PUBLIC = path.join(__dirname, '..', 'public');

/**
 * @param {{db: import('pg').Pool, cfg: object, logger?: Console, notify?: Function, verifyGoogleToken?: Function}} deps
 */
function createApp(deps) {
  const { db, cfg } = deps;
  const logger = deps.logger || console;
  const notify = deps.notify || createNotifier(cfg, logger);
  const oauth = new OAuth2Client(cfg.googleClientId);
  const verifyGoogleToken = deps.verifyGoogleToken || (async (idToken) =>
    (await oauth.verifyIdToken({ idToken, audience: cfg.googleClientId })).getPayload());

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://accounts.google.com/gsi/client'],
        frameSrc: ['https://accounts.google.com/gsi/'],
        connectSrc: ["'self'", 'https://accounts.google.com/gsi/'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://accounts.google.com/gsi/style'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https://*.googleusercontent.com'],
        upgradeInsecureRequests: cfg.production ? [] : null
      }
    },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
  }));
  app.use(express.json({ limit: '20mb' }));
  app.use(cookieSession({
    name: 'rfq_session',
    keys: [cfg.sessionSecret],
    maxAge: 12 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: cfg.production
  }));
  const limiter = rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false });
  app.use(['/api', '/auth'], limiter);

  app.get('/healthz', async (req, res) => {
    try { await db.query('select 1'); res.json({ ok: true }); } catch (e) { res.status(503).json({ ok: false }); }
  });

  // ------------------------------------------------------------ auth

  async function sessionUser(req) {
    const email = req.session && req.session.email;
    if (!email) return null;
    const u = (await db.query('select email, name, role, active from users where email = $1', [email])).rows[0];
    if (!u || !u.active) { req.session = null; return null; }
    return u;
  }

  async function signIn(req, email, name) {
    email = String(email).toLowerCase();
    const u = (await db.query(
      `insert into users (email, name, last_login_at) values ($1, $2, now())
       on conflict (email) do update set last_login_at = now(), name = case when users.name = '' or users.name = split_part(users.email, '@', 1) then excluded.name else users.name end
       returning *`, [email, name || email.split('@')[0]])).rows[0];
    if (!u.active) throw new UserError('บัญชีนี้ถูกปิดการใช้งาน', 403);
    req.session.email = u.email;
    return u;
  }

  app.post('/auth/google', async (req, res) => {
    try {
      const p = await verifyGoogleToken(String((req.body && req.body.credential) || ''));
      const domain = String(p.email || '').split('@')[1];
      if (!p.email_verified || p.hd !== cfg.allowedDomain || domain !== cfg.allowedDomain) {
        throw new UserError(`อนุญาตเฉพาะบัญชี @${cfg.allowedDomain}`, 403);
      }
      await signIn(req, p.email, p.name);
      res.json({ ok: true });
    } catch (e) {
      sendError(res, e instanceof UserError ? e : new UserError('เข้าสู่ระบบไม่สำเร็จ', 401), logger);
    }
  });

  if (cfg.devLogin) {
    // Local preview/tests only — never enabled when NODE_ENV=production (see config.js).
    app.get('/auth/dev', async (req, res) => {
      const email = String(req.query.email || '');
      if (!email.endsWith('@' + cfg.allowedDomain)) return res.status(400).send('bad email');
      await signIn(req, email, email.split('@')[0]);
      res.redirect('/' + (req.query.hash ? '#' + req.query.hash : ''));
    });
  }

  app.post('/auth/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

  app.get('/login', (req, res) => {
    const html = fs.readFileSync(path.join(PUBLIC, 'login.html'), 'utf8')
      .replace('{{GOOGLE_CLIENT_ID}}', escAttr(cfg.googleClientId))
      .replace('{{ALLOWED_DOMAIN}}', escAttr(cfg.allowedDomain))
      .replace('{{DEV_LOGIN}}', cfg.devLogin ? '<form class="dev" action="/auth/dev"><input name="email" placeholder="someone@' + escAttr(cfg.allowedDomain) + '"><button>Dev login</button></form>' : '');
    res.type('html').send(html);
  });

  // ------------------------------------------------------------ browser API (session + CSRF header)

  app.post('/api/rpc/:fn', async (req, res) => {
    try {
      if (req.get('X-RFQ') !== '1') throw new UserError('Bad request', 400);
      const fn = service.rpc[req.params.fn];
      if (!fn || !Object.prototype.hasOwnProperty.call(service.rpc, req.params.fn)) throw new UserError('Not found', 404);
      const user = await sessionUser(req);
      if (!user) throw new UserError('กรุณาเข้าสู่ระบบ', 401);
      const args = Array.isArray(req.body && req.body.args) ? req.body.args : [];
      const out = await fn({ db, cfg, user, notify, logger }, ...args);
      res.json({ ok: true, data: out === undefined ? null : out });
    } catch (e) {
      sendError(res, e, logger);
    }
  });

  // ------------------------------------------------------------ n8n integration API (bearer token)

  const integration = express.Router();
  integration.use((req, res, next) => {
    const auth = req.get('Authorization') || '';
    if (!cfg.integrationToken || auth !== 'Bearer ' + cfg.integrationToken) return res.status(401).json({ ok: false, error: 'unauthorized' });
    next();
  });
  integration.post('/import/:type', async (req, res) => {
    try {
      const out = await importData(db, { type: req.params.type, values: req.body && req.body.values, brand: req.query.brand, group: req.query.group, today: service.todayIso(cfg.timezone) });
      await db.query(`insert into audit_log (user_email, action, detail) values ('n8n', 'IMPORT', $1)`, [JSON.stringify({ type: req.params.type, imported: out.imported })]);
      res.json({ ok: true, data: out });
    } catch (e) { sendError(res, e, logger); }
  });
  integration.get('/requests', async (req, res) => {
    try {
      const rows = (await db.query(`select r.*, g.name as group_name, c.name as channel_name from requests r
        left join price_groups g on g.id = r.group_id left join channels c on c.id = r.channel_id order by r.requested_at nulls first, r.id`)).rows;
      const header = ['Req. Id.', 'Batch', 'Price group', 'Channel', 'Customer', 'Project', 'Note', 'Product key', 'Product', 'Qty',
        'Normal price', 'Special price', 'Disc 1', 'Disc 2', 'Disc 3', 'Cost', 'Net incl. VAT', 'Net ex VAT', 'Gain', '%MU', 'Indicator',
        'Status', 'Start', 'End', 'Requester', 'Requested at', 'Decided by', 'Decided at', 'Comment', 'Flags', 'Source'];
      const iso = (d) => (d ? d.toISOString() : '');
      const values = rows.map((r) => [r.id, r.batch_id || '', r.group_name || r.group_id, r.channel_name || r.channel_id, r.customer, r.project, r.note,
        r.product_key, r.product_name, r.qty ?? '', r.normal_price ?? '', r.special_price ?? '',
        ...[0, 1, 2].map((i) => (r.discounts || [])[i] ?? ''), r.cost ?? '', r.net_inc_vat ?? '', r.net_ex_vat ?? '', r.gain ?? '', r.mu ?? '', r.indicator,
        r.status, r.start_date || '', r.end_date || '', r.requester, iso(r.requested_at), r.decided_by || '', iso(r.decided_at), r.decision_comment,
        (r.flags || []).join('; '), r.source]);
      res.json({ ok: true, header, values: [header].concat(values) });
    } catch (e) { sendError(res, e, logger); }
  });
  app.use('/api/integrations', integration);

  // ------------------------------------------------------------ pages

  app.get('/', async (req, res, next) => {
    try {
      if (!(await sessionUser(req))) return res.redirect('/login');
      res.sendFile(path.join(PUBLIC, 'index.html'));
    } catch (e) { next(e); }
  });
  app.use(express.static(PUBLIC, { index: false, maxAge: cfg.production ? '1h' : 0 }));
  app.use((req, res) => res.status(404).send('Not found'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => sendError(res, err, logger));
  return app;
}

function sendError(res, e, logger) {
  if (e instanceof UserError) return res.status(e.status).json({ ok: false, error: e.message });
  if (e && e.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'ข้อมูลใหญ่เกินไป' });
  logger.error(e);
  res.status(500).json({ ok: false, error: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่' });
}

function escAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { createApp };
