# Publicação na Cloudflare (Worker + D1) & Frontend Vercel

Guia de configuração e publicação da API serverless e banco de dados distribuído na Cloudflare, com frontend estático hospedado na Vercel.

---

## 1. Arquitetura Canônica

- **Backend / API:** Cloudflare Worker em TypeScript compilado para `dist/worker/index.js`.
- **Banco de Dados:** Cloudflare D1 (banco relacional SQLite distribuído na borda, binding `DB`).
- **Frontend:** Arquivos estáticos HTML/JS/CSS hospedados na Vercel (`.vercel/output/` e `dist/frontend`).
- **Comunicação:** Chamadas REST seguras via HTTPS com cookies `HttpOnly`, `SameSite=Lax`, verificação de CSRF tokens e cabeçalhos CORS restritos (`CORS_ORIGINS`).
- **Legado isolado:** Os componentes legados em PHP, Apache e MQTT não são publicados nem empacotados.

---

## 2. Provisionamento do Banco Cloudflare D1

Para configurar o banco remoto em sua conta Cloudflare:

```sh
# 1. Autenticar no Wrangler
node scripts/cloudflare/wrangler.mjs login

# 2. Criar a base de dados D1
node scripts/cloudflare/wrangler.mjs d1 create hidra-r3b
```

O comando retornará o `database_id` gerado pela Cloudflare.
Abra o arquivo `wrangler.toml` e atualize o campo correspondente:

```toml
[[d1_databases]]
binding = "DB"
database_name = "hidra-r3b"
database_id = "<COLE_O_DATABASE_ID_AQUI>"
migrations_dir = "cloudflare/migrations"
```

Em seguida, aplique todas as migrações no banco remoto:

```sh
node scripts/cloudflare/wrangler.mjs d1 migrations apply DB --remote
```

As migrações aplicam:

- `0001_initial.sql`: Esquema base (usuários, sessões, dispositivos, reservatórios, telemetria, logs).
- `0002_fix_device_source_check.sql`: Ajuste nos tipos de fontes aceitos (`monitorie`, `local`, `mock`).
- `0003_ingestion_retention.sql`: Índices para retenção em lote e tabela de credenciais de dispositivos.
- `0004_atomic_audit.sql`: Triggers de imutabilidade e proteção atômica de auditoria.
- `0005_telemetry_cache.sql`: Tabela de telemetria agregada e cache com single-flight lock.

---

## 3. Configuração de Secrets e Variáveis de Ambiente

Configure os secrets no Cloudflare Worker utilizando o prompt seguro do Wrangler. **Nunca** insira segredos reais no `wrangler.toml`, no código-fonte ou no controle de versão.

```sh
# Chave de criptografia de sessão (mínimo 32 bytes aleatórios)
node scripts/cloudflare/wrangler.mjs secret put SESSION_SECRET

# Pepper para o hash PBKDF2 de senhas (mínimo 32 bytes aleatórios)
node scripts/cloudflare/wrangler.mjs secret put PASSWORD_PEPPER

# URL canônica do frontend na Vercel (ex.: https://hidra.sua-organizacao.vercel.app)
node scripts/cloudflare/wrangler.mjs secret put APP_URL

# Origens permitidas para CORS (separadas por vírgula)
node scripts/cloudflare/wrangler.mjs secret put CORS_ORIGINS

# Credenciais Brevo (apenas quando o envio real de e-mails for aprovado)
node scripts/cloudflare/wrangler.mjs secret put BREVO_API_KEY
node scripts/cloudflare/wrangler.mjs secret put BREVO_SENDER_EMAIL
node scripts/cloudflare/wrangler.mjs secret put BREVO_SENDER_NAME

# Credenciais MonitorIE (somente após fornecimento formal pela IE Tecnologia)
node scripts/cloudflare/wrangler.mjs secret put MONITORIE_BASE_URL
node scripts/cloudflare/wrangler.mjs secret put MONITORIE_CREDENTIALS

# Tokens de dispositivos para ingestão direta (JSON opcional)
node scripts/cloudflare/wrangler.mjs secret put DEVICE_TOKENS
```

### Resumo das Variáveis e Modos de Operação

| Variável                       | Descrição                                                     | Padrão / Recomendado                   |
| ------------------------------ | ------------------------------------------------------------- | -------------------------------------- |
| `ENVIRONMENT`                  | Ambiente de execução (`production`, `preview`, `local`)       | `production`                           |
| `MONITORIE_MODE`               | Modo da integração MonitorIE (`unconfigured`, `live`, `mock`) | `unconfigured` (fail-closed)           |
| `MAIL_MODE`                    | Modo de envio de e-mails (`disabled`, `brevo`, `mock`)        | `disabled` (até validação de produção) |
| `INGEST_ENABLED`               | Habilita rota de ingestão direta de telemetria                | `true`                                 |
| `DEVICE_OFFLINE_AFTER_SECONDS` | Janela para considerar dispositivo offline                    | `90`                                   |
| `RETENTION_DAYS`               | Dias de retenção histórica de telemetria bruta                | `90`                                   |

---

## 4. Publicação do Backend (Cloudflare Worker)

Após compilar o projeto em modo de produção:

```sh
# Gerar bundle otimizado (Worker em dist/worker/index.js e frontend em dist/frontend)
npm run build:production

# Fazer o deploy do Worker na Cloudflare
node scripts/cloudflare/wrangler.mjs deploy
```

O Worker ficará acessível no subdomínio atribuído pela Cloudflare (ex.: `https://hidra-r3b.<seu-usuario>.workers.dev`) ou no domínio customizado configurado na Cloudflare.

---

## 5. Publicação do Frontend na Vercel

O frontend estático é compilado durante o build para a pasta `.vercel/output/static` e `dist/frontend`.

1. Conecte o repositório à Vercel.
2. Configure o framework preset como **Other** (ou Static).
3. Diretório de Build / Output:
   - Build Command: `npm run build:production`
   - Output Directory: `dist/frontend` (ou utilize o `vercel.json` na raiz que já define o routing e headers estritos).
4. No painel da Vercel, defina a variável de ambiente:
   - `API_BASE`: URL pública do seu Cloudflare Worker (ex.: `https://hidra-r3b.<seu-usuario>.workers.dev`).
5. Assegure que a URL do frontend na Vercel esteja cadastrada no `CORS_ORIGINS` e `APP_URL` do Cloudflare Worker.

---

## 6. Rotinas de Retenção e Manutenção Automática

O arquivo `wrangler.toml` define um cron trigger para execução de rotinas de manutenção:

```toml
[triggers]
crons = ["0 3 * * *"]  # Executa diariamente às 03:00 UTC
```

Durante a execução agendada (`scheduled` event no Worker):

1. **Limpeza de Sessões:** Remove sessões expiradas da tabela `sessions`.
2. **Limpeza de Rate Limits:** Exclui registros temporários de limites de requisição.
3. **Retenção de Telemetria:** Executa exclusão em lotes limitados (`RETENTION_BATCH_SIZE = 500`) de leituras brutas anteriores ao período configurado (`RETENTION_DAYS`), evitando ultrapassar os limites de escrita e tempo de execução do D1.

---

## 7. Limites do Plano Gratuito da Cloudflare

- **D1 Database:** 500 MB por banco de dados, 5 milhões de leituras/dia, 100.000 escritas/dia.
- **Workers:** 100.000 requisições/dia por conta, limite de 10ms de CPU por invocação em plano gratuito.
- O sistema utiliza hashing PBKDF2 com 100.000 iterações (limite nativo seguro do WebCrypto).
- Consultas de snapshot utilizam cache em memória/D1 com clamp de 60 segundos por dispositivo para evitar esgotamento de cotas.
