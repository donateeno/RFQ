-- SAP B1 reports uploaded from the SAP Windows server (deploy/sap-b1/Upload-SapToRfq.ps1):
--   NDBS_ReportStock -> sap_stock  (whole table replaced on every upload)
--   NDBS_ReportSales -> sap_sales  (month-to-date file; rows upserted by row_key, so re-uploads never duplicate)
-- The procedures' columns belong to SAP, so each row is kept as exported (header -> text) in `data`;
-- item_code is pulled out for lookups. The rows may hold cost / gross-profit columns: never return them
-- to the browser except through makeView() (CLAUDE.md rule 1). No RPC reads these tables yet.
create table sap_stock (
  id         bigserial primary key,
  item_code  text not null default '',
  data       jsonb not null
);
create index sap_stock_item_idx on sap_stock (item_code);

create table sap_sales (
  row_key     text primary key,               -- key columns joined with '|', or a hash of the whole row
  item_code   text not null default '',
  data        jsonb not null,
  file_date   date not null,                  -- date of the newest file that carried this row
  first_seen  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index sap_sales_item_idx on sap_sales (item_code);

create table sap_uploads (
  id           bigserial primary key,
  kind         text not null check (kind in ('stock', 'sales')),
  file_name    text not null default '',
  file_date    date not null,
  rows         int not null,
  header       jsonb not null,
  uploaded_at  timestamptz not null default now()
);
