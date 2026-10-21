# LeiAberta — Arquitetura

**Estado:** arquitetura-alvo do MVP; verificar código antes de considerar qualquer item implementado.

## Stack

| Camada | Tecnologia |
|---|---|
| Aplicação full-stack | TanStack Start + TypeScript strict |
| Rotas | TanStack Router |
| Cache e estado remoto | TanStack Query |
| Formulários | TanStack Form + Zod |
| Interface | Tailwind CSS |
| Persistência | Supabase PostgreSQL |
| Autenticação | Supabase Auth + `@supabase/ssr` |
| Autorização | PostgreSQL Row Level Security (RLS) |
| Busca inicial | PostgreSQL Full Text Search |
| Hospedagem | Cloudflare Workers |
| Ingestão | Script TypeScript executado fora do runtime de requisições |
| Testes | Testes unitários, banco/RLS e E2E |

## Estado conhecido da fundação

Conforme documentação de integração Supabase já existente no projeto (não auditada diretamente):

- Clientes Supabase de navegador e SSR foram criados.
- Existem migrations locais para `profiles` e `laws`.
- RLS e testes de banco foram implementados para essas tabelas.
- Tipos TypeScript do banco são gerados pelo CLI.
- OAuth completo, importador, votos, comentários e UI de consulta ainda não foram implementados.
- Não há confirmação de migrations aplicadas ao projeto remoto nem de deploy no Cloudflare.

**Fonte de verdade:** migrations e código efetivamente presentes no repositório. Se houver divergência, atualizar este documento após revisão.

## Fronteiras de confiança

- Browser: usa apenas URL e publishable key públicas; nunca recebe chave privilegiada.
- SSR/Server Functions: cliente Supabase por requisição, com cookies seguros; identidade validada no servidor.
- Banco: RLS protege leitura/escrita por usuário; não confiar apenas em checks da UI.
- Importador: execução administrativa isolada, credenciais privilegiadas em ambiente seguro, fora do bundle web.
- Cloudflare: respeitar APIs disponíveis no Workers e evitar dependências Node incompatíveis.

## Dados

### Existentes conforme documentação

- `auth.users`: identidades Supabase.
- `public.profiles`: pseudônimo e metadados públicos; ligado a `auth.users`.
- `public.laws`: normas federais e proveniência.

### Planejados — ainda não migrados

- `law_votes`: voto único por usuário/lei.
- `posts`: comentários e argumentos PRO/CON, respostas e moderação.
- `post_votes`: voto único por usuário/publicação.
- `reports`: denúncias de conteúdo.
- `moderation_actions`: trilha de auditoria.

Evitar duplicar `auth.users` em tabela própria de autenticação. Usar `profiles` como identidade pública.

## Organização sugerida

```text
src/
  routes/
  components/
  features/
    laws/
    votes/
    discussions/
    rankings/
    moderation/
  lib/
    supabase/
supabase/
  migrations/
scripts/
  import-laws.ts
docs/
```

Adaptar à estrutura real gerada pelo TanStack CLI; não reorganizar arquivos sem necessidade.

## Regras arquiteturais

1. Loaders isomórficos não devem importar código exclusivo do servidor diretamente; encapsular em Server Functions.
2. Nunca confiar em dados de usuário recebidos do cliente para autorização.
3. Não cachear publicamente respostas autenticadas ou que contenham `Set-Cookie`.
4. Manter legislação oficial e conteúdo da comunidade separados no modelo e na interface.
5. Registrar origem, hash e momento da sincronização de cada norma.
6. Migrations versionadas, revisadas e testadas localmente antes de aplicar remotamente.
7. Processos de ingestão devem ser idempotentes e preservar os IDs usados em votos e comentários.
8. Avaliar compatibilidade do build com Cloudflare Workers em cada mudança de dependência.

## Ambientes e deploy

- Local: Supabase CLI + Docker, com migrations e testes.
- Remoto: projeto Supabase criado, sem pressupor migrations aplicadas.
- Produção: Cloudflare Workers, com variáveis públicas configuradas no build e segredos protegidos.
- Nunca executar reset destrutivo nem `db push` remoto sem revisão e autorização.
