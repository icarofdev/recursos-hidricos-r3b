<?php

declare(strict_types=1);

use R3B\DeviceRepository;
use R3B\Mqtt\ClientFactory;
use R3B\Mqtt\MessageProcessor;
use R3B\Mqtt\PayloadValidator;
use R3B\Mqtt\TopicMatcher;
use R3B\Mqtt\ValidationException;
use PhpMqtt\Client\MessageProcessors\Mqtt311MessageProcessor;

require dirname(__DIR__) . DIRECTORY_SEPARATOR . 'vendor' . DIRECTORY_SEPARATOR . 'autoload.php';
require_once dirname(__DIR__) . DIRECTORY_SEPARATOR . 'config' . DIRECTORY_SEPARATOR . 'bootstrap.php';
require_once dirname(__DIR__) . DIRECTORY_SEPARATOR . 'config' . DIRECTORY_SEPARATOR . 'mqtt.php';

date_default_timezone_set('UTC');
ini_set('display_errors', '1');

final class TestFailure extends RuntimeException
{
}

/** @var list<array{name:string,callback:Closure():void}> $tests */
$tests = [];

function test(string $name, Closure $callback): void
{
    global $tests;

    $tests[] = ['name' => $name, 'callback' => $callback];
}

function expectTrue(bool $condition, string $message): void
{
    if (!$condition) {
        throw new TestFailure($message);
    }
}

function expectSame(mixed $expected, mixed $actual, string $message = ''): void
{
    if ($expected === $actual) {
        return;
    }

    $prefix = $message === '' ? '' : $message . ' ';
    throw new TestFailure(sprintf(
        '%sEsperado %s; recebido %s.',
        $prefix,
        var_export($expected, true),
        var_export($actual, true)
    ));
}

function expectNear(float $expected, mixed $actual, string $message = ''): void
{
    if (is_float($actual) && abs($expected - $actual) <= 0.000001) {
        return;
    }

    $prefix = $message === '' ? '' : $message . ' ';
    throw new TestFailure(sprintf(
        '%sEsperado %.6f; recebido %s.',
        $prefix,
        $expected,
        var_export($actual, true)
    ));
}

/** @param class-string<Throwable> $expectedClass */
function expectThrows(string $expectedClass, Closure $callback, string $messageFragment = ''): void
{
    try {
        $callback();
    } catch (Throwable $exception) {
        if (!$exception instanceof $expectedClass) {
            throw new TestFailure(sprintf(
                'Era esperada %s, mas foi recebida %s: %s',
                $expectedClass,
                $exception::class,
                $exception->getMessage()
            ), 0, $exception);
        }

        if ($messageFragment !== '' && !str_contains($exception->getMessage(), $messageFragment)) {
            throw new TestFailure(sprintf(
                'A mensagem de %s deveria conter %s; recebida: %s',
                $expectedClass,
                var_export($messageFragment, true),
                $exception->getMessage()
            ), 0, $exception);
        }

        return;
    }

    throw new TestFailure(sprintf('Era esperada uma excecao %s, mas nada foi lancado.', $expectedClass));
}

/** @return array{device_id:string,nivel_cm:float,capacidade_cm:float,percentual:float,volume_litros:float} */
function validReading(array $overrides = []): array
{
    /** @var array{device_id:string,nivel_cm:float,capacidade_cm:float,percentual:float,volume_litros:float} $reading */
    $reading = array_replace([
        'device_id' => 'sm-wa-01',
        'nivel_cm' => 42.5,
        'capacidade_cm' => 100.0,
        'percentual' => 42.5,
        'volume_litros' => 425.0,
    ], $overrides);

    return $reading;
}

function encodeJson(array $data): string
{
    return json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
}

/** @return array<string, mixed> */
function validClientConfig(string $clientId): array
{
    return [
        'host' => 'broker.invalid',
        'port' => 1883,
        'client_id' => $clientId,
        'username' => '',
        'password' => '',
        'connect_timeout' => 1,
        'socket_timeout' => 1,
        'keep_alive' => 30,
        'tls' => false,
        'tls_verify_peer' => true,
        'tls_ca_file' => null,
    ];
}

/** @return array<string, string> */
function validMqttEnvironment(array $overrides = []): array
{
    return array_replace(['MQTT_HOST' => 'broker.invalid'], $overrides);
}

/**
 * Executa uma verificacao com todas as variaveis MQTT isoladas e restaura
 * getenv(), $_ENV e $_SERVER mesmo quando o teste lanca uma excecao.
 */
function withMqttEnvironment(array $values, Closure $callback): mixed
{
    $keys = [
        'MQTT_HOST',
        'MQTT_PORT',
        'MQTT_USERNAME',
        'MQTT_PASSWORD',
        'MQTT_CLIENT_ID',
        'MQTT_TOPIC',
        'MQTT_STATUS_TOPIC',
        'MQTT_QOS',
        'MQTT_KEEP_ALIVE_SECONDS',
        'MQTT_CONNECT_TIMEOUT_SECONDS',
        'MQTT_SOCKET_TIMEOUT_SECONDS',
        'MQTT_MAX_PAYLOAD_BYTES',
        'MQTT_RECONNECT_MIN_SECONDS',
        'MQTT_RECONNECT_MAX_SECONDS',
        'MQTT_RECONNECT_RESET_AFTER_SECONDS',
        'MQTT_ALLOWED_DEVICE_IDS',
        'MQTT_TLS',
        'MQTT_TLS_VERIFY_PEER',
        'MQTT_TLS_CA_FILE',
    ];
    $snapshot = [];

    foreach ($keys as $key) {
        $snapshot[$key] = [
            'process' => getenv($key),
            'env_exists' => array_key_exists($key, $_ENV),
            'env' => $_ENV[$key] ?? null,
            'server_exists' => array_key_exists($key, $_SERVER),
            'server' => $_SERVER[$key] ?? null,
        ];
        putenv($key);
        unset($_ENV[$key], $_SERVER[$key]);
    }

    try {
        foreach ($values as $key => $value) {
            if (!in_array($key, $keys, true)) {
                throw new TestFailure(sprintf('Variavel MQTT desconhecida no teste: %s.', $key));
            }

            $stringValue = (string) $value;
            putenv(sprintf('%s=%s', $key, $stringValue));
            $_ENV[$key] = $stringValue;
        }

        return $callback();
    } finally {
        foreach ($snapshot as $key => $previous) {
            if ($previous['process'] === false) {
                putenv($key);
            } else {
                putenv(sprintf('%s=%s', $key, $previous['process']));
            }

            if ($previous['env_exists']) {
                $_ENV[$key] = $previous['env'];
            } else {
                unset($_ENV[$key]);
            }

            if ($previous['server_exists']) {
                $_SERVER[$key] = $previous['server'];
            } else {
                unset($_SERVER[$key]);
            }
        }
    }
}

/**
 * @return array{pdo:PDO,repository:DeviceRepository,validator:PayloadValidator,processor:MessageProcessor}
 */
function makeContext(int $offlineAfterSeconds = 90): array
{
    $pdo = new PDO('sqlite::memory:', null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_STRINGIFY_FETCHES => false,
    ]);

    $schemaPath = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'database' . DIRECTORY_SEPARATOR . 'schema.sqlite.sql';
    $schema = file_get_contents($schemaPath);
    if ($schema === false) {
        throw new RuntimeException('Nao foi possivel ler database/schema.sqlite.sql.');
    }

    $pdo->exec($schema);

    $repository = new DeviceRepository(
        $pdo,
        $offlineAfterSeconds,
        new DateTimeZone('America/Sao_Paulo')
    );
    $validator = new PayloadValidator(4096, ['sm-wa-01']);
    $processor = new MessageProcessor(
        $repository,
        $validator,
        'sm-wa/+/data',
        'sm-wa/+/status'
    );

    return [
        'pdo' => $pdo,
        'repository' => $repository,
        'validator' => $validator,
        'processor' => $processor,
    ];
}

test('TopicMatcher extrai somente o device_id de topicos compativeis', static function (): void {
    expectSame('sm-wa-01', TopicMatcher::deviceId('sm-wa/sm-wa-01/data', 'sm-wa/+/data'));
    expectSame(null, TopicMatcher::deviceId('sm-wa/sm-wa-01/status', 'sm-wa/+/data'));
    expectSame(null, TopicMatcher::deviceId('sm-wa/sm-wa-01/data/extra', 'sm-wa/+/data'));
    expectSame(null, TopicMatcher::deviceId('sm-wa//data', 'sm-wa/+/data'));
    expectSame(null, TopicMatcher::deviceId('sm-wa/a/data/b', 'sm-wa/+/data/+'));
    expectSame(null, TopicMatcher::deviceId('sm-wa/sm-wa-01/data', 'sm-wa/#/data'));
});

test('Payload de dados valido e normalizado para floats', static function (): void {
    $validator = new PayloadValidator(4096, ['sm-wa-01']);
    $validated = $validator->validateData(
        'sm-wa/sm-wa-01/data',
        encodeJson(validReading()),
        'sm-wa/+/data'
    );

    expectSame('sm-wa-01', $validated['device_id']);
    expectNear(42.5, $validated['nivel_cm']);
    expectNear(100.0, $validated['capacidade_cm']);
    expectNear(42.5, $validated['percentual']);
    expectNear(425.0, $validated['volume_litros']);
});

test('Percentual incoerente com nivel e capacidade e rejeitado', static function (): void {
    $validator = new PayloadValidator(4096, ['sm-wa-01']);

    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData(
            'sm-wa/sm-wa-01/data',
            encodeJson(validReading(['percentual' => 80.0])),
            'sm-wa/+/data'
        ),
        'nao corresponde a nivel_cm e capacidade_cm'
    );
});

test('JSON invalido e rejeitado', static function (): void {
    $validator = new PayloadValidator(4096, ['sm-wa-01']);

    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData('sm-wa/sm-wa-01/data', '{invalid', 'sm-wa/+/data'),
        'JSON valido'
    );
});

test('Campo numerico ausente e rejeitado', static function (): void {
    $validator = new PayloadValidator(4096, ['sm-wa-01']);
    $reading = validReading();
    unset($reading['volume_litros']);

    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData('sm-wa/sm-wa-01/data', encodeJson($reading), 'sm-wa/+/data'),
        'volume_litros'
    );
});

test('String numerica nao e aceita como numero', static function (): void {
    $validator = new PayloadValidator(4096, ['sm-wa-01']);
    $reading = validReading();
    $reading['nivel_cm'] = '42.5';

    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData('sm-wa/sm-wa-01/data', encodeJson($reading), 'sm-wa/+/data'),
        'nivel_cm'
    );
});

test('device_id divergente do topico e rejeitado', static function (): void {
    $validator = new PayloadValidator(4096, ['sm-wa-01', 'sm-wa-02']);

    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData(
            'sm-wa/sm-wa-02/data',
            encodeJson(validReading()),
            'sm-wa/+/data'
        ),
        'nao corresponde'
    );
});

test('device_id fora da lista autorizada e rejeitado', static function (): void {
    $validator = new PayloadValidator(4096, ['sm-wa-01']);

    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData(
            'sm-wa/sm-wa-02/data',
            encodeJson(validReading(['device_id' => 'sm-wa-02'])),
            'sm-wa/+/data'
        ),
        'nao esta autorizado'
    );
});

test('Payload acima do limite e rejeitado antes do parsing', static function (): void {
    $validator = new PayloadValidator(64, ['sm-wa-01']);

    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData(
            'sm-wa/sm-wa-01/data',
            str_repeat('x', 65),
            'sm-wa/+/data'
        ),
        'maior que o limite'
    );
});

test('Payload de status aceita estados validos e rejeita estado invalido', static function (): void {
    $validator = new PayloadValidator(4096, ['sm-wa-01']);

    expectSame(
        ['device_id' => 'sm-wa-01', 'status' => 'online'],
        $validator->validateStatus(
            'sm-wa/sm-wa-01/status',
            encodeJson(['device_id' => 'sm-wa-01', 'status' => 'online']),
            'sm-wa/+/status'
        )
    );
    expectSame(
        ['device_id' => 'sm-wa-01', 'status' => 'offline'],
        $validator->validateStatus(
            'sm-wa/sm-wa-01/status',
            encodeJson(['device_id' => 'sm-wa-01', 'status' => 'offline']),
            'sm-wa/+/status'
        )
    );
    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateStatus(
            'sm-wa/sm-wa-01/status',
            encodeJson(['device_id' => 'sm-wa-01', 'status' => 'sleeping']),
            'sm-wa/+/status'
        ),
        'online ou offline'
    );
});

test('MessageProcessor persiste leituras e current/history retornam valores e timestamps corretos', static function (): void {
    $context = makeContext();
    $pdo = $context['pdo'];
    $repository = $context['repository'];
    $processor = $context['processor'];
    $firstAt = new DateTimeImmutable('2026-08-20 12:00:00.123456', new DateTimeZone('UTC'));
    $secondAt = new DateTimeImmutable('2026-08-20 12:00:30.654321', new DateTimeZone('UTC'));

    expectSame(
        ['kind' => 'data', 'device_id' => 'sm-wa-01'],
        $processor->process('sm-wa/sm-wa-01/data', encodeJson(validReading()), $firstAt)
    );
    expectSame(
        ['kind' => 'data', 'device_id' => 'sm-wa-01'],
        $processor->process(
            'sm-wa/sm-wa-01/data',
            encodeJson(validReading([
                'nivel_cm' => 43.0,
                'percentual' => 43.0,
                'volume_litros' => 430.0,
            ])),
            $secondAt
        )
    );

    expectSame(2, (int) $pdo->query('SELECT COUNT(*) FROM sensor_readings')->fetchColumn());
    expectSame(1, (int) $pdo->query('SELECT COUNT(*) FROM devices')->fetchColumn());

    $storedTimestamps = $pdo->query('SELECT created_at FROM sensor_readings ORDER BY id')->fetchAll(PDO::FETCH_COLUMN);
    expectSame(
        ['2026-08-20 12:00:00.123456', '2026-08-20 12:00:30.654321'],
        $storedTimestamps,
        'Os timestamps devem ser persistidos em UTC com microssegundos.'
    );

    $current = $repository->current('sm-wa-01', $secondAt->modify('+1 second'));
    expectTrue(is_array($current), 'A leitura atual deveria existir.');
    expectSame('sm-wa-01', $current['device']['id']);
    expectSame('online', $current['device']['status']);
    expectSame(90, $current['device']['offline_after_seconds']);
    expectSame('2026-08-20T09:00:30-03:00', $current['device']['last_seen']);
    expectNear(43.0, $current['data']['nivel_cm']);
    expectNear(100.0, $current['data']['capacidade_cm']);
    expectNear(43.0, $current['data']['percentual']);
    expectNear(430.0, $current['data']['volume_litros']);
    expectSame('2026-08-20T09:00:30-03:00', $current['data']['timestamp']);

    $history = $repository->history(
        'sm-wa-01',
        new DateTimeImmutable('2026-08-20 11:59:59', new DateTimeZone('UTC')),
        10
    );
    expectSame('sm-wa-01', $history['device_id']);
    expectSame(2, count($history['data']));
    expectNear(43.0, $history['data'][0]['nivel_cm']);
    expectSame('2026-08-20T09:00:30-03:00', $history['data'][0]['timestamp']);
    expectNear(42.5, $history['data'][1]['nivel_cm']);
    expectSame('2026-08-20T09:00:00-03:00', $history['data'][1]['timestamp']);
});

test('Dispositivo fica online em 89s e offline exatamente em 90s', static function (): void {
    $context = makeContext(90);
    $repository = $context['repository'];
    $processor = $context['processor'];
    $receivedAt = new DateTimeImmutable('2026-08-20 12:00:00', new DateTimeZone('UTC'));

    $processor->process('sm-wa/sm-wa-01/data', encodeJson(validReading()), $receivedAt);

    $at89 = $repository->current('sm-wa-01', $receivedAt->modify('+89 seconds'));
    $at90 = $repository->current('sm-wa-01', $receivedAt->modify('+90 seconds'));
    $statusAt89 = $repository->status('sm-wa-01', $receivedAt->modify('+89 seconds'));
    $statusAt90 = $repository->status('sm-wa-01', $receivedAt->modify('+90 seconds'));

    expectTrue(is_array($at89) && is_array($at90), 'As leituras atuais deveriam existir.');
    expectTrue(is_array($statusAt89) && is_array($statusAt90), 'Os status deveriam existir.');
    expectSame('online', $at89['device']['status']);
    expectSame('offline', $at90['device']['status']);
    expectSame('online', $statusAt89['status']);
    expectSame('offline', $statusAt90['status']);
    expectSame(90, $statusAt89['offline_after_seconds']);
    expectSame(90, $statusAt90['offline_after_seconds']);
});

test('Status LWT offline tem efeito imediato e nao cria nova leitura', static function (): void {
    $context = makeContext(90);
    $pdo = $context['pdo'];
    $repository = $context['repository'];
    $processor = $context['processor'];
    $readingAt = new DateTimeImmutable('2026-08-20 12:00:00.000000', new DateTimeZone('UTC'));
    $offlineAt = new DateTimeImmutable('2026-08-20 12:00:05.500000', new DateTimeZone('UTC'));

    $processor->process('sm-wa/sm-wa-01/data', encodeJson(validReading()), $readingAt);
    $result = $processor->process(
        'sm-wa/sm-wa-01/status',
        encodeJson(['device_id' => 'sm-wa-01', 'status' => 'offline']),
        $offlineAt
    );

    expectSame(
        ['kind' => 'status', 'device_id' => 'sm-wa-01', 'status' => 'offline'],
        $result
    );
    expectSame(1, (int) $pdo->query('SELECT COUNT(*) FROM sensor_readings')->fetchColumn());

    $storedDevice = $pdo->query(
        "SELECT reported_status, last_seen FROM devices WHERE device_id = 'sm-wa-01'"
    )->fetch();
    expectTrue(is_array($storedDevice), 'O dispositivo deveria estar persistido.');
    expectSame('offline', $storedDevice['reported_status']);
    expectSame('2026-08-20 12:00:05.500000', $storedDevice['last_seen']);

    $status = $repository->status('sm-wa-01', $offlineAt);
    $current = $repository->current('sm-wa-01', $offlineAt);
    expectTrue(is_array($status) && is_array($current), 'Status e leitura atual deveriam existir.');
    expectSame('offline', $status['status']);
    expectSame('offline', $current['device']['status']);
    expectSame('2026-08-20T09:00:05-03:00', $status['last_seen']);
    expectSame('2026-08-20T09:00:00-03:00', $current['data']['timestamp']);
});

test('Leitura MQTT retida e rejeitada sem persistir device ou leitura', static function (): void {
    $context = makeContext();
    $pdo = $context['pdo'];
    $processor = $context['processor'];

    expectThrows(
        ValidationException::class,
        static fn () => $processor->process(
            'sm-wa/sm-wa-01/data',
            encodeJson(validReading()),
            new DateTimeImmutable('2026-08-20 12:00:00', new DateTimeZone('UTC')),
            true
        ),
        'Leituras retidas nao sao aceitas'
    );
    expectSame(0, (int) $pdo->query('SELECT COUNT(*) FROM devices')->fetchColumn());
    expectSame(0, (int) $pdo->query('SELECT COUNT(*) FROM sensor_readings')->fetchColumn());
});

test('Status retido altera device existente sem mudar last_seen', static function (): void {
    $context = makeContext();
    $pdo = $context['pdo'];
    $repository = $context['repository'];
    $processor = $context['processor'];
    $readingAt = new DateTimeImmutable('2026-08-20 12:00:00.123456', new DateTimeZone('UTC'));
    $retainedAt = new DateTimeImmutable('2026-08-20 12:05:00.654321', new DateTimeZone('UTC'));

    $processor->process('sm-wa/sm-wa-01/data', encodeJson(validReading()), $readingAt);
    $result = $processor->process(
        'sm-wa/sm-wa-01/status',
        encodeJson(['device_id' => 'sm-wa-01', 'status' => 'offline']),
        $retainedAt,
        true
    );

    expectSame([
        'kind' => 'status',
        'device_id' => 'sm-wa-01',
        'status' => 'offline',
        'retained' => true,
        'stored' => true,
    ], $result);

    $storedDevice = $pdo->query(
        "SELECT reported_status, last_seen, updated_at FROM devices WHERE device_id = 'sm-wa-01'"
    )->fetch();
    expectTrue(is_array($storedDevice), 'O device existente deveria permanecer persistido.');
    expectSame('offline', $storedDevice['reported_status']);
    expectSame(
        '2026-08-20 12:00:00.123456',
        $storedDevice['last_seen'],
        'Status retido nao deve se passar por uma comunicacao atual.'
    );
    expectSame('2026-08-20 12:05:00.654321', $storedDevice['updated_at']);

    $status = $repository->status('sm-wa-01', $retainedAt);
    expectTrue(is_array($status), 'O status do device deveria existir.');
    expectSame('offline', $status['status']);
    expectSame('2026-08-20T09:00:00-03:00', $status['last_seen']);
});

test('Status retido de device inexistente nao cria registro', static function (): void {
    $context = makeContext();
    $pdo = $context['pdo'];
    $repository = $context['repository'];
    $processor = $context['processor'];
    $receivedAt = new DateTimeImmutable('2026-08-20 12:00:00', new DateTimeZone('UTC'));

    $result = $processor->process(
        'sm-wa/sm-wa-01/status',
        encodeJson(['device_id' => 'sm-wa-01', 'status' => 'offline']),
        $receivedAt,
        true
    );

    expectSame([
        'kind' => 'status',
        'device_id' => 'sm-wa-01',
        'status' => 'offline',
        'retained' => true,
        'stored' => false,
    ], $result);
    expectSame(0, (int) $pdo->query('SELECT COUNT(*) FROM devices')->fetchColumn());
    expectSame(0, (int) $pdo->query('SELECT COUNT(*) FROM sensor_readings')->fetchColumn());
    expectSame(null, $repository->status('sm-wa-01', $receivedAt));
});

test('Consultas sem device_id resolvem o mesmo dispositivo mais recentemente visto', static function (): void {
    $context = makeContext(90);
    $pdo = $context['pdo'];
    $repository = $context['repository'];
    $utc = new DateTimeZone('UTC');
    $readingBAt = new DateTimeImmutable('2026-08-20 12:00:00', $utc);
    $readingAAt = new DateTimeImmutable('2026-08-20 12:01:00', $utc);
    $statusBAt = new DateTimeImmutable('2026-08-20 12:02:00', $utc);

    $repository->storeReading(
        validReading([
            'device_id' => 'sm-wa-b',
            'nivel_cm' => 20.0,
            'percentual' => 20.0,
            'volume_litros' => 200.0,
        ]),
        $readingBAt
    );
    $repository->storeReading(
        validReading([
            'device_id' => 'sm-wa-a',
            'nivel_cm' => 60.0,
            'percentual' => 60.0,
            'volume_litros' => 600.0,
        ]),
        $readingAAt
    );
    $repository->storeStatus('sm-wa-b', 'online', $statusBAt);

    expectSame(
        'sm-wa-a',
        $pdo->query('SELECT device_id FROM sensor_readings ORDER BY created_at DESC, id DESC LIMIT 1')->fetchColumn(),
        'A pre-condicao exige que a leitura mais nova seja do dispositivo A.'
    );
    expectSame(
        'sm-wa-b',
        $pdo->query('SELECT device_id FROM devices ORDER BY last_seen DESC, id DESC LIMIT 1')->fetchColumn(),
        'A pre-condicao exige que o dispositivo B tenha sido visto mais recentemente.'
    );

    $now = $statusBAt->modify('+1 second');
    $current = $repository->current(null, $now);
    $history = $repository->history(
        null,
        new DateTimeImmutable('2026-08-20 11:59:00', $utc),
        10
    );
    $status = $repository->status(null, $now);

    expectTrue(is_array($current), 'current(null) deveria encontrar a leitura do dispositivo B.');
    expectTrue(is_array($status), 'status(null) deveria encontrar o dispositivo B.');
    expectSame(
        ['sm-wa-b', 'sm-wa-b', 'sm-wa-b'],
        [$current['device']['id'], $history['device_id'], $status['id']],
        'current(null), history(null) e status(null) devem usar a mesma selecao por last_seen.'
    );
    expectSame('online', $current['device']['status']);
    expectSame('2026-08-20T09:02:00-03:00', $current['device']['last_seen']);
    expectNear(20.0, $current['data']['nivel_cm']);
    expectSame('2026-08-20T09:00:00-03:00', $current['data']['timestamp']);
    expectSame(1, count($history['data']));
    expectSame('sm-wa-b', $history['data'][0]['device_id']);
    expectNear(20.0, $history['data'][0]['nivel_cm']);
    expectSame('2026-08-20T09:00:00-03:00', $history['data'][0]['timestamp']);
    expectSame('online', $status['status']);
    expectSame('2026-08-20T09:02:00-03:00', $status['last_seen']);
});

test('ClientFactory preserva client ID valido e usa exatamente MQTT 3.1.1', static function (): void {
    $clientId = 'a' . str_repeat('b', 22);
    expectSame(23, strlen($clientId), 'A pre-condicao deve exercitar o limite valido de 23 caracteres.');

    $connection = ClientFactory::create(validClientConfig($clientId));
    $client = $connection['client'];
    expectSame($clientId, $client->getClientId(), 'A fabrica deve preservar o client ID configurado.');

    $reflection = new ReflectionObject($client);
    $messageProcessorProperty = $reflection->getProperty('messageProcessor');
    $messageProcessorProperty->setAccessible(true);
    $messageProcessor = $messageProcessorProperty->getValue($client);

    expectSame(
        Mqtt311MessageProcessor::class,
        $messageProcessor::class,
        'O processador interno comprova a selecao exata do protocolo MQTT 3.1.1.'
    );
});

test('ClientFactory rejeita client ID maior que 23 caracteres sem acessar a rede', static function (): void {
    $clientId = str_repeat('a', 24);

    expectThrows(
        RuntimeException::class,
        static fn () => ClientFactory::create(validClientConfig($clientId)),
        'entre 1 e 23 caracteres'
    );
});

test('publish_test gera client ID com no maximo 23 caracteres por inspecao estatica', static function (): void {
    $scriptPath = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'mqtt' . DIRECTORY_SEPARATOR . 'publish_test.php';
    $source = file_get_contents($scriptPath);
    expectTrue(is_string($source), 'Nao foi possivel ler mqtt/publish_test.php.');

    $matched = preg_match(
        "/'([^']*)'\\s*\\.\\s*bin2hex\\(random_bytes\\((\\d+)\\)\\)/",
        $source,
        $matches
    );
    expectSame(1, $matched, 'O padrao de geracao do client ID do publicador deve permanecer inspecionavel.');

    $maximumLength = strlen($matches[1]) + ((int) $matches[2] * 2);
    expectTrue(
        $maximumLength <= 23,
        sprintf('O client ID gerado pelo publicador pode atingir %d caracteres.', $maximumLength)
    );
});

test('mqtt_config preserva device ID 0 na allowlist e remove duplicatas', static function (): void {
    $config = withMqttEnvironment(
        validMqttEnvironment(['MQTT_ALLOWED_DEVICE_IDS' => '0, sm-wa-01, 0']),
        static fn (): array => mqtt_config()
    );

    expectSame(['0', 'sm-wa-01'], $config['allowed_devices']);
});

test('mqtt_config rejeita curinga + embutido em nivel do topico', static function (): void {
    expectThrows(
        RuntimeException::class,
        static fn () => withMqttEnvironment(
            validMqttEnvironment(['MQTT_TOPIC' => 'sm-wa/device+/data']),
            static fn (): array => mqtt_config()
        ),
        'unico nivel +'
    );
});

test('mqtt_config rejeita filtros de dados e status iguais', static function (): void {
    expectThrows(
        RuntimeException::class,
        static fn () => withMqttEnvironment(
            validMqttEnvironment([
                'MQTT_TOPIC' => 'sm-wa/+/events',
                'MQTT_STATUS_TOPIC' => 'sm-wa/+/events',
            ]),
            static fn (): array => mqtt_config()
        ),
        'devem ser diferentes'
    );
});

$passed = 0;
$failed = 0;

echo "R3B MQTT/PHP - testes de integracao\n\n";

foreach ($tests as $testCase) {
    try {
        $testCase['callback']();
        $passed++;
        printf("[PASS] %s\n", $testCase['name']);
    } catch (Throwable $exception) {
        $failed++;
        printf("[FAIL] %s\n", $testCase['name']);
        printf("       %s: %s\n", $exception::class, $exception->getMessage());
    }
}

printf("\nResultado: %d passou/passaram; %d falhou/falharam; %d total.\n", $passed, $failed, count($tests));

exit($failed === 0 ? 0 : 1);
