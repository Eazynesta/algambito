create table public.crownline_state (
  id integer primary key check (id = 1),
  revision bigint not null default 0,
  data text not null check (jsonb_typeof(data::jsonb) = 'object')
);

alter table public.crownline_state enable row level security;
revoke all on public.crownline_state from public, anon, authenticated, service_role;
grant select, update on public.crownline_state to service_role;

insert into public.crownline_state (id, data)
values (1, '{"users":{},"matches":{},"friends":{},"queue":{}}');
