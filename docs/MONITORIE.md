# MonitorIE — Protocolo Confirmado e Pendências Técnicas

Este documento descreve o estado atual da integração com a plataforma **MonitorIE** (IE Tecnologia), os componentes implementados e os itens técnicos bloqueantes que dependem de definições do fornecedor.

---

## 1. Estado da Integração: BLOQUEADO (Fail-Closed)

A integração real em produção permanece **bloqueada** aguardando fornecimento de informações contratuais e técnicas pela IE Tecnologia.

- **Comportamento em Produção:** Qualquer tentativa de consulta a dispositivos configurados com `source = 'monitorie'` sem a configuração completa retorna erro seguro `503 Service Unavailable` com o código `MONITORIE_NOT_CONFIGURED`.
- **Prevenção de Vazamento e Dados Falsos:** Nenhum dado simulado ou inventado é retornado em ambiente de produção.
- **Ambiente de Testes / Mock:** O modo simulado (`source = 'mock'`) opera estritamente em ambiente local (`ENVIRONMENT === 'local'`), restrito a endereços de loopback (`127.0.0.1`), sendo categoricamente rejeitado em produção e preview.

---

## 2. Protocolo Confirmado (ThingsBoard 3.6.4 PE)

Com base no Swagger oficial fornecido pelo suporte (`https://monitorie.com.br/swagger-ui.html`), a API é baseada na plataforma ThingsBoard REST API v3.6.4 PE:

| Ação                        | Método | Endpoint                                                     | Cabeçalhos / Parâmetros                                         |
| --------------------------- | ------ | ------------------------------------------------------------ | --------------------------------------------------------------- |
| **Autenticação (Login)**    | `POST` | `/api/auth/login`                                            | JSON `{ "username": "...", "password": "..." }`                 |
| **Listar Keys Disponíveis** | `GET`  | `/api/plugins/telemetry/DEVICE/{deviceId}/keys/timeseries`   | `X-Authorization: Bearer <token>`                               |
| **Últimas Leituras**        | `GET`  | `/api/plugins/telemetry/DEVICE/{deviceId}/values/timeseries` | `keys=...&useStrictDataTypes=true`                              |
| **Série Histórica**         | `GET`  | `/api/plugins/telemetry/DEVICE/{deviceId}/values/timeseries` | `keys=...&startTs=...&endTs=...&limit=...&agg=NONE&orderBy=ASC` |

### Características da Camada de Rede

- **Destino Fixo:** Comunicação restrita via HTTPS ao domínio oficial `monitorie.com.br`.
- **Timeout Rígido:** 10 segundos por requisição com rejeição expressa de redirecionamentos HTTP (evita SSRF).
- **Limite de Payload:** Limite de 1 MiB por resposta para proteção de memória do Worker.
- **Formato Temporal:** Timestamps em milissegundos UTC. Os dados retornados preservam a precisão temporal original.

---

## 3. Pendências Críticas a Obter com a IE Tecnologia

Para desbloquear a implementação do adaptador de produção, os seguintes itens devem ser formalmente respondidos pelo fornecedor:

### 1. Endpoint e Mecanismo de Refresh de Token

- O suporte informou que o token de autenticação expira a cada **20 minutos** e recomendou a utilização de renovação (refresh).
- O OpenAPI oficial não documenta o endpoint exato de refresh para a versão instalada.
- **Necessário:** Método HTTP, caminho do endpoint, formato do corpo JSON e tempo de vida do novo token retornado.

### 2. Mapeamento de Dispositivos e Hardware

- **Necessário:** Relação exata entre o `deviceId` da API da MonitorIE e o número de série / identificador físico de cada medidor SM-WU e SM-WA instalado.

### 3. Nomes de Chaves (Keys) e Unidades de Medida

- O ThingsBoard armazena séries temporais com chaves arbitrárias definidas pelo firmware/dispositivo.
- **Necessário para o SM-WU (Medidor de Nível / Ultrassom):**
  - Nome exato da chave de nível/distância e sua unidade de medida (centímetros, milímetros, metros, percentual?).
  - Fórmulas de calibração ou faixas úteis do sensor ultrassônico.
  - Chaves de diagnóstico adicionais (bateria, RSSI Wi-Fi, status de sensor).
- **Necessário para o SM-WA (Medidor de Água / Hidrômetro):**
  - Nome exato da chave de vazão e unidade (litros/minuto, m³/hora, etc.).
  - Nome da chave de volume acumulado e unidade (litros ou m³).
  - Fator de pulso ou resolução métrica do sensor.

### 4. Limites de Requisição (Rate Limits) e Cotas

- O suporte orientou intervalo mínimo de **60 segundos** entre requisições.
- **Necessário confirmar:**
  - Se o limite de 60s se aplica por conta de usuário, por dispositivo (`deviceId`) ou por endpoint.
  - Qual o código e formato de resposta para excesso de requisições (HTTP 429) e se é retornado cabeçalho `Retry-After`.
  - Se há restrição de IP de saída (Cloudflare Workers utilizam blocos de IPs dinâmicos distribuídos globalmente).

---

## 4. Arquitetura de Cache e Proteção contra Concorrência

Para atender a restrição de 60 segundos do fornecedor e otimizar recursos do Cloudflare Worker:

1. **Coordenação Global via D1 (`D1MonitorieGate`):**
   - Implementado em `cloudflare/monitorie/cache.ts`.
   - Utiliza lock atômico na tabela `settings` do Cloudflare D1.
   - Garante espaçamento de 70 segundos entre consultas ao mesmo dispositivo, prevenindo bloqueio por concorrência entre instâncias distintas do Worker.
2. **Desduplicação Single-Flight em Memória (`SingleFlight`):**
   - Implementado em `cloudflare/monitorie/single-flight.ts`.
   - Múltiplas requisições simultâneas ao mesmo dispositivo na mesma instância do Worker compartilham uma única Promise em voo, eliminando chamadas duplicadas ao fornecedor.
3. **Cache de Snapshots:**
   - Respostas válidas são cacheadas por 60 segundos.
   - Falhas temporárias recebem cache negativo de 15 segundos para evitar tempestade de requisições (thundering herd).
