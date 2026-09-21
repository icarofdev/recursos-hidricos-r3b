# Pré-produção: Cloudflare Worker, D1 e Vercel

Este guia descreve a configuração real do backend no Cloudflare Worker, dos bancos D1 separados e do frontend estático na Vercel. PHP, VPS e MQTT legado não participam deste deploy.

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

Depois, consulte `sqlite_master` e o estado de migrations pelos comandos oficiais do Wrangler para confirmar tabelas, índices e triggers. Não altere o schema manualmente.

## 3. Worker: secrets e variáveis

Gere `SESSION_SECRET` e `PASSWORD_PEPPER` de forma criptograficamente aleatória e independente, com pelo menos 32 bytes cada. Digite os valores somente no prompt seguro:

```sh
# Production
node scripts/cloudflare/wrangler.mjs secret put SESSION_SECRET
node scripts/cloudflare/wrangler.mjs secret put PASSWORD_PEPPER
node scripts/cloudflare/wrangler.mjs secret put MONITORIE_JWT

# Preview: secrets independentes
node scripts/cloudflare/wrangler.mjs secret put SESSION_SECRET --env preview
node scripts/cloudflare/wrangler.mjs secret put PASSWORD_PEPPER --env preview
node scripts/cloudflare/wrangler.mjs secret put MONITORIE_JWT --env preview
```

As configurações não secretas ficam em `[vars]` e `[env.preview.vars]` no `wrangler.toml`. Preencha `APP_URL` e `CORS_ORIGINS` somente quando a URL HTTPS estável do frontend correspondente for conhecida; use a origem exata, sem caminho, query, fragmento ou curingas.

| Nome                           | Production                          | Preview                          |
| ------------------------------ | ----------------------------------- | -------------------------------- |
| `APP_ENV`                      | `production`                        | `preview`                        |
| `APP_URL`                      | origem exata do frontend Production | origem exata do frontend Preview |
| `CORS_ORIGINS`                 | mesma origem exata de Production    | mesma origem exata de Preview    |
| `READINGS_RETENTION_DAYS`      | `90`                                | `90`                             |
| `AUDIT_RETENTION_DAYS`         | `180`                               | `180`                            |
| `RETENTION_BATCH_SIZE`         | `500`                               | `500`                            |
| `MONITORIE_CACHE_SECONDS`      | `60`                                | `60`                             |
| `DEVICE_OFFLINE_AFTER_SECONDS` | `90`                                | `90`                             |
| `MONITORIE_MODE`               | `unconfigured`                      | `unconfigured`                   |
| `MAIL_MODE`                    | `disabled`                          | `disabled`                       |
| `INGEST_ENABLED`               | `false`                             | `false`                          |

`/api/ready` só retorna pronto quando as origens, os dois secrets de autenticação e o D1 estiverem utilizáveis. A aplicação falha fechada se `SESSION_SECRET` ou `PASSWORD_PEPPER` estiver ausente/inválido.

### Integrações opcionais

- Brevo: configure `BREVO_API_KEY`, remetente e nome apenas quando houver credenciais reais e remetente verificado; só então altere `MAIL_MODE=brevo` e teste o fluxo completo de redefinição.
- Monitor IE: o JWT de Account > Security é o secret `MONITORIE_JWT`; nunca o configure como variável pública. O Swagger confirma `X-Authorization`, endpoints de leitura, paginação e timestamps UTC em ms. Descubra UUID/keys com `npm run monitorie:probe -- ...`, configure `MONITORIE_SMWU_MAPPING`/`MONITORIE_SMWA_MAPPING` somente com nomes e unidades confirmados e preserve `MONITORIE_MODE=unconfigured` até a validação. O código não faz login/refresh automático e não usa mock fora do desenvolvimento local; veja `docs/MONITORIE.md`.
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
node scripts/cloudflare/admin.mjs set-admin icarofranklin0@gmail.com --remote
```

Confirme no D1 remoto `users.role='admin'` e o evento `audit_logs.action='admin_promoted'`; teste `/admin` com um usuário comum e com o administrador. Não hardcode conta, senha ou papel no código.

## 7. Evidências antes do merge

Registre sem valores secretos: URLs do Preview, nomes/IDs D1, migrations aplicadas, nomes das variáveis configuradas, resultados da suíte e auditoria, status do GitHub Actions, confirmação do admin remoto e pendências externas de Brevo/MonitorIE. O Preview validado pode ser considerado pronto para merge, mas nunca deve ser promovido ou mesclado sem autorização explícita.
