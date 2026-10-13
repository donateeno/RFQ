-- Customer price lookup ("ราคาตามลูกค้า"), loaded from the Customer Price Mapping Google Sheet (n8n).
-- Customer → group (own override, else the default group of its SAP channel) → price tier → ordered
-- discount / fee terms of the group and of the customer itself (pricing.applyTerms). Holds no cost.
create table price_terms (
  code         text primary key,
  name         text not null default '',
  name_en      text not null default '',
  category     text not null default '',
  method       text not null check (method in ('PCT_RUNNING', 'PCT_GROSS', 'THB_UNIT', 'THB_ORDER')),
  basis        text not null default '',
  borne_by     text not null default '',
  on_invoice   text not null default '',
  in_mu_net    text not null default '',
  reference    text not null default '',
  source       text not null default ''
);

create table customer_groups (
  code         text primary key,
  name         text not null default '',
  price_tier   text not null default '',   -- GT, DGT, BT, NTW, FOSTER, JS
  credit_days  int,
  approver     text not null default '',
  note         text not null default ''
);

create table sap_channel_groups (
  sap_channel  text primary key,
  group_code   text not null default ''
);

create table customers (
  code            text primary key,         -- SAP customer code
  name            text not null default '',
  sap_channel     text not null default '',
  sales_employee  text not null default '',
  last_month      text not null default '',
  override_group  text not null default '', -- Customer Map: replaces the channel's default group
  updated_at      timestamptz not null default now()
);
create index customers_name_idx on customers (lower(name));

create table group_terms (
  id          serial primary key,
  owner_code  text not null,                -- a customer group code, or a customer code for customer-only terms
  seq         int not null default 0,
  term_code   text not null references price_terms(code),
  pct         numeric(9, 6),
  thb         numeric(14, 2),
  scope       text not null default 'ALL',  -- ALL, a barcode or a model key
  valid_from  date,
  valid_to    date,
  note        text not null default ''
);
create index group_terms_owner_idx on group_terms (upper(owner_code));
