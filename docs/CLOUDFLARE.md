# Pré-produção: Cloudflare Worker, D1 e Vercel

Este guia descreve a configuração real do backend no Cloudflare Worker, dos bancos D1 separados e do frontend estático na Vercel. PHP, VPS e MQTT legado não participam deste deploy.

Para schema 14, siga também [a ordem de publicação e recuperação](OPERATIONS.md).
Antes de migrations remotas, faça backup e suspenda tráfego conforme esse procedimento.

## 1. Princípios de segurança

- Trabalhe em `codex/production-hardening` e valide primeiro um Preview Deployment.
- Não crie bancos D1 se os IDs configurados já pertencerem à conta correta.
- Não apague, resete ou semeie bancos remotos com dados de demonstração.
- Nunca salve secrets em Git, argumentos de CLI ou bundle do frontend. Para validação local, use somente `.dev.vars`, que é ignorado pelo Git, e não compartilhe seu conteúdo.
- Mantenha `MONITORIE_MODE=unconfigured`, `MAIL_MODE=disabled` e `INGEST_ENABLED=false` até cada integração estar realmente provisionada e validada.
- Não promova Preview para Production e não faça merge antes da validação remota completa.

## 2. Conta Cloudflare e bancos D1

Autentique pelo wrapper do projeto e confirme a conta antes de qualquer alteração:

```sh
node scripts/cloudflare/wrangler.mjs login
node scripts/cloudflare/wrangler.mjs whoami
node scripts/cloudflare/wrangler.mjs d1 list
```

O `wrangler.toml` referencia estes recursos:

| Ambiente   | Nome                | ID configurado                         |
| ---------- | ------------------- | -------------------------------------- |
| Production | `hidra-r3b`         | `0148ef8b-e4c4-44d1-b188-0dcd159a23db` |
| Preview    | `hidra-r3b-preview` | `c794e2f5-15ca-4764-af44-58b17b9e225f` |

Compare nome e ID com `d1 list`. Só execute `d1 create` se o recurso estiver ausente ou pertencer a outra conta; nesse caso, atualize apenas o ID correspondente em `wrangler.toml`.

Consulte e aplique migrations sem resetar os bancos:

```sh
# Production
node scripts/cloudflare/wrangler.mjs d1 migrations list DB --remote
node scripts/cloudflare/wrangler.mjs d1 migrations apply DB --remote

# Preview (binding e banco de [env.preview])
node scripts/cloudflare/wrangler.mjs d1 migrations list DB --remote --env preview
node scripts/cloudflare/wrangler.mjs d1 migrations apply DB --remote --env preview
```

As migrations versionadas são:

- `0001_initial.sql`: usuários, sessões, dispositivos, reservatórios, SM-WU, rate limits e settings.
- `0002_admin_devices_smwa.sql`: perfis, administração, ativação, auditoria e SM-WA.
- `0003_ingestion_retention.sql`: idempotência, retenção e `device_credentials`.
- `0004_atomic_audit.sql`: auditoria imutável e gatilhos atômicos.
- `0005_telemetry_cache.sql`: cache/lock de telemetria.
- `0006_device_mac.sql`: MAC normalizado opcional para registros antigos, obrigatório no novo cadastro, com índice único. Preserva códigos internos, ativações, proprietários e vínculos existentes.
- `0007_monitorie_auth_cache.sql`: cache cifrado e lease de login/refresh da MonitorIE; não altera dispositivos, vínculos ou leituras existentes.
- `0008_admin_totp.sql`: autenticadores individuais e desafios TOTP para admins.
- `0009_security_events.sql`: eventos de autenticação e ações administrativas, com retenção limitada pela manutenção.
- `0010_endpoint_requests.sql`: contadores de requisições por endpoint em janelas de cinco minutos, sem IP bruto.
- `0011_device_memberships_geometry.sql`: membros por dispositivo e configuração geométrica.
- `0012_security_boundaries.sql`: prova de e-mail, sessões, gerações de acesso/titularidade, códigos e cache.
- `0013_telemetry_quality.sql`: qualidade da medição, volume/nível nulos quando inválidos e versão 13 do schema.
- `0014_audit_identity_configuration.sql`: identidades duráveis de dispositivo, eventos legados explicitamente não comprovados e versão otimista da configuração; schema 14.

Depois, consulte `sqlite_master` e o estado de migrations pelos comandos oficiais do Wrangler para confirmar tabelas, índices e triggers. Não altere o schema manualmente.

## 3. Worker: secrets e variáveis

Gere `SESSION_SECRET` e `PASSWORD_PEPPER` de forma criptograficamente aleatória e independente, com pelo menos 32 bytes cada. Digite os valores somente no prompt seguro:

```sh
# Production
node scripts/cloudflare/wrangler.mjs secret put SESSION_SECRET
node scripts/cloudflare/wrangler.mjs secret put PASSWORD_PEPPER
node scripts/cloudflare/wrangler.mjs secret put RESEND_API_KEY
node scripts/cloudflare/wrangler.mjs secret put MONITORIE_USERNAME
node scripts/cloudflare/wrangler.mjs secret put MONITORIE_PASSWORD

# Preview: secrets independentes
node scripts/cloudflare/wrangler.mjs secret put SESSION_SECRET --env preview
node scripts/cloudflare/wrangler.mjs secret put PASSWORD_PEPPER --env preview
node scripts/cloudflare/wrangler.mjs secret put RESEND_API_KEY --env preview
node scripts/cloudflare/wrangler.mjs secret put MONITORIE_USERNAME --env preview
node scripts/cloudflare/wrangler.mjs secret put MONITORIE_PASSWORD --env preview
```

As configurações não secretas ficam em `[vars]` e `[env.preview.vars]` no `wrangler.toml`. Preencha `APP_URL` e `CORS_ORIGINS` somente quando a URL HTTPS estável do frontend correspondente for conhecida; use a origem exata, sem caminho, query, fragmento ou curingas.

| Nome                           | Production                          | Preview                          |
| ------------------------------ | ----------------------------------- | -------------------------------- |
| `APP_ENV`                      | `production`                        | `preview`                        |
| `APP_URL`                      | origem exata do frontend Production | origem exata do frontend Preview |
| `CORS_ORIGINS`                 | mesma origem exata de Production    | mesma origem exata de Preview    |
| `READINGS_RETENTION_DAYS`      | `90`                                | `90`                             |
| `AUDIT_RETENTION_DAYS`         | `180`                               | `180`                            |
| `RETENTION_BATCH_SIZE`         | `2000`                              | `2000`                           |
| `RETENTION_MAX_BATCHES`        | `2`                                 | `2`                              |
| `MONITORIE_CACHE_SECONDS`      | `300`                               | `300`                            |
| `DEVICE_OFFLINE_AFTER_SECONDS` | `90`                                | `90`                             |
| `MONITORIE_MODE`               | `live`                              | `live`                           |
| `MONITORIE_SMWU_MAPPING`       | JSON mapeando chaves SM-WU          | JSON mapeando chaves SM-WU       |
| `MONITORIE_SMWA_MAPPING`       | JSON mapeando chaves SM-WA          | JSON mapeando chaves SM-WA       |
| `MAIL_MODE`                    | `disabled` até configurar Resend    | `disabled`                       |
| `MAIL_REQUIRED`                | `true`                              | `false`                          |
| `INGEST_ENABLED`               | `false`                             | `false`                          |

`/api/ready` verifica origens, secrets, formato da chave TOTP, schema 14 e configurações das funcionalidades obrigatórias. Não consulta provedores externos. Com `MAIL_REQUIRED=true` e `MAIL_MODE=disabled`, retorna 503 até o operador configurar recuperação e confirmação. `/api/health` é somente liveness.

### Integrações opcionais

- Resend: configure `RESEND_API_KEY` como secret do Worker e `EMAIL_FROM` como variável não secreta no formato `Hidra R3B <contato@dominio-verificado>` (ou apenas o endereço). No painel da Resend, adicione o domínio em **Domains**, publique os registros DNS indicados para SPF e DKIM, aguarde o status **Verified** e crie uma API key com permissão de envio em **API Keys**. Configure `MAIL_MODE=resend` somente após isso. O Worker usa a API HTTP oficial da Resend para a recuperação de senha; o token não aparece em logs. A resposta de recuperação continua genérica, e a falha de envio invalida o token no D1. O teste automatizado simula a Resend e não verifica entrega real.
- Sem domínio verificado, use apenas o remetente de teste autorizado que aparece no painel do provedor, respeitando as restrições de destinatário. Endereços `example.test` desta documentação são fictícios e não recebem nem enviam mensagens reais. A chave do Worker deve ser adicionada diretamente ao secret privado, sem passar pelo chat.

Os testes automatizados interceptam Resend e não enviam mensagens. Um ensaio real posterior exige autorização, chave privada, remetente autorizado e conta do operador. Configure-os fora de Git; use links locais somente em desenvolvimento. O envio pelo conector não comprova o funcionamento do Worker.

- Monitor IE: configure `MONITORIE_USERNAME` e `MONITORIE_PASSWORD` somente como secrets do Worker. O backend faz login e refresh, mantendo o par de tokens cifrado no D1 pela chave derivada de `SESSION_SECRET`; `MONITORIE_JWT` permanece apenas como alternativa manual se ambas as credenciais estiverem ausentes. O backend percorre a lista e consulta a chave de telemetria `mac` de cada dispositivo para confirmar uma correspondência exata, única e do mesmo modelo antes de vincular a leitura. Configure `MONITORIE_SMWU_MAPPING`/`MONITORIE_SMWA_MAPPING` somente com nomes e unidades confirmados e preserve `MONITORIE_MODE=unconfigured` até a validação; veja `docs/MONITORIE.md`.
- Ingestão local: não existe secret global `DEVICE_TOKENS` no Worker atual. Tokens são provisionados/rotacionados pelo fluxo administrativo, exibidos uma vez e persistidos somente como hash em `device_credentials`. Habilite `INGEST_ENABLED` apenas para dispositivo `source='local'` real e validado.

## 4. Build e frontend Vercel

O build consome exatamente estas variáveis públicas em build-time:

```sh
PUBLIC_API_URL=https://ORIGEM-EXATA-DO-WORKER
PUBLIC_APP_URL=https://ORIGEM-EXATA-DO-FRONTEND
npm run build:production
```

`PUBLIC_API_URL` é gravada em `static/js/config.js`. `PUBLIC_APP_URL` valida a separação entre frontend e API. Ambas devem ser origens HTTPS sem caminho. O build falha se estiverem ausentes, forem iguais, usarem HTTP ou contiverem placeholders inválidos.

A estratégia autoritativa é o Vercel Build Output API v3:

- `scripts/cloudflare/build.mjs` produz `.vercel/output/static` e `.vercel/output/config.json`.
- `.vercel/output/config.json` contém rotas e os headers, inclusive CSP dinâmica com `connect-src 'self' <PUBLIC_API_URL>`.
- `vercel.json` define apenas o framework e `npm run build:production`; ele não redefine `outputDirectory`, rotas ou headers.
- `dist/frontend` é um artefato intermediário para auditoria local e não é a configuração de publicação.

Na Vercel, configure `PUBLIC_API_URL` e `PUBLIC_APP_URL` no ambiente Preview da branch `codex/production-hardening`. Não use `API_BASE`. Como a URL automática de Preview pode mudar, prefira um alias HTTPS estável específico da branch e use exatamente esse alias em `PUBLIC_APP_URL`, `APP_URL` e `CORS_ORIGINS`.

## 5. Deploy e validação

Depois de migrations, variáveis e secrets:

```sh
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build:production
npm run audit

# Worker Production; use --env preview para o Worker Preview
node scripts/cloudflare/wrangler.mjs deploy
node scripts/cloudflare/wrangler.mjs deploy --env preview
```

Valide `/api/health` e `/api/ready`, HTTPS, CORS restrito, preflight, ausência de stack traces, headers de segurança e cookies. Quando frontend e API estiverem em sites diferentes, a implementação usa cookie `HttpOnly; Secure; SameSite=None; Partitioned`; em contexto same-site usa `SameSite=Lax`. Todas as chamadas do frontend usam `credentials: include` e mutações continuam protegidas por Origin e CSRF.

O cron atual roda a cada 10 minutos (`*/10 * * * *`) e chama a manutenção em lotes. Os períodos reais são `READINGS_RETENTION_DAYS` e `AUDIT_RETENTION_DAYS`; teste com dados recentes antes de considerar a retenção validada.

## 6. Admin remoto

Cadastre o usuário normalmente no ambiente remoto antes da promoção. Depois execute a CLI oficial:

```sh
node scripts/cloudflare/admin.mjs set-admin operador@example.test --remote
```

Confirme no D1 remoto `users.role='admin'` e o evento `audit_logs.action='admin_promoted'`; teste `/admin` com um usuário comum e com o administrador. Não hardcode conta, senha ou papel no código.

## 7. Evidências antes do merge

Registre sem valores secretos: URLs do Preview, nomes/IDs D1, migrations aplicadas, nomes das variáveis configuradas, resultados da suíte e auditoria, status do GitHub Actions, confirmação do admin remoto e pendências externas de Resend/MonitorIE. O Preview validado pode ser considerado pronto para merge, mas nunca deve ser promovido ou mesclado sem autorização explícita.

# TOTP individual de administradores

Após aplicar localmente a migration `0008_admin_totp.sql`, configure `TOTP_ENCRYPTION_KEY` como secret do Worker. O valor deve representar 32 bytes aleatórios em base64url (43 caracteres), base64 padrão (44 caracteres com `=` final) ou hexadecimal (64 caracteres). Guarde uma cópia segura fora do repositório: perder ou trocar essa chave impede a leitura dos autenticadores existentes. Para desenvolvimento local, adicione a variável em `.dev.vars` (ignorado pelo Git). No ambiente Cloudflare, configure o secret pelo painel do Worker em **Settings → Variables and Secrets**, sem colocar o valor em `wrangler.toml`. Confira o histórico de migrations de cada banco antes de publicar; se `0008_admin_totp.sql` já foi aplicada, preserve-a e não a reverta.

O papel `admin` continua vindo exclusivamente da coluna `users.role` do D1. Uma sessão criada antes do TOTP, ou uma conta recém-promovida a admin, não acessa `/api/admin/*`. O administrador entra com a senha novamente para receber um desafio válido por cinco minutos. No primeiro acesso, a tela de login exibe um QR gerado localmente no navegador, além da chave para entrada manual. A confirmação do código ativa o autenticador, cria a sessão administrativa e mostra dez códigos de recuperação uma única vez. Guarde-os fora do aparelho autenticador.

Nos próximos logins, a senha abre o desafio e o código TOTP conclui a sessão. Há tolerância de um intervalo de 30 segundos para cada lado do relógio; o mesmo intervalo não pode ser usado novamente. Cada desafio aceita no máximo cinco tentativas, com limites adicionais por IP e conta. Para recuperar o acesso, escolha **Usar código de recuperação** na etapa TOTP do login. Cada código funciona uma vez e inicia o cadastro de um novo autenticador; a sessão administrativa só é liberada após a confirmação do novo código. A rotação revoga as sessões antigas e substitui os códigos de recuperação. Sem autenticador e sem códigos de recuperação, é necessária uma recuperação administrativa fora do aplicativo, com verificação de identidade e intervenção direta no D1; a senha sozinha nunca desativa o TOTP.

O cadastro público devolve a mesma resposta para e-mails novos e já cadastrados e orienta o usuário a entrar. Ele não cria sessão nem envia confirmação de e-mail. Senhas novas e redefinidas seguem a política de caracteres Unicode e a lista local de senhas comuns em `cloudflare/auth/common-passwords.ts`; o login de senhas antigas continua disponível. Falhas de login têm limite por e-mail normalizado em janela fixa de 60 segundos, além dos limites por IP e IP+e-mail. Recusas não prolongam a janela; uma tentativa legítima pode precisar aguardar até 60 segundos.

Todas as mutações em `/api/admin/devices` e a exclusão da própria conta admin exigem TOTP confirmado nos cinco minutos anteriores. O painel solicita o código quando recebe `ADMIN_REAUTH_REQUIRED` e repete a operação uma vez após `POST /api/auth/admin-totp/reauth`; códigos de recuperação não são aceitos nessa etapa. A trilha `security_events` registra tipo, resultado, identificador interno ou pseudônimo da conta e request ID, sem códigos nem tokens. A manutenção usa `AUDIT_RETENTION_DAYS` também para essa tabela. Aplique `0009_security_events.sql` somente no ambiente escolhido durante uma publicação planejada; esta alteração de código não aplica migrations remotas.

O nome `BREVO_API_KEY` não é referenciado pelo Worker atual. Se o secret ainda existir no Cloudflare, remova-o manualmente em **Settings → Variables and Secrets** após conferir que nenhuma versão anterior em uso depende dele. O envio Resend permanece desativado até configurar e validar domínio, remetente e `RESEND_API_KEY`.

O código enviado por e-mail em todo login é um recurso separado e ainda não está implementado.

As validações de código em login, confirmação de cadastro, recuperação e reautenticação usam o mesmo orçamento de dez tentativas por conta em uma janela fixa de cinco minutos. O Worker reserva cada tentativa atomicamente no D1 antes de verificar o código, inclusive sob concorrência; sucesso, troca de IP ou sessão, novo desafio e uso de recuperação não zeram a contagem. A resposta de limite é `429` com `Retry-After`; recusas não aumentam nem prolongam a janela. Os limites adicionais por IP e por desafio continuam ativos. A identidade só entra nesse orçamento após validar a senha/desafio ou uma sessão administrativa com CSRF, para impedir que requisições anônimas bloqueiem uma conta conhecida. O limite usa a tabela `rate_limits` existente e não exige nova migration.

Os testes E2E usam um banco exclusivo por execução em `.runtime/e2e/`, chaves aleatórias em memória e traces desativados para não guardar códigos, cookies ou segredos de cadastro. Eles não leem `.dev.vars`, `.env` nem os secrets do runtime de desenvolvimento.

O build calcula uma revisão SHA-256 apenas de fontes públicas explicitamente selecionadas e grava o mesmo identificador no Worker (`GET /api/health`, campo `revision`) e no frontend (`GET /build-info.json`). Para publicar alterações locais sem commit, registre essa revisão nos metadados dos deployments e confira os dois endpoints depois da publicação; não use apenas o commit base para afirmar que as alterações locais estão publicadas. Publique o frontend pelo artefato local `.vercel/output` para preservar o build validado. Antes de escrever em produção, consulte `d1_migrations` e obtenha um bookmark atual com `wrangler d1 time-travel info` no ID de produção; as migrations `0009` e `0010` são aditivas e só devem ser aplicadas se ainda estiverem pendentes. Uma falha de autorização ou validação no Preview impede avançar para produção.

## Observação de requisições

A migration `0010_endpoint_requests.sql` e o evento estruturado `endpoint_request` permitem identificar caminhos repetidos sem bloquear tráfego. Veja [o guia de observação e as limitações das regras Cloudflare por plano](ENDPOINT_OBSERVATION.md). Confira as migrations aplicadas antes de publicar; este trabalho não aplica migrations remotas nem ativa regras WAF.
