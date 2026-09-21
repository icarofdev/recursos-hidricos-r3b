# Monitor IE — JWT, contrato de leitura e validação

O backend integra-se à API oficial em `https://monitorie.com.br`. O navegador continua autenticado pela sessão do Hidra e chama somente o Cloudflare Worker; o JWT externo nunca é incluído no frontend, D1, cache, resposta ou log.

## Contrato confirmado

O Swagger oficial em `https://monitorie.com.br/swagger-ui/` identifica a instalação como ThingsBoard Professional Edition `3.6.4PE` e documenta:

| Operação                | Método e caminho                                                 | Observações                                                                                     |
| ----------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Dispositivos acessíveis | `GET /api/user/devices`                                          | `page` começa em `0`; `pageSize` é obrigatório; resposta `PageData<Device>`                     |
| Chaves de telemetria    | `GET /api/plugins/telemetry/DEVICE/{deviceId}/keys/timeseries`   | `deviceId` é UUID                                                                               |
| Últimos valores         | `GET /api/plugins/telemetry/DEVICE/{deviceId}/values/timeseries` | `keys` e `useStrictDataTypes=true`                                                              |
| Histórico               | mesmo caminho de valores                                         | `keys`, `startTs`, `endTs`, `limit`, `agg=NONE`, `orderBy=ASC`; timestamps UTC em milissegundos |

A autenticação confirmada é `X-Authorization: Bearer <JWT>`. O JWT copiado em **Account > Security** é usado diretamente pelo Worker como `MONITORIE_JWT`. O projeto não envia usuário/senha, não usa `Authorization` comum e não implementa login ou refresh automático. Um JWT ausente, expirado, revogado ou sem permissão produz erro controlado e não afeta as contas do Hidra.

O cliente aceita somente a origem HTTPS fixa `monitorie.com.br`, rejeita redirects, limita respostas a 1 MiB, usa timeout de 10 segundos e mapeia 401, 403, 404, 429, 5xx, timeout e resposta inválida sem repassar corpo ou detalhes internos.

## Descoberta local sem expor o JWT

Crie `.dev.vars` localmente (o arquivo é ignorado pelo Git) e preencha o JWT fora da conversa:

```dotenv
MONITORIE_JWT=
MONITORIE_SMWU_MAPPING=
MONITORIE_SMWA_MAPPING=
```

Nunca use `VITE_`, `NEXT_PUBLIC_`, `PUBLIC_` ou argumento de linha de comando para o token. O utilitário abaixo lê `.dev.vars`, faz exatamente uma chamada de leitura por execução e não imprime o JWT:

No PowerShell, depois de usar **Copy JWT token** na página, salve-o sem exibi-lo e limpe a área de transferência:

```powershell
Get-Clipboard | npm --silent run monitorie:store-jwt
Set-Clipboard -Value ''
```

Se o navegador usar uma área de transferência isolada, execute `npm run monitorie:store-jwt-browser`, abra somente `http://127.0.0.1:8790/`, cole no campo de senha e salve. O servidor aceita uma única gravação local e encerra em seguida.

```sh
npm run monitorie:probe -- devices --page 0
npm run monitorie:probe -- keys --device-id UUID_CONFIRMADO
npm run monitorie:probe -- latest --device-id UUID_CONFIRMADO --keys chave1,chave2
npm run monitorie:probe -- history --device-id UUID_CONFIRMADO --keys chave1,chave2 --hours 24 --limit 500
```

Respeite pelo menos 70 segundos entre execuções enquanto o limite informado pelo suporte não for formalmente detalhado. As consultas são somente leitura; não alteram dispositivos, alarmes ou configurações.

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

Depois de confirmar IDs, keys e unidades, grave os mappings em `.dev.vars`, provisione no D1 local um dispositivo `source='monitorie'` cujo `external_id` seja o UUID confirmado e execute:

```sh
npm run dev:monitorie
```

Esse modo é opt-in. O `npm run dev` comum continua usando mock local e bloqueia rede externa. O frontend local permanece em `http://127.0.0.1:8788`, chama o Worker em `http://127.0.0.1:8787` e mantém os estados já existentes de carregamento, ausência de dados e erro.

O D1 já possui `telemetry_cache` e `settings`; não é necessária migration nova. O cache evita chamadas repetidas e o gate D1 preserva um intervalo global conservador de 70 segundos. Nenhuma leitura da Monitor IE é copiada para as tabelas de ingestão local ou para MySQL legado.

## Cloudflare Worker

Somente depois da validação local e com autorização para alterar o ambiente remoto, insira o JWT pelo prompt seguro:

```sh
node scripts/cloudflare/wrangler.mjs secret put MONITORIE_JWT
node scripts/cloudflare/wrangler.mjs secret put MONITORIE_JWT --env preview
```

Configure os mappings confirmados como bindings do Worker sem colocá-los no frontend. Mantenha `MONITORIE_MODE=unconfigured` até o JWT, o UUID e o mapping do modelo estarem validados; então use `MONITORIE_MODE=live`. Produção e preview devem ter credenciais e D1 separados.

JWTs da página Account > Security expiram. Quando isso ocorrer, copie um novo token e substitua o secret. Não existe renovação automática nesta integração porque esse fluxo não foi solicitado nem comprovado para o token fornecido.

## Pendências para comprovação real

Sem um `MONITORIE_JWT` válido em `.dev.vars`, não é possível provar uma chamada real. Depois do primeiro `devices`, ainda é necessário confirmar qual UUID corresponde fisicamente a cada SM-WU/SM-WA; depois de `keys`/`latest`, confirmar semanticamente cada campo e unidade. Esses são os únicos dados externos restantes para a validação Monitor IE → Worker → frontend.
