# Monitorie — integração pendente da especificação real

Nenhuma especificação da API Monitorie foi encontrada no código ou documentos
do projeto. Não há endereço, cabeçalho de autenticação ou formato de resposta
suposto. Preencher secrets não é suficiente para concluir o adaptador.

## Pedir à IE Tecnologias

1. Documentação oficial/versionamento e URL HTTPS base da API.
2. Confirmação de acesso à API no plano da nuvem já contratado e respectivas cotas.
3. Autenticação: emissão, escopos, renovação e expiração das credenciais.
4. Identificador estável de cada equipamento e prova de qual conta pode consultá-lo.
5. Endpoints de leitura atual, estado/última comunicação e histórico.
6. Exemplos reais sem segredos: nomes de campos, unidade de distância/volume/nível,
   formato/fuso de datas e significado dos estados.
7. Histórico: filtros temporais, ordenação, paginação, tamanho máximo e retenção.
8. Limites, respostas 429, Retry-After, timeouts, webhooks opcionais e política de IPs.
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
