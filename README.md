# Hidra R3B — Cloudflare Pages + D1

Dashboard existente preservado, backend TypeScript serverless. Funciona sem PHP,
VPS, Nginx, subscriber MQTT ou computador ligado após a publicação.

```text
Navegador → Pages/Worker → D1 (contas, sessões, vínculos)
                       → adaptador Monitorie (telemetria com cache)
                       → Brevo (recuperação de senha)
```

**Estado:** integração real da Monitorie depende da documentação da IE Tecnologias.
O modo local oferece telemetria claramente simulada. Não há endpoints remotos
inventados. Brevo está implementado, mas o envio permanece desativado por padrão.

## Executar localmente

Requer Node.js 22+ e npm. Não precisa de conta Cloudflare para os testes locais.

```sh
npm ci
npm run db:local
npm run dev:seed
npm run dev
```

Abra `http://127.0.0.1:8788`, crie uma conta e use o código de pareamento exibido
pelo seed. O seed não cria usuários/senhas de exemplo. O código vale 24 horas;
não sobrepõe um dispositivo já vinculado. O dispositivo de demonstração gera
leituras simuladas a partir do momento do vínculo.

`npm run dev` cria `.dev.vars` com secrets locais novos se o arquivo não existir.
Não copia nem lê as credenciais do `.env` PHP. Não envie este arquivo ao Git.
Se criar `.dev.vars` manualmente, preencha SESSION_SECRET e PASSWORD_PEPPER com
segredos aleatórios independentes (32 bytes ou mais). O modelo lista somente nomes.
O envio de e-mails fica explicitamente desligado no comando de desenvolvimento.

## Verificar

```sh
npm run check
```

Compila TypeScript e o Worker, aplica migrations em D1 vazio/efêmero e executa
testes HTTP no workerd/Miniflare. Chamadas Brevo são interceptadas, sem envio real.
O banco de desenvolvimento, o `.env` existente e contas externas não são usados
pelos testes.

## Publicar depois da autorização

Leia [o guia Cloudflare](docs/CLOUDFLARE.md), incluindo o provisionamento do D1,
secrets novos, ambiente de produção e publicação de `dist/` em `*.pages.dev`.
Nenhum comando de desenvolvimento ou teste faz deploy.

- [Inventário, rotas e decisões de migração](docs/MIGRATION.md)
- [Contrato interno e pendências Monitorie](docs/MONITORIE.md)
- [Modelo sem valores secretos](.dev.vars.example)
- [Migrations D1](cloudflare/migrations/0001_initial.sql)
- [Documentação PHP/VPS preservada como legado](docs/LEGACY-PHP.md)

## Estrutura ativa

- `web/`: templates HTML extraídos da interface existente, sem PHP.
- `static/`: CSS responsivo, JavaScript e Chart.js preservados.
- `cloudflare/worker.ts`: roteamento Pages em modo avançado.
- `cloudflare/auth/`: hash, sessões, CSRF, abuso e recuperação.
- `cloudflare/db/`: autorização, vínculos, migrations e limpeza de sessões expiradas.
- `cloudflare/mail/`: Brevo, com URL pública obrigatória.
- `cloudflare/monitorie/`: contrato, adaptador pendente, mock local e cache.
- `scripts/cloudflare/`: build, ambiente local, provisionamento administrativo.
- `tests/cloudflare/`: testes reais do runtime/D1 local.

Os diretórios `api/`, `src/`, `config/`, `includes/`, `mqtt/`, `deploy/`, arquivos
PHP da raiz e scripts anteriores são **legados preservados**. O build usa uma
lista explícita de arquivos permitidos; nenhum deles é publicado.
