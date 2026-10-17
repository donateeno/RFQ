-- Where each number came from (shown in ตาราง GP), and menus a user only gets when the owner grants them.
alter table products add column master_row int;                   -- SMG MASTER 'MASTER' row of the item (GP cells K–O, T–V, Y)
alter table customer_groups add column source_row int;            -- Customer Price Mapping 'Customer Groups' row
alter table group_terms add column source_row int;                -- Customer Price Mapping 'Group Terms' row
alter table users add column granted_menus text[] not null default '{}';   -- opt-in menus (e.g. ตาราง GP), granted by the owner
