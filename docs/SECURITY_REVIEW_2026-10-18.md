# Revisão de segurança e estabilidade — 18/10/2026

## Complemento após o commit ebf3b92

Este complemento valida o documento de correção fornecido pelo usuário. Estado inicial
desta rodada: branch `security-review-2026-10-18`, HEAD
`ebf3b92a461cf6f6de80d85210c9e32e9ffed4be`, árvore limpa, remoto `origin` neste
repositório. O usuário autorizou explicitamente commit e push nesta branch. As seções
posteriores preservam o registro da revisão original, anterior a esse commit; os estados
abaixo atualizam os pontos afetados.

| Item                                       | Validação, gravidade e confiança                                                                                                                                                                                                                                            | Correção e regressão                                                                                                                                                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Upgrade de hash quebra MFA               | Confirmado; média, confiança alta; disponibilidade do login administrativo. O trigger de senha apaga a sessão já carregada, deixando o desafio ligado a um cookie inválido.                                                                                                 | `auth/routes.ts` cria sessão anônima nova quando o upgrade revoga a sessão da própria conta; `totp-routes.ts` devolve seu CSRF. Quatro cenários combinam v1/pepper anterior com setup/verificação MFA e sessão prévia sem MFA.                                              |
| 2 Contador pós-KDF e código morto          | Confirmados o status observável do contador e a exportação sem uso; baixa, confiança alta; consistência. O contador já era posterior ao KDF e não protegia CPU distribuída. A diferença normal entre senha correta e incorreta não é prova isolada de nova vulnerabilidade. | Contador continua limitado a dez falhas/janela, sem estender a janela; saturação não troca `401 INVALID_CREDENTIALS` por 429. IP e IP/e-mail continuam protegidos antes do KDF; `checkFailureLimit` foi removida. A1 e testes existentes cobrem concorrência e limites.     |
| 3 Cabeça abandonada na fila                | Confirmado; média, confiança alta; disponibilidade/cota MonitorIE. Entrada válida por 140 s podia manter o gate ocioso depois de aberto.                                                                                                                                    | Prioridade de fila vale até 15 s após abrir a janela global; limite global de 70 s permanece atômico. Teste com SQL/relógio controlados usa t=0/5/10/69/70/84/85/86.                                                                                                        |
| 4 Basic Auth intercepta páginas/API normal | Confirmado; média, confiança alta; disponibilidade/UX. Redirects anônimos e polling após expiração recebiam desafio Basic e consumiam quota de compartilhamento.                                                                                                            | Páginas redirecionam antes de compartilhamento; só header Basic explícito opta por esse login. A2 cobre `/`, `/login`, JSON 401 sem WWW-Authenticate/quota, Basic inválido limitado e sessões autenticadas preservadas.                                                     |
| 5 Unknown ainda parecia Online             | Confirmado; baixa, confiança alta; integridade da apresentação. A correção original cobria renderConnection, mas não métricas/cartão/pareamento.                                                                                                                            | Estado, contexto, ponto e badge agora tratam unknown explicitamente; ternário duplicado removido. Teste executa as funções reais para SM-WU/SM-WA com/sem last_seen e callback do pareamento.                                                                               |
| 6a Truncamento da janela de membro         | Confirmado; baixa, confiança alta; metadata incorreta. Limite do proprietário era propagado mesmo quando os pontos cobriam integralmente a janela recente do membro.                                                                                                        | `remoteHistory` só preserva truncamento do provedor se não houver timestamp completo até a fronteira efetiva. Cache vazio continua conservador e corte pelo limit continua sinalizado. Testes incluem limite exato, proprietário, membro e cache compartilhado.             |
| 6b Seed após tombstone                     | Confirmado; baixa, confiança alta; desenvolvimento local. ID 1 fixo colidia com o ledger após exclusão.                                                                                                                                                                     | `local-db.mjs` reutiliza DEMO-WU mock sem titular ou aloca MAX(ledger)+1. Códigos de ativação usam o ID retornado. Teste executa o corpo real do CLI sobre D1 efêmero: seed/reseed/delete/seed, e recusa demo já vinculada.                                                 |
| 6c Atestação remota individual             | Funcionalidade ausente confirmada; não classificada como vulnerabilidade.                                                                                                                                                                                                   | `attest-email.mjs` aceita --remote e --env preview, exige ID inteiro seguro e --attested, rejeita opções inválidas, usa Node/Wrapper Wrangler sem shell e não imprime saída privada. Processo remoto é simulado; SQL e auditoria/no-op também são executados em D1 efêmero. |

Nenhuma migration 0015 foi criada; 0001–0014 e `wrangler.toml` estão intactos.
`MAIL_MODE="disabled"` e `MAIL_REQUIRED="true"` da configuração de produção permanecem
como trava de readiness. Atestar uma conta individualmente após prova externa da caixa
postal não configura o provedor e não libera esse readiness.

Uso preparado, **não executado contra serviços reais**:

```text
node scripts/cloudflare/attest-email.mjs USER_ID --attested
node scripts/cloudflare/attest-email.mjs USER_ID --attested --remote
node scripts/cloudflare/attest-email.mjs USER_ID --attested --remote --env preview
```

Local usa D1 local; remoto sem --env seleciona hidra-r3b; --env preview seleciona
hidra-r3b-preview. A flag --attested é declaração do operador após verificação externa,
não uma verificação automatizada da caixa. Nesta rodada nenhum desses comandos reais
foi executado; somente seus imports/processos substituídos em testes.

Validação final do complemento:

| Verificação                                                  | Resultado                                                                                                                                                  |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline ebf3b92, somente leitura por git show               | 11 cenários novos/expandidos falham como esperado. Os quatro cenários de MFA reproduzem especificamente 419 no setup/verify.                               |
| `security-auth-review.test.mjs`                              | 15/15 passaram.                                                                                                                                            |
| `security-consistency-review.test.mjs`                       | 7/7 passaram.                                                                                                                                              |
| `security-operations-review.test.mjs`                        | 14/14 passaram.                                                                                                                                            |
| `security-telemetry-review.test.mjs` (Worker)                | 11/11 passaram.                                                                                                                                            |
| `security-telemetry-review.test.mjs` (frontend)              | 5/5 passaram.                                                                                                                                              |
| Compatibilidade em `app.test.mjs`                            | 11 casos distintos aprovados: oito na seleção inicial e três no reteste de expectativas deliberadamente alteradas, incluindo Basic com headers excessivos. |
| Compatibilidade em `remediation.test.mjs`                    | 3/3 passaram: contador atômico, readiness e histórico/fila/retenção.                                                                                       |
| `monitorie-protocol.test.mjs` e frontend `security.test.mjs` | 11/11 passaram.                                                                                                                                            |
| `npm run typecheck`, `npm run lint`, `npm run format:check`  | Passaram.                                                                                                                                                  |
| `npm run build`                                              | Passou com origens loopback; diretórios de saída conferidos dentro do workspace.                                                                           |
| Diff, configuração e migrations                              | Sem whitespace inválido; 17 arquivos existentes alterados, nenhum novo. Configuração e migrations preservadas.                                             |

São **77 casos distintos aprovados** nas seleções desta rodada, incluindo os 52 dos
cinco arquivos de revisão. A suíte completa não foi executada. Falhas esperadas de
baseline e retestes não foram somados novamente. Os testes antigos ajustados refletiam
os contratos substituídos: páginas sem desafio Basic, Basic explícito em APIs e
401 sem Retry-After para contador global pós-KDF saturado. Sua proteção por IP continua
exigindo 429 com Retry-After antes do KDF. O teste de fila agora representa abertura
recente, preservando a prioridade durante seus 15 segundos de graça.

Comando dos arquivos de revisão:

```text
node --test --test-concurrency=1 tests/cloudflare/security-auth-review.test.mjs tests/cloudflare/security-consistency-review.test.mjs tests/cloudflare/security-operations-review.test.mjs tests/cloudflare/security-telemetry-review.test.mjs tests/frontend/security-telemetry-review.test.mjs
```

Revisão pública da fonte deste build:
`b73ed046d7da4e88580ee1b80a198af54fda6a8f071308d29ed9c0e3762e9a22`;
o marcador de `dist/frontend/build-info.json` coincide com a fonte. Build e evidências
sintéticas continuam ignorados no Git. O commit inclui apenas código, testes e este
registro, sem secrets, arquivos ignorados ou artefatos gerados. Não houve deploy,
merge, migration remota, envio de e-mail nem atestação real de conta.

## Estado e limites da execução

Estado inicial: diretório `recursos-hidricos-r3b`, branch `main`, HEAD
`eb0b30005a42cf818f8e2a76728f1de1038a141d`, árvore limpa. O conector GitHub confirmou
o mesmo commit em `icarofdev/recursos-hidricos-r3b:main`. As alterações desta revisão
ficam locais, sem commit, push, merge ou publicação.

Diretório absoluto: `C:\Users\Ícaro\Downloads\recursos-hidricos-r3b`.
Remoto `origin` de fetch/push: `https://github.com/icarofdev/recursos-hidricos-r3b.git`.
Não havia alterações locais preexistentes a preservar.

Foram relidos os relatórios anteriores e conferidos os fluxos atuais. Testes usam
Miniflare/D1 efêmero, dados sintéticos, relógio controlado e transportes simulados.
Nenhum endpoint de produção, painel, banco remoto, Resend ou MonitorIE real foi
consultado. Arquivos `.env`, `.dev.vars`, credenciais e backups reais não foram abertos.
Documentação pública oficial e metadados do GitHub foram usados para verificar contratos
da plataforma e referências de actions; isso não valida serviços publicados.

“Corrigido” significa corrigido nesta árvore local e coberto pela regressão indicada.
“Já corrigido” significa controle preexistente revalidado. Nenhum desses estados confirma
publicação. “Não verificável” identifica evidência externa que não estava autorizada.
Não foram demonstradas regressões que exijam restaurar código anterior.

## Matriz A — itens solicitados

| Item                            | Estado final local                           | Evidência e comportamento                                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 Login bloqueado pelo e-mail  | Corrigido                                    | Limites por IP e IP/e-mail continuam antes do KDF; falhas distribuídas não recusam a senha correta. O contador da conta só limita respostas de senha inválida. Testes auth A1 e app correspondente.                  |
| A2 Shared access                | Já corrigido                                 | Login normal não é interceptado; sessão normal/admin não é rebaixada; requisições autenticadas não consomem quota de compartilhamento. Auth A2.                                                                      |
| A3 Rotação concorrente          | Já corrigido                                 | CAS existente mantém um candidato; 8 rotações e 6 confirmações concorrentes, confirmação e graça de 30 s verificadas. Auth A3.                                                                                       |
| A4 Sessão/MFA/recuperação       | Corrigido e controles anteriores revalidados | Expiração, versões, troca de senha/e-mail/papel, replay, recuperação e reauth validados; instalação MFA agora consome desafio e confere revogação na mesma transação das credenciais. Auth A4/A17 e regressão MFA.   |
| A5 Autorização/isolamento       | Já corrigido; preservado nas alterações      | Owner/member/admin, desafio alheio, versão e reauth; testes existentes de pareamento e revogação, e cache compartilhado com reautorização.                                                                           |
| A6 Histórico local ilimitado    | Já corrigido                                 | HISTORY_MAX_SAMPLES, saída e paginação limitados; geometria não linear mantém conversão por amostra antes da média. Telemetry A6/A22.                                                                                |
| A7 Gate/cache MonitorIE         | Corrigido; gate já protegido                 | Cache bruto passa a ser compartilhado pelo vínculo proprietário/geração/mapping, sem amarrar a membro. Gate, fila, 70 s e contenção sem negativo continuam protegidos. Telemetry A7/A15.                             |
| A8 Truncamento remoto           | Corrigido                                    | Metadata atravessa adapter e cache; atingir limite do provedor continua sinalizado mesmo depois de descartar timestamps desalinhados. Telemetry A8/D3.                                                               |
| A9 Scan longo                   | Corrigido                                    | Expiração por inatividade, retomada e limite de páginas; evidência do MAC é revalidada no encerramento, inclusive idade/futuro. Telemetry A9/D4.                                                                     |
| A10 Histórico frontend          | Corrigido                                    | Timer da próxima vaga e Retry-After, independente do polling de 75/300 s; coalescência do período atual, pausa quando oculto e retomada. Frontend A10.                                                               |
| A11 Identidade da auditoria     | Corrigido                                    | Ledger append-only, allocator e trigger impedem IDs reciclados; logs legados são explicitamente não comprovados, sem receber nome de dispositivo atual. Consistency audit identity e migration 0014.                 |
| A12 Capacidade/calibração       | Corrigido                                    | configuration_version monotônica e guard atômico; operação obsoleta retorna 409 nos dois intercalamentos. Consistency configuration version.                                                                         |
| A13 Ingestão sem vínculo        | Corrigido                                    | DEVICE_UNLINKED 409 antes de ocupar evento; guard exige vínculo ativo na inserção. Telemetry A13/A14.                                                                                                                |
| A14 Qualidade/last_seen         | Já corrigido                                 | Distância autenticada fora da geometria mantém valor bruto, qualidade inválida e comunicação, sem inventar nível/volume. A14 também passou no baseline.                                                              |
| A15 Fronteira temporal do cache | Preservada e revalidada                      | Cache compartilhado contém payload bruto do vínculo proprietário; membro recebe filtro em milissegundos, last_seen filtrado e autorização após await/cache hit. Revogação impede resposta.                           |
| A16 Confirmação de e-mail       | Corrigido                                    | Token novo removido na falha; recibos devolvem apenas quota de rejeição determinada; timeout conserva quota; último link entregue sobrevive ao reenvio falho. Auth A16.                                              |
| A17 Recuperação de senha        | Corrigido e controles anteriores revalidados | Reenvio falho preserva link entregue; sucesso invalida só provas anteriores e revalida e-mail/hash/versão. Resposta anônima e quotas uniformes, 20 min, uso único e revogação de sessões. Mail real não verificável. |
| A18 put-secret portátil         | Já corrigido                                 | process.execPath e wrapper com fileURLToPath; teste estático sem ler credenciais nem executar Wrangler.                                                                                                              |
| A19 Manutenção 60 s             | Corrigido                                    | t/t+60/t+120, lease, renovação e fencing das exclusões/relatório, takeover e liberação em falha. Operations maintenance.                                                                                             |
| A20 Nomes de migrations         | Já corretos; documentação atualizada         | 0012/0013 correspondiam aos arquivos; OPERATIONS/CLOUDFLARE agora incluem 0014 e schema 14.                                                                                                                          |
| A21 Migrations/rollback         | Verificado localmente                        | Banco vazio, upgrade 13→14, falha de batch revertida, dados preservados, FKs e restore sintético. Rollback de código antigo incompatível documentado.                                                                |
| A22 Recursos por rota           | Verificado nos caminhos críticos examinados  | JSON 16 KiB, integração 1 MiB, auth remota 16 KiB, timeout/cancelamento, histórico e manutenção limitados; scanner diagnóstico também limitado. Não equivale a carga/fuzzing de todas as rotas.                      |
| A23 Hoje/24 h                   | Corrigido                                    | Série móvel mantém pontos de ontem ainda dentro das 24 h; métricas do dia civil têm função separada. Frontend A23.                                                                                                   |

## Matriz B — superfícies adicionais

| Item                                 | Estado                                             | Evidência/limite                                                                                                                                                                       |
| ------------------------------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 Diagnósticos MonitorIE            | Corrigido                                          | Default de contagens/estados, paths sem IDs e erros allowlist; detalhes privados no probe exigem --include-sensitive. Execução dos CLIs testada com imports totalmente sintéticos.     |
| B2 Security events                   | Corrigido                                          | Amostragem antes do console e D1; console sem account_id/account_hash, correlação no D1 mantida.                                                                                       |
| B3 GitHub Actions                    | Corrigido                                          | contents:read, persist-credentials:false, actions oficiais por SHA; sem secrets em workflow e sem pull_request_target. Configuração efetiva da organização não verificada.             |
| B4 Secrets/defaults                  | Verificado estaticamente; externo não verificável  | Nenhum valor privado lido. Mocks só locais, origens exatas, recuperação obrigatória causa readiness503 se desabilitada; separação e presença real das chaves exigem operador.          |
| B5 Revisão publicada/schema/bindings | Não verificável                                    | Nenhum acesso a produção/painel. Fonte local e GitHub iniciais coincidem; correções desta revisão não publicadas.                                                                      |
| B6 Dependências/supply chain         | Verificado com limites                             | npm audit atual: zero advisories/263 entradas; integridade/registry/lifecycle examinados. Sem instalação. Chart.js 4.5.1 identificado; origem criptográfica do vendor não autenticada. |
| B7 Frontend/Worker/banco             | Verificado nos pontos examinados                   | SQL parametrizado, allowed fields, normalização, escaping/textContent, controle por recurso, CSRF, CORS, CSP, cookies e redirects. Não é prova universal contra SQLi/XSS.              |
| B8 Saída/SSRF                        | Verificado localmente                              | Destinos de integração fixos, redirects manuais rejeitados, IDs/keys validados antes do fetch; timeout, limites e cancelamento de corpos rejeitados. DNS real não consultado.          |
| B9 Logs/erros                        | Corrigido localmente; plataformas não verificáveis | D1, stdout do Worker e CLIs separados no exame; sem propagação de error.message remoto. Logs reais de CI, hospedagem/provedor e retenção dependem de configuração externa.             |
| B10 Backup/cron/quota/WAF/alertas    | Parcialmente verificado                            | Lease/limites/retencão local e restauração sintética; nenhuma prova de backup agendado, cron publicado, plano, quota, WAF ou alerta ativo.                                             |
| B11 Firmware/dispositivos            | Não verificável                                    | Nenhuma fonte/artefato verificável de firmware encontrado. Contrato de ingestão testado; faltam versão, TLS, credencial em flash, relógio, buffer e retries reais.                     |

## Matriz C — checklist da imagem

| Item                    | Classificação                           | Escopo                                                                                                          |
| ----------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| C1 HTTPS                | Verificado localmente                   | Worker recusa HTTP fora de dev; HSTS nos artefatos. Transporte publicado não verificável.                       |
| C2 Hash de senha        | Verificado                              | PBKDF2 com salt/pepper, política e rotação existentes revalidados. Sem leitura de chaves.                       |
| C3 MFA                  | Corrigido/revalidado                    | TOTP, replay, recuperação/reauth e corrida de instalação cobertos. MFA é de administradores.                    |
| C4 Rate limit           | Corrigido/revalidado                    | IP/identidade, conta inválida, MFA, ingestão e gate; custo de ataque distribuído ainda exige mitigação externa. |
| C5 Validação            | Corrigido/revalidado                    | Campos/tipos/tamanhos, qualidade, números finitos, ID seguro e JSON/UTF-8.                                      |
| C6 Sanitização          | Verificado nos sinks examinados         | Escaping e textContent; dados remotos não viram HTML executável nos pontos revistos.                            |
| C7 SQL injection        | Não reproduzido nos caminhos examinados | Parâmetros vinculados; nomes SQL dinâmicos vêm de constantes.                                                   |
| C8 Migrations           | Verificado localmente                   | Schema 14 aditivo; sem execução remota.                                                                         |
| C9 Rollback             | Verificado localmente/parcial           | Reversão transacional e restore sintético; rollback operacional real pendente.                                  |
| C10 Controle de acesso  | Corrigido/revalidado                    | Isolamento e desafios; guards de ownership/configuração/MFA.                                                    |
| C11 Expiração de sessão | Já corrigido/verificado                 | Inatividade, absoluto, versão e rotação concorrente.                                                            |
| C12 Secrets             | Verificado estaticamente                | Nenhum arquivo privado aberto; inventário real, separação e rotação externos não verificados.                   |
| C13 CORS                | Verificado localmente                   | Origem exata, credenciais e recusa de origem indevida; origens publicadas não verificadas.                      |
| C14 Logs                | Corrigido                               | Console amostrado/sem IDs de conta e CLIs com redaction; retenção dos serviços pendente.                        |
| C15 Backups             | Verificado com dados sintéticos         | Restore D1/SQLite e integridade; backups reais/agendamento/RPO/RTO pendentes.                                   |
| C16 Criptografia        | Verificado no código/testes             | TOTP e cache de autenticação AES-GCM, chaves fora do DB, transição existente. Custódia real não verificável.    |
| C17 Dependências        | Verificado com limites                  | Audit/lock/lifecycle/CI/vendor; sem declaração de ausência de falhas desconhecidas.                             |
| C18 “PMP”               | Ambíguo/não verificável                 | Significado não inferido. Precisa de interpretação ou imagem legível para requisito adicional.                  |
| C19 Monitoramento       | Pendente externo                        | Categorias/requestID/backlog locais presentes; destinatários, alertas, quotas e execução reais não verificados. |
| C20 Texto encoberto     | Não verificável                         | Nenhum requisito inventado.                                                                                     |

## Matriz D — cinco achados da última auditoria

| Item                      | Resultado                     | Regressão                                                                                     |
| ------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------- |
| D1 ID reciclado/auditoria | Corrigido com migration14     | consistency: audit identity; migração e restore preservam ledger.                             |
| D2 Capacidade/calibração  | Corrigido com versão otimista | consistency: stale capacity e stale configuration.                                            |
| D3 Truncamento            | Corrigido                     | telemetry: 2.000 pontos por chave/1.999 completos, metadata em cache/API.                     |
| D4 Scan 24 h              | Corrigido                     | telemetry: retoma progresso recente; expira inativo; recusa evidência antiga/futura no final. |
| D5 Cron 60s               | Corrigido                     | operations: cadência, concorrência, takeover, fencing e falha.                                |

## Achados adicionais confirmados nesta revisão

Todos os cenários abaixo foram reproduzidos com dados sintéticos e têm regressão que
falhava no código público `eb0b300`. São correções locais, sem confirmação em produção.

| Achado / classificação                                                               | Evidência, pré-condição e impacto                                                                                                                                                                                                                                             | Correção e reprodução segura                                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instalação MFA após revogação — média, confiança alta; segurança                     | totp-routes.ts: desafio era consumido antes do batch das credenciais. Uma troca de senha naquele intervalo removia o desafio/sessões, mas o pedido antigo ainda instalava autenticador. Requer confirmação MFA já em andamento; não foi demonstrado acesso sem a senha atual. | Auth teste “new: password change…” pausa antes do batch e troca senha sintética. Guard, consumo e escrita de credenciais agora são uma transação; nenhuma credencial é instalada após a revogação.  |
| Reenvio falho invalida último link entregue — média, confiança alta; disponibilidade | auth/routes.ts requestReset e email-verification.ts invalidavam provas anteriores antes de aceitar o novo envio. Sequência 201→503/timeout deixava o usuário sem o link ainda válido que recebeu.                                                                             | Testes auth A16/A17 simulam aceitação, rejeição e transporte incerto. Invalidação só após aceitação, condicionada à mesma identidade/credenciais e a rowids anteriores; falha remove só token novo. |
| Edição admin apaga last_seen concorrente — média, confiança alta; bug funcional      | admin/mutations.ts reutilizava reported_status/last_seen do SELECT inicial em UPDATE posterior. Uma leitura autenticada recebida nesse intervalo voltava a parecer offline.                                                                                                   | Consistency “admin update…” intercala last_seen 100→200 antes do batch. CASE preserva o estado atual quando a identidade não mudou; troca real de identidade continua limpando comunicação.         |
| Estado unknown exibido como Online — baixa, confiança alta; bug funcional            | dashboard.js tratava unknown como “não desconectado” na legenda de conexão. Indisponibilidade MonitorIE podia aparecer como comunicação confirmada.                                                                                                                           | Frontend “unknown MonitorIE status…” usa snapshot sintético unknown; UI mostra “Sem confirmação”.                                                                                                   |
| Probe structure sem limite de resposta — baixa, confiança alta; recursos             | monitorie-probe.mjs usava response.json() sem teto de bytes. Corpo remoto sintético maior que 1 MiB era aceito pelo CLI diagnóstico.                                                                                                                                          | Operations “structure CLI…” injeta stream grande, sem executar serviço real; leitura limitada a1 MiB e UTF-8 estrito.                                                                               |

O cancelamento explícito de corpos remotos rejeitados é fortalecimento preventivo,
sem alegação de SSRF ou DoS demonstrado. O ajuste de cache resolve fragmentação da cota;
não foi tratado como vazamento de dados preexistente.

## Gravidade dos demais problemas corrigidos

Classificação pelo impacto reproduzido, com confiança alta nos cenários locais.
Os testes citados nas matrizes e no inventário abaixo contêm os dados sintéticos e a
reprodução executável. Não se presume que os cenários existam no ambiente publicado.

| Itens   | Gravidade / natureza                  | Causa e impacto confirmado                                                                                                                |
| ------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A1      | Média / disponibilidade               | Bloqueio por e-mail precedia a senha: falhas de múltiplos IPs impediam login válido da conta conhecida.                                   |
| A7      | Baixa / disponibilidade e quota       | Chave por usuário fragmentava o cache do mesmo vínculo; proprietário e membro repetiam consulta remota apesar de dados reaproveitáveis.   |
| A8/D3   | Média / integridade da informação     | Adapter descartava metadata; timestamp desalinhado fazia uma resposta limitada parecer completa.                                          |
| A9/D4   | Média / disponibilidade               | Expiração pelo início do scan descartava progresso recente; inventários longos podiam nunca concluir.                                     |
| A10     | Baixa / bug funcional                 | Histórico aguardava polling distante após a trava local ou troca de período; faltava agendamento próprio.                                 |
| A11/D1  | Média / integridade da auditoria      | INTEGER PRIMARY KEY reutilizável e join ao cadastro atual atribuíam evento antigo ao dispositivo novo.                                    |
| A12/D2  | Média / integridade dos dados         | Capacidade e calibração eram validadas sobre snapshots distintos e gravadas sem versão atômica.                                           |
| A13     | Média / integridade e disponibilidade | Dispositivo sem reservatório ativo gravava linha órfã e ocupava identidade de evento sem possibilidade de associação posterior.           |
| A16/A17 | Média / disponibilidade               | Reservas de envio e substituição antecipada de provas prejudicavam novas tentativas ou o último link entregue após falha de envio.        |
| A19/D5  | Média / operação                      | Comparação estrita ignorava t+60; marcador sem fencing também permitia execução atrasada alterar o trabalho de um sucessor.               |
| A23     | Baixa / bug funcional                 | Filtro por dia civil removia ontem da janela móvel de 24 h solicitada pelo gráfico.                                                       |
| B1      | Média / privacidade operacional       | Diagnósticos imprimiam identificadores, nomes, valores e mensagens remotas em stdout por padrão.                                          |
| B2      | Baixa / privacidade e custo           | Console era escrito antes da amostragem e incluía correlação de conta; volume não acompanhava o controle do D1.                           |
| B3      | Baixa / fortalecimento preventivo     | Workflow não explicitava permissões mínimas e usava tags mutáveis/credenciais persistidas; não foi demonstrado comprometimento da cadeia. |

## Arquivos e contratos alterados

Inventário relativo à raiz indicada acima. `M` é arquivo existente modificado; `??`
é arquivo novo, ainda não adicionado ao índice. As migrations 0001–0013 foram preservadas.

| Git | Arquivo                                                       | Alteração                                                                                          |
| --- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| M   | `.github/workflows/ci.yml`                                    | Permissão contents:read, SHAs oficiais e credenciais de checkout não persistidas.                  |
| M   | `README.md`                                                   | Link para este relatório.                                                                          |
| M   | `cloudflare/admin/monitorie-association.ts`                   | Progresso por inatividade e validação final da idade da evidência MAC.                             |
| M   | `cloudflare/admin/mutations.ts`                               | Allocator sobre ledger e preservação de comunicação concorrente.                                   |
| M   | `cloudflare/admin/routes.ts`                                  | Identidade de auditoria estável, com eventos legados sem atribuição presumida.                     |
| M   | `cloudflare/auth/email-verification.ts`                       | Recibos de quotas, compensação de falha e preservação do link entregue.                            |
| M   | `cloudflare/auth/rate-limit.ts`                               | Reserva e liberação idempotente vinculadas à janela exata.                                         |
| M   | `cloudflare/auth/routes.ts`                                   | Senha correta sem bloqueio por e-mail; reset anterior preservado após reenvio falho.               |
| M   | `cloudflare/auth/security-events.ts`                          | Amostragem antes de stdout/D1 e remoção de identidade de conta do console.                         |
| M   | `cloudflare/auth/totp-routes.ts`                              | Guard, consumo de desafio e instalação MFA na mesma transação.                                     |
| M   | `cloudflare/db/maintenance.ts`                                | Cadência inclusiva, lease/fencing, backlog condensado e orçamento por ciclo.                       |
| M   | `cloudflare/db/reservoirs.ts`                                 | Versão de configuração conferida atomicamente ao alterar capacidade/calibração.                    |
| M   | `cloudflare/history.ts`                                       | Propagação de truncamento do provedor até metadata da API.                                         |
| M   | `cloudflare/ingest.ts`                                        | Vínculo ativo obrigatório e guard da configuração usada para derivar a leitura.                    |
| M   | `cloudflare/mail/index.ts`                                    | Resultado de envio distingue rejeição determinada de transporte incerto.                           |
| M   | `cloudflare/monitorie/adapter.ts`                             | Histórico com metadata, preservando a interface anterior de arrays.                                |
| M   | `cloudflare/monitorie/auth.ts`                                | Cancelamento de corpo de autenticação rejeitado ou excessivo.                                      |
| M   | `cloudflare/monitorie/cache.ts`                               | Cache por vínculo proprietário/geração; filtro temporal e autorização por solicitante.             |
| M   | `cloudflare/monitorie/mock.ts`                                | Implementação sintética do contrato de histórico com metadata.                                     |
| M   | `cloudflare/monitorie/protocol.ts`                            | Cancelamento de respostas remotas rejeitadas/excessivas.                                           |
| M   | `cloudflare/monitorie/single-flight.ts`                       | Nova versão das chaves do cache bruto compartilhado.                                               |
| M   | `cloudflare/types.ts`                                         | Tipo configuration_version no reservatório.                                                        |
| M   | `cloudflare/worker.ts`                                        | Readiness exige schema 14.                                                                         |
| M   | `docs/CLOUDFLARE.md`                                          | Estado atual das migrations e readiness.                                                           |
| M   | `docs/OPERATIONS.md`                                          | Schema 14, lease, backup do ledger e restrições de rollback.                                       |
| M   | `docs/REMEDIATION.md`                                         | Ponteiro histórico para esta revisão, preservando o relatório anterior.                            |
| M   | `scripts/cloudflare/monitorie-auth-live.mjs`                  | Sumários seguros em stdout e erros sem conteúdo remoto.                                            |
| M   | `scripts/cloudflare/monitorie-probe.mjs`                      | Sumários por padrão, modo sensível explícito e parsing limitado.                                   |
| M   | `static/js/admin.js`                                          | Exibição de dispositivo excluído/identidade histórica não comprovada.                              |
| M   | `static/js/dashboard.js`                                      | Timer de histórico, Retry-After, visibilidade e estado unknown.                                    |
| M   | `static/js/dashboard/model.js`                                | Janela móvel de 24 h separada do dia civil.                                                        |
| M   | `tests/cloudflare/app.test.mjs`                               | Expectativa de login válido após falhas distribuídas.                                              |
| M   | `tests/cloudflare/remediation.test.mjs`                       | Nome do teste pós-KDF e idade explícita da fila, sem depender de virar o segundo.                  |
| M   | `tests/e2e/helpers.mjs`                                       | Fixture de criação usa allocator do ledger.                                                        |
| ??  | `cloudflare/migrations/0014_audit_identity_configuration.sql` | Ledger imutável, cutoff de auditoria e versão de configuração, sem reconstruir tabelas existentes. |
| ??  | `docs/SECURITY_REVIEW_2026-10-18.md`                          | Matrizes, evidências, inventário e limites desta revisão.                                          |
| ??  | `scripts/cloudflare/diagnostic-output.mjs`                    | Redaction por allowlist e JSON até 1 MiB com UTF-8 estrito.                                        |
| ??  | `tests/cloudflare/security-auth-review.test.mjs`              | 11 testes de autenticação, e-mail, sessões, MFA e logs.                                            |
| ??  | `tests/cloudflare/security-consistency-review.test.mjs`       | 6 testes de identidade, concorrência, upgrade, rollback e restore.                                 |
| ??  | `tests/cloudflare/security-operations-review.test.mjs`        | 13 testes de manutenção, diagnósticos, portabilidade, CI e documentação.                           |
| ??  | `tests/cloudflare/security-telemetry-review.test.mjs`         | 9 testes de integração/ingestão/cache/histórico e limites.                                         |
| ??  | `tests/frontend/security-telemetry-review.test.mjs`           | 5 testes de janela temporal, agendamento e conexão unknown.                                        |

## Validação

Foram selecionadas regressões das alterações e contratos existentes afetados; a suíte
completa e Playwright não foram executados. Todos os serviços externos nos testes
abaixo foram substituídos por mocks; D1 e dados são efêmeros/sintéticos.

| Verificação                                                                                                | Resultado                                                                            |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Cinco arquivos novos de regressão (`security-*-review`)                                                    | 44/44 passaram na rodada integrada.                                                  |
| `app.test.mjs`, seleção de autenticação, ownership, ingestão, configuração, exclusão e observação          | 32/32 passaram.                                                                      |
| `monitorie-adapter`, `monitorie-protocol`, `monitorie-auth`, frontend `security` e `dashboard-model`       | 23/23 passaram.                                                                      |
| `remediation.test.mjs`, seleção de prova de e-mail, privacidade, readiness, histórico/manutenção e upgrade | 5/5 passaram na rodada final.                                                        |
| TypeScript Worker e frontend                                                                               | Ambos passaram sem erros.                                                            |
| ESLint em `cloudflare static/js scripts/cloudflare tests`                                                  | Passou.                                                                              |
| Prettier nos arquivos modificados e `git diff --check`                                                     | Passaram na verificação final.                                                       |
| Build local com PUBLIC_API_URL=127.0.0.1:8787 e PUBLIC_APP_URL=127.0.0.1:8788                              | Passou; nenhum endereço de serviço real.                                             |
| Restauração sintética schema 14                                                                            | D1 e verificador SQLite existente passaram, preservando dados e tombstones.          |
| Scanner de 143 arquivos públicos de texto, sem arquivos privados                                           | Sem padrões de chave privada/chave de provedor/JWT literal; sem sourcemaps públicos. |

A primeira execução do teste existente de fila/histórico falhou por depender de duas
requisições ocorrerem em segundos diferentes. O gate não foi alterado para isso: a
fixture agora explicita a idade do item aguardando na fila antes de liberar a janela,
respeitando o desempate por device_id do contrato existente.

Total das seleções finais: **104 testes passaram**, sendo 44 novos e 60 existentes.
O reteste isolado da fila também passou; não foi contado novamente nesse total.

As regressões dos problemas corrigidos também foram executadas contra a fonte pública
`eb0b300` por plugins de leitura de `git show`, sem checkout/reset: os casos de identidade,
CAS, last_seen administrativo, autenticação/e-mail/MFA, telemetria/frontend, cron e
diagnóstico falharam como esperado. Controles preexistentes, como last_seen de leitura
fora da faixa, passaram também nessa fonte. Falhas esperadas de baseline não contam
como falhas da árvore corrigida.

Comandos principais, executados a partir da raiz:

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.frontend.json
node node_modules/eslint/bin/eslint.js cloudflare static/js scripts/cloudflare tests
node --test --test-concurrency=1 tests/cloudflare/security-auth-review.test.mjs tests/cloudflare/security-consistency-review.test.mjs tests/cloudflare/security-operations-review.test.mjs tests/cloudflare/security-telemetry-review.test.mjs tests/frontend/security-telemetry-review.test.mjs
node --test --test-concurrency=1 tests/cloudflare/monitorie-adapter.test.mjs tests/cloudflare/monitorie-protocol.test.mjs tests/cloudflare/monitorie-auth.test.mjs tests/frontend/security.test.mjs tests/frontend/dashboard-model.test.mjs
node --test --test-concurrency=1 --test-name-pattern='e-mail proof|privacy survives erasure|readiness validates|history bounds work|upgrade from schema 11' tests/cloudflare/remediation.test.mjs
```

A seleção de `app.test.mjs` cobriu migrations/revisão, cadastro/hash, login lembrado,
expiração/logout concorrente/rate limit/recuperação/reset, pareamento/ingestão,
compartilhamento/admin, TOTP/recovery/reauth, unicidade/rollback da criação, autorização
de capacidade, exclusão, cinco contas por dispositivo, configuração/backend único,
login distribuído e amostragem de observação.

Hash da fonte pública produzida pelo build:
`e04240fe5bec356fd4490dc666a3eecf5b85fb131014591c7c2d9a5db0213ad4`.
O marcador gerado coincide com a fonte. CSP/form-action self/HSTS foram conferidos nos
artefatos locais; isso não confirma headers publicados.

## Estado final do Git e diff

Branch `main` e HEAD `eb0b30005a42cf818f8e2a76728f1de1038a141d` preservados.
Nenhum commit, arquivo staged, exclusão, push ou deploy. O inventário acima corresponde
ao `git status --short`: **34 arquivos modificados (`M`) e 8 novos (`??`), total 42**.
`git diff --shortstat` registra **519 inserções e 246 exclusões em 34 arquivos rastreados**;
esse comando não inclui os oito arquivos novos. Estes acrescentam a migration 0014,
o helper de diagnóstico, cinco arquivos de regressão e este relatório.

O diff foi inspecionado e os módulos de autenticação, telemetria, manutenção e consistência
também receberam revisão cruzada entre os agentes. Sem alterações em package.json,
package-lock.json, dependências instaladas ou migrations anteriores. Artefatos gerados e
evidências sintéticas ficam em diretórios ignorados, sem novos arquivos públicos secretos.

## Dependências e evidências externas

O npm audit desta execução, sem fix/install, retornou zero advisories nos 263 pacotes do
lockfile. As entradas verificadas têm integridade e registry.npmjs.org. Há scripts de
instalação em esbuild, workerd, fsevents e versões transitivas esbuild/workerd do Wrangler;
nenhum instalador foi executado. Audit consulta vulnerabilidades conhecidas, não garante
proveniência nem ausência de código malicioso.

Chart.js vendorizado: versão 4.5.1, 208.536 bytes,
SHA256 `f52399835588eada7bc2a9f720298d5f12fea63c01d6a59c34beec89ccaa670f`.
[Release oficial](https://github.com/chartjs/Chart.js/releases/tag/v4.5.1) e
[advisories do mantenedor](https://github.com/chartjs/Chart.js/security/advisories)
consultados; não foi autenticada a correspondência criptográfica do vendor com um release.

Actions fixadas em commits oficiais, preservando major 4:
[checkout](https://github.com/actions/checkout/commit/11d5960a326750d5838078e36cf38b85af677262)
e [setup-node](https://github.com/actions/setup-node/commit/49933ea5288caeca8642d1e84afbd3f7d6820020).
[Guia oficial de hardening](https://docs.github.com/en/actions/reference/security/secure-use).
[Transações D1.batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
[limites D1](https://developers.cloudflare.com/d1/platform/limits/),
[npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/) e
[Build Output API](https://vercel.com/docs/build-output-api/configuration) foram usados
para conferir contratos, sem consultar endpoints do projeto.

## Pendências externas e limites

- Publicação efetiva, revisões Worker/frontend, migrations remotas, bindings e domínios:
  não verificados. O novo Worker exige schema 14; não executar deploy isolado ou rollback
  antigo que ignore o allocator e as fronteiras de segurança.
- Entrega de e-mail, domínio/DNS, modo mail e custódia/rotação de secrets: não verificados.
  HTTP 2xx significa aceitação pelo provedor, não prova de entrega ao destinatário.
- Ataque distribuído de senha: IP/IP+identidade permanecem limitados; permitir a senha
  correta evita o DoS por e-mail, mas o contador pós-KDF não protege CPU contra muitas
  origens. WAF, quotas e observação da rota real precisam de configuração do operador.
- Cookies cross-site nas origens reais, particularidades dos navegadores, DNS/resolução
  das integrações, carga/CPU e volumes reais: não exercitados em produção.
- Logs do Worker/provedor, CI e hospedagem têm retenção/acesso externos. Links de reset e
  confirmação continuam transitando em URLs; remoção da barra/no-referrer não apagam logs
  de acesso da plataforma. Não foram abertos logs reais.
- Backups, Time Travel, cron, alertas, WAF e quotas ativos: não confirmados. Um restore
  sintético pequeno não demonstra RPO 15 min/RTO 60 min. Ledger de IDs deve fazer parte do backup.
- Firmware ausente. A imagem 18 é ambígua e 20 ilegível; nenhum significado foi inventado.
- Runtime disponível Node 24.18.1; projeto/CI declaram Node 22. Não houve instalação de outro
  runtime; compatibilidade exata com Node 22 depende da execução do CI correspondente.

Testes aprovados e ausência de novos achados nos pontos examinados não demonstram que
o sistema publicado está seguro. Não foi executado pentest externo, fuzzing integral,
teste de carga, nem acesso a dados reais.
