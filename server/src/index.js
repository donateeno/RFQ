'use strict';
const { load } = require('./config');
const { createPool, migrate } = require('./db');
const { seed } = require('./seed');
const { createApp } = require('./app');

async function main() {
  const cfg = load();
  const db = createPool(cfg.databaseUrl);
  await migrate(db);
  await seed(db, cfg);
  const app = createApp({ db, cfg });
  const server = app.listen(cfg.port, () => console.log(`RFQ app listening on :${cfg.port} (${cfg.production ? 'production' : 'development'})`));
  const stop = () => server.close(() => db.end().then(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
