# Recursos Hídricos R3B — SM-WA

Dashboard PHP para monitorar o reservatório medido por um ESP32/HC-SR04. O navegador não se conecta ao MQTT e nunca recebe as credenciais do broker.

```text
SM-WA (ESP32 + HC-SR04)
        │ publica MQTT
        ▼
     broker MQTT
        │ assinatura persistente
        ▼
mqtt/subscriber.php ──► MySQL/MariaDB ──► API PHP ──► dashboard existente
```

O CSS, a responsividade, os componentes visuais e o Chart.js 4.5.1 local foram preservados. A dashboard consulta a API por polling, com intervalo inicial de 5 segundos.

## Dados utilizados

O projeto e o firmware existentes só medem dados do reservatório. Por isso, o contrato final não inventa pressão, vazão, temperatura ou bateria:

- `device_id`;
- `nivel_cm`;
- `capacidade_cm`;
- `percentual`;
- `volume_litros`.

O horário é atribuído pelo subscriber no recebimento da mensagem, em UTC no banco, e devolvido pela API em `APP_TIMEZONE`. O arquivo legado `iot_database.db` contém apenas registros simulados e permanece como arquivo histórico; ele não é importado automaticamente nem é usado pela aplicação PHP.

## Requisitos

- PHP 8.1 ou superior com `json`, `openssl`, `PDO` e `pdo_mysql`;
- Composer 2;
- MySQL 8+ ou MariaDB 10.2+;
- um broker MQTT acessível pelo computador do subscriber e pelo ESP32;
- permissão para manter um processo PHP CLI em execução;
- para o firmware: ESP32, ArduinoJson e `espMqttClient` 1.7.3.

O ambiente XAMPP verificado neste projeto possui PHP 8.2.12 e MariaDB 10.4.32, compatíveis. Em hospedagem compartilhada que não permita processos persistentes, execute o subscriber em uma máquina, VPS, contêiner ou serviço que permaneça ativo; não o exponha como uma requisição HTTP.

## Instalação

Na raiz do projeto:

```powershell
composer install
Copy-Item .env.example .env
Copy-Item assets/ino/secrets.example.h assets/ino/secrets.h
```

Em produção, prefira `composer install --no-dev --optimize-autoloader`. Em Linux/macOS, use `cp` no lugar de `Copy-Item`.

Edite `.env`. As variáveis que normalmente precisam ser preenchidas são:

- `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME` e `DB_PASSWORD`;
- `MQTT_HOST`, `MQTT_PORT`, `MQTT_USERNAME` e `MQTT_PASSWORD`;
- `MQTT_ALLOWED_DEVICE_IDS`, inicialmente `ESP32_001`;
- `MQTT_TLS=true` e `MQTT_TLS_CA_FILE`, caso o broker use TLS.

`MQTT_USERNAME` e `MQTT_PASSWORD` podem ficar vazios apenas em um broker local configurado deliberadamente sem autenticação. Em produção, use autenticação, ACL limitada aos tópicos necessários e TLS. O arquivo `.env` e `assets/ino/secrets.h` estão ignorados pelo Git.

### Criar o banco

Importe [database/schema.sql](database/schema.sql) com phpMyAdmin ou com o cliente MySQL:

```bash
mysql --host=127.0.0.1 --port=3306 --user=root --password < database/schema.sql
```

O script cria o banco `recursos_hidricos` e as tabelas `devices` e `sensor_readings`. Se o usuário da aplicação não puder criar bancos, importe o schema com um usuário administrativo e conceda ao usuário da aplicação somente as permissões necessárias nesse banco.

Se usar outro valor em `DB_DATABASE`, altere as instruções `CREATE DATABASE` e `USE` no início do schema antes da importação.

## Executar

Inicie primeiro o subscriber em um terminal que permaneça aberto:

```powershell
php mqtt/subscriber.php
```

No XAMPP deste computador, quando `php` não estiver no `PATH`:

```powershell
& 'C:\xampp\php\php.exe' mqtt/subscriber.php
```

Os logs mostram conexão, assinatura, mensagens aceitas ou rejeitadas, gravações e reconexões, sem imprimir usuário ou senha. Para produção, supervisione o comando com systemd, Supervisor, Docker, NSSM ou Agendador de Tarefas do Windows.

O subscriber usa MQTT 3.1.1, client ID estável e sessão persistente. Após a primeira assinatura, um broker configurado para sessões persistentes pode enfileirar mensagens QoS 1 enquanto o worker estiver temporariamente fora do ar. Ao alterar os filtros de tópicos, troque também `MQTT_CLIENT_ID` ou remova a sessão antiga no broker.

O backoff cresce em quedas repetidas, recebe jitter e só volta ao mínimo depois de uma conexão estável por `MQTT_RECONNECT_RESET_AFTER_SECONDS`. Status retidos atualizam o estado reportado sem transformar o instante da reassinatura em uma falsa última comunicação; leituras retidas são recusadas.

Para servir localmente com o servidor embutido do PHP, use obrigatoriamente o roteador fornecido:

```powershell
& 'C:\xampp\php\php.exe' -S 127.0.0.1:8080 router.php
```

Abra [http://127.0.0.1:8080](http://127.0.0.1:8080). Não inicie com apenas `php -S ... -t .`, pois isso tornaria arquivos internos da raiz acessíveis.

No Apache/XAMPP, aponte o `DocumentRoot` ou um Alias para esta pasta, habilite `mod_rewrite` e permita o uso do `.htaccess` (`AllowOverride All`). O `.htaccess` e o roteador local deixam públicos somente `index.php`, os três assets atuais e os quatro endpoints. Se `mod_rewrite` estiver indisponível, o `.htaccess` bloqueia o acesso por segurança.

## MQTT

Tópicos escaláveis utilizados:

```text
sm-wa/ESP32_001/data
sm-wa/ESP32_001/status
```

O subscriber usa os filtros:

```text
sm-wa/+/data
sm-wa/+/status
```

Payload de leitura, QoS 1 e sem retenção:

```json
{
  "device_id": "ESP32_001",
  "nivel_cm": 112.5,
  "capacidade_cm": 150.0,
  "percentual": 75,
  "volume_litros": 1125.0
}
```

Payload de status, QoS 1 e retido:

```json
{"device_id":"ESP32_001","status":"online"}
```

O ESP32 publica `online` ao conectar e configura uma Last Will retida com `offline`. Toda mensagem precisa ter JSON válido, identificador igual ao trecho do tópico, tipos numéricos reais, valores dentro das faixas permitidas e tamanho menor que `MQTT_MAX_PAYLOAD_BYTES`.

Configure também no broker um limite de pacote compatível e ACLs que permitam ao dispositivo publicar somente em seus próprios tópicos. O limite PHP é uma segunda barreira, aplicada depois que a biblioteca MQTT já recebeu o pacote.

### Configurar o ESP32

Edite apenas a cópia local `assets/ino/secrets.h`:

- `WIFI_SSID` e `WIFI_PASSWORD`;
- `MQTT_HOST` com o IP ou DNS do broker alcançável pelo ESP32 — nunca `localhost`;
- porta, usuário e senha MQTT;
- `MQTT_USE_TLS=1` e a CA raiz em PEM, quando aplicável.

O identificador atual é `ESP32_001`, alinhado a `MQTT_ALLOWED_DEVICE_IDS`. O firmware mede a cada 30 segundos, reconecta Wi-Fi/MQTT sem bloquear o loop, descarta leituras inválidas do HC-SR04 e publica somente os cinco campos reais.

## API PHP

Todos os endpoints aceitam somente `GET`, respondem JSON com `Cache-Control: no-store` e podem receber `?device_id=ESP32_001`:

- `api/device/current.php`: leitura mais recente e dispositivo;
- `api/device/history.php?hours=24&limit=300`: histórico limitado, com `hours` entre 1 e 720 e `limit` entre 1 e 2.000;
- `api/device/status.php`: `online`, `offline` e última comunicação;
- `api/device/alerts.php`: alertas de desconexão e nível baixo.

Sem `device_id`, os endpoints usam o dispositivo com `last_seen` mais recente. Dispositivo inexistente e ausência de leitura retornam `404`; parâmetros inválidos retornam `422`; falhas do banco retornam resposta genérica `503`, sem stack trace.

O limite de inatividade é `DEVICE_OFFLINE_AFTER_SECONDS=90`. Isso tolera até três ciclos do firmware de 30 segundos. Uma Last Will `offline` torna o estado offline imediatamente; caso contrário, a API calcula o estado com base em `last_seen`. O valor pode ser alterado no `.env`.

## Dashboard

`index.php` carrega o mesmo CSS e Chart.js locais. `static/js/dashboard.js` consulta leitura atual, status e alertas no intervalo escolhido; o histórico completo é sincronizado a cada 30 segundos e a leitura atual é mesclada em memória entre essas sincronizações. Assim, cards e gráfico continuam atuais sem transferir centenas de registros a cada poll. O código limita o histórico conforme a faixa escolhida e evita polls sobrepostos e respostas antigas. O intervalo da tela pode ser alterado para 5, 15 ou 30 segundos.

Pressão e vazão continuam marcadas como não disponíveis porque não existem sensores correspondentes no firmware analisado.

## Testes

Execute a suíte sem precisar de MySQL ou broker; ela usa SQLite em memória:

```powershell
composer test
```

Ela cobre tópico, payload válido e inválido, campos ausentes, tipos, tamanho máximo, autorização do dispositivo, persistência, leitura atual, histórico, conversão de fuso horário, Last Will, limite online/offline e consistência entre dispositivos.

Com um broker configurado no `.env`, mantenha o subscriber ativo e publique uma leitura realista com:

```powershell
php mqtt/publish_test.php ESP32_001
```

Depois consulte:

```text
http://127.0.0.1:8080/api/device/current.php?device_id=ESP32_001
http://127.0.0.1:8080/api/device/history.php?device_id=ESP32_001&hours=24&limit=100
http://127.0.0.1:8080/api/device/status.php?device_id=ESP32_001
```

O teste MQTT real depende do host, credenciais e ACL do broker fornecidos no `.env`. O helper reutiliza essas variáveis e não grava credenciais no código ou no navegador.

### Limites operacionais

MQTT QoS 1 e sessão persistente evitam boa parte das perdas de rede, mas não oferecem exatamente uma vez. Ao detectar falha do banco, o worker sai da conexão MQTT, reconstrói o PDO com backoff e deixa o broker enfileirar as mensagens seguintes. Ainda assim, a versão usada de `php-mqtt/client` confirma cada entrega ao broker antes de executar o callback: a primeira mensagem que encontrou a falha é registrada no log, porém não é reenviada automaticamente. Retransmissões também podem gerar leituras duplicadas porque o dispositivo ainda não fornece um identificador persistente por medição. Para garantia transacional, adicione uma inbox/fila durável e um ID de leitura no protocolo.

A dashboard não implementa autenticação de usuários. Mantenha-a em LAN controlada ou proteja-a com autenticação no proxy/servidor web antes de expor o endereço publicamente.

## Arquivos principais

- `index.php`: interface preservada;
- `static/js/dashboard.js`: integração da API e polling;
- `mqtt/subscriber.php`: worker MQTT persistente;
- `mqtt/publish_test.php`: publicação de desenvolvimento;
- `src/Mqtt/`: validação, roteamento e cliente;
- `src/DeviceRepository.php`: persistência e consultas;
- `api/device/`: API consumida pela dashboard;
- `database/schema.sql`: schema MySQL/MariaDB;
- `assets/ino/ESP32_HC_SR04.ino`: firmware MQTT;
- `.env.example`: configuração sem segredos.
