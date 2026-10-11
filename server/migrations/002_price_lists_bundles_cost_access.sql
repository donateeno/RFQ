-- Price list periods (the company re-prices about every 4 months), user-built bundles,
-- and a cost-visibility permission separate from roles.

create table price_lists (
  id              serial primary key,
  name            text not null unique,
  effective_from  date not null,
  note            text not null default '',
  created_by      text not null default '',
  created_at      timestamptz not null default now()
);

insert into price_lists (name, effective_from, note, created_by)
values ('เริ่มต้น', '2000-01-01', 'ราคาที่นำเข้าก่อนมีระบบรอบราคา', 'system');

alter table products add column price_list_id int references price_lists(id) on delete cascade;
update products set price_list_id = (select id from price_lists where name = 'เริ่มต้น');
alter table products alter column price_list_id set not null;
alter table products drop constraint products_pkey;
alter table products add primary key (price_list_id, brand, key_norm);
create index products_brand_key_idx on products (brand, key_norm);

-- Bundles ("DUMMY SET"): name = component keys joined with " + ", priced live from the current price list.
create table bundles (
  id          serial primary key,
  brand       text not null,
  name        text not null,
  name_norm   text generated always as (upper(btrim(name))) stored,
  label       text not null default '',
  created_by  text not null,
  created_at  timestamptz not null default now(),
  active      boolean not null default true
);
create unique index bundles_active_name_idx on bundles (brand, name_norm) where active;

create table bundle_items (
  bundle_id    int not null references bundles(id) on delete cascade,
  position     int not null,
  product_key  text not null,
  qty          int not null default 1 check (qty between 1 and 99),
  primary key (bundle_id, position)
);

alter table requests add column price_list_id int references price_lists(id);
alter table requests add column bundle_id int references bundles(id);

-- Only users listed in COST_VIEWERS (environment, not editable in the app) see cost, gain and exact %MU.
alter table users add column can_view_cost boolean not null default false;
