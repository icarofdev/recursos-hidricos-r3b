# MonitorIE — protocolo confirmado, mapeamento dos medidores pendente

Em 17/09/2026, o suporte da IE Tecnologia forneceu o
[Swagger oficial](https://monitorie.com.br/swagger-ui.html). A interface e seu
[OpenAPI JSON](https://monitorie.com.br/v3/api-docs?group=thingsboard) foram
consultados: ThingsBoard REST API **3.6.4PE**. Isso resolve a descoberta do
protocolo comum, mas não confirma IDs, keys ou unidades dos SM-WU e SM-WA.

## Contrato confirmado e implementação local

`cloudflare/monitorie/protocol.ts` contém uma camada de leitura ainda **não
conectada aos adaptadores de produção**:

| Operação | Método e caminho |
| --- | --- |
| Login | `POST /api/auth/login` |
| Listar keys | `GET /api/plugins/telemetry/DEVICE/{deviceId}/keys/timeseries` |
| Últimas leituras | `GET /api/plugins/telemetry/DEVICE/{deviceId}/values/timeseries?keys=...&useStrictDataTypes=true` |
| Histórico | Mesmo caminho, com `keys`, `startTs`, `endTs`, `limit`, `agg=NONE`, `orderBy=ASC`, `useStrictDataTypes=true` |

O login recebe JSON com `username` e `password` e retorna `token` e
`refreshToken`. O Swagger especifica **`X-Authorization: Bearer <token>`**;
o texto encaminhado do suporte menciona genericamente Authorization.
Foi seguido o contrato explícito do Swagger, sem tentar headers alternativos.

Telemetria: objeto cujas propriedades são keys, cada uma contendo um array
de `{ ts, value }`. `ts`, `startTs` e `endTs` são Unix timestamps em
**milissegundos UTC**. Cada key conserva seu próprio timestamp. A camada
não combina medições de horários distintos nem inventa valores ausentes.
Os valores são preservados até confirmar o mapeamento e suas unidades.

O histórico usa limite explícito (até 2.000 pontos por key no cliente local).
Não há cursor/page nesse endpoint documentado. Ao atingir o limite, a camada
sinaliza `possiblyTruncated`; não apresenta a resposta como histórico completo.
Retenção, limite máximo aceito pelo servidor e estratégia de paginação temporal
continuam pendentes de confirmação. Não há loop automático de páginas.

O cliente usa destino HTTPS fixo, timeout de 10 segundos, rejeita redirects,
limita respostas a 1 MiB, valida IDs/keys/timestamps, trata 401/403/429/falhas
sem revelar corpos ou segredos e não faz retries imediatos. O callback de
token será fornecido somente por código confiável do Worker; o cliente não
lê sessão, cookies ou armazenamento do navegador.

O suporte recomenda **no mínimo 60 segundos entre consultas**. A classe
`D1MonitorieGate` coordena chamadas usando uma reserva atômica na tabela
`settings` do D1 primário, sem credenciais. Reserva conservadora de 70 segundos
(60 + timeout de 10), compartilhada por todas as chamadas dessa integração
que usem o mesmo D1, e respeita `Retry-After` maior. Cache regional sozinho
não garante essa regra. Ambientes com bancos diferentes não compartilham a
trava: não ativar consultas simultâneas com a mesma conta em preview e produção
sem coordenação compartilhada. A trava ainda não é usada por rotas de produção.

## Renovação e secrets pendentes

O suporte informou validade de **20 minutos** para o token e recomendou refresh.
O OpenAPI dessa instância lista `/api/auth/login`, mas não descreve o endpoint
de refresh. No [vídeo indicado, próximo de 4:10](https://www.youtube.com/watch?v=qoXDIUneo9w&t=250s),
o trecho inspecionado mostra consulta de telemetria; não foi possível confirmar
o request de renovação. Solicitar método, caminho, JSON e expiração do refresh
ao suporte. Não presumir os defaults de outras versões do ThingsBoard.

`loginMonitorie` implementa apenas o login documentado. Não foi chamado com
credenciais reais; não há gerenciador automático de sessão ativado. O par de
tokens retornado deve permanecer exclusivamente no backend, nunca em respostas
HTTP do Hidra, logs, cache público ou D1 em texto claro. O usuário inserirá as
credenciais diretamente como secrets do Cloudflare Worker quando essa etapa
estiver pronta; nenhum segredo foi solicitado ou cadastrado nesta etapa.

Os dois adaptadores de modelo continuam falhando explicitamente com
`MONITORIE_NOT_CONFIGURED` até confirmar o contrato específico dos equipamentos.
Nenhum `external_id` ou vínculo de cliente foi alterado.

## Pedir à IE Tecnologias

1. `deviceId` real de cada aparelho instalado, associado ao nome e modelo.
2. Keys e unidades exatas de cada SM-WU e SM-WA, com exemplos reais sem segredos.
3. Request exato de refresh: método, endpoint, JSON, escopos e expiração.
4. Identificador estável de cada equipamento e prova de qual conta pode consultá-lo.
5. Endpoints de leitura atual, estado/última comunicação e histórico.
6. Exemplos reais sem segredos: nomes de campos, unidade de distância/volume/nível,
   formato/fuso de datas e significado dos estados.
7. Histórico: filtros temporais, ordenação, paginação, tamanho máximo e retenção.
8. Esclarecer se o mínimo de 60s vale por conta, equipamento ou endpoint;
   demais cotas, respostas 429, Retry-After e política de IPs.
9. Confirmar que o SM-WU consegue enviar diretamente para a nuvem contratada.
   O gateway local do firmware HTTP antigo não fará parte desta implantação.

## Implementar o contrato interno

`cloudflare/monitorie/adapter.ts` define:

```ts
interface MonitorieAdapter {
  snapshot(scope: TelemetryScope): Promise<Snapshot>;
  history(scope: TelemetryScope, since: number, limit: number): Promise<Reading[]>;
}
```

Isso é o contrato interno do dashboard, **não o contrato da API da Monitorie**.
O scope contém ID interno, ID externo provisionado pelo administrador, instante
do vínculo e limiar de offline. Não confiar em ID externo enviado pelo navegador.
O adaptador real deve mapear os dados documentados, converter unidades/datas,
aplicar timeout, rejeitar redirecionamentos, limitar tamanho e número de páginas
e transformar falhas em erros seguros. Nunca retornar credenciais/corpo bruto.

Snapshot: estado online/offline e última comunicação ISO 8601, leitura opcional
com id, distancia (cm), nivel (%), volume (litros), rssi_wifi (dBm), timestamp.
Confirmar unidades com a IE antes de implementar qualquer conversão.
Histórico: no máximo 2.000 registros validados, na janela pedida.

O serviço rejeita respostas inválidas e filtra dados anteriores ao vínculo
atual, inclusive em cache. Isso evita expor leituras do antigo dono quando um
equipamento troca de conta. O pareamento local continua exigindo código de uso
único entregue pelo administrador ao proprietário correto.

## Cache e indisponibilidade

- Cache API do Worker, TTL `MONITORIE_CACHE_SECONDS` (60s padrão; 15–3.600).
- Chave inclui usuário, reservatório, dispositivo, vínculo, fonte e janela.
- A autorização D1 é validada antes de cada leitura do cache.
- Cache negativo por 15s para falhas; a conta/renomeação/logout continuam ativos.
- O cache é regional (por centro de dados), sujeito a remoção antecipada. Não
  representa uma cota global de uma chamada por minuto; vários centros podem
  consultar o mesmo equipamento. Solicitações simultâneas em cache frio também
  podem chegar ao provedor. Conhecer a cota real antes da ativação.
- Cache de leitura nunca atualiza artificialmente a última comunicação.
- O histórico permanece na Monitorie; não é duplicado automaticamente no D1.

## Desenvolvimento

O mock só funciona com `APP_ENV=development`, `MONITORIE_MODE=mock`, acesso por
localhost/loopback e dispositivo com `source=mock`. URLs públicas recusam a
configuração simulada; dispositivos `source=monitorie` nunca recebem fallback
silencioso de dados falsos. A tela local mostra uma faixa de demonstração.

Depois de implementar o protocolo e testar com fixtures anonimizadas, cadastrar
os IDs reais via script administrativo e validar com a IE. Não converter um
dispositivo mock em produção nem copiar dados simulados para o D1 publicado.
