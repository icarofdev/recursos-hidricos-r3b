# Observação de requisições e planejamento de rate limit

Para a proteção de CPU do login, veja [Turnstile adaptativo e regra WAF por IP](LOGIN_ABUSE_PROTECTION.md).
O guia contém a expressão POST/hostname, adaptações por plano e confirmação do trajeto da API.

O Worker amostra respostas bem-sucedidas de usuários autenticados. Respostas anônimas, recusadas, inválidas ou `204` não geram escrita desta observação no D1. `OBSERVABILITY_SAMPLE_RATE=100` seleciona aproximadamente uma resposta em cem, independentemente em cada isolate, sem depender de flush em memória. O evento `endpoint_request` contém caminho normalizado, método, status, request ID, país aproximado (`request.cf.country`), janela UTC de cinco minutos e `sample_rate`. O D1 guarda contadores de **amostras**, agregados por caminho, método e país. Eles não representam o total de requisições nem permitem medir tentativas recusadas. Sem metadata válida, o país é `XX`.

O caminho é uma rota conhecida ou um modelo como `/api/admin/devices/:id/delete`. Consulta, fragmento, corpo, cabeçalhos, IP bruto, e-mail, senha, token e código não entram no evento. O header `CF-IPCountry` enviado pelo cliente é ignorado. A gravação usa `waitUntil`; falhas não alteram a resposta original. A tabela é limpa em lotes depois de sete dias. Transições de segurança bem-sucedidas continuam na auditoria; falhas de autenticação são amostradas separadamente. Acompanhe abuso e bloqueios pela observabilidade da plataforma/WAF, com retenção configurada externamente; estes contadores de sucesso não bastam para dimensionar regras de ataque.

Consulta de leitura para ver repetições no D1 local ou em um ambiente autorizado:

```sql
SELECT window_start, path, method, country, request_count, last_status, last_request_id
FROM endpoint_requests
WHERE path IN ('/api/auth/login', '/api/auth/admin-totp/verify', '/api/auth/forgot-password')
ORDER BY window_start DESC, request_count DESC
LIMIT 100;
```

Os contadores são por país, **não por IP**. Uma regra WAF baseada em IP precisa de análise própria de falsos positivos. A janela fixa do Worker também não é a mesma janela calculada pelo WAF, que conta por centro de dados e pode demorar alguns segundos para aplicar uma ação.

## Preparar uma regra Cloudflare, sem ativá-la agora

1. Em **Workers & Pages → Worker → Settings → Domains & Routes**, confira o hostname que recebe a API. O `wrangler.toml` atual não declara rota nem domínio próprio; se o tráfego estiver apenas em `workers.dev`, confira a proteção disponível para esse hostname antes de criar uma regra WAF de zona. Uma regra criada na zona de outro domínio não cobrirá automaticamente o hostname `workers.dev`.
2. Na zona que realmente recebe a API, abra **Security → Security rules → Create rule → Rate limiting rules**. Confira o plano e quantas regras já estão em uso. Não altere nenhuma regra existente só para abrir espaço.
3. Selecione os caminhos exatos de `POST /api/auth/login`, TOTP (`/api/auth/admin-totp/setup`, `/confirm`, `/verify`, `/reauth`) e recuperação de senha (`/api/auth/forgot-password`, `/api/auth/reset-password`). Considere os aliases `.php` se ainda receberem tráfego. Use **IP** como característica no Free/Pro; isso não armazena IP no Worker, mas o WAF usa IP internamente para contar.
4. Escolha o número de requisições por período depois de observar tráfego real e testar o fluxo de login, TOTP e recuperação em staging. No Free, existe apenas uma regra e um período de 10 segundos: combine os caminhos em uma expressão por `http.request.uri.path`, sabendo que eles compartilharão o mesmo contador por IP. No Pro, há duas regras e período até um minuto; separe login e o grupo TOTP/recuperação. Free e Pro não oferecem método na expressão nem contagem por status da resposta. No Business, há cinco regras, método na expressão, período até dez minutos e expressão de contagem por status; separe os três fluxos. O endpoint `forgot-password` devolve resposta genérica 200, então uma contagem só de erros não o protege.
5. Avalie a ação disponível no plano antes de ativar. Um **Managed Challenge** em `POST` de API pode interromper `fetch` e CSRF; um **Block** pode impedir um usuário legítimo atrás de NAT. Valide a resposta e a duração em staging, confira eventos e publique apenas após escolher limites com dados. O código do Worker continua com seus limites próprios. Nenhuma regra WAF foi criada por esta implementação.

Limites oficiais consultados em 2026-09-29: [disponibilidade por plano](https://developers.cloudflare.com/waf/rate-limiting-rules/#availability), [criação no painel](https://developers.cloudflare.com/waf/rate-limiting-rules/create-zone-dashboard/), [parâmetros e ações](https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/), [cálculo e limitações](https://developers.cloudflare.com/waf/rate-limiting-rules/) e [Workers `workers.dev`](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/). O plano contratado e a rota efetiva desta conta não estão declarados no repositório; confirme ambos no painel antes de escolher uma configuração.
