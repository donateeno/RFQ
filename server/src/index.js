'use strict';
const { load } = require('./config');
const { createPool, migrate } = require('./db');
const { seed } = require('./seed');
const { createApp } = require('./app');
const { createNotifier } = require('./rfq/notifications');
const { checkAndAlert } = require('./rfq/sources');
const { getSettings } = require('./rfq/catalog');

async function main() {
  const cfg = load();
  const db = createPool(cfg.databaseUrl);
  await migrate(db);
  await seed(db, cfg);
  const app = createApp({ db, cfg });
  const server = app.listen(cfg.port, () => console.log(`RFQ app listening on :${cfg.port} (${cfg.production ? 'production' : 'development'})`));
  // Hourly: alert the owners when a Google Sheets sync has not succeeded for SYNC_STALE_HOURS.
  const notify = createNotifier(cfg, console);
  const timer = setInterval(() => {
    getSettings(db).then((s) => checkAndAlert(db, cfg, notify, s.SYNC_STALE_HOURS)).catch((e) => console.error('[alerts]', e.message));
  }, 60 * 60 * 1000);
  timer.unref();
  const stop = () => server.close(() => db.end().then(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
