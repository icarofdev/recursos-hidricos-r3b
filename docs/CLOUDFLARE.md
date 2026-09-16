# Publicação na Cloudflare sem VPS

## 1. Preparação

O alvo é Pages em modo avançado (`dist/_worker.js`), com D1 no binding `DB`.
O HTML/CSS/JS existente é mantido. A raiz do repositório nunca é diretório público.
Use Node.js 22+, `npm ci` e `npm run check` antes de publicar.

Os comandos abaixo são para uma futura publicação autorizada. A migração/testes
locais não executam nenhum deles automaticamente. Evite ligar integração Git
antes de conferir as configurações: novos pushes podem gerar deploy automático.

## 2. Conta, D1 e migrations

```sh
node scripts/cloudflare/wrangler.mjs login
node scripts/cloudflare/wrangler.mjs d1 create hidra-r3b
```

Substitua somente `database_id` em `wrangler.toml` pelo ID retornado. O nome e
binding são `hidra-r3b` / `DB`. O ID não é segredo; o placeholder atual só serve
ao ambiente local. Inicialize o banco remoto novo:

```sh
node scripts/cloudflare/wrangler.mjs d1 migrations apply DB --remote
node scripts/cloudflare/wrangler.mjs pages project create hidra-r3b
```

Se o nome Pages já estiver ocupado, use outro e ajuste `name` no TOML. O domínio
atribuído será `NOME.pages.dev`; não é necessário comprar domínio.

## 3. Secrets e variáveis

Em Workers & Pages → projeto → Settings → Variables and Secrets, configure os
ambientes Production e Preview separadamente. Use tipo **Secret** para todas
as credenciais e dados de remetente. Nunca os salve em `[vars]`, frontend ou Git.
Também é possível usar o prompt seguro do CLI, por exemplo:

```sh
node scripts/cloudflare/wrangler.mjs pages secret put SESSION_SECRET --project-name hidra-r3b
node scripts/cloudflare/wrangler.mjs pages secret put PASSWORD_PEPPER --project-name hidra-r3b
node scripts/cloudflare/wrangler.mjs pages secret put BREVO_API_KEY --project-name hidra-r3b
node scripts/cloudflare/wrangler.mjs pages secret put BREVO_SENDER_EMAIL --project-name hidra-r3b
node scripts/cloudflare/wrangler.mjs pages secret put BREVO_SENDER_NAME --project-name hidra-r3b
node scripts/cloudflare/wrangler.mjs pages secret put APP_URL --project-name hidra-r3b
```

| Configuração | Valor esperado |
| --- | --- |
| SESSION_SECRET | Aleatório, independente, 32 bytes ou mais |
| PASSWORD_PEPPER | Outro segredo aleatório, 32 bytes ou mais; preservar junto dos backups |
| APP_URL | Origem HTTPS pública exata, sem caminho/query, por exemplo o domínio pages.dev atribuído |
| BREVO_API_KEY | Chave NOVA, revogando as anteriormente expostas |
| BREVO_SENDER_EMAIL / BREVO_SENDER_NAME | Remetente verificado na Brevo |
| MONITORIE_BASE_URL / MONITORIE_CREDENTIALS | Somente após especificação real; não habilitam o adaptador por si só |
| DEVICE_TOKENS | Opcional: objeto JSON de ID → segredo forte de ingestão, se essa função for utilizada |
| DASHBOARD_SHARE_* | Opcionais: modo somente leitura, descrito abaixo |

Secrets locais em `.dev.vars` são independentes de produção. Não copiar `.env`
legado e não importar as chaves expostas. Nunca digitar segredos no argumento
de um comando, em documentos ou no chat. O wrapper Wrangler desativa a leitura
automática de `.env`; este projeto não usa dotenv no build.

No `wrangler.toml`, manter `APP_ENV=production`, `MONITORIE_MODE=unconfigured`
até concluir o adaptador, e `MAIL_MODE=disabled` até autorizar envio real.
Depois de configurar a Brevo, alterar `MAIL_MODE` para `brevo` e republicar.
O mock só funciona em loopback e é recusado nas URLs de produção/preview.

**Brevo/IP:** Workers não oferecem um único IP fixo de saída. A lista restritiva
de IPs da conta Brevo deve ser desativada ou substituída por configuração que
aceite Workers. Não cadastrar o IP do computador como solução de produção.
Revogar TODAS as chaves compartilhadas anteriormente e criar outra diretamente
no armazenamento de secrets. Nenhuma delas foi reutilizada na migração.

## 4. Publicação Pages

```sh
npm run build
node scripts/cloudflare/wrangler.mjs pages deploy dist --project-name hidra-r3b
```

Para integração Git: comando de build `npm run build`, pasta de saída `dist`,
Node.js 22+, e binding D1 `DB` conforme TOML. Nunca selecionar a raiz como saída.
Não usar `wrangler deploy`, que criaria outro produto/domínio; o alvo é Pages.
Separar D1 e secrets de Preview para não usar dados/recuperação reais em branches.
Preview pode manter e-mail desativado. Conferir APP_URL antes de enviar mensagens.

Depois da publicação autorizada, validar `/api/health`, cadastro/login/logout,
cookie Secure, limite de CPU, domínio nos links e um e-mail real autorizado.
Testes locais não comprovam entregabilidade nem o comportamento da conta Brevo.

## 5. Dispositivos e telemetria

Receber primeiro os itens em [MONITORIE.md](MONITORIE.md), implementar o adaptador
e cadastrar os IDs confirmados. Código de pareamento local tem validade de 24h:

```sh
node scripts/cloudflare/provision.mjs --id 1 --source monitorie --external-id ID_CONFIRMADO --remote
```

O código é gerado aleatoriamente, exibido uma vez ao administrador e armazenado
apenas como hash. Entregar somente ao proprietário. O script não altera um
dispositivo vinculado, nem troca fonte/ID externo de um equipamento existente.
Depois de desvincular, gerar novo código. Não executar seed demo no banco remoto.

Ingestão direta opcional: `INGEST_ENABLED=true`, `DEVICE_TOKENS` como secret,
`POST /api/device/ingest` com Authorization Bearer ou X-Device-Token em HTTPS.
Preserva normalização do firmware e faixas do payload antigo. Token na query
é recusado para evitar registros em URLs. Firmware somente HTTP precisa usar
a nuvem Monitorie compatível; não depende do antigo gateway com PC ligado.

Compartilhamento somente leitura é opcional e abrange o projeto inteiro:
configure os três secrets DASHBOARD_SHARE_USERNAME, DASHBOARD_SHARE_PASSWORD e
DASHBOARD_SHARE_USER_EMAIL de uma conta existente. O Worker exige HTTP Basic e
cria sessões de leitura; alterações são rejeitadas mesmo se o cookie for
reutilizado fora desse modo. Não habilitar se o projeto deve aceitar cadastros.

## 6. Segurança e limites reais do gratuito

- Sessões aleatórias de 256 bits, somente SHA-256 do identificador no D1;
  HttpOnly, Secure em HTTPS, SameSite=Lax e prefixo __Host- em produção.
- Sessão comum: 12h absolutas / 2h sem atividade. Lembrar: 30 dias. Rotação a
  cada 15 minutos, 30s de tolerância para requisições concorrentes; CSRF estável.
- Senhas PBKDF2-SHA256 nativo, salt individual, 100.000 iterações e HMAC com pepper
  obrigatório fora do banco. É o teto documentado do runtime; está abaixo da
  recomendação OWASP de 600.000 iterações sem essa defesa adicional. Não remover
  pepper nem reduzir iterações. Mudar o pepper exige recuperação das senhas.
- O limite gratuito de CPU é 10ms por chamada. O emulador local NÃO aplica esse
  orçamento da conta. Medir cadastro/login/reset em staging antes de prometer
  operação gratuita em produção. Se exceder, revisar a arquitetura de identidade
  (ex.: provedor externo gratuito compatível) ou plano; não enfraquecer o hash.
- Reset: 256 bits, SHA-256 no banco, 20 minutos, uso único atômico, revoga todas
  as sessões e tokens. A URL pública é obrigatória, nunca inferida do Host.
- Respostas de recuperação sempre genéricas; envio assíncrono via waitUntil.
  Falha remove o token e registra somente um código seguro, nunca o erro bruto.
- Consultas parametrizadas; autorização D1 antes do cache; sem CORS necessário.
- Rate limits no D1 por IP/identidade (identificadores HMAC). Em produção somente
  o header CF-Connecting-IP da borda é usado; não confiar em X-Forwarded-For.
- Logs de invocação desativados por padrão. Não habilitar coleta de URL/query,
  corpo ou headers, especialmente nas rotas de recuperação e ingestão.
- Limpeza de sessões/tokens/rate limits expirados em lotes por hora acionados
  por visitas às páginas. Leituras locais não são apagadas automaticamente.
  Fazer exportação/retencão conforme necessidade, sem depender de cron de VPS.
- D1 gratuito: 500 MB por banco, 5 GB por conta; 5 milhões de linhas lidas/dia e
  100 mil escritas/dia. Índices também custam escritas. Monitorar métricas reais.
- 100 mil requisições de Worker/dia são por conta. Cache do Worker reduz chamadas
  à Monitorie, não elimina invocações do Worker feitas pelo navegador.

Tela padrão: snapshot + histórico a cada 60s (até 960 chamadas em 8h por aba,
mais navegação/autenticação). A estimativa anterior de uma chamada por atualização
não incluía o histórico. A preferência de 5s aumenta consumo; abas ocultas pausam.
O plano Free interrompe operações ao alcançar cotas, sem upgrade automático.
Não foram contratados planos nem serviços pagos.

Referências: [Pages avançado](https://developers.cloudflare.com/pages/functions/advanced-mode/),
[D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/),
[limites Workers](https://developers.cloudflare.com/workers/platform/limits/),
[limite PBKDF2](https://github.com/cloudflare/workerd/issues/1346),
[limites D1](https://developers.cloudflare.com/d1/platform/limits/).

## 7. Dados existentes e rollback

O D1 começa vazio. O banco PHP existente não foi alterado, importado ou apagado.
Não transportar sessões antigas ou tokens de recuperação. Para migrar contas,
exportar dados em ambiente seguro, mapear datas para segundos UTC e importar
usuários/dispositivos/reservatórios/leituras respeitando IDs e vínculos.
Hashes bcrypt PHP não são convertíveis para o formato novo: usuários importados
precisarão redefinir a senha (usar hash marcador não autenticável e fluxo de
recuperação após configurar Brevo). Não pedir nem exportar senhas em texto puro.
Planejar e validar essa importação contra uma cópia antes de trocar produção.

Arquivos PHP e infraestrutura antiga foram mantidos. Para consultar a versão
anterior, usar o commit anterior em checkout separado; JS principal agora usa
as APIs Cloudflare. Não servir a raiz antiga como site de produção.
Para rollback de uma publicação Cloudflare futura, usar a versão anterior de
Pages e backup D1 compatível. Não apagar o banco antigo até aceitar a migração.
