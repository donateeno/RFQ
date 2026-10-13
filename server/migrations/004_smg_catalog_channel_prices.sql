-- SMG catalogue (EVE / Evercook / Excel) from the cost file, the Nationwide pricelist and the SMG MASTER.
-- One cost per product (cost column, unchanged) and a selling price per channel tier:
--   GT, DGT (online) and BT hot price; when a product has no hot price it falls back to the Nationwide
--   promotion price (see pricing.resolveTierPrice). Channels name their tier in price-groups.json.
alter table channels add column price_tier text;

alter table products
  add column barcode      text,
  add column make         text not null default '',   -- EVE / EVERCOOK / EXCEL (brand stays the channel family, e.g. EVE)
  add column category     text not null default '',
  add column status       text not null default '',   -- Nationwide pricelist: S, OR, EX, G, MTO
  add column sale_channel text not null default '',   -- HOTPRICE "SALE CH.": NTW, GT Exclus., ยกเลิก, ...
  add column price_cat    text not null default '',   -- display-unit price category: A, B, NS
  add column list_price   numeric(14, 2),             -- Nationwide "NORMAL" (display only)
  add column price_gt     numeric(14, 2),
  add column price_dgt    numeric(14, 2),
  add column price_bt     numeric(14, 2),
  add column tiered       boolean not null default false;  -- true: channel price comes from price_<tier>, never normal_price

create index products_barcode_idx on products (price_list_id, brand, barcode);
