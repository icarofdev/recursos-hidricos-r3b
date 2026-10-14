# Correções locais de segurança e confiabilidade — 13/10/2026

As alterações estão somente na pasta local. Não houve commit, push, merge, deploy,
migration remota, restauração remota ou envio real de e-mail nesta tarefa. O checkout
estava limpo ao começar. A referência anterior é `28242de`, com 11 migrations; não foi
usada a arquitetura antiga com sete migrations para orientar a implementação.

## Resultado e mudanças de comportamento

Foram corrigidas as fronteiras de identidade, acesso temporal, sessões compartilhadas,
ativação e ingestão. A aplicação passa a exigir confirmação de e-mail para receber acesso
como membro e para novas promoções administrativas. Proprietários e administradores
existentes conservam seus vínculos/login; membros antigos precisam confirmar o endereço
antes de voltar a ler. Nenhuma conta existente foi confirmada automaticamente.

Snapshot, histórico e cache respeitam o início do acesso de cada conta e a geração da
titularidade. A exceção de primeira ativação foi retirada porque não há evidência segura
de primeira titularidade física depois de apagamentos ou em dados legados. Credenciais
de ingestão anteriores à troca de titular não funcionam para a nova instalação.

Distância autenticada fora da geometria demonstra comunicação, preserva o valor bruto
e registra volume/nível desconhecidos. Ajustes dentro da tolerância configurada são
identificados por `within_tolerance`. Medições iguais sem identidade de evento são novas
leituras; retransmissões devem usar timestamp ou chave de idempotência estável.

Cache antigo e indisponibilidade da integração geram estado `unknown`, sem inventar
evidência de comunicação nem concluir que o equipamento está offline. A integração
MonitorIE continua com intervalo global de 70 segundos.

## Arquitetura preservada

Frontend estático em HTML/JS, publicado pela Vercel; Worker TypeScript e D1 na Cloudflare.
O Worker autentica sessões, aplica origem/CSRF, autoriza proprietário/membros/admin com
MFA, recebe ingestão opcional e consulta MonitorIE por adapter, trava global e cache.
Resend continua sendo o transporte de recuperação e agora também de confirmação.
Não foram reimplementados MFA, política de senha, escapes de HTML ou auditoria atômica
que já existiam.

## Achados consolidados

“Confirmado” identifica evidência no código anterior ou reprodução indicada. Testes
corretivos verificam o novo comportamento; não provam ausência de outras falhas.

| Achado / gravidade original                                                               | Natureza e evidência                                                      | Situação e solução                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Concessão por e-mail sem prova — alta                                                     | Segurança; confirmado no código de membros                                | **Corrigido:** prova autenticada da mesma conta, token aleatório com hash, 20 minutos, uso único; remetente e destinatário do vínculo precisam estar confirmados.                                                              |
| Nome de pessoa sem vínculo — média                                                        | Privacidade; resposta anterior de concessão                               | **Corrigido:** resposta genérica 202 para alvo válido, ausente ou não confirmado; nome só aparece na lista de vínculos autorizados. Isso não elimina toda diferença de tempo/comportamento de contas já vinculadas.            |
| Promoção de endereço não confirmado — alta                                                | Segurança; scripts/UPDATE permitiam promoção                              | **Corrigido:** script e trigger exigem prova. Administradores já existentes permanecem; atestação excepcional é individual, auditada e exige comprovação externa da caixa postal.                                              |
| Snapshot de titular anterior após exclusão — alta                                         | Segurança; exceção dependia de histórico apagável                         | **Corrigido:** geração durável no dispositivo, acesso em milissegundos, filtro também no cache; teste de exclusão/repareamento usa dados anteriores sintéticos.                                                                |
| Membro removido/readicionado herdando janela — alta                                       | Segurança; confirmado em seleção/cache                                    | **Corrigido:** proprietário e membro têm fronteiras separadas; novo vínculo recebe geração aleatória, cache é invalidado e autorização é rechecada depois de operações assíncronas.                                            |
| Logout read_only impedido — média                                                         | Segurança/confiabilidade; CSRF bloqueava todas as mutações                | **Corrigido:** somente logout aceita read_only, mantendo origem e CSRF. Administração continua bloqueada.                                                                                                                      |
| Compartilhamento ainda válido após mudança — alta                                         | Segurança; cookie não estava ligado à configuração                        | **Corrigido:** versão HMAC da configuração; troca/desativação revoga. Usuário normalmente autenticado não precisa passar pelo login compartilhado.                                                                             |
| Sessão perdida após resposta abortada e polling — média                                   | Operacional; **reproduzido em 28242de** com relógio avançado 75 s         | **Corrigido:** candidato confirmado pelo cliente antes da troca; cookie atual sobrevive à resposta perdida. A tolerância do identificador anterior continua 30 s após confirmação.                                             |
| Códigos divergentes/órfãos ou após apagar emissor — alta                                  | Segurança; API e painel tinham fontes distintas                           | **Corrigido:** código ativo precisa existir na tabela e coincidir com hash/validade no dispositivo; exclusão do emissor revoga; migration reconcilia sem legitimar órfãos; consumo concorrente dá somente um vínculo.          |
| Token de equipamento continuando na nova titularidade — alta                              | Segurança; credencial não tinha geração de titularidade                   | **Corrigido:** geração na credencial e guard transacional; unlink/transfer/claim revogam. Buffer anterior ao novo vínculo é recusado. Firmware precisa de reprovisionamento.                                                   |
| Geometria inválida apagando evidência de comunicação — média                              | Operacional; **reproduzido em 28242de**: 422 autenticado                  | **Corrigido:** distância válida é registrada, com qualidade inválida e volume/nível nulos; last_seen é autenticado, limitado e temporalmente plausível.                                                                        |
| Valores iguais sem timestamp/chave suprimidos — média                                     | Integridade; **reproduzido em 28242de**: segunda leitura não armazenada   | **Corrigido:** eventos sem identidade são distintos; idempotência explícita continua estável e rejeita mesma chave com conteúdo diferente.                                                                                     |
| Orçamento de login reservado depois do KDF — média                                        | Abuso/CPU; confirmado em sequência e concorrência                         | **Corrigido:** reserva atômica por conta antes do KDF, junto aos limites por IP/identidade. Janela fixa curta não é estendida por recusas; terceiros ainda podem provocar indisponibilidade temporária da conta.               |
| Histórico com trabalho ilimitado — média                                                  | Abuso/custo; limite de saída não limitava amostras                        | **Corrigido:** teto de trabalho, SQL/páginas limitados; acima do teto pede janela menor. Limites por usuário, dispositivo e operação.                                                                                          |
| Contenção global virando cache negativo — média                                           | Operacional; confirmado no catch genérico                                 | **Corrigido:** contenção não cria negativo; dado anterior pode voltar com idade/estado, por até 30 min. Fila por dispositivo reduz disputa; não aumenta chamadas externas.                                                     |
| Cache 300 s versus offline 90 s — média                                                   | Operacional; evidências confundidas                                       | **Corrigido:** idade de leitura/cache, checagem de comunicação e falha externa separadas; painel/pareamento usam evidência expirada. `unknown` pode durar até atualização efetiva do provedor.                                 |
| Escrita de observação por cada resposta — média                                           | Abuso/custo; confirmado                                                   | **Corrigido:** ignora anônimas/recusadas/inválidas, amostra sucesso autenticado (1/100); falhas de segurança têm amostra própria (1/20), sucessos e auditoria de mutações permanecem.                                          |
| Retenção operacional incompleta — média                                                   | Operacional/privacidade; tabelas sem limpeza                              | **Corrigido localmente:** limpeza limitada, índices para predicados e backlog por tabela, incluindo códigos, recuperação consumida, sessões, desafios, descobertas e cache. Dimensionamento real depende de quota/volume/cron. |
| Readiness sem schema/chave válida/mail obrigatório — média                                | Operacional; confirmado                                                   | **Corrigido:** exige schema 13, formato TOTP, IDs atuais válidos, origens e serviços obrigatórios configurados. Não consulta provedores no healthcheck. Produção exige mail; enquanto desativado, retorna 503.                 |
| Rotas precoces antes de HTTPS / health duplicado — média                                  | Segurança/manutenção; confirmado                                          | **Corrigido:** exigência HTTPS precede preflight, health e redirects; liveness é única, sem banco; readiness é separada.                                                                                                       |
| Ausência de APP_URL no TOML — hipótese de configuração                                    | Arquivo não prova o binding remoto                                        | **Dependente de configuração externa:** origem canônica agora declarada; bindings realmente publicados e origens do preview não foram inspecionados. MAIL_FROM não era o nome usado: o código usa EMAIL_FROM.                  |
| METRICS sem declaração — baixa                                                            | Operacional; binding era opcional                                         | **Alinhado:** continua opcional/tolerante à ausência; uso real e provisionamento são documentados. Não foi criada instância Analytics Engine.                                                                                  |
| Rotação TOTP/pepper sem transição — média                                                 | Operacional/segurança                                                     | **Corrigido localmente:** IDs v2, uma chave anterior com deadline limitado, re-hash no login, recriptografia lazy/helper local. Rotação de chaves reais e reenrolamento são operações externas não executadas.                 |
| JSON.parse em auditoria, código/MAC/modelo e e-mail em docs — baixa                       | Manutenção/privacidade; confirmado estaticamente                          | **Corrigido:** JSON malformado não derruba painel; device_code é recalculado quando há MAC; documentação não usa endereço pessoal; entrada de segredos sem echo, erros genéricos.                                              |
| Encoding corrompido / assets relativos — hipótese                                         | Busca estática na versão atual                                            | **Não reproduzido** nos arquivos ativos verificados; assets já tinham caminhos absolutos. A tela nova segue o mesmo padrão.                                                                                                    |
| SQL interpolado por entrada da API / XSS nos sinks vistos — hipótese                      | Queries parametrizadas, textContent/escape e URLs validadas já existentes | **Já resolvido nos pontos revisados:** controles preservados; não é afirmação global de ausência de SQLi/XSS.                                                                                                                  |
| Ausência de MFA admin, limites TOTP, revogação de papel/reset — hipótese de versão antiga | Migrations 0008/0009 e testes atuais                                      | **Já resolvido:** MFA individual, reauth recente, orçamento concorrente, replay/recuperação e revogação já estavam implementados. Correção nova trata rotação de chaves/sessão.                                                |
| path-to-regexp 6.3.0 ligado a CVE-2024-52798 — alta alegada                               | Advisory afeta versões anteriores a 0.1.12                                | **Falso positivo para essa associação:** nenhuma atualização baseada nela. Outros advisories foram conferidos separadamente.                                                                                                   |
| Ferramenta de build em dependência runtime — baixa                                        | Manutenção; esbuild em dependencies                                       | **Corrigido:** devDependencies e lock alinhados; Vercel instala dev para compilar. Não houve atualização arbitrária de versões.                                                                                                |
| Backups/alertas ativos presumidos — risco operacional                                     | Não havia OPERATIONS.md nem ferramenta de restauração no checkout         | **Procedimento/ferramenta criados; configuração externa pendente:** SQL sintético restaurado em SQLite descartável, integridade/FKs verificadas; nenhum backup real ou alerta foi ativado.                                     |

## Migrations e compatibilidade

Pontos principais para revisão no código:

- [Confirmação e uso único](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/auth/email-verification.ts:9): `UPDATE users ... EXISTS(token_hash, user_id, expires_at, used_at)`; criação do token confere também o endereço atual.
- [Autorizar acesso e separar janelas](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/db/reservoirs.ts:19): vínculo ativo e membro confirmado; fronteira `MAX(linked_at_ms, access_started_ms)`.
- [Códigos autoritativos](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/db/reservoirs.ts:296): `ac.code_hash=devices.pairing_code_hash AND used_at IS NULL AND revoked_at IS NULL` com validade.
- [Sessão e confirmação da rotação](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/auth/sessions.ts:18): `pending_hash` só promove depois de ser apresentado pelo cliente; `share_version` revoga configuração antiga.
- [Ingestão autenticada](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/ingest.ts:11): `cr.ownership_generation=d.ownership_generation`, revogação e guard no mesmo batch da leitura.
- [Cache](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/monitorie/single-flight.ts:14), [retenção](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/db/maintenance.ts:5) e [readiness](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/worker.ts:181): trabalho/orçamento limitado e estados explícitos.

Somente duas migrations novas: `0012_security_boundaries.sql` e
`0013_telemetry_quality.sql`. As migrations 0001–0011 não foram alteradas.
A 0012 não confirma e-mails legados, invalida sessões compartilhadas antigas, limpa
cache anterior e reconcilia códigos divergentes conservadoramente. A 0013 preserva
IDs/eventos/leituras e permite valores nulos de qualidade inválida; marca schema 13.

O Worker corrigido exige esse schema. Aplicar migrations sob tráfego do Worker antigo
ou voltar ao código anterior não é compatível com as novas garantias. Siga a janela e
o rollback separado de dados/código em OPERATIONS.md.

## Validação e limites

- Uma rodada ampla: 89 testes existentes, 84 passaram inicialmente. Os cinco restantes
  foram corrigidos/ajustados para os novos contratos e **os cinco passaram** em repetição
  pontual. Não foi repetida a suíte inteira.
- 13 cenários novos de remediação: 12 passaram inicialmente; a ingestão revelou precisão
  temporal de last_seen, corrigida e aprovada no teste pontual. Alterações posteriores
  de e-mail/schema/retencão/ingestão/readiness foram novamente verificadas somente nos
  caminhos afetados. Reproduções do código anterior não usam arquivos de segredos.
- Quatro testes de geometria passaram, inclusive tolerância explícita. Três E2E locais
  passaram: administração com MFA e duas verificações da tela de confirmação, incluindo
  viewport móvel. E-mail nessa tela é simulado; não houve entrega real.
- Build Worker/frontend, TypeScript Worker/frontend, ESLint e verificações de formato.
  O typecheck frontend cobre os módulos definidos no tsconfig; outros JS passaram por
  lint/parser/build e os fluxos de navegador indicados, não por typecheck integral.
- Runtime Workers/D1 local (Miniflare), migrations em banco vazio e upgrade com dados de
  schema 11, sem auto-confirmação e preservando admin/MFA/sessões normais/leituras; FKs
  verificadas. Restauração de SQL sintético em SQLite temporário: integridade OK, nenhuma
  violação FK; ATTACH rejeitado. Não foi ensaiado restore de um dump real ou grande.
- Subprocessos Miniflare/esbuild e temporários Python precisaram da execução local fora
  do sandbox restrito. Nenhuma chamada autorizada de teste atingiu Resend/MonitorIE reais.
  Ambiente disponível: Node 24.18, embora projeto/CI peçam Node 22; CI nesse runtime ainda
  precisa confirmar compatibilidade. Testes não substituem teste de carga/CPU do Worker.
- Não foram verificados produção, cookies cross-site em origens públicas/navegadores
  reais, entrega/DNS Resend, quota D1, cron publicado, WAF, alertas, backups existentes,
  permissões de serviços ou firmware físico. INGEST_ENABLED permanece false no TOML.
  O smoke live legado foi alinhado ao MFA/reauth e às contas sintéticas isoladas; teve
  somente validação estática, pois executá-lo acionaria a integração real.

## Dependências: evidências e limitação

A consulta bulk de advisories ao registry npm não completou por restrição de rede, mesmo
na tentativa autorizada fora do sandbox. Não há resultado válido de auditoria completa
nem declaração de “zero vulnerabilidades”. Versões instaladas foram comparadas ao lock;
fontes primárias foram consultadas sem varrer ou testar serviços do projeto.

| Componente efetivo                    | Escopo                  | Conferência específica                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| path-to-regexp 6.3.0                  | transitivo dev          | Fora do intervalo de [GHSA-rhx6-c78j-4q9w](https://github.com/advisories/GHSA-rhx6-c78j-4q9w); 6.3.0 também é patch indicado em [GHSA-9wv6-86v2-598j](https://github.com/pillarjs/path-to-regexp/security/advisories/GHSA-9wv6-86v2-598j).                                                                         |
| esbuild 0.28.2 e transitivo 0.28.1    | build/dev               | Após patches 0.25.0 e 0.28.1: [CORS](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99), [Windows](https://github.com/evanw/esbuild/security/advisories/GHSA-g7r4-m6w7-qqqr), [Deno](https://github.com/evanw/esbuild/security/advisories/GHSA-gv7w-rqvm-qjhr). Projeto usa Node, não Deno. |
| Wrangler 4.115.0                      | dev/CI                  | Após patch 4.59.1 de [injeção de comando](https://github.com/cloudflare/workers-sdk/security/advisories/GHSA-36p8-mvp6-cv38).                                                                                                                                                                                      |
| Undici 7.30.0                         | transitivo dev          | Após patch 7.29.1 de [cookies em cache](https://github.com/nodejs/undici/security/advisories/GHSA-2jfj-6hjv-fm6j); lista recente do mantenedor consultada, sem alegar cobertura exaustiva.                                                                                                                         |
| Miniflare 4.20260730.0 / 4.20260722.1 | testes/dev              | Versões efetivas registradas; ausência de resultado bulk deixa pendente cobertura automática integral de transitivos.                                                                                                                                                                                              |
| qrcode 1.5.4                          | frontend/runtime bundle | [Mantenedor sem advisories publicados na consulta](https://github.com/soldair/node-qrcode/security/advisories); isso não prova ausência de falhas.                                                                                                                                                                 |
| Chart.js 4.5.1                        | vendorizado no frontend | Identificado no arquivo; consulta de advisories teve disponibilidade variável. Sem mudança de versão sem evidência aplicável; não foi tratado como auditado pelo npm.                                                                                                                                              |

## Ordem de publicação e pendências externas

Consulte OPERATIONS.md para comandos e recuperação. Prioridade e esforço aproximado
para o operador revisar/ativar o resultado, sem contar espera de DNS ou firmware:

| Prioridade | Ação restante                                                                                                                          | Estimativa                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| P0         | Backup privado + ensaio em staging, janela de manutenção, migrations 0012 → 0013, Worker e frontend correspondentes                    | 2–4 h                     |
| P0         | Configurar Resend/remetente/MAIL_MODE e conferir APP_URL/CORS; readiness precisa ficar pronto antes de liberar                         | 1–3 h + DNS               |
| P0         | Confirmar e-mails de administradores existentes e orientar membros suspensos; não fazer verificação em massa                           | 30–60 min + contas        |
| P1         | Reprovisionar credencial de cada equipamento local após novo vínculo, com TOTP recente; manter ingestão pública desativada nesta etapa | 15–45 min por equipamento |
| P1         | Conferir cookies nas origens reais, cron/quotas/backlog, configurar WAF e alertas na rota efetiva                                      | 2–4 h                     |
| P1         | Cofre e plano de rotação/recuperação, ensaio de recriptografia e inventário de contas ainda antigas                                    | 2–4 h                     |
| P2         | Repetir audit completo em rede permitida/CI Node 22, revisar transitivos e Chart.js, teste de carga/CPU                                | 1–3 h                     |
| P2         | Agendar backup cifrado, retenção de logs/backups e ensaio periódico de RPO/RTO                                                         | 2–4 h                     |

Nenhum desses serviços foi ativado apenas porque existe documentação. Os objetivos
propostos RPO 15 min/RTO 60 min precisam ser medidos no ambiente real. Os testes locais
reduzem risco nas fronteiras verificadas; não permitem declarar o projeto seguro.

## Arquivos alterados

O inventário abaixo inclui os arquivos novos e os modificados; artefatos gerados em
dist e arquivos temporários de teste não são fonte versionada.

- [cloudflare/admin/credentials.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/admin/credentials.ts)
- [cloudflare/admin/monitorie-association.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/admin/monitorie-association.ts)
- [cloudflare/admin/mutations.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/admin/mutations.ts)
- [cloudflare/admin/routes.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/admin/routes.ts)
- [cloudflare/auth/crypto.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/auth/crypto.ts)
- [cloudflare/auth/email-verification.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/auth/email-verification.ts)
- [cloudflare/auth/key-window.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/auth/key-window.ts)
- [cloudflare/auth/rate-limit.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/auth/rate-limit.ts)
- [cloudflare/auth/routes.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/auth/routes.ts)
- [cloudflare/auth/security-events.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/auth/security-events.ts)
- [cloudflare/auth/sessions.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/auth/sessions.ts)
- [cloudflare/auth/totp-rotation.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/auth/totp-rotation.ts)
- [cloudflare/auth/totp-routes.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/auth/totp-routes.ts)
- [cloudflare/auth/totp.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/auth/totp.ts)
- [cloudflare/db/errors.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/db/errors.ts)
- [cloudflare/db/maintenance.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/db/maintenance.ts)
- [cloudflare/db/reservoirs.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/db/reservoirs.ts)
- [cloudflare/device-status.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/device-status.ts)
- [cloudflare/history.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/history.ts)
- [cloudflare/http.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/http.ts)
- [cloudflare/ingest.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/ingest.ts)
- [cloudflare/mail/index.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/mail/index.ts)
- [cloudflare/migrations/0012_security_boundaries.sql](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/migrations/0012_security_boundaries.sql)
- [cloudflare/migrations/0013_telemetry_quality.sql](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/migrations/0013_telemetry_quality.sql)
- [cloudflare/monitorie/cache.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/monitorie/cache.ts)
- [cloudflare/monitorie/protocol.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/monitorie/protocol.ts)
- [cloudflare/monitorie/single-flight.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/monitorie/single-flight.ts)
- [cloudflare/observability/endpoint-requests.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/observability/endpoint-requests.ts)
- [cloudflare/reservoir-volume.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/reservoir-volume.ts)
- [cloudflare/telemetry.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/telemetry.ts)
- [cloudflare/types.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/types.ts)
- [cloudflare/worker.ts](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/cloudflare/worker.ts)
- [docs/CLOUDFLARE.md](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/docs/CLOUDFLARE.md)
- [docs/ENDPOINT_OBSERVATION.md](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/docs/ENDPOINT_OBSERVATION.md)
- [docs/OPERATIONS.md](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/docs/OPERATIONS.md)
- [docs/REMEDIATION.md](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/docs/REMEDIATION.md)
- [package-lock.json](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/package-lock.json)
- [package.json](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/package.json)
- [README.md](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/README.md)
- [scripts/cloudflare/admin.mjs](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/scripts/cloudflare/admin.mjs)
- [scripts/cloudflare/attest-email.mjs](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/scripts/cloudflare/attest-email.mjs)
- [scripts/cloudflare/build.mjs](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/scripts/cloudflare/build.mjs)
- [scripts/cloudflare/config.mjs](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/scripts/cloudflare/config.mjs)
- [scripts/cloudflare/local-db.mjs](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/scripts/cloudflare/local-db.mjs)
- [scripts/cloudflare/monitorie-live-smoke.mjs](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/scripts/cloudflare/monitorie-live-smoke.mjs)
- [scripts/cloudflare/provision.mjs](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/scripts/cloudflare/provision.mjs)
- [scripts/cloudflare/put-secret.mjs](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/scripts/cloudflare/put-secret.mjs)
- [scripts/cloudflare/restore-check.py](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/scripts/cloudflare/restore-check.py)
- [scripts/cloudflare/rotate-totp-local.mjs](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/scripts/cloudflare/rotate-totp-local.mjs)
- [scripts/cloudflare/secret-input.mjs](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/scripts/cloudflare/secret-input.mjs)
- [static/js/admin.js](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/static/js/admin.js)
- [static/js/dashboard.js](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/static/js/dashboard.js)
- [static/js/dashboard/model.js](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/static/js/dashboard/model.js)
- [static/js/dashboard/screens.js](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/static/js/dashboard/screens.js)
- [static/js/email-verification.js](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/static/js/email-verification.js)
- [tests/cloudflare/app.test.mjs](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/tests/cloudflare/app.test.mjs)
- [tests/cloudflare/monitorie-protocol.test.mjs](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/tests/cloudflare/monitorie-protocol.test.mjs)
- [tests/cloudflare/remediation.test.mjs](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/tests/cloudflare/remediation.test.mjs)
- [tests/cloudflare/reservoir-volume.test.mjs](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/tests/cloudflare/reservoir-volume.test.mjs)
- [tests/e2e/email-verification.spec.mjs](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/tests/e2e/email-verification.spec.mjs)
- [tests/e2e/helpers.mjs](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/tests/e2e/helpers.mjs)
- [vercel.json](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/vercel.json)
- [web/admin.html](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/web/admin.html)
- [web/index.html](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/web/index.html)
- [web/verify-email.html](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/web/verify-email.html)
- [wrangler.toml](C:/Users/Ícaro/Downloads/recursos-hidricos-r3b/wrangler.toml)
