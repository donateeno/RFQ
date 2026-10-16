-- Two-level partner pricing: gross price by price tier (GT/DGT/BT) and a GP % per item per GP tier
-- (SMG MASTER K–O, T–V, Y: SCGH, T15, T18, T20, T24, BT GP / MKT / DC, DST1), plus the NON PC wholesale
-- net price (cost file tab WHOLESALE). Both are selling-side numbers, not cost. Snapshotted per price list.
alter table products add column gp_rates jsonb;    -- {"T15":0.15,"T18":0.18,...}; missing key = no rate in MASTER
alter table products add column wholesale jsonb;   -- {"net":501.5,"label":"แพ็ค 6","options":[{"label":"ซื้อ 12 ลด 7%","net":697.5}]}
alter table customer_groups add column gp_tier text not null default '';  -- Customer Groups column I
