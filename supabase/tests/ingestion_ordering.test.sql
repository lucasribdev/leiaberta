begin;
create extension if not exists pgtap with schema extensions;
select plan(8);
grant law_ingestor to postgres with set true;
grant usage on schema extensions to law_ingestor;
select has_column('ingestion_private', 'runs', 'execution_sequence', 'runs have monotonic execution order');
select has_column('ingestion_private', 'items', 'event_sequence', 'items have monotonic attempt order');
select ok(has_sequence_privilege('law_ingestor', 'ingestion_private.items_event_sequence_seq', 'USAGE')
 and has_sequence_privilege('law_ingestor', 'ingestion_private.runs_execution_sequence_seq', 'USAGE'), 'runner can use both identity sequences');
select ok(not has_sequence_privilege(r, 'ingestion_private.items_event_sequence_seq', 'USAGE,SELECT,UPDATE')
 and not has_sequence_privilege(r, 'ingestion_private.runs_execution_sequence_seq', 'USAGE,SELECT,UPDATE'), r || ' cannot access operational sequences')
from unnest(array['anon', 'authenticated', 'service_role']) r;
set local role law_ingestor;
insert into ingestion_private.runs(id,target_commit_sha,parser_version,config_hash,mode,started_at)
values('00000000-0000-0000-0000-000000000005',repeat('a',40),'ordering-test',repeat('b',64),'full','2099-01-01');
insert into ingestion_private.items(run_id,source_path,operation,outcome,error_code,error_message,attempt,recorded_at)
values('00000000-0000-0000-0000-000000000005','synthetic.md','add','failed','synthetic','Synthetic clock regression',1,'2099-01-01');
insert into ingestion_private.items(run_id,source_path,operation,outcome,attempt,recorded_at)
values('00000000-0000-0000-0000-000000000005','synthetic.md','reprocess','unchanged',2,'2000-01-01');
select is((select outcome from ingestion_private.items where run_id='00000000-0000-0000-0000-000000000005' order by event_sequence desc limit 1),'unchanged','event order survives backwards timestamps');
update ingestion_private.runs set status='completed',inventory_complete=true,finished_at=greatest(statement_timestamp(),started_at)
where id='00000000-0000-0000-0000-000000000005';
select lives_ok($$insert into ingestion_private.checkpoints(repository,run_id,commit_sha)
values('https://github.com/ctresb/leis','00000000-0000-0000-0000-000000000005',repeat('a',40))$$,'clock regression does not break reconciled checkpoint');
reset role;
select * from finish();
rollback;
