begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

select has_table('public', 'profiles', 'profiles table exists');
select has_table('public', 'laws', 'laws table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.profiles'::regclass), 'profiles RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.laws'::regclass), 'laws RLS enabled');
select columns_are('public', 'profiles', array['id', 'pseudonym', 'created_at', 'updated_at'], 'no private auth fields');

insert into auth.users (id, raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000001', '{"name":"Private Name","email":"private@example.invalid"}'),
 ('00000000-0000-0000-0000-000000000002', '{}');
alter table public.profiles disable trigger profiles_updated_at;
update public.profiles set updated_at = now() - interval '2 minutes';
alter table public.profiles enable trigger profiles_updated_at;
select is((select count(*) from public.profiles where id in (
 '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002')), 2::bigint, 'signup creates profiles');
select matches((select pseudonym from public.profiles where id = '00000000-0000-0000-0000-000000000001'), '^cidadao_[a-f0-9]{32}$', 'pseudonym ignores private metadata');

insert into public.laws (law_type, number, year, title, legislative_text, source_id, source_path, source_url, source_hash)
values ('lei', '1', 2026, 'Norma de teste', 'Texto de teste', 'test-lei-1', 'test/lei-1.json', 'https://github.com/ctresb/leis/blob/master/test/lei-1.json', repeat('a', 64));
select is((select legal_status from public.laws where source_id = 'test-lei-1'), 'unknown', 'does not presume law is in force');
select throws_ok($$update public.laws set jurisdiction = 'state' where source_id = 'test-lei-1'$$, '23514', null, 'only federal laws');
select throws_ok($$update public.laws set legal_status = 'in_force' where source_id = 'test-lei-1'$$, '23514', null, 'status needs evidence');
select throws_ok($$update public.laws set source_hash = 'bad' where source_id = 'test-lei-1'$$, '23514', null, 'valid source hash required');

set local role anon;
select ok(exists(select 1 from public.laws where source_id = 'test-lei-1'), 'anonymous law browsing');
select ok(exists(select 1 from public.profiles), 'anonymous public profiles');
select throws_ok($$update public.profiles set pseudonym = 'intruso'$$, '42501', null, 'anonymous profile writes denied');
select throws_ok($$delete from public.laws$$, '42501', null, 'anonymous law writes denied');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$update public.profiles set pseudonym = 'cidadao_teste' where id = '00000000-0000-0000-0000-000000000001'$$, 'own pseudonym can change');
select throws_ok($$update public.profiles set pseudonym = 'muito_rapido' where id = '00000000-0000-0000-0000-000000000001'$$, 'P0001', null, 'profile write throttle');
update public.profiles set pseudonym = 'intruso' where id = '00000000-0000-0000-0000-000000000002';
select isnt((select pseudonym from public.profiles where id = '00000000-0000-0000-0000-000000000002'), 'intruso', 'cannot edit another profile');
select throws_ok($$update public.profiles set id = '00000000-0000-0000-0000-000000000002'$$, '42501', null, 'cannot change profile ownership');
select throws_ok($$insert into public.profiles (id, pseudonym) values ('00000000-0000-0000-0000-000000000003', 'intruso')$$, '42501', null, 'cannot create profiles directly');
select throws_ok($$delete from public.profiles$$, '42501', null, 'cannot delete profiles directly');
select throws_ok($$update public.laws set title = 'adulterado'$$, '42501', null, 'authenticated law writes denied');
reset role;

select throws_ok($$insert into public.laws (law_type, number, year, title, legislative_text, source_id, source_path, source_url, source_hash)
values ('lei', '1', 2026, 'Duplicada', 'Texto', 'test-lei-1', 'other.json', 'https://example.invalid', repeat('b', 64))$$,
 '23505', null, 'unique source identity enables idempotent imports');
delete from auth.users where id = '00000000-0000-0000-0000-000000000001';
select is((select count(*) from public.profiles where id = '00000000-0000-0000-0000-000000000001'), 0::bigint, 'account deletion cascades to profile');
select * from finish();
rollback;
