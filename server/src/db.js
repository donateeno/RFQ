'use strict';
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// numeric → JS number (values here are money/percentages well inside double precision)
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// date → 'YYYY-MM-DD' string, never shifted by timezone
types.setTypeParser(1082, (v) => v);

function createPool(databaseUrl) {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}

async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Applies migrations/*.sql in name order, once each. */
async function migrate(pool) {
  const dir = path.join(__dirname, '..', 'migrations');
  await pool.query('create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await pool.query('select id from schema_migrations')).rows.map((r) => r.id));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await tx(pool, async (c) => {
      await c.query(sql);
      await c.query('insert into schema_migrations (id) values ($1)', [f]);
    });
  }
}

module.exports = { createPool, tx, migrate };
