begin;

-- A wall clock can move backwards. Recovery and pending-item resolution need a
-- monotonic order, independent of timestamps or random UUIDs. Existing attempts
-- stay immutable; their initial sequence order is not evidence of historical time.
alter table ingestion_private.runs
  add column execution_sequence bigint generated always as identity unique;
alter table ingestion_private.items
  add column event_sequence bigint generated always as identity unique;

revoke all on sequence ingestion_private.runs_execution_sequence_seq,
  ingestion_private.items_event_sequence_seq from public, anon, authenticated, service_role;
grant usage on sequence ingestion_private.runs_execution_sequence_seq,
  ingestion_private.items_event_sequence_seq to law_ingestor;

create index ingestion_latest_path_event on ingestion_private.items(source_path, event_sequence desc);
create index ingestion_latest_law_event on ingestion_private.items(law_id, event_sequence desc)
  where outcome in ('inserted', 'updated', 'unchanged');

commit;
