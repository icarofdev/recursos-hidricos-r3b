# Hidra R3B — Vercel + Cloudflare Worker + Cloudflare D1

Sistema de monitoramento e gestão de recursos hídricos para medidores SM-WU (nível de reservatórios) e SM-WA (hidrômetros).
Dashboard web preservado, arquitetura serverless moderna, sem dependência de PHP, VPS, Apache/Nginx ou subscribers MQTT locais.

```text
Navegador → Frontend Estático (Vercel)
          → API REST (Cloudflare Worker) → Cloudflare D1 (contas, sessões, vínculos, telemetria)
                                        → Adaptador Monitorie (ThingsBoard PE com single-flight gate e cache)
                                        → Brevo (recuperação de senha transacional)
```

**Estado da integração Monitor IE:** o contrato REST ThingsBoard 3.6.4 PE e o uso de JWT via `X-Authorization` estão implementados. A ativação real continua **fail-closed** até confirmar, pela consulta read-only, o UUID, as keys e as unidades de cada medidor. O token fica somente em `MONITORIE_JWT`; não há login ou refresh automático.

---

## Arquitetura Canônica

1. **Frontend (Vercel):**
   - HTML5 semântico, CSS moderno com variáveis e temas (Claro/Escuro/Auto), JavaScript modular puro (sem frameworks pesados).
   - Build estático otimizado gerado em `dist/frontend` e publicado exclusivamente pelo Build Output API em `.vercel/output/`.
   - `PUBLIC_API_URL` e `PUBLIC_APP_URL` são obrigatórias no build de produção; a CSP gerada permite `connect-src` somente para a origem HTTPS exata da API.
   - Cabeçalhos estritos de segurança HTTP (CSP, X-Content-Type-Options, Referrer-Policy).
2. **Backend & API (Cloudflare Worker):**
   - Implementado em TypeScript, empacotado em `dist/worker/index.js`.
   - Roteamento nativo com validação rigorosa de entradas, CSRF tokens por sessão, rate limits por IP e identidade.
   - Autenticação com PBKDF2-SHA256 (100.000 iterações + pepper) e sessões criptográficas em cookies `HttpOnly`, `Secure`, `SameSite=Lax`.
3. **Banco de Dados (Cloudflare D1):**
   - Banco relacional SQLite distribuído na borda (`hidra-r3b`, binding `DB`).
   - Migrations versionadas (`cloudflare/migrations/0001` a `0005`).
   - Integridade referencial com foreign keys, triggers de atomicidade e trilha de auditoria imutável.
4. **Isolamento de Legado:**
   - O código legado em PHP, scripts de VPS e subscribers MQTT permanecem preservados em suas pastas históricas, mas estão **estritamente excluídos** do build e deploy de produção.

---

## Execução Local e Desenvolvimento

### Pré-requisitos

- Node.js 22+ (conforme `.nvmrc`) e npm.
- Nenhuma conta externa ou credencial de produção é necessária para rodar e testar localmente.

### Instalação e Inicialização

```sh
# 1. Instalar dependências
npm ci

# 2. Aplicar migrations no D1 local
npm run db:local

# 3. Criar dados de demonstração (dispositivo mock de teste)
npm run dev:seed

# 4. Iniciar servidores de desenvolvimento (Frontend + Worker API)
npm run dev
```

O comando `npm run dev` inicia:

- **Frontend:** `http://127.0.0.1:8788`
- **Worker API:** `http://127.0.0.1:8787`

Se preferir rodar os serviços separadamente:

```sh
npm run dev:api       # Inicia somente o Cloudflare Worker local
npm run dev:frontend  # Inicia somente o servidor frontend local
```

Para descobrir dispositivos/keys e validar o fluxo real com um JWT guardado em `.dev.vars`, use `npm run monitorie:probe -- ...` e `npm run dev:monitorie`; consulte [a documentação da Monitor IE](docs/MONITORIE.md). O modo comum continua sem acesso à rede externa.

### Bootstrap Administrativo

Para promover um usuário a administrador no ambiente local ou remoto:

```sh
# Promover usuário no banco local
node scripts/cloudflare/admin.mjs set-admin seu_email@dominio.com

# Promover usuário no D1 de produção (requer login Wrangler prévio)
node scripts/cloudflare/admin.mjs set-admin seu_email@dominio.com --remote
```

---

## Testes e Verificação de Qualidade

A suíte de testes abrange verificação estática de tipos, linting, formatação, testes unitários e de integração no runtime do Cloudflare Worker (Miniflare), e testes ponta a ponta (E2E) com Playwright.

```sh
# Verificação estática de tipos (TypeScript Worker e Frontend)
npm run typecheck

# Análise de linting (ESLint 9 flat config)
npm run lint

# Verificação de formatação de código
npm run format:check

# Formatação automática
npm run format

# Testes de integração do Worker e D1 (45 testes)
npm test

# Testes ponta a ponta (Playwright E2E)
npm run test:e2e

# Auditoria de segurança de dependências
npm run audit

# Pipeline completa de validação local
npm run check
```

---

## Documentação Detalhada

- [Publicação e Configuração na Cloudflare](docs/CLOUDFLARE.md)
- [Protocolo, Contrato e Pendências da MonitorIE](docs/MONITORIE.md)
- [Inventário e Decisões de Migração](docs/MIGRATION.md)
- [Documentação PHP/VPS Legada Preservada](docs/LEGACY-PHP.md)
