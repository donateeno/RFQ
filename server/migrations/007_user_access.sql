-- Access the owner grants per user in the app (เจ้าของระบบ → ผู้ใช้และสิทธิ์).
-- Cost stays env-only (COST_VIEWERS); this never grants it.
alter table users add column can_view_gp boolean not null default false;   -- sees GP % and each discount step
alter table users add column hidden_menus text[] not null default '{}';    -- side-menu items (and their RPCs) closed to this user
