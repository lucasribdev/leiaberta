begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
-- Test-only ability to SET ROLE; rolled back with all fixtures.
grant law_ingestor to postgres with set true;
grant usage on schema extensions to law_ingestor;

select ok(not rolcanlogin and not rolsuper and not rolbypassrls and not rolcreatedb and not rolcreaterole,
  'runner has no login, superuser, RLS bypass or DDL role privileges') from pg_roles where rolname = 'law_ingestor';
select ok(not pg_has_role('authenticator', 'law_ingestor', 'MEMBER'), 'API cannot assume runner role');
select ok(not has_schema_privilege(r, 'ingestion_private', 'USAGE'), r || ' cannot access operational schema')
from unnest(array['anon', 'authenticated', 'service_role']) r;
select ok(not has_table_privilege(r, 'ingestion_private.' || t, 'SELECT,INSERT,UPDATE,DELETE'), r || ' has no grants on ' || t)
from unnest(array['anon', 'authenticated', 'service_role']) r
cross join unnest(array['runs', 'items', 'checkpoints', 'law_source_paths']) t;
select ok(relrowsecurity, relname || ' has RLS') from pg_class where relnamespace = 'ingestion_private'::regnamespace and relkind = 'r';
select ok(not has_table_privilege('law_ingestor', 'public.laws', 'DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'runner cannot delete or administer laws');
select ok(not has_schema_privilege('law_ingestor', 'public', 'CREATE') and not has_schema_privilege('law_ingestor', 'ingestion_private', 'CREATE'), 'runner cannot create schema objects');
select ok(not has_table_privilege('law_ingestor', 'public.profiles', 'SELECT,INSERT,UPDATE,DELETE'), 'runner cannot access profiles');
select ok(not has_table_privilege('law_ingestor', 'auth.users', 'SELECT,INSERT,UPDATE,DELETE'), 'runner cannot access identities');
select ok(not has_column_privilege('law_ingestor', 'public.laws', c, 'UPDATE'), 'runner cannot update ' || c)
from unnest(array['id', 'source_id', 'created_at', 'legal_status', 'status_evidence_url', 'status_checked_at']) c;

set local role anon;
select throws_ok($$select * from ingestion_private.runs$$, '42501', null, 'anonymous operational read denied');
select throws_ok($$insert into ingestion_private.items default values$$, '42501', null, 'anonymous operational write denied');
reset role;
set local role authenticated;
select throws_ok($$select * from ingestion_private.items$$, '42501', null, 'authenticated failures read denied');
select throws_ok($$update ingestion_private.checkpoints set commit_sha = repeat('f',40)$$, '42501', null, 'authenticated checkpoint write denied');
reset role;

set local role law_ingestor;
select lives_ok($$insert into public.laws (law_type, year, title, legislative_text, source_id, source_path, source_url, source_hash,
 source_commit_sha, source_blob_sha, official_source_url, source_metadata)
values ('Decreto', 1821, 'Ato sem número', 'Texto preservado', 'la004:initial', 'federal/original.md',
 'https://github.com/ctresb/leis/blob/' || repeat('a',40) || '/federal/original.md', repeat('b',64), repeat('a',40), repeat('c',40),
 'https://normas.leg.br/ato', '{"revogada":false,"situacao":"Não consta revogação expressa","forca_legal_fonte":"NotInForce","extra":{"valor":1}}')$$, 'runner can insert unnumbered act with snapshot');
select is((select number from public.laws where source_id = 'la004:initial'), null::text, 'missing number is NULL');
select is((select legal_status from public.laws where source_id = 'la004:initial'), 'unknown', 'source claims never infer legal status');
select is((select source_metadata->'extra'->>'valor' from public.laws where source_id = 'la004:initial'), '1', 'unknown metadata preserved');
select isnt((select source_url from public.laws where source_id = 'la004:initial'), (select official_source_url from public.laws where source_id = 'la004:initial'), 'official and GitHub URLs are separate');
select throws_ok($$update public.laws set number = ' ' where source_id = 'la004:initial'$$, '23514', null, 'blank number rejected');
select lives_ok($$update public.laws set number = '14-A' where source_id = 'la004:initial'$$, 'textual number suffix allowed');
select lives_ok($$update public.laws set number = '1463-2' where source_id = 'la004:initial'$$, 'reissue number allowed');
select throws_ok($$update public.laws set source_commit_sha = null, source_blob_sha = null where source_id = 'la004:initial'$$, '23514', null, 'runner requires snapshot');
select throws_ok($$update public.laws set source_blob_sha = 'bad' where source_id = 'la004:initial'$$, '23514', null, 'Git blob hash validated');
select throws_ok($$update public.laws set source_url = 'https://github.com/ctresb/leis/blob/main/file.md' where source_id = 'la004:initial'$$, '23514', null, 'mutable URL rejected for snapshot');
select throws_ok($$update public.laws set source_metadata = '[]' where source_id = 'la004:initial'$$, '23514', null, 'metadata must be object');
select throws_ok($$update public.laws set legal_status = 'in_force', status_evidence_url = 'https://normas.leg.br/ato', status_checked_at = now() where source_id = 'la004:initial'$$, '42501', null, 'runner cannot assert status even with URL');
select throws_ok($$delete from public.laws where source_id = 'la004:initial'$$, '42501', null, 'runner cannot delete laws');
reset role;

create temporary table identity_before as select id, source_id, created_at from public.laws where source_id = 'la004:initial';
select throws_ok($$update public.laws set id = gen_random_uuid() where source_id = 'la004:initial'$$, '23514', null, 'UUID immutable even for administrator');
select throws_ok($$update public.laws set source_id = 'replacement' where source_id = 'la004:initial'$$, '23514', null, 'initial identity immutable');
select throws_ok($$update public.laws set legal_status = 'repealed', status_evidence_url = 'https://normas.leg.br/ato' where source_id = 'la004:initial'$$, '23514', null, 'status assertion requires verified timestamp');

set local role law_ingestor;
select lives_ok($$update public.laws set source_path = 'federal/renamed.md', source_url = 'https://github.com/ctresb/leis/blob/' || repeat('d',40) || '/federal/renamed.md', source_commit_sha = repeat('d',40), source_blob_sha = repeat('e',40), source_urn = 'urn:lex:br:federal:decreto:1821-05-26;seq-sf-1', legislative_text = 'Texto atualizado' where source_id = 'la004:initial'$$, 'rename, new URN and content update use same law');
select lives_ok($$insert into public.laws (law_type, year, title, legislative_text, source_id, source_path, source_url, source_hash, source_commit_sha, source_blob_sha)
values ('Decreto',1821,'Replay','Texto','la004:initial','federal/renamed.md',
'https://github.com/ctresb/leis/blob/' || repeat('d',40) || '/federal/renamed.md',repeat('b',64),repeat('d',40),repeat('e',40))
on conflict (source_id) do update set title = excluded.title where laws.source_hash <> excluded.source_hash$$, 'same-hash replay skips update');
select is((select title from public.laws where source_id = 'la004:initial'), 'Ato sem número', 'same-hash replay preserves projection');
select is((select count(*) from public.laws where source_id = 'la004:initial'), 1::bigint, 'replay does not duplicate law');
select lives_ok($$update public.laws set source_removed_at = now() where source_id = 'la004:initial'$$, 'removal records unavailability');
select is((select legal_status from public.laws where source_id = 'la004:initial'), 'unknown', 'Git removal does not revoke law');
reset role;
select is((select id from public.laws where source_id = 'la004:initial'), (select id from identity_before), 'update preserves UUID');
select is((select created_at from public.laws where source_id = 'la004:initial'), (select created_at from identity_before), 'update preserves creation time');
select throws_ok($$insert into public.laws (law_type, year, title, legislative_text, source_id, source_path, source_url, source_hash, source_urn)
values ('Decreto',1821,'Duplicata','Texto','la004:duplicate','other.md','https://example.invalid',repeat('a',64),'urn:lex:br:federal:decreto:1821-05-26;seq-sf-1')$$, '23505', null, 'duplicate URN conflicts instead of silently merging');

set local role law_ingestor;
insert into ingestion_private.runs (id, target_commit_sha, parser_version, config_hash, mode)
values ('00000000-0000-0000-0000-000000000004', repeat('d',40), 'test-v1', repeat('a',64), 'full');
select throws_ok($$insert into ingestion_private.runs (target_commit_sha, parser_version, config_hash, mode) values (repeat('a',40),'v1',repeat('b',64),'full')$$, '23505', null, 'only one active run per repository');
select throws_ok($$insert into ingestion_private.checkpoints values ('https://github.com/ctresb/leis','00000000-0000-0000-0000-000000000004',repeat('d',40),now())$$, '23514', null, 'running inventory cannot advance checkpoint');
select throws_ok($$insert into ingestion_private.items (run_id, source_path, operation, outcome) values ('00000000-0000-0000-0000-000000000004','bad.md','add','failed')$$, '23514', null, 'failure requires diagnostic');
insert into ingestion_private.items (run_id, source_path, operation, outcome, error_code, error_message)
values ('00000000-0000-0000-0000-000000000004','bad.md','add','failed','invalid_yaml','Synthetic invalid input');
select throws_ok($$update ingestion_private.items set error_message = 'erased'$$, '42501', null, 'runner cannot overwrite attempt history');
select throws_ok($$delete from ingestion_private.items$$, '42501', null, 'runner cannot erase failures');
select throws_ok($$update ingestion_private.runs set status = 'completed', finished_at = now()$$, '23514', null, 'completion requires full inventory');
update ingestion_private.runs set status = 'completed', inventory_complete = true, finished_at = now() where id = '00000000-0000-0000-0000-000000000004';
select throws_ok($$insert into ingestion_private.checkpoints values ('https://github.com/ctresb/leis','00000000-0000-0000-0000-000000000004',repeat('d',40),now())$$, '23514', null, 'unresolved failure blocks checkpoint');
insert into ingestion_private.items (run_id, source_path, operation, outcome, attempt)
values ('00000000-0000-0000-0000-000000000004','bad.md','reprocess','excluded',2);
select lives_ok($$insert into ingestion_private.checkpoints values ('https://github.com/ctresb/leis','00000000-0000-0000-0000-000000000004',repeat('d',40),now())$$, 'durable resolution permits checkpoint');
select throws_ok($$update ingestion_private.checkpoints set commit_sha = repeat('a',40)$$, '23514', null, 'checkpoint cannot advance from unrelated base');

insert into ingestion_private.law_source_paths (law_id, source_path, first_commit_sha, last_commit_sha, is_primary)
select id, 'federal/original.md', repeat('a',40), repeat('d',40), true from public.laws where source_id = 'la004:initial';
select throws_ok($$insert into ingestion_private.law_source_paths (law_id, source_path, first_commit_sha, last_commit_sha)
select id, 'federal/original.md', repeat('a',40), repeat('d',40) from public.laws where source_id = 'la004:initial'$$, '23505', null, 'active path cannot be claimed twice');
select throws_ok($$insert into ingestion_private.law_source_paths (law_id, source_path, first_commit_sha, last_commit_sha, is_primary)
select id, 'federal/renamed.md', repeat('a',40), repeat('d',40), true from public.laws where source_id = 'la004:initial'$$, '23505', null, 'law has at most one active primary path');
update ingestion_private.law_source_paths set closed_at = now();
select lives_ok($$insert into ingestion_private.law_source_paths (law_id, source_path, first_commit_sha, last_commit_sha, is_primary)
select id, 'federal/renamed.md', repeat('d',40), repeat('d',40), true from public.laws where source_id = 'la004:initial'$$, 'rename retains closed path history and opens new path');
reset role;
select * from finish();
rollback;
