# Relatório de migração e validação local

Data: 15/09/2026. Não houve deploy nem envio de e-mails reais.

Este relatório registra a validação histórica da versão anterior. Desde 29/09/2026, o Worker usa Resend para recuperação de senha; a validação atual está nos testes de integração com provedor simulado. A entrega real pela Resend ainda depende de chave e domínio/remetente verificado.

## Encerramento da validação e publicação — 01/10/2026

**Preview aprovado e produção publicada e conferida.** Este encerramento complementa o checkpoint anterior abaixo. Não foram repetidos a suíte completa nem migrations já registradas. As alterações locais foram preservadas na branch `main`, sem novo commit; o commit base continua `b450d2241e9191938667ee19bb36ea66f32ba243`.

### Validação pendente concluída no Preview

- A API Cloudflare respondeu às consultas e escritas autorizadas no mesmo D1 de Preview `c794e2f5-15ca-4764-af44-58b17b9e225f`. Reconfirmadas `0001–0010`, sem reaplicação.
- Teste focado, usando o frontend e Worker já publicados da revisão anterior: cadastro protegido do autenticador em conta descartável, reautenticação com TOTP válido `200`, CSRF incorreto `419`, código de recuperação recusado na reautenticação `422` e replay recusado `422`.
- O horário de MFA recente foi atualizado pelo próprio endpoint e conferido no D1. Nenhum contador, intervalo TOTP, horário de sessão ou configuração de MFA foi alterado para liberar esse teste. A ação sensível, com corpo vazio, passou pelo gate de MFA e recebeu `422` de validação de negócio, sem criar dispositivo.
- Conferidos eventos persistidos `login_password`, `totp_setup`, `totp_confirm`, `totp_reauth` com sucesso/falha e `admin_device_create` com falha, todos com request ID. A observação de reautenticação registrou método, caminho normalizado, país `BR`, contagem e request ID de 36 caracteres.
- O cadastro público adicional foi recusado com `429` porque o limite por IP dos testes anteriores continuava vigente. Ele foi preservado. Para o teste pendente foi preparada somente uma conta sintética no Preview, com senha configurada pelo fluxo normal de redefinição e credenciais apenas em memória; nenhuma conta real foi modificada. O cadastro público sem confirmação de e-mail e a resposta idêntica para duplicatas já tinham passado na mesma revisão.
- Conta descartável removida. Consulta final confirmou **zero contas de teste restantes**. O teste focado acrescentou 18 requisições aos contadores; a amostra posterior da última hora tinha 59 linhas e 176 requisições agregadas. Essas contagens não são o total de escritas faturadas pelo D1.

### Banco de produção e recuperação

- Confirmados nome `hidra-r3b` e ID `0148ef8b-e4c4-44d1-b188-0dcd159a23db`; histórico inicial `0001–0008`, com as duas novas tabelas ausentes.
- Registrado o ponto anterior às migrations do backup automático [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), bookmark `00000581-00000000-000050f7-20baf0d7bfb95945d3752a1862af67f8`. Não houve exportação de dados de usuários nem restauração.
- `node scripts/cloudflare/wrangler.mjs d1 migrations apply hidra-r3b --remote`: aplicadas somente `0009_security_events.sql` e `0010_endpoint_requests.sql`, nessa ordem. A consulta posterior confirmou `0001–0010`, cada uma registrada uma vez, e ambas as tabelas existentes. SQL permanece em LF.
- O comando de migrations exige o nome/binding do banco e recusou o UUID antes de escrever. Houve também um timeout anterior à aplicação; antes de tentar novamente, consultas confirmaram que nenhuma migration/tabela nova tinha sido criada. Não houve reaplicação.

### Versões e artefatos publicados

- Revisão SHA-256 compartilhada, conferida em `/api/health` e `/build-info.json`: `12c9d21f32aec749c0a34340efc40deba8fe54c09aa341da02ecb0e23d669902`.
- SHA-256 do Worker compilado localmente: `fd081dbf1226a3b3dd216849f5ba5d3c82fd201976df68ae91fbeb4d0e2db0e7`, idêntico ao artefato testado no Preview. Esse é o hash do arquivo compilado; o endpoint público do Worker informa a revisão das fontes.
- Worker de produção: versão `91e4d2df-33e1-4e2d-82f4-54bf17f49268`, deployment `d380af5d-96dd-40ae-973c-2c740536177b`, confirmado com **100% do tráfego**, em `https://hidra-r3b.hidra-r3b-cloudflare.workers.dev`.
- Frontend: `dpl_9zkLmxrXGD1Fdq2JVNP2yXaj4uWE`, `READY`, target `production`, URL imutável `https://frontend-6q2gofv78-synxgms-projects.vercel.app`, promovido e servido em `https://hidra-r3b.vercel.app`.
- Build com origens públicas de produção; publicação Vercel `--prebuilt --prod --skip-domain`, seguida da verificação do artefato, publicação do Worker `--keep-vars` e promoção do frontend. O CLI recebeu metadados de revisão, estado do workspace e commit base.
- **17/17 artefatos conferidos por SHA-256** tanto na URL imutável quanto no domínio principal: seis páginas HTML, marcador JSON de revisão, configuração pública, cinco scripts (incluindo a biblioteca de gráficos) e quatro estilos. A lista exata e os hashes estão nos relatórios locais ignorados em `.runtime/production-immutable-artifacts.json` e `.runtime/production-served-artifacts.json`. A CSP corresponde ao build e permite a API correta de produção.
- Smoke tests públicos: revisão `200`, readiness/D1 `200`, redirecionamento para o frontend correto `302`, origem permitida com credenciais `204` e origem não autorizada `403`. Sem login em produção nem alteração de dados de usuários. Monitorie retornou `configured` na readiness; isso não confirma uma nova autenticação real no serviço externo.
- Confirmada a observação publicada no D1 de produção: cinco requisições de smoke test, país aproximado `BR`, caminhos/métodos normalizados, status e request IDs preenchidos. A consulta foi somente de leitura.

### Comandos, auditoria final e limites

- Novos nesta retomada: teste focado remoto **5 verificações aprovadas**, `npm audit --audit-level=high` **zero vulnerabilidades**, `npm run build:production` aprovado, verificações de artefatos **17/17** em cada URL e smoke tests do Worker **5/5**. O build inicialmente recebeu `EPERM` da sandbox Windows ao iniciar esbuild; a execução autorizada fora da sandbox passou.
- Reutilizados os resultados já concluídos para estas fontes: **81/81** testes, typecheck, lint e formatação aprovados, além dos cenários E2E discriminados no checkpoint anterior. Não houve nova execução integral dessas suítes.
- Revisados diff, estado do Git, exclusão dos arquivos secretos e a revisão das fontes. Varredura das 81 fontes públicas não encontrou os padrões de credenciais de provedor/chave privada examinados. Essa varredura não prova ausência universal de segredos. `.env`, `.dev.vars` e `.runtime` continuam fora dos arquivos versionados; seu conteúdo secreto não foi aberto, copiado ou alterado.
- O transporte local para a API Cloudflare apresentou falhas transitórias. As operações incertas foram verificadas por leitura antes de qualquer nova escrita. A consulta final passou usando IPv4 e timeout de conexão de 30 segundos apenas em um helper local ignorado, com a mesma conta e banco; nenhuma configuração do Worker/MFA foi ajustada.
- `TOTP_ENCRYPTION_KEY`, `SESSION_SECRET` e `PASSWORD_PEPPER` foram confirmados somente por nome em produção. Nenhum secret foi criado, rotacionado ou exposto. `BREVO_API_KEY` ainda existe como secret remoto obsoleto: sua remoção depende do painel Cloudflare e não foi realizada. Não há referência ativa a ele no backend/configuração local.
- TOTP continua somente para admins; cadastro continua sem confirmação de e-mail. Resend permanece preparado com `MAIL_MODE=disabled`. Ativação futura exige `RESEND_API_KEY`, `EMAIL_FROM` e domínio/remetente verificado; nenhum e-mail real foi enviado. Código por e-mail em todo login não foi implementado nesta retomada.
- Não foram feitas regras WAF, teste de carga, login com usuários reais ou auditoria externa completa. Os resultados não constituem garantia de segurança do site. O teste de aceitação com uma conta admin real em produção permanece manual; não há bloqueio restante para a publicação conferida acima.

## Checkpoint de segurança e Preview — 30/09/2026 (execução anterior)

**Produção não foi publicada nesta execução.** O gate de Preview ficou incompleto por falhas intermitentes de transporte do Wrangler. As seções posteriores registram verificações históricas e não confirmam a publicação destas alterações em produção.

### Publicação e banco de Preview

- Branch `main`, HEAD `b450d2241e9191938667ee19bb36ea66f32ba243`, com alterações locais preservadas e sem novo commit.
- Revisão SHA-256 das fontes públicas: `12c9d21f32aec749c0a34340efc40deba8fe54c09aa341da02ecb0e23d669902`.
- D1 de Preview: `c794e2f5-15ca-4764-af44-58b17b9e225f`. Histórico confirmou `0001–0010` aplicadas; nenhuma migration foi reaplicada. Confirmadas as tabelas `rate_limits`, `admin_totp`, `admin_totp_challenges`, `admin_totp_recovery`, `security_events` e `endpoint_requests`.
- Worker de Preview publicado: versão `96ef25bc-c510-4079-92d7-4d0aadf90228`, em `https://hidra-r3b-preview.hidra-r3b-cloudflare.workers.dev`.
- Frontend de Preview publicado na Vercel: deployment `dpl_6qoCJWjxxYaG7cw9b8pM1Dc8isH7`, estado `READY`, em `https://frontend-4gqq1ygdf-synxgms-projects.vercel.app`.
- `/api/health` e `/build-info.json` serviram a mesma revisão. Os artefatos utilizados pelo navegador foram obtidos do deployment protegido via CLI Vercel e comparados com o build preservado. O HTML do dashboard recebeu somente o acréscimo do script de toolbar da Vercel; seu conteúdo original coincide byte a byte com o build. A proteção do deployment e a CSP não foram desativadas.
- `TOTP_ENCRYPTION_KEY` foi confirmada por nome no Worker, sem leitura do valor. O cadastro criptografado do autenticador funcionou. `APP_URL` e CORS de Preview foram ajustados para a origem desse frontend. Foram removidos os valores vazios do arquivo de configuração que poderiam sobrescrever os bindings existentes.

### Verificações executadas

- `npm test`: **81/81**, sem falhas; inclui limites atômicos entre sessões/IPs, aliases, expiração, replay, recuperação, cadastro sem confirmação de e-mail e mocks da Monitorie/Resend.
- `npm run typecheck`, `npm run lint`, `npm run format:check` e `git diff --check`: aprovados.
- `npm run test:e2e`: inicialmente excedeu os 30 segundos de inicialização. O prazo do servidor isolado foi ampliado para 90 segundos. A execução seguinte passou 6/7 cenários; o teste de logout agia antes de o dashboard terminar de carregar a sessão/CSRF. O teste agora aguarda o nome da conta carregado.
- `npm run test:e2e -- --grep "deve registrar sem validar e-mail|deve realizar logout"`: **2/2** após esse ajuste. Com os cinco outros cenários anteriormente aprovados, os sete cenários foram verificados. Não se registra aqui uma execução integral posterior com 7/7.
- Build e revisão publicados em Preview foram conferidos. A normalização SQL para LF foi preservada. `.dev.vars`, `.env` e `.runtime` estão ignorados; nenhum arquivo secreto foi aberto, copiado ou alterado.

No Preview publicado, com contas descartáveis e credenciais mantidas somente em memória:

- Cadastro de conta nova e duplicada com a mesma resposta, sem sessão automática nem confirmação de e-mail.
- Login comum sem MFA, sessão persistente, cookies `Secure`, `HttpOnly`, `SameSite=None`, `Partitioned` e `Path=/`; usuário comum sem acesso admin; logout e recusa de CSRF incorreto.
- Cadastro admin com QR local, confirmação inválida recusada, ativação e exibição única dos códigos de recuperação; nenhum acesso admin antes de concluir o autenticador.
- Login admin com etapa TOTP, código inválido/reutilizado recusado e sessão emitida somente depois da confirmação válida.
- Ação sensível exigindo MFA recente; códigos de recuperação recusados na reautenticação.
- Limite compartilhado por conta atingido, incluindo novas sessões/desafios e o caminho de recuperação. A tentativa bloqueada não consumiu o código de recuperação.
- Expiração natural da janela de cinco minutos, recuperação protegida, troca do segredo e recusa da reutilização do código de recuperação.

A última atualização de horário MFA da sessão descartável via Wrangler falhou com exit code 1 e diagnóstico de transporte, sem indicação de erro de autorização 10000. Por isso a confirmação final de reautenticação válida e o encerramento do gate de Preview ficaram pendentes. Houve também falha transitória na limpeza; a leitura posterior confirmou **zero contas descartáveis restantes**. O fluxo normal do Worker conseguiu escrever no D1 durante os testes, mas o acesso pelo Wrangler não permaneceu estável.

A observação estava ativa no deployment: uma consulta de leitura encontrou 75 linhas agregadas e 219 requisições na última hora. Esta é uma amostra dos contadores, não uma medição do total de escritas faturadas; sessões, rate limits e auditoria também escrevem no D1. Nenhum teste de carga foi realizado.

### Pendências e limites

1. Estabilizar o transporte do Wrangler para a API Cloudflare usando a mesma conta e o D1 de Preview, e concluir a reautenticação válida/CSRF e a revisão dos eventos de auditoria no Preview. Não é necessário fornecer senhas, códigos ou chaves no chat.
2. Só depois do gate completo: conferir novamente o D1 de produção `0148ef8b-e4c4-44d1-b188-0dcd159a23db`, guardar o ponto de recuperação Time Travel, revisar o histórico e aplicar somente `0009–0010` que continuarem pendentes.
3. Publicar Worker e frontend de produção da mesma revisão e conferir versões, hashes e smoke tests sem dados de usuários. Nenhuma dessas operações de produção foi iniciada nesta execução.

TOTP permanece exclusivo para admins; não foi implementada confirmação de e-mail. `MAIL_MODE=disabled` foi preservado, não houve envio real, alteração de chaves criptográficas ou regra WAF. Os resultados acima não representam uma auditoria completa de segurança.

## Implementado

- Cinco páginas preservadas em templates HTML independentes do PHP.
- Dezesseis endpoints de negócio e saúde portados para TypeScript/Pages.
- Snapshot agregado, CSRF, sessões D1 com rotação e expiração, lembrar de mim.
- Cadastro, login/logout, hash com salt/pepper e limites por IP/identidade.
- Recuperação via API Brevo, token SHA-256, validade fixa de 20 minutos,
  consumo atômico, revogação das sessões/tokens anteriores e URL pública HTTPS.
- Pareamento atômico, renomeação/desvinculação, consultas isoladas por proprietário.
- Ingestão HTTPS opcional com credencial individual por dispositivo.
- Compartilhamento opcional HTTP Basic somente leitura, preservando a restrição
  mesmo quando o cookie é reutilizado no modo normal.
- Interface de integração Monitorie, erros controlados, cache positivo/negativo,
  filtragem de histórico por vínculo e simulação restrita ao desenvolvimento local.
- Migrations completas, build com allowlist, secrets locais novos, comandos D1,
  provisionamento administrativo e instruções de publicação em Pages.
- Código/infraestrutura PHP legados preservados fora do artefato de publicação.

## Verificação automatizada

`npm run check`: TypeScript sem erros, build concluído e **17 testes aprovados**.
Executados no runtime workerd via Miniflare com D1 efêmero, aplicando as migrations
reais. A saída externa de e-mail foi interceptada; nenhuma conta externa usada.

1. Banco inicialmente vazio, migrations completas e cinco páginas.
2. Cadastro, hash/salt, cookie seguro, CSRF e logout.
3. Login, lembrar de mim, redirect interno e bloqueio de origem externa.
4. Expiração absoluta/inativa e rotação de sessão.
5. APIs privadas, métodos e validação de entrada.
6. Logout concorrente à rotação de sessão.
7. Rate limit persistente de login e Retry-After.
8. Contrato Brevo simulado, hash do token, URL pública e 20 minutos.
9. Dois resets concorrentes: somente um aceito; todas as sessões revogadas.
10. Token expirado e invalidação quando o envio falha.
11. Dois pareamentos concorrentes, isolamento entre contas e histórico preservado.
12. Monitorie sem configuração: erro controlado/cache negativo, conta acessível.
13. Ingestão autenticada, aliases do firmware e faixas físicas.
14. Mock recusado em URL pública; snapshot reutilizado pelo cache local.
15. URL de recuperação localhost rejeitada e e-mail desativado sem envio.
16. Compartilhamento Basic somente leitura, inclusive ao reutilizar o cookie.
17. Artefato sem PHP, arquivos de ambiente ou chaves utilizadas nos testes.

Também passaram a verificação de sintaxe dos dois scripts do frontend e
`git diff --check` (apenas avisos informativos LF/CRLF do Windows).

## Verificação do fluxo de desenvolvimento

- `npm run db:local`: migration aplicada via Wrangler em D1 local vazio, 24 comandos.
- `npm run dev:seed`: dispositivo mock provisionado com código aleatório/expirável.
- `npm run dev`: Pages/workerd respondendo em `http://127.0.0.1:8788`.
- Pelo navegador: cadastro de conta fictícia, onboarding, validação do código,
  vínculo do reservatório e dashboard com nível, volume, estado e histórico.
- Conferência visual em painel estreito: design responsivo preservado e faixa
  identificando dados simulados. Preview deixado aberto com essa conta local.

O preview contém somente uma conta fictícia e dispositivo simulado. Credenciais
reais, banco PHP existente e seus dados não foram importados nem modificados.
O `.env` legado permanece intacto; a execução Cloudflare não o carrega.

## Validação em Produção Concluída

1. **Monitor IE (telemetria validada):** Mapeamento e telemetria real validados para SM-WU (`d`, `nivel`, `volume`, `rssi_wifi`) e SM-WA (`vazao`, `consumo`, `rssi_wifi`). Modo `live` ativo, cache de 300 segundos e gate D1 de concorrência. O novo fluxo de login e refresh foi testado com respostas simuladas; a rota real de refresh respondeu 401 a um token artificial. O teste bem-sucedido com credenciais reais depende de configurar `MONITORIE_USERNAME` e `MONITORIE_PASSWORD` no backend.
2. **Resend (Pendente de Ativação Real):** `MAIL_MODE=disabled` mantido até configuração de chave, domínio/remetente verificado e aprovação de envio real.
3. **Ingestão Direta:** Mantida desabilitada (`INGEST_ENABLED=false`).
4. **Banco D1 de Produção:** Limpo, sem contas ou dados sintéticos residuais. Apenas usuários e dispositivos reais autorizados.

## Arquivos de referência

- `docs/MIGRATION.md`: inventário e mapeamento completo antes/depois.
- `docs/CLOUDFLARE.md`: publicação, segurança, limites, backups e dados legados.
- `docs/MONITORIE.md`: contrato interno e informações a pedir à IE.
- `docs/LEGACY-PHP.md`: documentação anterior, preservada.

Alterações ficaram no workspace, sem commit automático, sem assinatura de plano
pago e sem apagar o backend/banco anteriores.
