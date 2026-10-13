-- RFQ special-price approval — initial schema

create table users (
  email          text primary key,
  name           text not null default '',
  role           text not null default 'SALES' check (role in ('SALES', 'SUPERVISOR', 'ADMIN')),
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz
);

create table settings (
  key          text primary key,
  value        jsonb not null,
  description  text not null default ''
);

-- Price groups and channels are synced from config/price-groups.json on start.
create table price_groups (
  id               text primary key,
  name             text not null,
  description      text not null default '',
  cost_source      text not null check (cost_source in ('PRODUCT', 'PROJECT', 'LANDED')),
  indicator_rules  jsonb not null default '[]',
  params           jsonb not null default '{}',
  sort             int not null default 0,
  active           boolean not null default true
);

create table channels (
  id           text primary key,
  group_id     text not null references price_groups(id),
  name         text not null,
  brand        text,
  id_prefix    text not null,
  formula      text not null check (formula in ('MULTIPLY', 'GP_ON_NORMAL')),
  discounts    jsonb not null default '[]',
  key_label    text not null default '',
  description  text not null default '',
  sort         int not null default 0,
  active       boolean not null default true
);

-- Cost masters. key_norm makes look-ups case/space-insensitive.
create table products (
  brand         text not null,
  key           text not null,
  key_norm      text generated always as (upper(btrim(key))) stored,
  name          text not null default '',
  cost          numeric(14, 4),
  normal_price  numeric(14, 2),
  source        text not null default '',
  updated_at    timestamptz not null default now(),
  primary key (brand, key_norm)
);

create table project_costs (
  group_id      text not null references price_groups(id),
  project_key   text not null,
  key_norm      text generated always as (upper(btrim(project_key))) stored,
  customer      text not null default '',
  description   text not null default '',
  cost          numeric(14, 2),
  normal_price  numeric(14, 2),
  source        text not null default '',
  updated_at    timestamptz not null default now(),
  primary key (group_id, key_norm)
);

create table landed_items (
  group_id      text not null references price_groups(id),
  item_code     text not null,
  key_norm      text generated always as (upper(btrim(item_code))) stored,
  description   text not null default '',
  factory_rmb   numeric(14, 2) not null,
  exch_rate     numeric(10, 4) not null,
  bp_disc       numeric(6, 4) not null default 0,
  incoterm      text,
  misc_charge   numeric(14, 2) not null default 0,
  source        text not null default '',
  updated_at    timestamptz not null default now(),
  primary key (group_id, key_norm)
);

create table id_counters (
  prefix      text primary key,
  last_value  int not null default 0
);

create table requests (
  id                text primary key,
  batch_id          text,
  group_id          text not null,
  channel_id        text not null,
  cost_source       text not null,
  brand             text,
  customer          text not null default '',
  project           text not null default '',
  note              text not null default '',
  product_key       text not null default '',
  product_name      text not null default '',
  qty               int,
  normal_price      numeric(14, 2),
  special_price     numeric(14, 2),
  discounts         jsonb not null default '[]',
  discount_labels   jsonb not null default '[]',
  cost              numeric(14, 2),
  net_inc_vat       numeric(14, 2),
  net_ex_vat        numeric(14, 2),
  gain              numeric(14, 2),
  mu                numeric(10, 4),
  indicator         text not null default '',
  status            text not null default 'Pending'
                    check (status in ('Pending', 'Approved', 'Rejected', 'Cancelled', 'Closed')),
  start_date        date,
  end_date          date,
  requester         text not null default '',
  requested_at      timestamptz,
  decided_by        text,
  decided_at        timestamptz,
  decision_comment  text not null default '',
  flags             text[] not null default '{}',
  source            text not null default 'APP',
  updated_at        timestamptz not null default now()
);
create index requests_status_idx on requests (status);
create index requests_requester_idx on requests (lower(requester));
create index requests_requested_at_idx on requests (requested_at desc);
create index requests_group_idx on requests (group_id, channel_id);
create index requests_product_idx on requests (upper(product_key));
create index requests_customer_idx on requests (lower(customer));

create table audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  user_email  text not null,
  action      text not null,
  req_ids     text[] not null default '{}',
  detail      jsonb not null default '{}'
);
create index audit_log_at_idx on audit_log (at desc);
