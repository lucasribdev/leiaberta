# Integração Supabase

A base usa `@supabase/ssr` e `@supabase/supabase-js`, já instalados no projeto. Não há telas/rotas de login, votos, comentários nem importador nesta etapa.

## Ambiente local

Requisitos: Node.js 24+, npm e Docker em execução, acessível ao usuário atual.

```bash
npm ci
# O CLI já está inicializado: supabase/config.toml está versionado.
# Em um projeto vazio, a inicialização seria: npx supabase init
npm run supabase:start
npm run db:migrate
npx supabase status
```

Copie `.env.example` para `.env.local` apenas se o arquivo local ainda não existir. Preencha `VITE_SUPABASE_URL` com a API URL e `VITE_SUPABASE_PUBLISHABLE_KEY` com a publishable key mostradas pelo CLI. Versões locais que mostram somente `anon key` também são aceitas. O ambiente local existente foi preservado.

As duas variáveis são públicas e incorporadas pelo Vite ao browser e ao SSR, inclusive no build existente para Workers. Para outro ambiente, forneça os valores corretos **antes do build** e reconstrua ao alterá-los. Nenhuma credencial privilegiada é necessária para os clientes SSR/browser. Nunca coloque `service_role`, `sb_secret_*`, email ou identificadores OAuth em `VITE_*`. `.env*` está ignorado, exceto `.env.example`.

`env.ts` valida as variáveis com Zod quando o cliente é criado e informa apenas os nomes inválidos. A checagem do formato da chave evita configuração acidental com uma chave privilegiada; não substitui a validação de tokens pelo Supabase.

## Uso dos clientes

- `src/lib/supabase/client.ts`: `createClient()` exclusivo do browser; a biblioteca reutiliza a instância no navegador. Use em handlers/efeitos do cliente.
- `src/lib/supabase/server.ts`: `createClient()` exclusivo do servidor e criado dentro de cada requisição. Use em server functions, handlers ou middleware, nunca em escopo global. O adaptador lê todos os cookies, escreve inclusive remoções de chunks e propaga os headers de cache fornecidos pelo SSR.
- Loaders TanStack são isomórficos: encapsule acesso ao cliente SSR em `createServerFn`, em vez de importá-lo diretamente em um loader executado no navegador.
- Em futuras operações autenticadas, valide identidade no servidor com `auth.getClaims()` ou `auth.getUser()` e trate os erros; não confie em `getSession().data.session.user` para autorização. RLS continua obrigatória.
- Não aplique cache público/CDN a respostas autenticadas ou com `Set-Cookie`. Configure isso também em futuras rotas de callback/refresh; a configuração atual não implementa um fluxo OAuth completo.

## Schema e permissões

`20261021184539_initial_schema.sql` já estava aplicado, porém vazio. Seu histórico foi preservado; `20261021184852_profiles_and_federal_laws.sql` cria o primeiro schema funcional, em transação.

| Tabela | Leitura pública | Escrita |
| --- | --- | --- |
| `profiles` | UUID interno, pseudônimo e timestamps; sem email/dados OAuth | Trigger em `auth.users` cria pseudônimo aleatório. Usuário autenticado altera somente seu `pseudonym`, via RLS e grant de coluna. Sem INSERT/DELETE direto. |
| `laws` | Texto legislativo e proveniência | Somente processo confiável no servidor; clientes anon/authenticated sem escrita. |

A troca de pseudônimo aceita 3–40 caracteres ASCII, começa com letra e permite letras, números e `_`. O banco limita a uma alteração por minuto, inclusive durante o primeiro minuto após o cadastro. A unicidade é exata e diferencia maiúsculas de minúsculas. O UUID de perfil é interno ao Supabase, não um identificador do provedor OAuth. A exclusão de `auth.users` pelo futuro fluxo confiável de exclusão de conta remove o perfil em cascata.

Leis exigem jurisdição federal, tipo/número/ano/título/texto, repositório `ctresb/leis`, identificador e caminho únicos, URL, hash SHA-256 e timestamps de importação. O status é `unknown` por padrão. `in_force`/`repealed` exigem URL de evidência: a autenticidade dessa evidência deverá ser verificada pelo importador/operador; uma constraint não comprova vigência. O texto deve ser renderizado como texto seguro, separado das futuras opiniões.

O grant para `service_role` nas leis é a base de administração confiável, sem cliente privilegiado no app. O futuro importador deve usar credencial exclusiva no servidor e papel de menor privilégio, registrar falhas e preservar proveniência. A unicidade de origem dá suporte ao futuro upsert; o pipeline incremental ainda não foi implementado.

## Validação e geração de tipos

```bash
npm run db:migrate       # apenas banco local; não apaga dados
npm run db:types         # gera do banco local e substitui o arquivo atomicamente
npm run lint
npm run typecheck
npm test                # 4 testes Node: ambiente, SSR, cookies e headers
npm run test:db         # 24 verificações pgTAP, com rollback
npm run lint:db
npm run build
```

`database.types.ts` é gerado pelo CLI, formatado com Biome e consumido por ambos os clientes como `Database`. Gere novamente após cada mudança de schema. A geração usa arquivo temporário para preservar os tipos anteriores se o CLI falhar. Os testes Node usam module mocks experimentais; o aviso do Node é esperado.

Os testes SQL cobrem RLS ativa, ausência de campos privados, criação automática, leitura anônima, edição própria, bloqueio de terceiros, throttle, proteção de IDs, escrita negada, jurisdição federal, evidência de status, hash, unicidade de origem e exclusão em cascata. Todos os fixtures são sintéticos e a transação sofre rollback.

Não é necessário `supabase db reset` para esta entrega. Esse comando apaga os dados locais. Nenhum `link`, `db push`, reset ou deploy remoto foi executado. A aplicação em ambiente remoto deve ser revisada e autorizada separadamente.

## Próximas etapas de autenticação

Configurar Google/GitHub no projeto Supabase com credenciais próprias, URLs de callback/redirect permitidas e proteção anti-spam do Auth, antes de abrir cadastro público. Segredos dos provedores ficam no Supabase/ambiente servidor, nunca em `VITE_*`. Para desenvolvimento OAuth local, as seções `[auth.external.google]` e `[auth.external.github]` do `config.toml` devem referenciar credenciais por `env(...)`; não há credenciais de terceiros incluídas nesta entrega. Rotas de callback, login/logout e interface de edição de pseudônimo ficam para a issue de autenticação.

## Referências oficiais

Consultadas em 21/10/2026:

- [Supabase com TanStack Start](https://supabase.com/docs/guides/getting-started/quickstarts/tanstack)
- [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [CLI e migrations locais](https://supabase.com/docs/guides/local-development/cli-workflows)
- [Testes do banco](https://supabase.com/docs/guides/local-development/cli/testing-and-linting)
- [Modelo de execução do TanStack Start](https://tanstack.com/start/latest/docs/framework/react/guide/execution-model)
