-- Price list names are matched case-insensitively ("aug26" and "AUG26 " are the same list).
-- Fails on purpose if two existing names differ only by case/spaces: rename one first.
alter table price_lists drop constraint price_lists_name_key;
alter table price_lists add column name_norm text generated always as (upper(btrim(name))) stored;
create unique index price_lists_name_norm_idx on price_lists (name_norm);

-- Every price check by someone who cannot see cost. Checking one item at many net prices (by changing
-- the special price, the discounts or the channel) can reveal the MU thresholds and so the cost:
-- distinct net prices per user + item are rate-limited and reported to the admins. Holds no cost, gain or %MU.
create table price_checks (
  id            bigserial primary key,
  at            timestamptz not null default now(),
  user_email    text not null,
  channel_id    text not null,
  key_norm      text not null,
  special_price numeric not null,
  net_price     numeric not null,
  indicator     text not null default ''
);
create index price_checks_user_at_idx on price_checks (user_email, at);
create index price_checks_user_key_idx on price_checks (user_email, key_norm, at);
