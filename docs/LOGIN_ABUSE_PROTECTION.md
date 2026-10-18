# Login: Turnstile adaptativo e rate limit de borda

Implementação local preparada em `security-review-2026-10-18`, a partir de
`f3d2698abae6f9a03b1917872de6dc4322420478`. A etapa inicial ocorreu sem commit,
push ou deploy. Não houve regra WAF publicada nem leitura de secrets. Em
18/10/2026, após login do operador no painel Cloudflare, foi criado o widget de
produção e conferida a ausência de domínio próprio/rota e de zonas na conta.
O operador autorizou a publicação posteriormente; os resultados dessa operação
devem ser conferidos pelos endpoints e pelas revisões dos artefatos publicados.

## Fluxo no Worker

`POST /api/auth/login` e seu alias `.php` mantêm CSRF, origem e JSON limitado a 16 KiB.
Antes do KDF, continuam os limites de **20 tentativas/IP/15 min** em produção e
**10 tentativas/IP+e-mail/15 min**. O limite por IP de desenvolvimento local permanece
200/15 min, como antes.

No modo adaptativo, o contador HMAC de falhas por e-mail normalizado passa a ser sinal
para desafio, sem recusar uma identidade por saturação:

1. Abaixo do limiar, uma tentativa sem token segue para `verifyPassword`.
2. A partir do limiar, sem token a API responde `403 TURNSTILE_REQUIRED`, com chave
   pública, ação `login` e `cdata` opaco. Não consulta a senha nem executa PBKDF2.
3. O frontend exibe o widget e aguarda a pessoa pressionar **Entrar** novamente.
4. O Worker envia o token a `https://challenges.cloudflare.com/turnstile/v0/siteverify`.
   Confere sucesso, hostname do frontend (`APP_URL`), ação, data e vínculo à identidade
   e sessão. Um token válido autoriza **uma tentativa de senha**.
5. Senha incorreta continua retornando `401 INVALID_CREDENTIALS`, inclusive com o
   contador saturado. Exige outro token na próxima tentativa. Senha correta limpa o
   sinal global e segue para sessão normal ou MFA administrativo, conforme a conta.

Requisições que já atingiram os limites por IP continuam recebendo 429 antes de
Siteverify/PBKDF2. O desafio não concede exceção a esses limites. Contas ausentes usam
o mesmo sinal e os mesmos desafios; o desafio não consulta a existência da conta.

O `cdata` é HMAC da identidade e do CSRF da sessão, não contém e-mail/cookie em claro e
continua válido na rotação ordinária do cookie. Tokens fornecidos são verificados mesmo
que o contador tenha sido limpo desde sua emissão. Não há cache de tokens aceitos,
cookie de bypass nem autorização reutilizável para executar KDF.

O contrato do provedor estabelece tokens de até 2.048 caracteres, validade de cinco
minutos e uso único; expirados/reutilizados são rejeitados pelo Siteverify. O Worker
também confere `challenge_ts` e recusa tokens de ação, hostname ou contexto diferentes.
Fonte: [validação no servidor](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

O transporte usa destino fixo, redirects desabilitados, timeout de 5 s e resposta JSON
até 16 KiB, com UTF-8 estrito. Falha de rede/provedor retorna 503, sem executar o KDF nem
revelar mensagens externas. Não há retry automático de validação. Tokens e secret não
entram em logs, respostas, URLs, D1 ou bundle; D1 mantém somente os contadores HMAC.

## Configuração e ativação posterior

Nenhum secret foi lido, copiado ou configurado no Worker. O modo ausente é `disabled`, preservando o
comportamento anterior até o operador configurar a integração. **A proteção adaptativa
não está declarada ativa em produção.**

| Variável do Worker                  | Configuração                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `LOGIN_TURNSTILE_MODE`              | `adaptive` para ativar; `disabled` ou ausente para desativar. Outro valor causa falha de configuração.        |
| `LOGIN_TURNSTILE_FAILURE_THRESHOLD` | Padrão 5 falhas por identidade; inteiro 1–100. Valor inválido usa o padrão.                                   |
| `LOGIN_TURNSTILE_WINDOW_SECONDS`    | Padrão 900 s; inteiro 60–3600. Valor inválido usa o padrão.                                                   |
| `TURNSTILE_SITE_KEY`                | Chave **pública** do widget, entregue ao navegador na resposta de desafio.                                    |
| `TURNSTILE_SECRET_KEY`              | Secret exclusivo do Worker, armazenado no gerenciador de secrets; nunca em Git, argumentos, logs ou frontend. |

### Preparação realizada no painel em 18/10/2026

O widget **`hidra-r3b-login-production`** foi criado e confirmado na lista da conta.
Está em modo **Managed**, com somente **`hidra-r3b.vercel.app`** permitido e
**sem pre-clearance**. A lista confirmou um único widget, sem duplicatas.
Chave pública do widget, que pode ser usada em `TURNSTILE_SITE_KEY`:

```text
0x4AAAAAAFal3KRm5oYYb1yh
```

O valor do secret gerado pelo provedor não foi inspecionado nem transferido.
O widget não ativa a integração por si só. Nessa etapa, código e configuração do
Worker/frontend continuavam sem publicação, e não foram alterados bindings,
variáveis ou versões do Worker.
Para a futura configuração de produção, os valores públicos preparados são:

```text
LOGIN_TURNSTILE_MODE=adaptive
LOGIN_TURNSTILE_FAILURE_THRESHOLD=5
LOGIN_TURNSTILE_WINDOW_SECONDS=900
TURNSTILE_SITE_KEY=0x4AAAAAAFal3KRm5oYYb1yh
```

Não aplique `adaptive` isoladamente: primeiro provisione `TURNSTILE_SECRET_KEY` do
mesmo widget e publique os componentes compatíveis em uma operação autorizada.
Preview ainda precisa de widget/configuração próprios, depois de confirmar seu hostname.

No painel de produção, `hidra-r3b` está exposto em
`hidra-r3b.hidra-r3b-cloudflare.workers.dev`; **Custom domains** e **Routes** aparecem
vazios. A lista de Domains da conta também está vazia. Portanto, não há nesta conta
uma zona onde criar a regra WAF documentada abaixo para o hostname atual da API.
Antes disso, o operador precisa indicar um domínio próprio sob seu controle e
disponibilizar sua zona/rota para a API. Nenhum domínio foi comprado, adicionado ou
migrado, e nenhum endereço de produção foi alterado.

O contador usa janela fixa, não estendida por recusas e limitado a `max(10, limiar)`.
No modo desativado, conserva o contador anterior de dez falhas/60 s, somente para
observação. A manutenção já existente remove janelas expiradas; nenhuma migration nova.

Para ativar em uma operação futura autorizada:

1. Configure o widget para o **hostname do frontend que contém o login**, correspondente
   a `APP_URL`. A chave pública e o secret devem pertencer ao mesmo widget. Preview e
   Production precisam de configurações próprias; não permita qualquer hostname.
2. Armazene o secret no ambiente correto e configure as variáveis públicas acima.
   Somente então habilite `LOGIN_TURNSTILE_MODE=adaptive`. Não use chaves de teste em
   produção. O frontend obtém a chave pública da API; não precisa receber o secret.
3. Valide login normal, desafio, token vencido/repetido e MFA em ambiente de teste.
   No modo adaptativo, configuração incompleta faz readiness **e login** responderem
   503 antes do KDF, independentemente da identidade. Readiness confere configuração,
   não prova a validade real das chaves ou disponibilidade do Siteverify.
4. Confira CSP do frontend: `script-src` e `frame-src` permitem apenas a origem
   `https://challenges.cloudflare.com` adicional. Não foram adicionados `unsafe-inline`
   nem `unsafe-eval`. O widget carrega por renderização explícita, sob demanda, com
   renovação de tokens e botão de recarga, sem reenviar credenciais automaticamente.
   Referências: [CSP](https://developers.cloudflare.com/turnstile/reference/content-security-policy/),
   [widget e callbacks](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/).

Na preparação inicial, `MAIL_MODE=disabled` e `MAIL_REQUIRED=true` foram preservados.
Posteriormente, o operador autorizou commit, push e deploy e pediu para manter o
Resend temporariamente desativado. A configuração de publicação usa, portanto,
`MAIL_MODE=disabled` e `MAIL_REQUIRED=false`: e-mail é temporariamente opcional para
readiness. Recuperação de senha e envio de confirmação continuam indisponíveis;
as regras de comprovação de identidade não foram removidas. Depois de provisionar
Resend e remetente, configure `MAIL_MODE=resend` e restaure `MAIL_REQUIRED=true`.

### Pré-publicação autorizada

O secret `TURNSTILE_SECRET_KEY` foi cadastrado e publicado pelo operador. Sua presença
foi confirmada somente pelo nome/tipo do binding, sem consultar o valor. `APP_URL`
também existe como Secret na produção; o arquivo Wrangler deixa de tentar redefini-lo
como variável em texto. O deploy deve preservar os bindings existentes.

A CLI Vercel confirmou que `hidra-r3b.vercel.app` resolve para um deployment de
produção do projeto `frontend`, ID `prj_HzvmwpLX1mU6ym6OeniwIxORcxFU`, na equipe
`synxgms-projects`. O endpoint público `build-info.json` confirma a API `workers.dev`.

O preflight encontrou produção com migrations até 0011, sem marcador `schema_version`,
e Preview com schema 13. Antes de publicar o Worker atual, é necessário aplicar as
migrations pendentes em staging e produção, com recuperação e manutenção coordenadas.
Bookmarks de Time Travel foram obtidos sem exportar conteúdo do banco. O código novo
não deve receber tráfego sobre o schema anterior.

A suíte completa também revelou três fixtures antigas de ingestão que tentavam
enviar leituras sem vincular o equipamento. Elas passam a criar o proprietário e
o vínculo antes da emissão/rotação do token, preservando a recusa `DEVICE_UNLINKED`
do backend. Não foi relaxada a proteção de ingestão.

O teste de demonstração local também revelou arredondamento indevido do timestamp
do mock para segundos: uma leitura criada logo após um vínculo em milissegundos
era descartada como anterior a ele. O mock agora usa a precisão de `Date.now()`;
o teste confirma que sua primeira leitura não antecede `linked_at_ms` e que o
snapshot seguinte reutiliza o cache. As fronteiras de telemetria real permanecem
inalteradas.

Validação ampliada de pré-publicação: a execução completa encontrou 166 testes,
com 161 aprovados, quatro falhas e um caso de baseline intencionalmente ignorado.
As quatro falhas descritas acima foram corrigidas e passaram em reteste direcionado;
o mesmo reteste conferiu a revisão comum de Worker/frontend (cinco aprovados).
Playwright passou os nove testes de navegador. Typecheck, lint e formatação também
passaram. A execução completa não foi repetida após esses ajustes pontuais.

## Regra Cloudflare por IP para o login

Prepare a regra na zona que **realmente recebe a API**, não apenas na zona do frontend.
Em Workers → Settings → Domains & Routes, identifique o hostname usado por
`PUBLIC_API_URL`. Confirme que sua rota/domínio e DNS passam pela zona onde o WAF será
aplicado. Uma regra de outra zona não protege automaticamente o endereço `workers.dev`.
Identifique também URLs alternativas de API que possam contornar essa zona.

Antes de ativar, confirme o trajeto em ambiente autorizado: gere uma requisição de
teste identificável e confira a correspondência da regra em Security Events/Trace ou
modo Log quando disponível. DNS proxied e `CF-Ray` isoladamente não provam que a regra
da zona foi avaliada. Se o hostname não atravessar o WAF apropriado, resolva a rota
antes de considerar a proteção ativa. A inspeção do painel em 18/10/2026 confirmou
apenas o endereço `workers.dev` acima, sem domínio próprio ou rota; não houve teste
remoto de tráfego ou correspondência de regra.

Quando o plano oferecer os campos Host e Method, use uma expressão como:

```text
(http.host eq "API_HOSTNAME"
 and http.request.method eq "POST"
 and http.request.uri.path in {"/api/auth/login" "/api/auth/login.php"})
```

Substitua `API_HOSTNAME` pelo hostname confirmado. Característica de contagem: **IP de
origem (`ip.src`)**. Conte todas as requisições correspondentes, sem condicionar a 401:
200, 403 e 429 também consomem recursos. Não agrupe pelo e-mail/conta. O Worker mantém
seus limites independentemente da regra de borda.

| Plano/capacidade                                 | Expressão possível           | Exemplo inicial ajustável por IP                                            |
| ------------------------------------------------ | ---------------------------- | --------------------------------------------------------------------------- |
| Business ou superior com Method/Host disponíveis | Host + POST + caminhos acima | 20 requisições/60 s; ação Block, mitigação 60 s.                            |
| Pro                                              | Host + caminhos; sem Method  | 20 requisições/60 s; Block por 60 s. Inclui outros métodos nesses caminhos. |
| Free                                             | Caminhos; sem Host/Method    | 10 requisições/10 s; Block por 10 s. Aplica-se aos caminhos na zona.        |

São pontos de partida para ajuste, não valores aprovados para tráfego real. Confira
plano, campos, janelas, número de regras e ações disponíveis na conta. Free/Pro não
oferecem filtro Method nesta classe de regras; não anuncie uma regra exclusiva para
POST nesses planos. Fonte: [disponibilidade e parâmetros por plano](https://developers.cloudflare.com/waf/rate-limiting-rules/#availability).

Escolha N requisições, período e duração após observar tráfego e NATs compartilhados.
Ensaiar em staging deve incluir senha incorreta, desafio, nova tentativa com token,
login correto e vários titulares atrás do mesmo IP. Bloqueios curtos afetam somente
o IP; não crie uma regra por identidade que impeça o titular de cumprir o desafio.
Evite Managed Challenge diretamente sobre POST via fetch: o desafio deve ser cumprido
no widget do formulário, sem resposta HTML inesperada no fluxo JSON.

Os contadores de borda são distribuídos por centro de dados e a aplicação pode sofrer
atraso na aplicação da regra; não são orçamento global exato de CPU. Consulte os
[parâmetros](https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/) e
[cálculo de requisições](https://developers.cloudflare.com/waf/rate-limiting-rules/request-rate/).
Esta regra foi documentada, não criada nem ativada.

## Evidências e limites locais

Testes usam D1 efêmero, contas sintéticas, widget/processo de navegador simulados e
Siteverify simulado com uso único. Um contador injetado **apenas no bundle de teste**
mede chamadas à função real `verifyPassword`; o código de produção não contém esse hook.
São cobertos token ausente/inválido/expirado/reutilizado, contexto/hostname/ação, titular
após desafio, limites preexistentes, configurações e falhas do provedor, UI e CSP.

Validação inicial: **36 testes distintos aprovados** — oito de backend Turnstile,
quatro da integração do formulário/widget, 15 regressões de autenticação/sessão/MFA,
quatro de segurança do frontend/artefatos e cinco contratos existentes de revisão,
cadastro, limites por IP/e-mail e TOTP. O cenário de token reutilizado também passou
em concorrência: duas requisições com o mesmo token resultam em 200/403 e somente uma
nova chamada ao KDF. Esse reteste não foi contado novamente no total.

`npm run typecheck`, `npm run lint`, `npm run format:check`, build local e
`git diff --check` passaram. Na etapa inicial não houve execução da suíte completa. Runtime local Node 24;
o CI do projeto usa Node 22, não executado nesta tarefa.

Fonte pública do build:
`c1b88caae86be6d6537b7e26cef5dd6e585fdc93e591654df3c95ffbba9c9f66`.
O marcador gerado coincide com a fonte; o frontend não contém o binding do secret
e o Worker de produção não contém a instrumentação de KDF dos testes. Estado daquela etapa:
dez arquivos existentes modificados e cinco novos, todos locais e fora do índice;
HEAD era `f3d2698abae6f9a03b1917872de6dc4322420478`. Naquela etapa, `wrangler.toml`, migrations,
package.json e lockfile foram preservados. Nenhum artefato gerado está no diff.

O limiar não é teto global rígido: tentativas simultâneas que leem o contador antes
do limiar podem entrar em voo. Ataques que variam identidades/IPs e adversários que
cumprem desafios ainda consomem recursos. WAF, acompanhamento de CPU/latência/custos e
limites do plano continuam necessários. Não foi feito teste de carga, validação real
de widget/chaves ou avaliação de acessibilidade em navegador real. A preparação externa
limitou-se à criação do widget e à inspeção de domínios/rotas descritas acima.
