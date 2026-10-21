# LeiAberta — Product Requirements Document

**Versão:** 1.0 — MVP  
**Status:** Planejado; implementação parcial da fundação  
**Escopo:** legislação federal brasileira

## Visão

O LeiAberta é uma plataforma independente de participação cidadã para encontrar, consultar, avaliar e debater normas federais brasileiras. O texto legislativo e sua proveniência devem ser apresentados separadamente de opiniões da comunidade.

## Hipótese

Pessoas desejam descobrir leis relevantes, expressar aprovação ou desaprovação e participar de discussões fundamentadas sobre elas.

## Público

- Cidadãos interessados em direitos e políticas públicas.
- Estudantes e pesquisadores que querem explorar debates.
- Moderadores responsáveis pela integridade da comunidade.

## Funcionalidades P0

1. Importação auditável de normas federais do repositório `ctresb/leis`.
2. Listagem pública com busca textual, filtros por tipo e ano e paginação.
3. Página individual com texto, metadados, fonte, data de sincronização e status de vigência quando verificável.
4. Login Google/GitHub via Supabase Auth.
5. Perfil público com pseudônimo; dados privados não expostos.
6. Aprovar, desaprovar, alterar ou retirar voto em cada lei.
7. Comentários livres e argumentos classificados como PRO/CON, com respostas.
8. Votos de utilidade em publicações.
9. Rankings: mais aprovadas, rejeitadas, debatidas, controversas e em alta.
10. Denúncias, moderação básica, controles antiabuso e trilha de auditoria.
11. Layout responsivo, acessibilidade e SEO para conteúdo público.

## Fora do MVP

- Leis estaduais e municipais.
- IA para aconselhamento ou resumo jurídico.
- Avaliação por artigo, propostas de redação e notificações.
- Mensagens privadas, aplicativo nativo e gamificação.

## Jornadas

### Descobrir e votar

1. Visitante busca uma lei.
2. Abre página com texto e origem.
3. Visualiza votos agregados e debates.
4. Ao votar, autentica-se se necessário.
5. Voto é salvo e contagem atualizada.

### Debater

1. Usuário autenticado abre uma lei.
2. Publica comentário livre ou argumento PRO/CON.
3. Outros usuários respondem e votam na utilidade.
4. Conteúdo inadequado pode ser denunciado e moderado.

## Metas experimentais — primeiros 30 dias

| Indicador | Meta |
|---|---:|
| Cadastros | 100 |
| Usuários que votaram | 30 |
| Votos em leis | 150 |
| Publicações | 50 |
| Retenção em 7 dias | 20% |

Esses valores são metas de validação, não projeções.

## Critérios de lançamento

- Consulta pública e busca funcionam com dados reais e fonte identificável.
- Autenticação, votos, discussões e moderação funcionam com RLS e testes.
- Nenhum dado privado de autenticação aparece publicamente.
- Importações repetidas não duplicam normas nem apagam interações.
- Políticas de privacidade, termos e canais de denúncia estão disponíveis.
- A plataforma esclarece que votos não representam a população brasileira.
