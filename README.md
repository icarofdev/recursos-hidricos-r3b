# Recursos Hídricos R3B — SM-WA

Dashboard PHP conectado à telemetria real do SM-WA. O navegador consulta somente a API PHP; credenciais de MQTT e banco não são enviadas ao frontend.

```text
SM-WA ──MQTT──► mqtt/subscriber.php ──► MySQL/MariaDB ──► API PHP ──► dashboard
```

## Contrato de dados

O dispositivo publica em `sm-wa/{id}/data`, com QoS configurável e sem retenção. O payload possui somente os cinco campos reais:

```json
{
  "id": 1,
  "ppl": 1.00,
  "vazao": 0.00,
  "consumo": 1253.00,
  "rssi_wifi": -60.00
}
```

`id` deve ser um inteiro positivo e deve coincidir com o trecho `{id}` do tópico. Os demais campos devem ser números JSON. Leituras retidas, campos ausentes, campos desconhecidos, valores fora das faixas básicas e dispositivos não autorizados são rejeitados.

O status opcional usa `sm-wa/{id}/status`, QoS 1 e retenção:

```json
{"id":1,"status":"online"}
```

O dispositivo pode publicar `online` ao conectar e configurar uma Last Will retida com `{"id":1,"status":"offline"}`.

## Requisitos

- PHP 8.1 ou superior com `json`, `openssl`, `PDO` e `pdo_mysql`;
- Composer 2;
- MySQL 8+ ou MariaDB 10.2+;
- broker MQTT acessível pelo SM-WA e pelo subscriber PHP;
- um processo PHP CLI persistente para o subscriber.

## Configuração

```powershell
composer install
Copy-Item .env.example .env
```

Preencha no `.env`:

- `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME` e `DB_PASSWORD`;
- `MQTT_HOST`, `MQTT_PORT`, `MQTT_USERNAME` e `MQTT_PASSWORD`;
- `MQTT_ALLOWED_DEVICE_IDS`, por exemplo `1` ou `1,2,3`;
- `MQTT_TLS=true` e `MQTT_TLS_CA_FILE` quando o broker usar TLS.

O `.env` está ignorado pelo Git. Em produção, use autenticação, TLS e ACL que permitam a cada dispositivo publicar apenas em seus próprios tópicos.

### Banco de dados

Importe [database/schema.sql](database/schema.sql):

```bash
mysql --host=127.0.0.1 --port=3306 --user=root --password < database/schema.sql
```

O schema cria `devices` e `sensor_readings`. `sensor_readings` mantém o histórico integral de `id`, `ppl`, `vazao`, `consumo`, `rssi_wifi` e o horário de recebimento. Se o schema antigo de reservatório chegou a ser importado durante a execução anterior, recrie essas duas tabelas com o schema atual antes de iniciar o subscriber; os campos antigos não representam a telemetria do SM-WA e não são convertidos automaticamente.

## Execução

Inicie o subscriber em um terminal persistente:

```powershell
php mqtt/subscriber.php
```

Em outro terminal, sirva a aplicação com o roteador fornecido:

```powershell
php -S 127.0.0.1:8080 router.php
```

Abra [http://127.0.0.1:8080](http://127.0.0.1:8080). No Apache/XAMPP, aponte o `DocumentRoot` ou um Alias para esta pasta e mantenha as regras do `.htaccess` habilitadas.

O subscriber usa MQTT 3.1.1, sessão persistente, backoff de reconexão e os filtros existentes:

```text
sm-wa/+/data
sm-wa/+/status
```

Falhas de validação são registradas sem derrubar o processo. Em falha de banco, o worker refaz a conexão e a sessão MQTT permite ao broker enfileirar as mensagens seguintes conforme a configuração de QoS/sessão.

## API PHP

Todos os endpoints aceitam apenas `GET`, respondem JSON sem cache e podem ser filtrados com `?id=1`:

- `api/device/current.php`: leitura mais recente e estado do dispositivo;
- `api/device/history.php?hours=24&limit=300`: histórico do período;
- `api/device/status.php`: estado e última comunicação;
- `api/device/alerts.php`: alerta de perda de comunicação.

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
    "ppl": 1.0,
    "vazao": 0.0,
    "consumo": 1253.0,
    "rssi_wifi": -60.0,
    "timestamp": "2026-08-20T12:00:00-03:00"
  }
}
```

## Dashboard

`index.php` preserva o layout, CSS, responsividade e componentes existentes. `static/js/dashboard.js` consulta a API a cada 5 segundos, sincroniza o histórico completo a cada 30 segundos e exibe diretamente os quatro valores reais. Os filtros do gráfico alternam entre `consumo`, `vazao`, `ppl` e `rssi_wifi`; nenhuma série é simulada ou estimada.

## Testes

A suíte usa SQLite em memória e não precisa de broker nem MySQL:

```powershell
composer test
```

Para publicar o payload de exemplo em um broker configurado no `.env`:

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
- `mqtt/publish_test.php`: publicação manual do payload real de exemplo;
- `src/Mqtt/`: tópicos, validação e cliente MQTT;
- `src/DeviceRepository.php`: persistência, estado e histórico;
- `api/device/`: API consumida pelo dashboard;
- `database/schema.sql`: schema MySQL/MariaDB;
- `index.php` e `static/js/dashboard.js`: interface e integração da API.
