# LeiAberta — Backlog do MVP

**Legenda:** P0 = obrigatório para lançamento; P1 = posterior. Todas as issues abaixo são propostas e não devem ser marcadas como concluídas sem verificação no código e testes.

## Épico A — Fundação e documentação

- [ ] **LA-001 (P0) — Auditar fundação existente.** Conferir AGENTS.md, clients Supabase, migrations, RLS, tipos e scripts. **Aceite:** `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:db` e `npm run build` executados e resultados documentados.
- [ ] **LA-002 (P0) — Validar Cloudflare Workers.** Conferir configuração de runtime, build e preview. **Aceite:** aplicação inicia em ambiente compatível com Workers, sem segredos no bundle.

## Épico B — Ingestão e consulta

- [ ] **LA-003 (P0) — Inspecionar ctresb/leis.** Documentar formatos reais, metadados, licenças e limites da cobertura em `docs/INGESTION.md`. **Aceite:** exemplos reais e mapeamento campo a campo; nenhuma suposição sem validação.
- [ ] **LA-004 (P0) — Revisar schema de laws.** Comparar a fonte com a migration existente. **Aceite:** migrations incrementais e testes para mudanças necessárias, preservando IDs.
- [ ] **LA-005 (P0) — Implementar importador idempotente.** Parse, validação, hash, upsert e relatório de erros. **Aceite:** reexecução não duplica registros; atualização preserva interações; credenciais seguras.
- [ ] **LA-006 (P0) — Implementar busca e filtros.** Busca em português, tipo/ano, paginação. **Aceite:** consultas parametrizadas e desempenho básico medido.
- [ ] **LA-007 (P0) — Criar página da lei.** Texto seguro, proveniência, data de sincronização e situação verificável. **Aceite:** renderização SSR, SEO e links oficiais.

## Épico C — Autenticação e identidade

- [ ] **LA-008 (P0) — Implementar OAuth Google/GitHub.** Fluxo login/logout/callback e cookies SSR. **Aceite:** sessão segura, redirects permitidos e testes de falha.
- [ ] **LA-009 (P0) — Criar perfil com pseudônimo.** Tela de edição compatível com restrições da migration. **Aceite:** unicidade, limites e ausência de dados privados públicos.

## Épico D — Participação

- [ ] **LA-010 (P0) — Migration e RLS de votos em leis.** **Aceite:** voto único por usuário/lei, escrita própria, suspensão respeitada e testes SQL.
- [ ] **LA-011 (P0) — UI de votação.** **Aceite:** aprovar/desaprovar/trocar/retirar voto com estados de loading/erro.
- [ ] **LA-012 (P0) — Migration e RLS de publicações.** **Aceite:** COMMENT/PRO/CON, profundidade máxima, vínculo à mesma lei, edição própria e moderação.
- [ ] **LA-013 (P0) — Interface de discussões.** **Aceite:** publicar, responder, editar, excluir logicamente e paginar.
- [ ] **LA-014 (P0) — Votos de utilidade.** **Aceite:** unicidade, proibição de voto próprio e políticas RLS testadas.

## Épico E — Descoberta e comunidade

- [ ] **LA-015 (P0) — Home e listagem.** **Aceite:** navegação mobile, estados vazios e destaque de leis.
- [ ] **LA-016 (P0) — Rankings.** **Aceite:** Wilson, mínimo de votos, atividade, controvérsia e critérios documentados.
- [ ] **LA-017 (P0) — Perfil público.** **Aceite:** pseudônimo e atividade permitida sem revelar dados privados.

## Épico F — Moderação e lançamento

- [ ] **LA-018 (P0) — Denúncias e painel.** **Aceite:** fila de revisão, decisão e controle de acesso.
- [ ] **LA-019 (P0) — Auditoria e suspensão.** **Aceite:** ações administrativas registradas e bloqueios testados.
- [ ] **LA-020 (P0) — Antiabuso e privacidade.** **Aceite:** rate limits, termos, privacidade e fluxo de exclusão de conta.
- [ ] **LA-021 (P0) — Testes E2E e acessibilidade.** **Aceite:** jornadas de busca, login, voto, debate e moderação passam.
- [ ] **LA-022 (P0) — Deploy e beta.** **Aceite:** Workers + Supabase remoto configurados, migrations revisadas, logs e rollback planejado.

## Ordem sugerida

1. LA-001 → LA-003 → LA-004 → LA-005.
2. Em paralelo, LA-002 e LA-008 após estabilizar a fundação.
3. LA-006/007 para disponibilizar consulta real.
4. LA-009 a LA-014 para participação.
5. LA-015 a LA-022 para lançamento.

## Convenção para cada issue

Incluir: contexto, objetivo, arquivos afetados, dependências, critérios de aceite, testes, riscos de segurança e observações sobre migrações. Uma issue por PR/commit lógico sempre que possível.
