# LeiAberta — Regras de negócio

## Identidade

- Leitura de leis e debates é pública.
- Publicar, votar e denunciar exige autenticação.
- Identidade pública é um pseudônimo, nunca email ou identificador OAuth.
- Perfis têm papéis `USER`, `MODERATOR`, `ADMIN` e estado de conta para suspensão.
- Respeitar as restrições já implementadas na migration de `profiles`; qualquer alteração exige migration explícita.
- OAuth não impede múltiplas contas por pessoa; tratar abuso com medidas proporcionais e auditáveis.

## Votos em leis

- Um voto ativo por par `(user_id, law_id)`.
- Valores permitidos: `+1` (aprovo) ou `-1` (desaprovo).
- Usuário pode trocar ou retirar seu voto.
- Repetir a mesma operação não deve criar duplicatas.
- Contagem total = aprovações + desaprovações.
- Percentual de aprovação = `aprovações / total * 100` quando total > 0.
- Sem votos: mostrar “sem avaliação”, não 0%.
- Contagens devem refletir apenas votos elegíveis segundo a política de moderação vigente.

## Publicações

- Tipos: `COMMENT` (livre), `PRO` (argumento favorável), `CON` (contrário).
- Comprimento do corpo: de 10 a 5.000 caracteres.
- Respostas podem ter no máximo dois níveis de profundidade.
- Profundidade e associação à lei são verificadas no servidor/banco.
- Edição é permitida ao autor, com registro de `edited_at`.
- Exclusão lógica preserva a estrutura das respostas, ocultando o texto removido.
- Renderizar conteúdo de usuário sem HTML executável.
- Moderadores podem ocultar publicações e registrar motivo.

## Votos de utilidade

- Um voto por usuário/publicação, valores `+1` ou `-1`.
- O autor não pode votar na própria publicação.
- Voto de utilidade não significa concordância com o argumento.
- Publicações ocultas ou removidas não podem receber novos votos.

## Rankings

- “Mais aprovadas” e “mais rejeitadas” usam estimativa de Wilson e mínimo configurável de 10 votos.
- “Mais debatidas” ordena pelo número de publicações visíveis.
- “Mais controversas” pondera equilíbrio de votos e volume, com fórmula documentada antes do lançamento.
- “Em alta” considera interações recentes e usuários distintos, com janela documentada.
- Paginação e desempates são determinísticos.
- Mostrar que rankings refletem apenas participantes da plataforma, não pesquisa representativa.

## Legislação

- MVP aceita apenas normas federais.
- Cada norma tem identidade de origem estável, proveniência e hash.
- `unknown` é o estado padrão de vigência; não presumir que a norma está em vigor.
- Mudanças de conteúdo devem preservar a identidade usada pelas interações.
- Propostas e opiniões nunca alteram o texto oficial armazenado.
- Exibir link da fonte e data da sincronização; não confundir sincronização com alteração legal.

## Denúncias e moderação

- Usuário autenticado pode denunciar uma publicação por motivo definido.
- Evitar múltiplas denúncias idênticas do mesmo usuário para o mesmo conteúdo.
- Denúncia não remove automaticamente conteúdo apenas por quantidade.
- Toda ação administrativa relevante registra ator, alvo, motivo e horário.
- Contas suspensas não podem participar enquanto durar a suspensão.
- Criar processo de revisão e canal de contestação antes da abertura pública.

## Privacidade e segurança

- Nunca expor email, tokens, credenciais OAuth ou chaves privilegiadas em perfis.
- RLS em todas as tabelas acessíveis pelo cliente.
- Rate limiting para publicação, votos, denúncias e autenticação.
- Política de retenção/exclusão de dados e termos de uso antes do lançamento.
- Não prometer anonimato absoluto: pseudônimo é identidade pública, não ausência de dados de conta.
