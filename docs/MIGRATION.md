# Migração para Cloudflare — inventário e plano

Inventário realizado antes da implementação. `git status --short` estava vazio.

## Plano

1. Criar TypeScript, build isolado de Pages, migrations D1 e execução local com Wrangler.
2. Migrar autenticação, sessões, recuperação, pareamento, autorização e telemetria.
3. Reaproveitar HTML/CSS/Chart.js, trocar URLs das APIs e reduzir consultas repetidas.
4. Validar com D1/workerd locais, documentar publicação e dependências externas.

## Páginas

| Origem PHP | Rota preservada | Destino |
| --- | --- | --- |
| index.php | / | Template HTML protegido pelo Worker |
| login.php | /login | Template HTML |
| register.php | /cadastro | Template HTML |
| forgot-password.php | /esqueci-senha | Template HTML |
| reset-password.php | /redefinir-senha | Template HTML |

## Todos os endpoints

| Endpoint antigo | Endpoint Cloudflare | Regra |
| --- | --- | --- |
| POST /api/auth/register.php | POST /api/auth/register | Cadastro, sessão nova, CSRF, rate limit |
| POST /api/auth/login.php | POST /api/auth/login | Login e lembrar de mim |
| POST /api/auth/logout.php | POST /api/auth/logout | Revogação da sessão |
| GET /api/auth/me.php | GET /api/auth/me | Usuário e CSRF da sessão |
| POST /api/auth/forgot-password.php | POST /api/auth/forgot-password | Resposta genérica, Brevo |
| GET/POST /api/auth/reset-password.php | GET/POST /api/auth/reset-password | Validação/consumo atômico do token |
| GET /api/reservoirs/index.php | GET /api/reservoirs | Somente reservatórios próprios |
| POST /api/reservoirs/rename.php | POST /api/reservoirs/rename | Nome com até 60 caracteres |
| POST /api/devices/validate-pairing.php | POST /api/devices/validate-pairing | Código secreto com expiração |
| POST /api/devices/connect.php | POST /api/devices/connect | Reivindicação atômica |
| POST /api/devices/unlink.php | POST /api/devices/unlink | Preserva histórico, invalida pareamento |
| GET /api/device/current.php | GET /api/device/current | Última leitura autorizada |
| GET /api/device/history.php | GET /api/device/history | Histórico autorizado, horas/limite validados |
| GET /api/device/status.php | GET /api/device/status | Estado autorizado |
| GET /api/device/alerts.php | GET /api/device/alerts | Offline, nível <20 crítico e <40 baixo |
| POST /api/device/ingest.php | POST /api/device/ingest | Ingestão HTTPS opcional, segredo por dispositivo |
| GET /health.php, /api/health.php | GET /api/health | Saúde do D1, sem detalhes internos |

Aliases `.php` permanecem apenas como rotas TypeScript para compatibilidade externa.
Novo GET `/api/device/snapshot` agrega leitura, estado e alertas em uma requisição.
Novo GET `/api/auth/csrf` inicia uma sessão anônima para clientes que não carregam páginas.

## Dados e integrações existentes

- Tabelas: users, devices, reservoirs, smwu_readings, sensor_readings (SM-WA legado), password_reset_tokens, rate_limits, schema_migrations.
- Sessões PHP estavam em disco; migram para D1. Todas as sessões antigas precisarão de novo login.
- Brevo: API transacional HTTP. Nenhuma chave antiga será copiada ou utilizada.
- MQTT/EMQX, gateway HTTP local do firmware V5.10, backups/cron/systemd/Nginx: componentes legados fora do artefato publicado.
- Compartilhamento HTTP Basic: preservar como modo opcional de leitura, com secrets novos.
- Não foram encontradas especificações da Monitorie nem variáveis MONITORIE no ambiente existente. Nenhuma URL/credencial será presumida.
- Frontend: static/js/auth.js (formulários), static/js/dashboard.js (10 rotas, três consultas por atualização + histórico), CSS responsivo e Chart.js local.

## Decisões e diferenças justificadas

- Intervalo inicial da tela passa de 5 para 60 segundos; opções rápidas continuam disponíveis. Snapshot reduz três requisições a uma. Cache da integração é independente do intervalo da tela.
- Ingestão por token na query é desativada: tokens em URLs podem entrar em logs. Usar Authorization ou X-Device-Token em HTTPS. Firmware somente HTTP deve usar Monitorie; gateway local não faz parte da arquitetura final.
- Histórico remoto só pode começar no vínculo atual: a nova conta não recebe histórico do proprietário anterior.
- Datas da nova API são ISO 8601 UTC; a interface já as formata no fuso do navegador.
- Histórico da nova API vem em ordem cronológica. A interface já ordena registros para gráfico/tabela, mantendo a apresentação existente.
- Ingestão usa agora um mapa JSON de tokens individuais em secret, em vez de token global e lista no .env. A separação limita o acesso de cada equipamento ao seu ID.
- Duplicatas idênticas de ingestão são suprimidas por cinco segundos (antes, três por padrão), reduzindo escritas repetidas no D1; leituras diferentes continuam registradas imediatamente.
- O limite do corpo JSON foi uniformizado em 16 KiB, incluindo ingestão (antes 4 KiB por padrão). Todas as faixas físicas e rejeição de campos desconhecidos permanecem.
- A tabela SM-WA antiga permanece no banco original; sua importação é opcional, pois não há endpoint ativo que a utilize.
- Arquivos PHP permanecem no repositório, marcados como legado, e nunca entram no build Cloudflare.

Implementação e validação local concluídas: consulte [o relatório](VALIDATION.md) e [o guia de publicação](CLOUDFLARE.md).
