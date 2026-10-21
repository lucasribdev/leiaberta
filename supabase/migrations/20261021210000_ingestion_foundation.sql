begin;

-- No login/password or membership is provisioned here. The isolated runner will
-- receive membership from an operator, never through authenticator/PostgREST.
create role law_ingestor nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create schema ingestion_private;
revoke all on schema ingestion_private from public, anon, authenticated, service_role;
grant usage on schema public, ingestion_private to law_ingestor;
alter default privileges in schema ingestion_private revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema ingestion_private revoke execute on functions from public, anon, authenticated, service_role;

alter table public.laws
  alter column number drop not null,
  add column enactment_date date,
  add column publication_reference text,
  add column text_version text,
  add column official_source_url text check (official_source_url ~ '^https://[^[:space:]]+$'),
  add column source_urn text unique check (source_urn ~ '^urn:lex:br:'),
  add column source_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(source_metadata) = 'object'),
  add column source_downloaded_at date,
  add column source_commit_sha text check (source_commit_sha ~ '^[a-f0-9]{40}$'),
  add column source_blob_sha text check (source_blob_sha ~ '^[a-f0-9]{40}$'),
  add column status_checked_at timestamptz,
  add column source_removed_at timestamptz,
  add constraint laws_snapshot_pair check ((source_commit_sha is null) = (source_blob_sha is null)),
  add constraint laws_snapshot_permalink check (
    source_commit_sha is null or source_url = source_repository || '/blob/' || source_commit_sha || '/' || source_path
  );

-- Unknown legacy provenance remains unknown. Never copy an ambiguous URL or
-- fabricate verification timestamps. NOT VALID preserves legacy assertions;
-- all new writes must satisfy this constraint.
alter table public.laws add constraint laws_status_checked check (
  legal_status = 'unknown' or status_checked_at is not null
) not valid;
comment on column public.laws.source_url is 'GitHub file permalink for a known snapshot; legacy URLs are not automatically reclassified.';
comment on column public.laws.official_source_url is 'Official source from the document; URL syntax does not verify authority or legal status.';
comment on column public.laws.source_metadata is 'Parsed source metadata, including unknown fields and source claims; never evidence of verified legal status.';

create function ingestion_private.guard_law_identity()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.id is distinct from old.id
    or new.source_id is distinct from old.source_id
    or new.created_at is distinct from old.created_at) then
    raise exception 'Law UUID, initial source identity and creation time are immutable' using errcode = '23514';
  end if;
  if current_user = 'law_ingestor' and
     (new.source_commit_sha is null or new.source_blob_sha is null) then
    raise exception 'Ingestion requires a pinned source snapshot' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function ingestion_private.guard_law_identity() from public, anon, authenticated, service_role;
create trigger laws_identity before insert or update on public.laws
for each row execute function ingestion_private.guard_law_identity();

create table ingestion_private.runs (
  id uuid primary key default gen_random_uuid(),
  repository text not null default 'https://github.com/ctresb/leis' check (repository = 'https://github.com/ctresb/leis'),
  base_commit_sha text check (base_commit_sha ~ '^[a-f0-9]{40}$'),
  target_commit_sha text not null check (target_commit_sha ~ '^[a-f0-9]{40}$'),
  parser_version text not null check (btrim(parser_version) <> ''),
  config_hash text not null check (config_hash ~ '^[a-f0-9]{64}$'),
  mode text not null check (mode in ('full', 'incremental', 'reprocess')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'cancelled')),
  inventory_complete boolean not null default false,
  counters jsonb not null default '{}' check (jsonb_typeof(counters) = 'object'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  check ((status = 'running') = (finished_at is null)),
  check (finished_at is null or finished_at >= started_at),
  check (status <> 'completed' or inventory_complete),
  unique (repository, id, target_commit_sha)
);
create unique index ingestion_one_running_repository on ingestion_private.runs(repository) where status = 'running';

-- Append one row per attempt, including exclusions, failures and unchanged files.
-- Rows are immutable to the runner, so retries cannot erase earlier errors.
create table ingestion_private.items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references ingestion_private.runs(id),
  source_path text not null check (btrim(source_path) <> ''),
  previous_path text,
  operation text not null check (operation in ('add', 'modify', 'rename', 'remove', 'reprocess')),
  blob_sha text check (blob_sha ~ '^[a-f0-9]{40}$'),
  source_hash text check (source_hash ~ '^[a-f0-9]{64}$'),
  law_id uuid references public.laws(id) on delete restrict,
  outcome text not null check (outcome in ('inserted', 'updated', 'unchanged', 'excluded', 'removed', 'failed', 'conflict')),
  error_code text,
  error_message text,
  attempt integer not null default 1 check (attempt > 0),
  retry_after timestamptz,
  artifact_reference text,
  source_metadata jsonb not null default '{}' check (jsonb_typeof(source_metadata) = 'object'),
  recorded_at timestamptz not null default now(),
  check (outcome not in ('failed', 'conflict') or (nullif(btrim(error_code), '') is not null and nullif(btrim(error_message), '') is not null)),
  unique (run_id, source_path, attempt)
);
create index ingestion_pending_items on ingestion_private.items(outcome, retry_after) where outcome in ('failed', 'conflict');

create table ingestion_private.checkpoints (
  repository text primary key check (repository = 'https://github.com/ctresb/leis'),
  run_id uuid not null,
  commit_sha text not null,
  updated_at timestamptz not null default now(),
  foreign key (repository, run_id, commit_sha) references ingestion_private.runs(repository, id, target_commit_sha)
);

create function ingestion_private.guard_checkpoint()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Lock the referenced run against concurrent state changes. A failed/conflict
  -- attempt blocks advancement until a later successful attempt for that path.
  perform 1 from ingestion_private.runs where id = new.run_id and status = 'completed' and inventory_complete for update;
  if not found or exists (
    select 1 from ingestion_private.items i where i.run_id = new.run_id
    and i.outcome in ('failed', 'conflict') and not exists (
      select 1 from ingestion_private.items later where later.run_id = i.run_id
      and later.source_path = i.source_path and later.attempt > i.attempt
      and later.outcome not in ('failed', 'conflict')
    )
  ) then
    raise exception 'Checkpoint requires a completed inventory without unresolved failures' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and not exists (
    select 1 from ingestion_private.runs where id = new.run_id and base_commit_sha = old.commit_sha
  ) then
    raise exception 'Checkpoint base does not match previous commit' using errcode = '23514';
  end if;
  new.updated_at = statement_timestamp();
  return new;
end;
$$;
revoke all on function ingestion_private.guard_checkpoint() from public, anon, authenticated, service_role;
create trigger checkpoint_guard before insert or update on ingestion_private.checkpoints
for each row execute function ingestion_private.guard_checkpoint();

create table ingestion_private.law_source_paths (
  id uuid primary key default gen_random_uuid(),
  law_id uuid not null references public.laws(id) on delete restrict,
  repository text not null default 'https://github.com/ctresb/leis' check (repository = 'https://github.com/ctresb/leis'),
  source_path text not null check (btrim(source_path) <> ''),
  first_commit_sha text not null check (first_commit_sha ~ '^[a-f0-9]{40}$'),
  last_commit_sha text not null check (last_commit_sha ~ '^[a-f0-9]{40}$'),
  is_primary boolean not null default false,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  check (closed_at is null or closed_at >= opened_at)
);
create unique index ingestion_active_path on ingestion_private.law_source_paths(repository, source_path) where closed_at is null;
create unique index ingestion_primary_path on ingestion_private.law_source_paths(law_id) where is_primary and closed_at is null;

revoke all on all tables in schema ingestion_private from public, anon, authenticated, service_role, law_ingestor;
grant select, insert, update on ingestion_private.runs, ingestion_private.checkpoints, ingestion_private.law_source_paths to law_ingestor;
grant select, insert on ingestion_private.items to law_ingestor;
alter table ingestion_private.runs enable row level security;
alter table ingestion_private.items enable row level security;
alter table ingestion_private.checkpoints enable row level security;
alter table ingestion_private.law_source_paths enable row level security;
create policy ingestion_runner on ingestion_private.runs to law_ingestor using (true) with check (true);
create policy ingestion_runner on ingestion_private.items to law_ingestor using (true) with check (true);
create policy ingestion_runner on ingestion_private.checkpoints to law_ingestor using (true) with check (true);
create policy ingestion_runner on ingestion_private.law_source_paths to law_ingestor using (true) with check (true);

-- Column grants exclude legal status/evidence, identity updates and timestamps.
grant select on public.laws to law_ingestor;
grant insert (jurisdiction, law_type, number, year, title, summary, legislative_text,
  publication_date, enactment_date, publication_reference, text_version,
  official_source_url, source_urn, source_metadata, source_downloaded_at,
  source_commit_sha, source_blob_sha, source_removed_at, source_repository,
  source_id, source_path, source_url, source_hash, imported_at) on public.laws to law_ingestor;
grant update (law_type, number, year, title, summary, legislative_text,
  publication_date, enactment_date, publication_reference, text_version,
  official_source_url, source_urn, source_metadata, source_downloaded_at,
  source_commit_sha, source_blob_sha, source_removed_at, source_path,
  source_url, source_hash, imported_at) on public.laws to law_ingestor;
create policy laws_ingestion_read on public.laws for select to law_ingestor using (true);
create policy laws_ingestion_insert on public.laws for insert to law_ingestor with check (true);
create policy laws_ingestion_update on public.laws for update to law_ingestor using (true) with check (true);
commit;
