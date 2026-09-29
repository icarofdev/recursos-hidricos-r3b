# Monitor IE — autenticação contínua e contrato de leitura

O backend integra-se à API oficial em `https://monitorie.com.br`. O navegador continua autenticado pela sessão do Hidra e chama somente o Cloudflare Worker. Senha, JWT e refreshToken nunca entram no frontend, nas respostas ou nos logs. O D1 guarda apenas o par de tokens cifrado com AES-GCM; a chave é derivada de `SESSION_SECRET` por HKDF e não é armazenada no banco.

## Contrato confirmado

O Swagger oficial em `https://monitorie.com.br/swagger-ui/` identifica a instalação como ThingsBoard Professional Edition `3.6.4PE` e documenta:

| Operação                 | Método e caminho                                                 | Observações                                                                                     |
| ------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Dispositivos acessíveis  | `GET /api/user/devices`                                          | `page` começa em `0`; `pageSize` é obrigatório; resposta `PageData<Device>`                     |
| Atributos do dispositivo | `GET /api/plugins/telemetry/DEVICE/{deviceId}/values/attributes` | Consulta diagnóstica; nos dois dispositivos acessíveis não houve atributo MAC.                  |
| Chaves de telemetria     | `GET /api/plugins/telemetry/DEVICE/{deviceId}/keys/timeseries`   | `deviceId` vem da lista de dispositivos; não é informado no cadastro.                           |
| Últimos valores          | `GET /api/plugins/telemetry/DEVICE/{deviceId}/values/timeseries` | `keys` e `useStrictDataTypes=true`; a chave real `mac` permite conferir o aparelho.             |
| Histórico                | mesmo caminho de valores                                         | `keys`, `startTs`, `endTs`, `limit`, `agg=NONE`, `orderBy=ASC`; timestamps UTC em milissegundos |

A autenticação de leitura confirmada é `X-Authorization: Bearer <JWT>`. Com `MONITORIE_USERNAME` e `MONITORIE_PASSWORD` configurados como secrets do Worker, o backend faz `POST /api/auth/login`, guarda o par de tokens cifrado e chama `POST /api/auth/token` antes do vencimento. O refresh devolve novos valores e pode rotacionar o refreshToken. Um refresh rejeitado por 400/401/403 provoca uma única tentativa de login; falhas de rede e respostas inválidas encerram a tentativa com erro genérico. Se ambas as credenciais estiverem ausentes, `MONITORIE_JWT` continua aceito para compatibilidade manual e expira normalmente. Uma configuração parcial de usuário/senha falha fechada.

O JWT retornado pela MonitorIE fornece `exp` quando presente. O backend usa o menor prazo entre `exp` e 20 minutos contados da resposta e renova com margem de 2 minutos. A duração de 20 minutos foi informada pela equipe da MonitorIE; ela pode diferir do padrão geral do ThingsBoard. A renovação ocorre na próxima consulta, sem chamadas de fundo quando o painel está inativo. Um lease no D1 permite apenas um login ou refresh em andamento entre instâncias; os demais pedidos aguardam o novo par. Se a consulta de telemetria receber 401, o próximo pedido permitido pelo gate tenta renovar o token.

Em 29/09/2026, uma chamada controlada a `/api/auth/token` com token artificial recebeu **401** da instância, confirmando a existência da rota sem usar credenciais reais. [Um mantenedor do ThingsBoard](https://github.com/thingsboard/thingsboard/issues/12371) documenta o POST com `refreshToken` e a resposta com `token` e `refreshToken`, inclusive a ausência dessa rota no Swagger de versões anteriores. O refresh **bem-sucedido na conta MonitorIE deste projeto ainda depende de configurar usuário/senha no backend**; o ciclo completo está coberto por testes com respostas simuladas.

O cliente aceita somente a origem HTTPS fixa `monitorie.com.br`, rejeita redirects, limita respostas a 1 MiB, usa timeout de 10 segundos e mapeia 401, 403, 404, 429, 5xx, timeout e resposta inválida sem repassar corpo ou detalhes internos.

## Configuração local sem expor credenciais

Crie `.dev.vars` localmente (ignorado pelo Git). Para autenticação contínua, preencha o usuário e a senha da MonitorIE diretamente nesse arquivo. O `SESSION_SECRET` local já é gerado no armazenamento privado do runtime:

```dotenv
MONITORIE_USERNAME=
MONITORIE_PASSWORD=
MONITORIE_SMWU_MAPPING=
MONITORIE_SMWA_MAPPING=
```

Não use `VITE_`, `NEXT_PUBLIC_`, `PUBLIC_` ou argumento de linha de comando para credenciais. `npm run dev:monitorie` lê essas variáveis só no backend; reinicie o processo depois de alterá-las. O cache cifrado fica em `monitorie_auth_cache` no D1 local, sem copiar tokens para as tabelas de telemetria.

O diagnóstico manual abaixo ainda aceita `MONITORIE_JWT` em `.dev.vars` e faz exatamente uma chamada de **leitura** por execução. Ele não executa login ou refresh e não imprime o JWT. Se optar por esse modo legado, copie o JWT sem exibi-lo e limpe a área de transferência:

No PowerShell, depois de usar **Copy JWT token** na página, salve-o sem exibi-lo e limpe a área de transferência:

```powershell
Get-Clipboard | npm --silent run monitorie:store-jwt
Set-Clipboard -Value ''
```

Se o navegador usar uma área de transferência isolada, execute `npm run monitorie:store-jwt-browser`, abra somente `http://127.0.0.1:8790/`, cole no campo de senha e salve. O servidor aceita uma única gravação local e encerra em seguida.

```sh
npm run monitorie:probe -- devices --page 0
npm run monitorie:probe -- structure --page 0
npm run monitorie:probe -- attributes --device-id ID_RETORNADO_PELA_LISTA
npm run monitorie:probe -- keys --device-id ID_RETORNADO_PELA_LISTA
npm run monitorie:probe -- latest --device-id ID_RETORNADO_PELA_LISTA --keys chave1,chave2
npm run monitorie:probe -- history --device-id ID_RETORNADO_PELA_LISTA --keys chave1,chave2 --hours 24 --limit 500
```

Respeite pelo menos 70 segundos entre execuções enquanto o limite informado pelo suporte não for formalmente detalhado. As consultas são somente leitura; não alteram dispositivos, alarmes ou configurações.
O comando `attributes` mostra os nomes das chaves de atributos e os valores apenas das chaves de MAC reconhecidas; oculta os demais valores retornados.
O comando `structure` mostra nomes de campos e caminhos de valores com formato de MAC na lista, sem mostrar os demais valores.

## Mapeamento explícito de chaves e classificação de unidades

O Swagger do ThingsBoard (`3.6.4PE`) define a assinatura dos endpoints HTTP, mas **não fornece metadados de unidade ou especificação técnica dos campos de telemetria**. A IE Tecnologia não disponibilizou manual técnico de integração ou datasheet dos firmwares SM-WU e SM-WA.

Portanto, as unidades configuradas não são formalmente homologadas pelo fornecedor; são classificadas da seguinte forma:

### Classificação de unidades

1. **`vazao` = L/h**: **CONFIGURADA / PROVISÓRIA**.
   - _Evidência:_ Rótulo visual do widget na tela Técnica do painel web da Monitor IE (`Vazão [L/H]`).
   - _Ressalva:_ A API retorna apenas o valor numérico (`vazao: 0`), sem confirmação documental de escala ou periodicidade.
2. **`consumo` = L**: **CONFIGURADA / PROVISÓRIA**.
   - _Evidência:_ Rótulos visuais no painel web (`Consumido [L]`, `Consumo Acumulado [L]`) e indicação de "consumo em litros" em Relatórios, associado a `ppl = 1` (pulsos por litro).
   - _Ressalva:_ Não há documento de API confirmando se o valor acumulado é resetado pelo medidor ou se representa litros absolutos.
3. **`d` = cm**: **CONFIGURADA / PROVISÓRIA**.
   - _Evidência:_ Coerência física empírica (leitura real `d: 188` com `nivel: 0` condizente com sensor a 188 cm do fundo em reservatório vazio) e contrato legado do sensor ultrassônico.
   - _Ressalva:_ Nenhuma documentação da IE Tecnologia atesta se a unidade é milímetros (`mm`) ou centímetros (`cm`).
4. **`nivel` = %**: **CONFIGURADA / PROVISÓRIA**.
   - _Evidência:_ Coerência com escala percentual de 0 a 100% (`nivel: 0`).
   - _Ressalva:_ Sem especificação de firmware por escrito.
5. **`volume` = L**: **CONFIGURADA / PROVISÓRIA**.
   - _Evidência:_ Contrato canônico de reservatório do sistema R3B.
   - _Ressalva:_ Sem confirmação se a ThingsBoard calcula volume em litros, m³ ou se depende de calibração geométrica prévia na nuvem.
6. **Outras chaves (`ppl`, `consumo_delta`)**: **BLOCKED**.
   - Chaves sem especificação semântica comprovada no contrato permanecem bloqueadas para ingestão.

### Estrutura de configuração

Cada variável de mapping é um objeto JSON. O operador declara a `key` real e a unidade de origem `unit` que o adaptador normaliza para o contrato canônico do frontend:

- SM-WU: `distancia` em `cm`, `nivel` em `%`, `volume` em `L`, `rssi_wifi` em `dBm`.
- SM-WA: `vazao` em `L/h`, `consumo_acumulado` em `L`, `rssi_wifi` em `dBm`; `volume` em `L` é opcional.

Unidades de origem aceitas:

- distância: `mm`, `cm`, `m`;
- volume/consumo: `mL`, `cL`, `L`, `m3` ou `m³`;
- vazão: `L/min`, `L/h`, `m3/h` ou `m³/h`;
- nível: `%`; sinal: `dBm`.

Estrutura, usando nomes deliberadamente não reais:

```json
{
  "vazao": { "key": "CHAVE_CONFIRMADA_DE_VAZAO", "unit": "L/h" },
  "consumo_acumulado": { "key": "CHAVE_CONFIRMADA_DE_CONSUMO", "unit": "L" },
  "rssi_wifi": { "key": "CHAVE_CONFIRMADA_DE_RSSI", "unit": "dBm" }
}
```

Chaves desconhecidas, unidades não suportadas, duplicação de key e timestamps sem todos os campos obrigatórios falham fechado com `MONITORIE_NOT_CONFIGURED` ou `MONITORIE_INVALID_DATA`. Uma resposta inteiramente vazia é representada como ausência de medição, nunca como zero. A data retornada pelo provedor alimenta `device.last_seen`, exibida pelo frontend como última atualização; dado antigo mantém o dispositivo offline.

## Execução ponta a ponta local

O cadastro administrativo de SM-WU e SM-WA pede modelo, MAC e fonte. O MAC é salvo em `mac_address` no formato `AA:BB:CC:DD:EE:FF`, com unicidade global; `device_code` continua obrigatório internamente e é gerado como `SMWU-AABBCCDDEEFF` ou `SMWA-AABBCCDDEEFF`. Códigos e associações de registros anteriores não são convertidos em MACs. A ação **Informar MAC** permite completar um registro legado somente depois de conferir o equipamento físico; o código interno antigo permanece estável. O MAC nunca é enviado como ID em chamadas à MonitorIE.

Um dispositivo MonitorIE pode ser ativado e pareado antes da associação. O cliente informa MAC e código de ativação. Para registros antigos ainda sem MAC, o código existente continua válido sozinho. Sem associação, snapshot e histórico não fazem requisições ao fornecedor e retornam ausência de leituras; a interface informa **Telemetria não vinculada**. Transferências e ativações anteriores são preservadas.

Em **Localizar telemetria pelo MAC**, o administrador avança uma consulta de leitura por etapa. A resposta real da MonitorIE em 23/09/2026 trouxe `mac` como chave de _telemetria_, enquanto os atributos e a lista de dispositivos não trouxeram MAC. O backend percorre a lista e lê o último valor de `mac` de cada dispositivo, respeitando o intervalo global de 70 segundos. Só associa quando o valor recente é exatamente o MAC cadastrado em um único dispositivo da lista completa e o modelo também corresponde. Nomes parecidos não contam como prova. Se o MAC faltar, aparecer em mais de um dispositivo ou pertencer a outro modelo, o equipamento continua sem telemetria vinculada. O identificador retornado pelo fornecedor fica interno ao backend e não é pedido no cadastro.

Se o MAC ou modelo de um equipamento MonitorIE já identificado for corrigido depois, a associação de telemetria é desfeita e precisa de nova descoberta pelo MAC. A correção de MAC desconhecido em registro legado preserva o vínculo preexistente.

No primeiro pareamento, o painel pode mostrar o último estado real conhecido, mesmo que a medição seja anterior ao cadastro. Em transferências, medições anteriores ao novo vínculo continuam ocultas para o novo titular; o histórico também começa no vínculo.

No painel, o SM-WA apresenta vazão instantânea e consumo acumulado reportados pela nuvem. Quando há pelo menos duas leituras após o pareamento, o consumo no período é a soma das diferenças positivas do contador acumulado; uma redução do contador é tratada como reinício e não como consumo. O SM-WU mantém o cálculo pela redução do volume do reservatório. Sem histórico suficiente, os gráficos indicam falta de dados em vez de estimar valores.

Depois de confirmar as chaves e unidades, grave os mappings em `.dev.vars`, faça a descoberta pelo MAC no painel administrativo e execute:

```sh
npm run dev:monitorie
```

Esse modo é opt-in. O `npm run dev` comum continua usando mock local e bloqueia rede externa. O frontend local permanece em `http://127.0.0.1:8788`, chama o Worker em `http://127.0.0.1:8787` e mantém os estados já existentes de carregamento, ausência de dados e erro.

O D1 possui `telemetry_cache`, `settings` e, após a migration aditiva `0007_monitorie_auth_cache.sql`, `monitorie_auth_cache`. O primeiro guarda leituras temporárias, o segundo preserva o gate global de 70 segundos e o terceiro guarda apenas o par de tokens cifrado e o lease de renovação. Nenhuma leitura da Monitor IE é copiada para as tabelas de ingestão local ou para MySQL legado.

## Cloudflare Worker

Somente depois da validação local e com autorização para alterar o ambiente remoto, aplique a migration `0007_monitorie_auth_cache.sql` e configure as credenciais pelo prompt seguro do Wrangler:

```sh
node scripts/cloudflare/wrangler.mjs secret put MONITORIE_USERNAME
node scripts/cloudflare/wrangler.mjs secret put MONITORIE_PASSWORD
node scripts/cloudflare/wrangler.mjs secret put MONITORIE_USERNAME --env preview
node scripts/cloudflare/wrangler.mjs secret put MONITORIE_PASSWORD --env preview
```

Configure os mappings confirmados como bindings do Worker sem colocá-los no frontend. Mantenha `MONITORIE_MODE=unconfigured` até as credenciais, a correspondência exata de MAC e o mapping do modelo estarem validados; então use `MONITORIE_MODE=live`. Produção e preview devem ter credenciais, `SESSION_SECRET` e D1 separados. A rotação de `SESSION_SECRET` invalida somente o cache cifrado e provoca novo login.

`MONITORIE_JWT` permanece como opção manual quando usuário/senha não forem configurados. Esse modo não renova o token. A implementação não altera a duração global dos JWTs na plataforma MonitorIE.

## Registros anteriores de validação real

Registros anteriores do projeto relatam validação da integração com a MonitorIE. Eles não comprovam, por si, a correspondência do MAC de um novo equipamento com o dispositivo remoto:

- Dispositivo **SM-WU** confirmado com as chaves: `d` (cm), `nivel` (%), `volume` (L) e `rssi_wifi` (dBm).
- Dispositivo **SM-WA** confirmado com as chaves: `vazao` (L/h), `consumo` (L) e `rssi_wifi` (dBm).
- As leituras reais retornaram conjuntos completos e timestamps consistentes.
- `MONITORIE_MODE` configurado para `live` e cache ajustado para 300 segundos.
- Ingestão direta mantida desabilitada (`INGEST_ENABLED=false`).
