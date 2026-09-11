# Recursos Hídricos R3B — SM-WU

Dashboard PHP conectado à telemetria real do medidor de nível ultrassônico SM-WU. O navegador consulta somente a API PHP e nunca recebe credenciais de dispositivo, MQTT ou banco.

```text
SM-WU ──HTTPS/POST──► api/device/ingest.php ──► MySQL/MariaDB ──► API PHP ──► dashboard
```

O SM-WU e o dashboard não precisam estar na mesma rede Wi-Fi. O endpoint precisa ficar acessível pela Internet; `php -S 127.0.0.1:8080 router.php` é apenas desenvolvimento local.

## Contrato de dados

O contrato canônico contém os três valores medidos pelo SM-WU:

```json
{
  "id": 1,
  "distancia": 42.50,
  "nivel": 75.00,
  "volume": 1253.00,
  "rssi_wifi": -60.00
}
```

`id` deve ser um inteiro positivo. No MQTT, também deve coincidir com `{id}` do tópico. A V5.10 envia a distância como `d`; a entrada HTTP converte esse nome para `distancia`, aceita nomes em maiúsculas e normaliza números em texto. Campos ausentes, desconhecidos, duplicados, valores fora das faixas básicas e dispositivos não autorizados são rejeitados.

O status MQTT opcional usa `sm-wu/{id}/status`, QoS 1 e retenção:

```json
{"id":1,"status":"online"}
```

O dispositivo pode publicar `online` ao conectar e configurar uma Last Will retida com `{"id":1,"status":"offline"}`.

## Requisitos

- PHP 8.1 ou superior com `json`, `openssl`, `PDO` e `pdo_mysql`;
- Composer 2;
- MySQL 8+ ou MariaDB 10.2+;
- EMQX Cloud (ou outro broker MQTT) somente se a integração MQTT opcional for usada;
- um processo PHP CLI persistente para o subscriber.

## Configuração

```powershell
composer install
Copy-Item .env.example .env
```

O `.env.example` já parte da configuração online do deployment `smwa-r3b`:

- `MQTT_HOST=r10116ac.ala.us-east-1.emqxsl.com` (confirme o hostname no EMQX Cloud antes de usar);
- `MQTT_PORT=8883`, `MQTT_TLS=true` e `MQTT_TLS_VERIFY_PEER=true`;
- `MQTT_USERNAME=smwa_device` e `MQTT_PASSWORD` com a senha local do deployment;
- `MQTT_TOPIC=sm-wu/+/data` e `MQTT_STATUS_TOPIC=sm-wu/+/status`;
- `MQTT_ALLOWED_DEVICE_IDS`, por exemplo `1` ou `1,2,3`;
- `SMWU_DEVICE_TOKEN` com um token forte para o fallback HTTPS.

Não versione `.env`, senha MQTT nem token. Se a rede bloquear TCP `8883`, não desative TLS: execute `powershell -ExecutionPolicy Bypass -File scripts/test-mqtt-cloud.ps1` e use o fallback HTTPS abaixo.

Também é possível sobrescrever no `.env`:

- `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME` e `DB_PASSWORD`;
- `MQTT_HOST`, `MQTT_PORT`, `MQTT_USERNAME` e `MQTT_PASSWORD`;
- `MQTT_TLS_CA_FILE` somente se o PHP não encontrar a CA confiável do sistema.

O `.env` está ignorado pelo Git. Em produção, use autenticação, TLS e ACL que permitam a cada dispositivo publicar apenas em seus próprios tópicos.

### Banco de dados

Importe [database/schema.sql](database/schema.sql):

```bash
mysql --host=127.0.0.1 --port=3306 --user=root --password < database/schema.sql
```

O schema cria `devices` e `smwu_readings`. `smwu_readings` mantém o histórico integral de `id`, `distancia`, `nivel`, `volume`, `rssi_wifi` e o horário de recebimento. A tabela legada `sensor_readings` continua no schema para preservar dados anteriores do SM-WA, mas não é usada pela dashboard do SM-WU.

## Execução

Se optar por MQTT, instale o serviço de exemplo [deploy/systemd/smwa-subscriber.service.example](deploy/systemd/smwa-subscriber.service.example), ajuste o caminho do projeto e habilite-o no `systemd`.

Para um teste manual local:

```powershell
php mqtt/subscriber.php
```

Em outro terminal, sirva a aplicação com o roteador fornecido:

```powershell
php -S 127.0.0.1:8080 router.php
```

Abra [http://127.0.0.1:8080](http://127.0.0.1:8080). No Apache/XAMPP, aponte o `DocumentRoot` ou um Alias para esta pasta e mantenha as regras do `.htaccess` habilitadas.

Para um túnel de teste, publique uma segunda instância restrita somente à ingestão. Assim a dashboard e os endpoints de consulta não ficam expostos:

```powershell
php -S 127.0.0.1:8081 device-ingest-router.php
```

O subscriber usa MQTT 3.1.1, sessão persistente, backoff de reconexão e os filtros existentes:

```text
sm-wu/+/data
sm-wu/+/status
```

Falhas de validação são registradas sem derrubar o processo. Em falha de banco, o worker refaz a conexão e a sessão MQTT permite ao broker enfileirar as mensagens seguintes conforme a configuração de QoS/sessão.

### Fallback HTTPS

Configure o SM-WU em **Tipo de envio: Padrão** e **Protocolo: POST**. Envie para `POST /api/device/ingest.php` com `Authorization: Bearer SEU_TOKEN` (ou `X-Device-Token`) quando o firmware permitir cabeçalhos. O endpoint aceita:

```json
{
  "id": 1,
  "distancia": 42.5,
  "nivel": 75.0,
  "volume": 1253.0,
  "rssi_wifi": -60.0
}
```

O token vem de `SMWU_DEVICE_TOKEN`; token ausente ou inválido não grava nada. A validação e a persistência são as mesmas usadas pelo caminho MQTT, e a leitura aparece em `api/device/current.php?id=1`.

Firmwares que não oferecem configuração de cabeçalhos podem usar `POST /api/device/ingest.php?token=SEU_TOKEN`. Esse formato só é aceito quando a requisição original usa HTTPS. O SM-WU envia `Content-Type: application/json` e pode serializar todos os valores como strings; a entrada HTTP normaliza antes de validar. Prefira cabeçalho quando possível e configure o servidor web para não registrar query strings.

O firmware V5.10 força HTTP no campo de servidor. Para manter TLS fora da rede local, execute o gateway em uma interface privada:

```powershell
php -S 192.168.0.2:8082 smwu-gateway-router.php
```

Configure o equipamento com servidor `192.168.0.2`, porta `8082` e caminho `/smwu`. O gateway aceita somente os IPs de `SMWU_LOCAL_DEVICE_IPS` e retransmite para `SMWU_FORWARD_URL` por HTTPS, usando o token somente no cabeçalho. A senha/token não fica armazenada no equipamento.

```text
SM-WU ──HTTPS──► api/device/ingest.php ──► MySQL/MariaDB ──► API PHP ──► dashboard
```

Exemplo de teste:

```bash
curl -X POST http://127.0.0.1:8080/api/device/ingest.php \
  -H 'Authorization: Bearer SEU_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"id":1,"distancia":42.5,"nivel":75.0,"volume":1253.0,"rssi_wifi":-60.0}'
```

## API PHP

Os endpoints de consulta aceitam apenas `GET`, respondem JSON sem cache e podem ser filtrados com `?id=1`:

- `api/device/current.php`: leitura mais recente e estado do dispositivo;
- `api/device/history.php?hours=24&limit=300`: histórico do período;
- `api/device/status.php`: estado e última comunicação;
- `api/device/alerts.php`: alertas de perda de comunicação e nível baixo/crítico.

`api/device/ingest.php` aceita somente `POST` autenticado e não é usado pelo navegador.

Sem `id`, a API usa o dispositivo que se comunicou mais recentemente. O horário é gravado em UTC e devolvido no fuso `APP_TIMEZONE`. O dispositivo passa a `offline` quando recebe a Last Will correspondente ou quando ultrapassa `DEVICE_OFFLINE_AFTER_SECONDS` sem comunicação.

Exemplo de resposta da leitura atual:

```json
{
  "success": true,
  "device": {
    "id": 1,
    "status": "online",
    "last_seen": "2026-08-20T12:00:00-03:00",
    "offline_after_seconds": 90
  },
  "data": {
    "id": 1,
    "distancia": 42.5,
    "nivel": 75.0,
    "volume": 1253.0,
    "rssi_wifi": -60.0,
    "timestamp": "2026-08-20T12:00:00-03:00"
  }
}
```

## Dashboard

`index.php` preserva o layout, CSS, responsividade e componentes existentes. `static/js/dashboard.js` consulta a API a cada 5 segundos, sincroniza o histórico a cada 30 segundos e exibe os quatro valores reais. Os filtros do gráfico alternam entre `nivel`, `volume`, `distancia` e `rssi_wifi`; nenhuma série é simulada ou estimada.

## Testes

A suíte usa SQLite em memória e não precisa de broker nem MySQL:

```powershell
composer test
```

Para publicar uma vez o payload de exemplo no broker configurado no `.env`:

```powershell
php mqtt/publish_test.php 1
```

Depois consulte:

```text
http://127.0.0.1:8080/api/device/current.php?id=1
http://127.0.0.1:8080/api/device/history.php?id=1&hours=24&limit=100
http://127.0.0.1:8080/api/device/status.php?id=1
```

## Arquivos principais

- `mqtt/subscriber.php`: subscriber MQTT persistente;
- `api/device/ingest.php`: fallback HTTPS autenticado para telemetria;
- `smwu-gateway-router.php`: upgrade de HTTP local do firmware V5.10 para HTTPS;
- `mqtt/publish_test.php`: publicação manual do payload real de exemplo;
- `scripts/test-mqtt-cloud.ps1`: diagnóstico inicial de DNS e TCP `8883` no Windows;
- `deploy/systemd/smwa-subscriber.service.example`: execução contínua do subscriber em produção;
- `src/Mqtt/`: tópicos, validação e cliente MQTT;
- `src/DeviceRepository.php`: persistência, estado e histórico;
- `api/device/`: API consumida pelo dashboard;
- `database/schema.sql`: schema MySQL/MariaDB;
- `index.php` e `static/js/dashboard.js`: interface e integração da API.
