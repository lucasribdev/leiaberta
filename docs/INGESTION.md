# LeiAberta — Análise da ingestão

**Status:** LA-005 implementada e validada com fixtures sintéticas e Supabase local; análise LA-003 e fundação LA-004 preservadas abaixo.
**Data:** 21/10/2026.  
**Escopo:** LA-005 (importador local), LA-004 (schema incremental) e LA-003 (análise histórica). Nenhuma carga real ou acesso ao Supabase remoto.

## LA-005 — Importador local (21/10/2026)

Implementação em `scripts/import-laws.ts` e `scripts/ingestion/`, sem imports a partir de `src/` e sem handlers HTTP. `pg`, `yaml` e seus tipos são dependências de desenvolvimento do runner Node.js 24+, não do bundle web. A migration incremental `20261021220000_ingestion_ordering.sql` acrescenta sequências privadas de ordenação a runs/items e seus índices/permissões mínimas. As migrations da LA-004 foram preservadas.

### Comandos e contrato operacional

```bash
npm ci
npm run ingest -- --help
# Padrão: inventaria/valida, imprime JSON, não abre conexão PostgreSQL.
npm run ingest -- --ref COMMIT --dry-run
# Também é dry-run quando --dry-run é omitido.
npm run ingest -- --ref COMMIT

# Escrita: somente Supabase local. Executar apenas depois de revisar o dry-run.
# INGESTION_DATABASE_URL deve ser injetada pelo ambiente seguro do operador;
# não colocar o valor na linha de comando, em logs ou em VITE_*.
npm run ingest -- --ref COMMIT --write --artifacts .ingestion/artifacts
# Retomada exige exatamente commit, base, parser e configuração da execução.
npm run ingest -- --ref COMMIT --write --artifacts .ingestion/artifacts --resume UUID
```

`COMMIT` representa o SHA de 40 caracteres retornado pelo relatório; `main` é o padrão quando `--ref` falta. O runner faz um único fetch da referência solicitada em repositório bare temporário, resolve `FETCH_HEAD^{commit}` uma vez e usa apenas esse commit/blobs imutáveis. Não faz checkout, inicializa submódulos, executa scripts/hooks da fonte ou consulta URLs do YAML. O diretório temporário é removido no encerramento normal. Retomar com `main` depois de a branch mudar é rejeitado: usar o commit original.

**Dry-run:** nenhuma escrita/conexão no banco, nenhuma criação de credencial e nenhum arquivo de artefato persistente. A aquisição Git usa disco temporário. Como não consulta o banco, `inserted` significa inserção prospectiva no catálogo vazio; não simula colisões com leis já existentes no banco. Detecta colisões entre os próprios documentos da amostra. Em escrita, os mesmos contadores representam resultados transacionais efetivamente persistidos. Não executar dry-run do acervo inteiro como teste rápido: o fetch obtém os objetos do snapshot completo, ainda que só leia os blobs de normas aprovadas.

**Escrita local:** exige simultaneamente `--write`, `--artifacts` e `INGESTION_DATABASE_URL`. Aceita somente URI PostgreSQL com IP literal `127.0.0.1` ou `[::1]`, porta `54322`, banco `postgres`, sem parâmetros de conexão; bloqueia hosts remotos, DNS, portas alternativas e usuários de API. Não lê `.env*` automaticamente. Executa `SET ROLE law_ingestor` e todas as consultas de ingestão usam esse papel. A identidade de conexão precisa já estar autorizada a assumir o papel; o runner não cria logins/senhas, não concede memberships e não usa `service_role`. Sem autorização preexistente, a escrita falha fechada. Esta entrega não provisiona o runner nem habilita banco remoto.

### Validação, limites e proveniência

- Allowlist explícita das 13 coleções em `model.ts`, conferindo caminho/tipo/autoridade LexML. Constituição, constituições históricas, regimentos, regulamentos, material auxiliar e outras esferas aparecem como `excluded`, com motivo. Novos formatos não entram automaticamente.
- UTF-8 fatal, SHA-256 dos bytes completos antes de interpretar BOM/CRLF; tamanho e SHA-1 do objeto Git também conferidos. Aceita somente blobs regulares `100644`; symlinks, executáveis e submódulos no recorte falham. Caminhos absolutos, traversal, controles e barras invertidas invalidam o inventário.
- YAML 1.2 core, chaves únicas, sem tags arbitrárias nem aliases; Zod valida os campos externos. Datas continuam strings e passam por validação de calendário; ano/pasta/data/URN, número textual, tipo, jurisdição, epígrafe e URL oficial são confrontados quando informados. URL oficial exige HTTPS e host exato na allowlist; não é acessada nem certifica vigência.
- Número ausente/vazio vira NULL; complementos/reedições permanecem texto. Metadados completos, inclusive desconhecidos, permanecem em `laws.source_metadata`; campos novos geram warnings nos itens. Documentos sem texto substancial, avisos de ausência, identidade pendente, U+FFFD, controles ou indícios de mojibake ficam em falha para revisão. Nada é corrigido silenciosamente.
- Limites: 2 MiB por documento, profundidade 20, zero aliases, parsing em worker isolado com prazo de 5 s e heap de 64 MiB; até 300 mil entradas e saída Git de 96 MiB. Comandos Git têm prazo de 30 s, conexão de 5 s e SQL de 10 s. Concorrência é 1, com lock consultivo PostgreSQL por repositório e índice de execução ativa da LA-004. **Zero retries automáticos**: erro fica durável e a repetição explícita cria nova tentativa, evitando loops e resolução repetida da branch.
- Cada versão aplicada preserva commit, blob, caminho, permalink GitHub, hash, URL oficial, metadados, datas declaradas e importação. Itens apontam para sua execução/commit e registram hash, operação, diagnóstico, warnings e versões do parser/configuração/projeção. Os bytes lidos são arquivados em arquivos privados por SHA-256 antes de parsear, inclusive quando o parsing falha; `artifact_reference` usa `sha256:HASH`. Arquivos acima do limite não são adquiridos/arquivados, mas a falha conserva blob/commit/caminho para auditoria.

### Identidade, incrementalidade e retomada

A identidade inicial usa URN validada ou `ctresb/leis:path:CAMINHO`. UPDATE usa UUID resolvido e colunas permitidas, nunca DELETE+INSERT. URN descoberta depois pode ser acrescentada sem trocar UUID/source_id. Correção/remoção de URN existente, alteração da identidade do caminho, colisão de URN e reutilização de caminho histórico exigem revisão.

Renome automático é conservador: inventário completo, um único caminho antigo ausente, blob exatamente idêntico, um único destino no recorte e nenhuma identidade conflitante. Essas condições provam a movimentação sem conteúdo alterado; conhecer apenas uma URN ou um blob não basta. Renomes com conteúdo diferente e possíveis duplicatas sem prova ficam em `conflict`, sem fusão. Lei, fechamento/abertura de caminhos e item aplicado são transacionados juntos. Remoção encerra o caminho e marca indisponibilidade, preservando lei, UUID, texto e status jurídico; o caminho antigo de um renome também entra em `removed` no relatório, com motivo `validated_rename`.

O delta usa o inventário completo do commit-alvo e a projeção/histórico duráveis como base aplicada. Não depende de ancestralidade Git ou de árvore recursiva truncada da API; funciona também com histórico reescrito. Blobs já aplicados com parser, configuração e projeção iguais não são lidos/parseados novamente. A decisão de replay verifica blob/hash e os hashes de parser/configuração/projeção; sem mudança, **nenhum UPDATE em laws**: UUID, conteúdo, `imported_at`, `updated_at` e commit da última versão aplicada são preservados. O commit da observação atual fica em `runs`. Alteração da projeção, parser ou configuração força revalidação mesmo com bytes iguais.

Retomada reinventa o snapshot completo, reaproveita os resultados resolvidos da mesma execução e incrementa tentativas de falhas/conflitos, mantendo o histórico imutável. O manifesto de remoções é salvo em `runs.counters.removals` antes de qualquer aplicação, para que interrupção após renome não perca os caminhos antigos. Crash deixa uma execução `running`, retomável com o mesmo UUID; erros capturados encerram como `failed`. Não iniciar outra execução enquanto houver uma `running`.

Pendências anteriores são reconsideradas mesmo em outra execução/commit. Se um caminho falho desaparecer sem lei publicada, ele continua como conflito de revisão; não desaparece da fila só porque saiu do delta. Uma versão posterior válida no mesmo caminho pode resolver falhas anteriores. Inventário incompleto, falha de aquisição/SQL, conflito ou pendência não resolvida impedem checkpoint. Execuções e eventos usam sequências monotônicas privadas, pois timestamps podem regredir; encerramentos usam o maior entre relógio e início para satisfazer as constraints, sem modificar tentativas anteriores. Conclusão da execução e avanço do cursor são uma transação com comparação da base; o trigger da LA-004 continua sendo aplicado. Erro antes de resolver o commit só pode produzir diagnóstico redigido em stderr, pois ainda não existe commit-alvo verificável para registrar em `runs`.

O relatório JSON reconcilia `inventoried = inserted + updated + unchanged + excluded + removed + failed + conflict`. `inventoried` conta caminhos do snapshot, mais caminhos removidos e pendências ausentes que exigem resultado; não significa número de leis. `@inventory` é uma tentativa operacional de controle, fora desses contadores. Falhas e conflitos contêm código/mensagem, sem erros brutos do driver ou strings de conexão. Saída 1 indica falha/conflito. Em dry-run, `checkpointAdvanced` é sempre false.

### Testes e resultados desta entrega

```bash
npm run db:migrate # somente local; migration incremental, sem reset
npm run lint
npm run typecheck
npm test
# Obtém a conexão do CLI local em memória, ou usa INGESTION_TEST_DATABASE_URL já injetada.
npm run test:ingestion:db
npm run test:db
npm run lint:db
npm run build
```

Fixtures em `tests/ingestion/` são inteiramente sintéticas, geradas de maneira determinística, sem rede ou documentos públicos copiados. O teste Git cria commits locais com autor/data fixos e verifica blobs/hashes. O launcher de integração captura `DB_URL` de `supabase status --output json` local somente em memória e injeta a conexão por ambiente no processo de teste, sem imprimir segredos. É possível fornecer `INGESTION_TEST_DATABASE_URL` por ambiente seguro, sujeita à mesma restrição local; não há credencial padrão no código. Exige banco operacional de teste sem execuções prévias. Abre transação externa, concede SET ROLE ao `postgres` local apenas nessa transação, executa o runner sob `law_ingestor`, usa savepoints nas unidades transacionais e reverte tudo no fim. Não testa provisionamento de login dedicado nem persistência após COMMIT do harness; testa SQL, constraints/RLS, atomicidade das unidades e retomada com permissões reais.

Resultados efetivamente verificados: lint e TypeScript passaram; testes Node existentes e novos passaram; integração PostgreSQL passou (13 cenários, incluindo regressão de relógio; a correção de ordenação foi também repetida três vezes sem falhas); pgTAP passou com **105 verificações**; lint SQL de `public,ingestion_private` sem erros; build cliente/SSR passou (código 0). O build repetiu o erro ambiental de log do Wrangler em home somente leitura e aviso de sourcemap CSS já documentados na LA-004. Nenhum deles bloqueou o build. Não houve reset, push, deploy, carga real, credenciais novas ou acesso remoto.

A cobertura inclui parsing/hash/escopo, número ausente/complementos, metadados desconhecidos, Git fixo e symlinks, artefatos, replay/timestamps, hash e projeção divergentes, parser/configuração, UUID/source_id estáveis e URN tardia, conflitos/renomes/caminho reutilizado, rollback, interrupção e manifesto de retomada, concorrência entre conexões, falhas persistentes/fora do inventário, bloqueio e recuperação de checkpoint e remoções sem exclusão/vigência. Não há votos/comentários implementados para provar preservação de interações concretas; a preservação do UUID e a ausência de DELETE são verificadas.

### Limitações e próximos passos operacionais

Não foi adquirido nem ingerido o repositório vivo nesta tarefa: aquisição remota e compatibilidade integral com todo o acervo permanecem pendentes de dry-run revisado em operação separada. As allowlists de hosts/tipos/URNs são deliberadamente estritas; variantes novas exigem revisão/versionamento. Não existe comando automático para aprovar conflitos, reabrir caminhos históricos ou fundir normas. Uma falha que desapareceu da fonte pode bloquear o cursor até haver decisão auditável; não contornar isso alterando dados manualmente.

Este runner local serializa aplicações e materializa inventário/projeções/relatório em memória; não foi medido para carga nacional e não oferece paralelismo, streaming de relatórios ou retomada de transferência Git. O fetch inicial traz o snapshot inteiro, limitado por tempo/saída dos comandos; não há quota total de disco Git. Retenção, backup e verificação periódica dos artefatos privados ficam a cargo do operador; diretório e relatórios devem ficar fora do Git (por padrão `.ingestion/` está ignorado). Não foi testada interrupção por perda real de rede/energia ou disco cheio; as falhas e interrupções sintéticas cobrem a lógica de recuperação. Antes de carga real, revisar o dry-run, dimensionar recursos e provisionar separadamente o acesso dedicado; nenhuma dessas operações foi executada nesta entrega.

## LA-004 — Contrato implementado em 21/10/2026

A [migration incremental](../supabase/migrations/20261021210000_ingestion_foundation.sql) acrescenta a fundação de ingestão sem editar as duas migrations anteriores. As seções LA-003 abaixo registram a análise original: quando chamam o schema de “proposto” ou “inexistente”, referem-se ao estado anterior à LA-004. O recorte de coleções continua proposta para o futuro importador, não é implementado por esta migration.

### Projeção pública e compatibilidade

- `number` aceita NULL; strings vazias ou só espaços continuam inválidas. O adaptador futuro converterá número vazio para NULL, sem sentinelas; complementos e reedições continuam texto.
- Acrescentados `enactment_date`, `publication_reference`, `text_version`, `official_source_url`, `source_urn`, `source_metadata`, `source_downloaded_at`, `source_commit_sha`, `source_blob_sha`, `status_checked_at` e `source_removed_at`.
- `source_url` identifica o arquivo GitHub. Quando há snapshot, deve corresponder exatamente a `source_repository/blob/<commit>/<source_path>`. `official_source_url` recebe a fonte oficial declarada, validada separadamente pelo futuro adaptador. Nenhuma URL antiga é copiada ou reinterpretada automaticamente.
- Commit/blob Git são hexadecimais minúsculos de 40 caracteres, presentes em par. `source_hash` continua SHA-256 dos bytes completos (64 caracteres). `source_metadata` é objeto JSON, incluindo chaves desconhecidas e alegações como `revogada`/`forca_legal_fonte`; o original exato será recuperável por snapshot e artefato arquivado, não pelo JSON parseado.
- Campos de proveniência novos permanecem NULL/objeto vazio para registros legados, sem inventar hashes, URNs, datas ou evidências. O papel de ingestão exige commit/blob em toda inserção/atualização; portanto, atualizar um legado exige antes resolver sua proveniência real.
- Status continua `unknown` por padrão. O papel de ingestão não pode inserir nem atualizar status, URL de evidência ou data de verificação. Qualquer futura verificação jurídica requer processo confiável separado. Para novas escritas administrativas, status afirmado exige URL HTTPS e `status_checked_at`; a constraint de data é `NOT VALID` para preservar eventuais afirmações legadas até revisão com evidência. Não há backfill nem inferência automática de vigência.
- Trigger bloqueia alteração de `id`, `source_id` e `created_at`, inclusive em UPDATE administrativo. Não há DELETE para o papel de ingestão. Os tipos públicos foram regenerados pelo CLI a partir do banco local; o schema operacional fica fora dos tipos consumidos pelos clientes web.

### Identidade estável, conflitos e renomes

1. Para nova norma, usar URN validada como `source_id` inicial quando disponível. Caso contrário usar namespace `ctresb/leis:path:<caminho-inicial>`; nunca somente tipo/número/ano. A identidade inicial é imutável, mesmo quando uma URN for descoberta depois.
2. Resolver primeiro `source_urn`, `source_id` e histórico de caminhos. URN é única quando presente; colisão rejeita a escrita. Ausência de URN não é erro. Uma correção de URN exige revisão, não trocar `source_id`. Não há fusão automática baseada em número, data, URL ou hash de conteúdo.
3. `laws.source_path` permanece principal e único. `ingestion_private.law_source_paths` guarda histórico com commits inicial/final e abertura/encerramento. Índices permitem um dono por caminho ativo e um principal ativo por lei. Renome validado encerra o vínculo anterior e abre o novo na **mesma transação** da atualização da lei, conservando UUID. Registrar `previous_path` no item. Nenhum histórico legado é fabricado.
4. URN/blob conhecidos são candidatos a renome, não prova suficiente para fusão. Renome com conteúdo alterado e identidade inconclusiva, caminhos reutilizados ou URN repetida com conteúdo divergente geram item `conflict` para revisão; conservar a versão pública válida. Caminhos encerrados continuam reservados como evidência histórica; reutilização exige decisão explícita. Exclusão no Git registra indisponibilidade e encerra vínculo, sem apagar a lei ou mudar vigência.
5. Usar INSERT apenas para identidade realmente nova; UPDATE por UUID resolvido ou `ON CONFLICT (source_id) DO UPDATE` com lista explícita de colunas permitidas. Não usar DELETE+INSERT ou upsert genérico de todas as colunas. Replay compara hash **e versão do parser/configuração/projeção** antes de escrever: sem mudança, não executar UPDATE, preservando também `imported_at`/`updated_at`. Os testes verificam o padrão de replay por hash, não um pipeline completo.

### Controle operacional privado

O schema `ingestion_private` não é exposto pela configuração da API. Suas quatro tabelas têm RLS, sem políticas para clientes, e sem privilégios de schema/tabela para PUBLIC, `anon`, `authenticated` ou `service_role`:

| Estrutura | Contrato |
| --- | --- |
| `runs` | Repositório, base/alvo, parser/configuração, modo, estado, inventário, contadores e início/fim; índice impede duas execuções `running` no mesmo repositório. Estado completo exige inventário completo e fim. |
| `items` | Uma linha imutável por tentativa `(run_id, source_path, attempt)`, operação, hashes, lei opcional, metadados, artefato, resultado, diagnóstico e retry. Falhas e conflitos exigem código/mensagem e podem existir sem lei publicada. Runner não recebe UPDATE/DELETE. |
| `checkpoints` | Um cursor por repositório; FK vincula execução/repositório/commit-alvo. Trigger exige execução completa, inventário completo e nenhuma falha/conflito sem tentativa posterior resolvida. Atualização exige base igual ao checkpoint anterior. |
| `law_source_paths` | Histórico privado de caminhos e principal; unicidade parcial e FK impedem colisões ativas e exclusão de lei referenciada. |

A decisão conservadora desta entrega é **não avançar checkpoint com falhas pendentes**. Não existe estado `completed_with_errors`. Registrar o erro/diagnóstico é obrigatório mesmo quando nada é publicado. Próxima tentativa deve preservar as anteriores, incrementando `attempt`.

### Privilégio mínimo e responsabilidades da LA-005

`law_ingestor` é NOLOGIN, sem superuser, criação de banco/papéis ou BYPASSRLS. Não possui DELETE/TRUNCATE/DDL, acesso a usuários/perfis ou permissão para alterar identidade/vigência das leis. Recebe SELECT e INSERT/UPDATE por coluna em `laws`; SELECT/INSERT/UPDATE no controle de execução/checkpoint/caminhos; apenas SELECT/INSERT em itens. Funções de trigger têm `search_path` vazio e execução pública revogada, sem SECURITY DEFINER.

Não foram criados login, senha, membership da API nem segredo. O operador deverá provisionar separadamente uma identidade exclusiva de servidor, com autorização revisada, que assuma somente esse papel por conexão PostgreSQL direta. Nunca usar `service_role` como credencial do importador ou conceder o papel a `authenticator`, `anon` ou `authenticated`. O administrador que cria o papel pode ter ADMIN OPTION para administrá-lo; a migration não concede SET ROLE à aplicação. Testes concedem SET ROLE ao usuário local `postgres` e USAGE da extensão pgTAP **dentro da transação revertida**, sem persistir esses acessos.

O banco limita permissões, formatos e colisões, mas não decide identidade semântica, autoridade de uma URL ou completude real do inventário. LA-005 deve: validar caminhos relativos e URLs, normalizar/validar URN e YAML com Zod, selecionar equivalências, transacionar lei+caminhos+item, manter correspondência entre principal e `laws.source_path`, serializar execução/checkpoint e usar compare-and-swap do cursor. O runner é confiável para essas decisões; os contadores, estados e histórico de caminhos são graváveis por ele. Validar concorrência/retomada, integridade dos artefatos e retenção de diagnósticos nessa etapa. Não há importador, RPC de importação ou chamadas externas implementados aqui.

### Validação local e aceite

Acesso ao Docker local foi necessário para os comandos Supabase. Com `SUPABASE_TELEMETRY_DISABLED=1`:

- `npx supabase migration up --local`: passou; somente a migration nova foi aplicada, sem reset ou carga.
- `npm run db:types`: passou; tipos gerados do schema `public`, mantendo estruturas privadas fora da API tipada.
- `npm run test:db`: passou, **97 verificações** em dois arquivos (73 novas e 24 anteriores); fixtures sintéticos e permissões de teste revertidos por ROLLBACK. As primeiras tentativas identificaram falta de SET ROLE e de USAGE do schema pgTAP no próprio harness, corrigidas somente na transação de teste.
- `npx supabase db lint --local --schema public,ingestion_private --fail-on warning`: passou, sem erros.
- `npm run lint`, `npm run typecheck` e `npm test`: passaram (4 testes Node).
- `npm run build`: terminou com código 0 e gerou bundles cliente/SSR. Emitiu erro de gravação de log do Wrangler em home somente leitura (`EROFS`) e aviso de sourcemap CSS; não impediram a compilação. Não houve deploy.

Os [testes pgTAP](../supabase/tests/ingestion.test.sql) verificam número ausente/complementos, metadados, snapshot/permalink, UUID e identidade imutáveis, replay sem duplicação, renome/histórico, colisões, vigência e remoção Git, permissões reais por SET ROLE, falhas duráveis e bloqueios de checkpoint. Os 24 testes anteriores permanecem presentes. Não comprovam idempotência de importador, votos ou discussões ainda inexistentes.

Os nove requisitos de LA-004 têm implementação de schema, regras operacionais documentadas e cobertura SQL. Restam revisão de legados antes de validar a constraint de status, provisionamento seguro do runner e implementação/testes end-to-end da LA-005. Não executar aplicação remota sem revisão e autorização. Nenhum reset, push, deploy ou operação Supabase remota foi executado.

## Fonte inicial e evidências

- Repositório: [ctresb/leis](https://github.com/ctresb/leis), branch `main`, analisada no commit [`15eb09b618ff08a38c4dfee06a91bd139d093f5d`](https://github.com/ctresb/leis/tree/15eb09b618ff08a38c4dfee06a91bd139d093f5d). Os exemplos deste documento usam esse snapshot, não uma promessa sobre o conteúdo futuro da branch.
- Destino: `public.laws`. A migration [profiles_and_federal_laws](../supabase/migrations/20261021184852_profiles_and_federal_laws.sql), os [tipos gerados](../src/lib/supabase/database.types.ts) e os [testes SQL](../supabase/tests/schema.test.sql) foram examinados. Na inspeção anterior desta tarefa, uma transação somente leitura no Supabase local confirmou 19 colunas, 16 constraints e zero registros em `laws`. O ambiente remoto não foi consultado.
- Amostra: 39 Markdown de coleções federais e a Constituição na raiz, além do README, licença, árvores de diretórios e scripts de geração/identificação. Os arquivos de pesquisa foram mantidos em `/tmp`, fora do projeto.
- Limite: as árvores recursivas de `federal/` e `federal/decretos/` retornaram `truncated: true`; as outras subárvores normativas consultadas vieram completas. Não foi feita auditoria integral nem se afirma contagem total, ausência de duplicatas ou qualidade uniforme do acervo.
- Alinhamento: [PRD](PRD.md), [arquitetura](ARCHITECTURE.md), [regras de negócio](BUSINESS_RULES.md) e [backlog](BACKLOG.md). A arquitetura prevê script TypeScript fora das requisições; o PRD exige consulta real com proveniência e importações que preservem interações. A implementação atual ainda contém a página inicial de scaffold, clientes Supabase e a fundação de schema/RLS, sem importador ou catálogo.

## Respostas às questões da inspeção

### 1. Árvore federal e tipos normativos

O padrão usual é `federal/<coleção>/<AAAA>/<slug>.md`. `federal/regimentos/*.md` não tem pasta de ano; `constituicao.md` fica na raiz. A pasta federal também contém anexos, capturas, relatórios, arquivos `_falhas*.jsonl` e cópias de recuperação. Selecionar todos os Markdown recursivamente importaria material auxiliar como se fossem normas.

| Coleção observada | Tipos e particularidades |
| --- | --- |
| `leis-ordinarias` | `Lei Ordinária`, inclusive sem número e com complemento como `14-A`; o gerador também prevê `Lei (não numerada)`. |
| `leis-complementares` | `Lei Complementar`. |
| `leis-delegadas` | `Lei Delegada`. |
| `leis-constitucionais` | `Lei Constitucional`, série histórica própria. |
| `decretos-lei` | `Decreto-Lei`. |
| `emendas-constitucionais` | `Emenda Constitucional` e `Emenda Constitucional de Revisão`, com tipos LexML distintos. |
| `decretos` | `Decreto`, inclusive números com complemento alfabético. |
| `decretos-nao-numerados` | `Decreto (não numerado)`; pode usar data e sequência do Senado na URN. |
| `decretos-legislativos` | `Decreto Legislativo` e `Decreto do Poder Legislativo`; há documentos históricos sem número e sem URN. |
| `medidas-provisorias` | `Medida Provisória`; reedições como `1463-2` têm identidade própria. |
| `resolucoes-camara` | `Resolução da Câmara dos Deputados`; o nome do arquivo pode incluir ID da Câmara. |
| `resolucoes-senado` | `Resolução do Senado Federal`; autoridade LexML `senado.federal`. |
| `resolucoes-congresso` | `Resolução do Congresso Nacional`; o gerador também distingue `Resolução da Revisão Constitucional`, sob autoridade `congresso.nacional`. |
| `constituicoes-historicas` | `Constituição`, com número vazio e sem URN nas amostras. |
| `regimentos` | `Regimento Interno`; pode representar resolução encontrada também em outra coleção. |
| `regulamentos` | Textos por assunto, frequentemente do tipo `Decreto`, potencialmente sobrepostos à coleção de decretos. |

Vocabulário e geração foram conferidos em [baixar_federal.py](https://github.com/ctresb/leis/blob/15eb09b618ff08a38c4dfee06a91bd139d093f5d/scripts/baixar_federal.py), [comum.py](https://github.com/ctresb/leis/blob/15eb09b618ff08a38c4dfee06a91bd139d093f5d/scripts/comum.py) e [baixar_camara.py](https://github.com/ctresb/leis/blob/15eb09b618ff08a38c4dfee06a91bd139d093f5d/scripts/baixar_camara.py).

**Recorte proposto para a primeira carga:** lista explícita das 13 coleções até `resolucoes-congresso`, validando conjuntamente caminho e tipo. Adiar Constituição, constituições históricas, regimentos e regulamentos para adaptadores próprios, registrando a exclusão deliberada no manifesto. Isso é uma recomendação técnica a aprovar, não uma redução já aprovada do escopo do produto.

Não incluir estados, municípios, jurisprudência, tratados ou reguladores nesta etapa. Ignorar como normas autônomas arquivos `_...`, relatórios, anexos e cópias de recuperação. Tipos e coleções novos geram diagnóstico para revisão, sem inclusão automática.

### 2. Formato Markdown/YAML e exemplos reais

O formato usual contém front matter entre `---`, H1 e corpo convertido. Exemplo real simplificado do [Código Civil](https://github.com/ctresb/leis/blob/15eb09b618ff08a38c4dfee06a91bd139d093f5d/federal/leis-ordinarias/2002/lei-10406-2002-01-10.md):

```yaml
titulo: "Lei nº 10.406 de 10/01/2002"
tipo: "Lei Ordinária"
numero: "10406"
data: 2002-01-10
ementa: "Institui o Código Civil."
revogada: false
versao_texto: "compilada (texto vigente)"
urn: "urn:lex:br:federal:lei:2002-01-10;10406"
fonte: "https://normas.leg.br/?urn=urn:lex:br:federal:lei:2002-01-10;10406"
baixado_em: 2026-10-13
```

As variações abaixo impedem tratar todo arquivo como o mesmo conjunto de campos obrigatórios:

| Documento fixado no snapshot | Achado e consequência |
| --- | --- |
| [Lei sem número de 1822](https://github.com/ctresb/leis/blob/15eb09b618ff08a38c4dfee06a91bd139d093f5d/federal/leis-ordinarias/1822/lei-sn-1822-10-14-s2.md) | `numero: ""`, tipo `Lei Ordinária`, URN terminada em `;seq-sf-2`. A constraint atual rejeita esse registro válido. |
| [Lei 14-A/1891](https://github.com/ctresb/leis/blob/15eb09b618ff08a38c4dfee06a91bd139d093f5d/federal/leis-ordinarias/1891/lei-14-a-1891-10-16.md) | Número `14-A`, URN com `14-a`. Não converter número em inteiro. |
| [MP 1463-2/1996](https://github.com/ctresb/leis/blob/15eb09b618ff08a38c4dfee06a91bd139d093f5d/federal/medidas-provisorias/1996/mpv-1463-2-1996-06-28.md) | Situação `Reeditada`, `revogada: false`, URN com reedição. Preservar a reedição e não inferir vigência. |
| [Decreto do Poder Legislativo de 1821](https://github.com/ctresb/leis/blob/15eb09b618ff08a38c4dfee06a91bd139d093f5d/federal/decretos-legislativos/1821/dpl-sn-1821-05-26.md) | Sem número e sem URN. Precisa de identidade provisória rastreável. |
| [Decreto 20.051/1945](https://github.com/ctresb/leis/blob/15eb09b618ff08a38c4dfee06a91bd139d093f5d/federal/decretos/1945/dec-20051-1945-11-28.md) | `revogada: null`, `forca_legal_fonte` é string contendo JSON com `NotInForce`; há URL/hash de metadados. Não converter automaticamente em `repealed`. |
| [Resolução da Câmara 5/1921](https://github.com/ctresb/leis/blob/15eb09b618ff08a38c4dfee06a91bd139d093f5d/federal/resolucoes-camara/1921/rcd-5-1921-11-18-611915.md) | Sem URN, situação `Não consta revogação expressa`, `revogada: false`. Ausência de revogação expressa não comprova vigência. |
| [Lei Delegada 13/1992](https://github.com/ctresb/leis/blob/15eb09b618ff08a38c4dfee06a91bd139d093f5d/federal/leis-delegadas/1992/ldl-13-1992-08-27.md) | Corpo contém tabela HTML com células mescladas. Markdown não garante ausência de HTML. |
| [Regimento do Senado](https://github.com/ctresb/leis/blob/15eb09b618ff08a38c4dfee06a91bd139d093f5d/federal/regimentos/regimento-senado.md) | Imagens relativas em `anexos/regimento-senado-2025/`, edição atualizada até julho de 2025 e hash do PDF. Adaptador futuro precisa tratar dependências e edição. |
| [Constituição na raiz](https://github.com/ctresb/leis/blob/15eb09b618ff08a38c4dfee06a91bd139d093f5d/constituicao.md) | Sem front matter; começa com H1 e nota de origem. Exige adaptador específico. |

As datas aparecem com e sem aspas. `revogada` é triestado: `true`, `false` ou `null`; ausência não equivale a false. Preservar `forca_legal_fonte` como recebido e validar sua representação JSON separadamente quando usada. O gerador também prevê `identidade_pendente_revisao: true`, que deve impedir publicação automática.

Usar parser YAML seguro, sem construtores arbitrários, rejeitando chaves duplicadas e limitando tamanho, profundidade e aliases. Configurar datas como strings e validar com Zod. Não fazer parsing linha a linha por regex nem executar scripts da fonte. Campos desconhecidos ficam preservados nos metadados e geram diagnóstico de mudança do contrato.

### 3. Mapeamento dos campos para `laws`

**Negrito** indica coluna proposta, ainda inexistente. Campos descritos pelo README mas não encontrados nas amostras principais estão identificados explicitamente.

| Origem | Destino | Regra e lacuna |
| --- | --- | --- |
| Caminho, `uf` e autoridade da URN | `jurisdiction` | Sempre `federal`; conferir coerência. Ausência de `uf` isoladamente não prova esfera federal. |
| `tipo` | `law_type` | Preservar rótulo canônico; validar combinação com coleção. Hoje aceita qualquer texto não vazio. |
| `numero` | `number` | Texto com complemento/reedição; vazio vira NULL na proposta. Hoje NOT NULL e check impedem ausência. Não preencher com `0`, `s/n` ou sequência. |
| `data` | **`enactment_date`** | Data do ato, distinta da publicação; validar calendário sem conversão de fuso. Ausente no schema. |
| Ano de `data`, ou `ano` explícito | `year` | Conferir ano da pasta; não usar ano do commit/download. `ano` é previsto no README para fontes que só fornecem ano. Sem ano confiável, quarentena. |
| `titulo` | `title` | Preservar, conferir presença e H1; não gerar título por IA. |
| `ementa` | `summary` | Vazio pode virar NULL, com original preservado. |
| Corpo após front matter | `legislative_text` | Preservar Markdown, H1, notas e avisos. H1 sozinho ou aviso de ausência não é íntegra válida. |
| `data_publicacao` | `publication_date` | Campo previsto no README; preencher só quando explicitamente informado e válido. Nunca copiar `data`. |
| `publicacao` | **`publication_reference`** | Referência textual prevista no README; não inferir data de string ambígua. |
| `versao_texto` | **`text_version`** | Preservar original, compilada, republicação/retificação e variantes. Não é certificado de vigência. |
| `revogada`, `situacao`, `forca_legal_fonte` | **`source_metadata`** | Alegações da fonte, preservando tipos/valores; não mapeadas automaticamente para vigência do produto. |
| Evidência oficial verificada | `legal_status`, `status_evidence_url`, **`status_checked_at`** | Carga inicial mantém `unknown`. URL HTTPS sozinha não comprova status. |
| `urn` | **`source_urn`** e `source_id` inicial | Usar URN validada quando existir; não inventar URN para arquivos sem esse campo. |
| Identidade provisória sem URN | `source_id` inicial | Namespace do repositório + caminho inicial. Identidade inicial permanece estável se uma URN aparecer depois. |
| Caminho relativo no Git | `source_path` | Arquivo principal; case preservado e sem `/` inicial. Renomes/aliases exigem histórico separado. |
| Repositório fixo | `source_repository` | Manter restrição atual a `https://github.com/ctresb/leis`. |
| Permalink do arquivo | `source_url` | Contrato proposto: `https://github.com/ctresb/leis/blob/<commit>/<path>`. Hoje a coluna só exige HTTPS. |
| `fonte` | **`official_source_url`** | Separar URL oficial da URL GitHub; hoje existe uma coluna para duas necessidades. |
| `arquivo`, `fonte_indice`, `id_senado` | **`source_metadata`** | Preservar identificadores e URLs auxiliares; `arquivo` é previsto no README para fonte PDF. |
| `url_metadados`, `fonte_metadados`, `sha256_metadados_fonte` | **`source_metadata`** | Evidência auxiliar; hash dos metadados oficiais não é hash do Markdown. |
| `recuperacao_integralidade`, `sha256_md_historico`, `sha256_pdf_fonte`, `atualizado_ate`, `identidade_pendente_revisao` | **`source_metadata`** | Preservar recuperação, edição, hashes e pendências. Hash histórico/PDF nunca substitui `source_hash`. |
| YAML completo parseado, incluindo chaves novas | **`source_metadata`** | Objeto JSON preservado sem descartar campos. Bytes originais recuperáveis por commit/caminho e preferencialmente arquivados por hash. |
| `baixado_em` | **`source_downloaded_at`** | Data da coleta realizada pela fonte; diferente da nossa importação. |
| Commit fixado, blob da árvore Git | **`source_commit_sha`, `source_blob_sha`** | Proveniência e comparação incremental. Não são SHA-256 do arquivo. |
| Bytes completos do Markdown | `source_hash` | SHA-256 hexadecimal minúsculo, incluindo YAML e quebras de linha, antes de normalizar. |
| Relógio do importador | `imported_at` | Última versão efetivamente aplicada; replay sem mudança não altera timestamp. |
| Relógio do banco | `created_at`, `updated_at` | Preservar criação e UUID. Trigger atual muda `updated_at` em qualquer UPDATE; evitar UPDATE sem alteração. |

### 4. Identificadores, duplicidades e renomes

`source_id` e `source_path` únicos não impedem a mesma norma com dois identificadores e caminhos diferentes. Caminhos mudam; URNs podem faltar ou ser corrigidas. Tipo/número/ano também não bastam para todas as séries e apresentações documentais.

1. `laws.id` permanece estável para votos e discussões. Atualizar a linha existente; nunca DELETE + INSERT nem substituir UUID para sincronizar conteúdo.
2. Preferir URN validada, guardada em `source_urn`. `source_id` inicial permanece imutável quando uma identidade provisória ganhar URN; procurar por URN e histórico de caminhos antes de inserir.
3. Número completo, data, tipo, autoridade e IDs oficiais ajudam a identificar candidatos. Não criar UNIQUE apenas em número/ano ou tipo/número/ano. Preservar `-A`, `-2` e `seq-sf-*`; resoluções de Casas distintas não devem colidir.
4. Mesma URN com arquivos distintos exige comparação de versão/conteúdo; divergência vai para revisão, sem regra de “último arquivo vence”. Número/data semelhantes ou URL oficial parecida geram candidato, não fusão automática.
5. Regimentos/regulamentos podem apresentar o mesmo ato de outras coleções. Sua inclusão futura exige equivalência verificada, documentos associados à mesma lei e seleção explícita do principal.
6. Renome com URN ou blob conhecido conserva UUID e registra caminhos anterior/novo. Renome com conteúdo alterado e identidade inconclusiva vai para revisão. Caminho antigo reutilizado por outra norma não autoriza sobrescrita.
7. Remoção no Git não é revogação. Preservar lei e interações, registrar indisponibilidade da origem e não trocar o status jurídico automaticamente.

### 5. Codificação, conteúdo e vigência

Os 40 documentos amostrados decodificaram como UTF-8 estrito, sem BOM ou U+FFFD. Isso não garante o restante do corpus: conversores da fonte têm fallback de charset, incluindo CP1252, e caminhos que substituem caracteres. UTF-8 válido pode conter corrupção já introduzida na conversão.

Calcular hash sobre bytes originais. Aceitar BOM/CRLF apenas na interpretação, sem mudar o material auditado. Rejeitar UTF-8 inválido e NUL; sinalizar U+FFFD, mojibake e controles inesperados para revisão. Não corrigir silenciosamente acentos, ordinais, referências ou grafia histórica: `vaccum`, `sôbre` e `Approva` não demonstram erro de codificação. Normalização Unicode/acentos para busca deve ser derivada.

Preservar tachados, tabelas e notas. Renderizar inicialmente como texto escapado, conforme o contrato atual. Uma visualização futura de Markdown precisa desativar HTML bruto ou convertê-lo para estruturas sanitizadas; nunca inserir HTML da fonte diretamente. Não apagar tabelas para resolver segurança. Links/imagens relativos precisam de resolução contra caminho/commit fixos e regras contra traversal e esquemas perigosos. Não buscar URLs arbitrárias do YAML pelo servidor.

O repositório é uma conversão secundária de fontes oficiais, sujeita a falhas de OCR, integralidade e atualização. `revogada: false`, `Não consta revogação expressa`, `Reeditada` e a palavra `compilada` não autorizam `in_force`. `NotInForce` não informa sozinho a causa e não deve virar automaticamente `repealed`.

Para afirmar status, verificar evidência oficial específica e registrar URL, instante, conteúdo/hash e decisão ou regra responsável. Uma mudança relevante na fonte exige revalidar a evidência anterior. A UI deve separar texto, avisos da conversão e opiniões; mostrar origem, edição e sincronização, sem confundir sincronização com alteração legal. As URLs oficiais dos exemplos foram lidas no YAML; não foi certificada individualmente sua disponibilidade ou a vigência das normas.

### 6. Licença e avisos de origem

A [LICENSE do snapshot](https://github.com/ctresb/leis/blob/15eb09b618ff08a38c4dfee06a91bd139d093f5d/LICENSE) foi consultada diretamente. Ela aplica MIT ao código em `scripts/`, com atribuição a João Davi, e distingue os textos normativos, descritos pelo próprio repositório como atos oficiais sob o art. 8º, I, da Lei nº 9.610/98. Essa é a declaração da fonte; não se deve rotular todo o material indistintamente como software MIT.

Se código dos scripts for copiado ou adaptado futuramente, preservar os avisos de copyright e licença exigidos. O plano atual é um parser próprio em TypeScript; não exige executar nem incorporar os scripts Python. Preservar proveniência e avisos sobre conversão automática, OCR, ausência de texto e consulta à publicação oficial. Não apresentar a conversão como publicação oficial ou certificação de integralidade/vigência.

## Incompatibilidades e schema recomendado para aprovação

As lacunas principais são: número obrigatório incompatível com atos sem número; ausência da data do ato e da versão textual; uma só URL para arquivo GitHub e fonte oficial; ausência de metadados/commit/blob/coleta; e falta de controle persistente de execuções, falhas e renomes.

### Alterações propostas em `laws`

| Alteração | Tipo e restrição propostos |
| --- | --- |
| `number` aceita ausência | Remover NOT NULL; check `number IS NULL OR length(btrim(number)) > 0`. Converter vazios para NULL; nenhuma sentinela. |
| `enactment_date` | `date NULL`; quando presente, ano deve coincidir com `year`. Não criar dia/mês fictícios. Manter `year` obrigatório e faixa atual; sem ano confiável, quarentena. |
| `publication_reference` | `text NULL`, referência literal à publicação. |
| `text_version` | `text NULL`, não vazio quando preenchido; validação de vocabulário no parser, sem enum rígido que descarte variantes. |
| `official_source_url` | `text NULL` na transição, obrigatório no contrato de novas entradas aceitas. Validar HTTPS/host oficial no processo confiável; divergências ficam no bruto para revisão. |
| `source_urn` | `text NULL`, validação de formato e UNIQUE parcial quando preenchida; conflito impede sobrescrita. |
| `source_metadata` | `jsonb NOT NULL DEFAULT '{}'::jsonb`, check de objeto. |
| `source_downloaded_at` | `date NULL`. |
| `source_commit_sha`, `source_blob_sha` | `text NULL` na transição, formato Git hexadecimal de 40 caracteres observado nesta fonte; novas ingestões exigem ambos. |
| `status_checked_at` | `timestamptz NULL`; status diferente de `unknown` exige instante e URL, além da verificação confiável. |
| `source_removed_at` | `timestamptz NULL`; indisponibilidade do documento principal, sem semântica de revogação. |

Manter constraints de jurisdição federal, repositório, SHA-256 e unicidade de `source_id`/`source_path`. Documentar `source_url` como permalink GitHub com commit. Não flexibilizar a exigência de texto para publicar documentos incompletos: esses ficam em quarentena.

### Controle de ingestão proposto

- `ingestion_runs`: UUID, repositório, commit-base/alvo, versão do parser, hash da configuração/recorte, modo (`full`, `incremental`, `reprocess`), início/fim, estado e contadores. Lock por repositório impede avanço de checkpoints fora de ordem.
- `ingestion_items`: execução, caminho, operação Git, blob SHA, SHA-256 quando disponível, lei opcional, resultado, código/mensagem de erro, tentativas, próximo retry, timestamps e referência aos bytes originais. UNIQUE `(run_id, source_path)`, com histórico de tentativas preservado. Guardar snapshot dos metadados/evidências da versão aplicada para auditoria. Incluir exclusões deliberadas e falhas sem correspondente em `laws`.
- `law_source_paths`: lei, repositório, caminho, commits de primeira/última observação, início/fim de validade e indicação do principal. UNIQUE parcial de repositório/caminho ativo e, no máximo, um principal ativo por lei. `laws.source_path` continua representando o principal e é atualizado na mesma transação. Aliases dependem de equivalência verificada.

Tabelas operacionais sem leitura pública, com RLS e grants restritos. Preferir papel de ingestão dedicado com SELECT/INSERT/UPDATE somente no necessário, sem DELETE em leis, DDL ou acesso a usuários/perfis. Chave privilegiada, se necessária, fica apenas no ambiente isolado do job, nunca em `VITE_*`, bundle ou cliente SSR de usuários.

**Pacote para aprovação:** recorte inicial de 13 coleções; NULL para números ausentes; colunas e tabelas propostas; `source_url` como permalink; carga inicial com `unknown`. Só após aprovação preparar nova migration incremental, testes e regeneração de tipos. Não editar migrations aplicadas nem presumir banco remoto vazio; backfills exigem evidência. Não copiar indiscriminadamente `source_url` para `official_source_url`, pois o contrato anterior não distingue os usos.

## Pipeline proposto para implementação posterior

1. **Snapshot e dry-run.** Script TypeScript separado do runtime web, como prevê a arquitetura. Resolver `main` uma vez para commit imutável; registrar parser e recorte. Primeiro gerar inventário, duplicidades e erros sem gravar leis. Não executar código da fonte.
2. **Inventário completo.** Percorrer subárvores/anos, detectando truncamento/paginação, ou usar checkout isolado somente leitura. Não carregar todo o histórico legislativo para a primeira carga. Recusar symlinks, submódulos e caminhos fora do recorte. Snapshot parcial nunca autoriza inferência de remoção.
3. **Aquisição.** Baixar blobs do commit-alvo com limites de tamanho, tempo e concorrência. Respeitar rate limits e `Retry-After`; não contornar bloqueios. A carga inicial não precisa raspar novamente as fontes oficiais nem buscar URLs arbitrárias do YAML.
4. **Validação e staging.** Hash dos bytes, UTF-8 estrito, YAML seguro, Zod, datas, tipo/pasta/URN e presença de texto. Aviso de documento vazio, H1 sozinho ou identidade pendente vai para quarentena; OCR/integralidade exigem diagnóstico conforme severidade.
5. **Identidade e transação.** Resolver identidade antes de gravar. Transacionar lei, caminhos e resultado aplicado; rollback em falha. Não registrar sucesso sem a mudança correspondente nem alterar UUIDs usados por interações.
6. **Idempotência.** Inserir apenas identidade nova. Atualizar só quando hash, parser/configuração ou projeção validada mudar. Replay idêntico conserva conteúdo e timestamps de `laws`; execuções continuam auditáveis nas tabelas operacionais.
7. **Delta incremental.** Comparar árvores por caminho/blob SHA desde o último checkpoint reconciliado; buscar adições/alterações e tratar renomes/remoções. Git diff é alternativa com histórico disponível. Data de commit, `baixado_em`, ano da norma e mtime não são cursores: o histórico inicial representa datas legislativas, coletas posteriores entram em lote e normas antigas recebem correções.
8. **Retomada.** Avançar checkpoint só com inventário completo e resultado durável para cada caminho. `completed_with_errors` só permite avanço se as falhas entrarem em fila persistente independente do delta seguinte; caso contrário, manter checkpoint anterior. Reprocessar pendências mesmo com blob inalterado. Interrupção não pode perder falhas nem duplicar leis.
9. **Remoções.** Encerrar associação do caminho removido, preservar lei/interações e marcar indisponibilidade do principal sem substituto aprovado. Nunca apagar automaticamente ou transformar remoção Git em revogação. Trocar principal só após validação.
10. **Reconciliação.** Recontar por coleção, conferir hashes e repetir pendências periodicamente. Histórico reescrito ou compare incompleto exige comparação completa de árvores. Parser/recorte novo exige reprocessamento versionado de blobs iguais. Arquivar bytes por hash permite auditoria mesmo se o histórico remoto desaparecer.

## Tratamento de erros e observabilidade

| Classe | Conduta |
| --- | --- |
| Timeout, 429 e 5xx | Retry limitado com backoff/jitter e `Retry-After`; persistir falha após esgotamento. |
| 401/403 ou limite de API | Pausar/reduzir execução e registrar diagnóstico, sem contornar bloqueios ou logar tokens. |
| Blob esperado com 404, download incompleto, árvore truncada | Falha de aquisição; não tratar como remoção nem finalizar inventário parcial. |
| UTF-8/YAML inválido, chave duplicada, data impossível ou campo obrigatório ausente | Quarentena com caminho, commit, hashes disponíveis, motivo e bytes preservados. |
| Colisão ou divergência de identidade, tipo, data ou epígrafe | Revisão; não fundir nem sobrescrever versão válida. |
| Ausência de texto ou dependência necessária | `missing_text`/`incomplete_document`; não publicar como íntegra. |
| Tipo/coleção novos | Diagnóstico de contrato e revisão do recorte, sem aceitação silenciosa. |
| Falha SQL, constraint ou perda de lock | Rollback da unidade, erro durável e retomada. |

Relatório deve reconciliar inventariados com inseridos, atualizados, inalterados, excluídos do recorte, removidos e falhos. Cada erro precisa de registro por documento, não só contador. `_falhas*.jsonl` da fonte descrevem lacunas anteriores à nossa coleta, não novas leis disponíveis. Falha em atualização conserva a última versão válida e sinaliza sincronização pendente.

Definir retenção/acesso de logs e artefatos; não versionar material operacional no Git da aplicação nem registrar segredos ou dados de usuários. Separar avisos de qualidade de erros impeditivos e tornar ambos visíveis no relatório.

## Testes necessários

| Área | Casos e resultados esperados |
| --- | --- |
| YAML e Zod | Datas com/sem aspas, BOM/CRLF, null/boolean, JSON dentro de string, campos desconhecidos, chave duplicada, truncamento e aliases excessivos. Erros rastreáveis, sem execução de código. |
| Codificação | Acentos, ordinais, `§`, NBSP, travessão, UTF-8 inválido, U+FFFD e mojibake. Hash dos bytes originais; nenhuma correção silenciosa. |
| Escopo | Coleções aprovadas aceitas; estados/municípios, `_...`, cópias e anexos excluídos explicitamente. Divergências pasta/tipo/autoridade detectadas. |
| Datas e números | Data do ato distinta de publicação, ano isolado, datas impossíveis/futuras para revisão, vazio, `14-A`, `25170-A`, `1463-2` e `seq-sf-*`; sem sentinelas ou colisões. |
| Identidade | Replay, URN repetida em dois caminhos, URN adicionada/corrigida, renome com/sem alteração, caminho reutilizado, Casas distintas e reedições. UUID estável ou quarentena. |
| Idempotência | Duas execuções iguais preservam contagem, UUID, conteúdo e timestamps; alteração em um arquivo afeta apenas a projeção correspondente. Mudança de parser provoca reprocessamento controlado. |
| Incremental e retomada | Adição, correção antiga, renome, remoção, histórico reescrito, truncamento, falhas fora do próximo delta, interrupção antes/depois da transação e concorrência. Sem perda de erros/checkpoints indevidos. |
| Texto e segurança | H1 vazio, aviso sem texto, OCR, tachados, HTML, tabelas e links/imagens relativos ou perigosos. Conteúdo preservado e nada executável no browser. |
| Vigência | False/null, `Reeditada`, ausência de revogação expressa, `NotInForce` e compilado não promovem status sem evidência verificada. Remoção Git não revoga. |
| Banco e permissões | Constraints propostas, caminhos/principal ativos únicos, escrita negada a anon/authenticated, logs não públicos, privilégio mínimo do job e rollback. |

Fixtures públicas pequenas fixadas por commit/hash e fixtures sintéticas malformadas; testes determinísticos sem rede. Verificação opcional da fonte viva separada. Os testes existentes não comprovam idempotência de um importador ainda inexistente. Manter os testes de votos, permissões e profundidade exigidos pelo AGENTS.md quando essas funcionalidades forem implementadas.

## Restrições preservadas

- Não executar ingestão pesada em requisições Cloudflare Workers.
- Nunca colocar chave privilegiada em `VITE_*` ou no bundle do cliente.
- Não alterar status de vigência sem evidência verificável.
- Não remover automaticamente normas ausentes de snapshot.
- Não modificar migrations remotas sem revisão e autorização.
- Propostas/opiniões não alteram o texto oficial; atualização preserva os IDs usados por interações.

## Critérios de aceite da análise (LA-003)

| Critério do roteiro | Evidência neste documento |
| --- | --- |
| Pelo menos três exemplos reais e variações | Nove exemplos vinculados ao commit na seção de Markdown/YAML, além do Código Civil. |
| Mapeamento campo a campo | Tabela de origem/destino, distinguindo campos observados dos previstos no README. |
| IDs, hashes, atualizações e falhas | Regras de identidade, pipeline incremental e tratamento de erros. |
| Incompatibilidades com schema atual | Número obrigatório, datas, versões, URLs, metadados, controle de execuções e renomes. |
| Recomendação de migration sem aplicação | Propostas explícitas de colunas, constraints e tabelas, pendentes de aprovação. |
| Licença e cobertura | LICENSE consultada e limites de amostragem/truncamento declarados. |

Conclusão histórica da LA-003: a análise isolada não concluía LA-004, LA-005 ou LA-001. A implementação e a validação posteriores da LA-004 estão registradas no início deste documento. Naquela etapa, LA-005 e a auditoria completa da fundação permaneciam pendentes. A implementação posterior da LA-005 está descrita no início deste documento; revisar o dry-run antes de autorizar a primeira carga. O backlog não foi alterado.
