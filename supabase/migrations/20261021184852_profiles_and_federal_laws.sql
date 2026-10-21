-- The previous, empty migration was already applied locally. Keep its history intact.
begin;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  pseudonym text not null unique
    check (pseudonym ~ '^[a-zA-Z][a-zA-Z0-9_]{2,39}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Public pseudonyms only. Never copy email, OAuth identifiers or auth metadata here.';

create table public.laws (
  id uuid primary key default gen_random_uuid(),
  jurisdiction text not null default 'federal' check (jurisdiction = 'federal'),
  law_type text not null check (length(btrim(law_type)) > 0),
  number text not null check (length(btrim(number)) > 0),
  year integer not null check (year between 1800 and 9999),
  title text not null check (length(btrim(title)) > 0),
  summary text,
  legislative_text text not null check (length(btrim(legislative_text)) > 0),
  publication_date date,
  legal_status text not null default 'unknown'
    check (legal_status in ('unknown', 'in_force', 'repealed')),
  status_evidence_url text,
  source_repository text not null default 'https://github.com/ctresb/leis'
    check (source_repository = 'https://github.com/ctresb/leis'),
  source_id text not null unique check (length(btrim(source_id)) > 0),
  source_path text not null unique check (length(btrim(source_path)) > 0),
  source_url text not null check (source_url ~ '^https://'),
  source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint laws_status_requires_evidence check (
    legal_status = 'unknown' or
    (status_evidence_url is not null and status_evidence_url ~ '^https://')
  )
);

comment on column public.laws.legal_status is
  'Unknown by default. Any asserted status requires evidence verified by the importer/operator.';
comment on column public.laws.legislative_text is
  'Source legislative text; never user opinions or generated explanations. Render as plain text.';

create function public.create_profile_for_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- Random, public pseudonym unrelated to the user id, email or provider metadata.
  insert into public.profiles (id, pseudonym)
  values (new.id, 'cidadao_' || replace(gen_random_uuid()::text, '-', ''));
  return new;
end;
$$;

revoke all on function public.create_profile_for_user() from public, anon, authenticated;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.create_profile_for_user();

-- Also cover users created before this migration, without copying private metadata.
insert into public.profiles (id, pseudonym)
select id, 'cidadao_' || replace(gen_random_uuid()::text, '-', '') from auth.users;

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Database-enforced write throttle; clients cannot bypass it with direct API calls.
  if tg_table_name = 'profiles' and current_user = 'authenticated'
     and old.updated_at > statement_timestamp() - interval '60 seconds' then
    raise exception 'Aguarde 60 segundos entre alterações do pseudônimo.' using errcode = 'P0001';
  end if;
  new.updated_at = statement_timestamp();
  return new;
end;
$$;
revoke all on function public.set_updated_at() from public, anon, authenticated;
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger laws_updated_at before update on public.laws
  for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.laws enable row level security;

-- Clear Supabase's default grants before granting the minimum API permissions.
revoke all on public.profiles, public.laws from public, anon, authenticated, service_role;
grant select on public.profiles, public.laws to anon, authenticated;
grant update (pseudonym) on public.profiles to authenticated;
grant select, insert, update, delete on public.laws to service_role;

create policy profiles_public_read on public.profiles
  for select to anon, authenticated using (true);
create policy profiles_update_own on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
create policy laws_public_read on public.laws
  for select to anon, authenticated using (true);

-- No client insert/delete on profiles; no client writes on laws.
-- Profiles are deleted by the trusted account deletion flow through auth.users.
commit;
