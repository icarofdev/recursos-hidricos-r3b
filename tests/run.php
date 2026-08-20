<?php

declare(strict_types=1);

use R3B\DeviceRepository;
use R3B\Mqtt\MessageProcessor;
use R3B\Mqtt\PayloadValidator;
use R3B\Mqtt\TopicMatcher;
use R3B\Mqtt\ValidationException;

require dirname(__DIR__) . DIRECTORY_SEPARATOR . 'vendor' . DIRECTORY_SEPARATOR . 'autoload.php';

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
    if ($expected !== $actual) {
        throw new TestFailure(sprintf(
            '%sEsperado %s; recebido %s.',
            $message === '' ? '' : $message . ' ',
            var_export($expected, true),
            var_export($actual, true)
        ));
    }
}

function expectNear(float $expected, mixed $actual, string $message = ''): void
{
    if (!is_float($actual) || abs($expected - $actual) > 0.000001) {
        throw new TestFailure(sprintf(
            '%sEsperado %.6f; recebido %s.',
            $message === '' ? '' : $message . ' ',
            $expected,
            var_export($actual, true)
        ));
    }
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
                'A mensagem deveria conter %s; recebida: %s',
                var_export($messageFragment, true),
                $exception->getMessage()
            ), 0, $exception);
        }
        return;
    }

    throw new TestFailure(sprintf('Era esperada uma excecao %s, mas nada foi lancado.', $expectedClass));
}

/** @return array{id:int,ppl:float,vazao:float,consumo:float,rssi_wifi:float} */
function validReading(array $overrides = []): array
{
    return array_replace([
        'id' => 1,
        'ppl' => 1.0,
        'vazao' => 0.0,
        'consumo' => 1253.0,
        'rssi_wifi' => -60.0,
    ], $overrides);
}

function encodeJson(array $data): string
{
    return json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
}

function testDatabase(): PDO
{
    $database = new PDO('sqlite::memory:');
    $database->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $database->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $database->setAttribute(PDO::ATTR_STRINGIFY_FETCHES, false);
    $schema = file_get_contents(dirname(__DIR__) . '/database/schema.sqlite.sql');
    if ($schema === false) {
        throw new TestFailure('Nao foi possivel carregar o schema SQLite.');
    }
    $database->exec($schema);
    return $database;
}

/** @return array{0:PDO,1:DeviceRepository,2:MessageProcessor} */
function testContext(): array
{
    $database = testDatabase();
    $repository = new DeviceRepository($database, 90, new DateTimeZone('America/Sao_Paulo'));
    $validator = new PayloadValidator(4096, ['1', '2']);
    $processor = new MessageProcessor($repository, $validator, 'sm-wa/+/data', 'sm-wa/+/status');
    return [$database, $repository, $processor];
}

test('TopicMatcher extrai o id do nivel curinga', static function (): void {
    expectSame('1', TopicMatcher::deviceId('sm-wa/1/data', 'sm-wa/+/data'));
    expectSame(null, TopicMatcher::deviceId('sm-wa/1/status', 'sm-wa/+/data'));
    expectSame(null, TopicMatcher::deviceId('sm-wa//data', 'sm-wa/+/data'));
});

test('Payload de dados aceita exatamente os cinco campos reais', static function (): void {
    $validator = new PayloadValidator(4096, ['1']);
    $reading = $validator->validateData('sm-wa/1/data', encodeJson(validReading()), 'sm-wa/+/data');

    expectSame(1, $reading['id']);
    expectNear(1.0, $reading['ppl']);
    expectNear(0.0, $reading['vazao']);
    expectNear(1253.0, $reading['consumo']);
    expectNear(-60.0, $reading['rssi_wifi']);
    expectSame(['id', 'ppl', 'vazao', 'consumo', 'rssi_wifi'], array_keys($reading));
});

test('Todos os campos de telemetria sao obrigatorios', static function (): void {
    $validator = new PayloadValidator(4096, ['1']);
    foreach (['ppl', 'vazao', 'consumo', 'rssi_wifi'] as $field) {
        $reading = validReading();
        unset($reading[$field]);
        expectThrows(
            ValidationException::class,
            static fn () => $validator->validateData('sm-wa/1/data', encodeJson($reading), 'sm-wa/+/data'),
            $field
        );
    }
});

test('Tipos numericos em texto e id textual sao rejeitados', static function (): void {
    $validator = new PayloadValidator(4096, ['1']);
    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData(
            'sm-wa/1/data',
            encodeJson(validReading(['ppl' => '1.0'])),
            'sm-wa/+/data'
        ),
        'ppl'
    );
    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData(
            'sm-wa/1/data',
            encodeJson(validReading(['id' => '1'])),
            'sm-wa/+/data'
        ),
        'inteiro positivo'
    );
});

test('Id deve coincidir com o topico e estar autorizado', static function (): void {
    $validator = new PayloadValidator(4096, ['1']);
    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData('sm-wa/2/data', encodeJson(validReading()), 'sm-wa/+/data'),
        'nao corresponde'
    );
    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData(
            'sm-wa/2/data',
            encodeJson(validReading(['id' => 2])),
            'sm-wa/+/data'
        ),
        'nao esta autorizado'
    );
});

test('Campos desconhecidos nao entram no contrato MQTT', static function (): void {
    $validator = new PayloadValidator(4096, ['1']);
    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData(
            'sm-wa/1/data',
            encodeJson(validReading(['campo_extra' => 25.0])),
            'sm-wa/+/data'
        ),
        'campo nao reconhecido'
    );
});

test('Faixas basicas rejeitam valores impossiveis', static function (): void {
    $validator = new PayloadValidator(4096, ['1']);
    foreach ([
        ['ppl', -1.0],
        ['vazao', -0.1],
        ['consumo', -0.1],
        ['rssi_wifi', -201.0],
        ['rssi_wifi', 1.0],
    ] as [$field, $value]) {
        expectThrows(
            ValidationException::class,
            static fn () => $validator->validateData(
                'sm-wa/1/data',
                encodeJson(validReading([$field => $value])),
                'sm-wa/+/data'
            ),
            $field
        );
    }
});

test('JSON invalido, lista, payload grande e leitura retida sao rejeitados', static function (): void {
    $validator = new PayloadValidator(128, ['1']);
    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData('sm-wa/1/data', '{', 'sm-wa/+/data'),
        'JSON valido'
    );
    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData('sm-wa/1/data', '[1,2]', 'sm-wa/+/data'),
        'objeto'
    );
    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData('sm-wa/1/data', str_repeat('x', 129), 'sm-wa/+/data'),
        'limite'
    );

    [, , $processor] = testContext();
    expectThrows(
        ValidationException::class,
        static fn () => $processor->process('sm-wa/1/data', encodeJson(validReading()), null, true),
        'retidas'
    );
});

test('Status usa id e aceita somente online ou offline', static function (): void {
    $validator = new PayloadValidator(4096, ['1']);
    expectSame(
        ['id' => 1, 'status' => 'online'],
        $validator->validateStatus(
            'sm-wa/1/status',
            encodeJson(['id' => 1, 'status' => 'online']),
            'sm-wa/+/status'
        )
    );
    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateStatus(
            'sm-wa/1/status',
            encodeJson(['id' => 1, 'status' => 'sleeping']),
            'sm-wa/+/status'
        ),
        'online ou offline'
    );
});

test('Fluxo MQTT persiste leitura atual, historico e status', static function (): void {
    [$database, $repository, $processor] = testContext();
    $firstAt = new DateTimeImmutable('2026-08-20 12:00:00.000000', new DateTimeZone('UTC'));
    $secondAt = $firstAt->modify('+30 seconds');

    expectSame(
        ['kind' => 'data', 'id' => 1],
        $processor->process('sm-wa/1/data', encodeJson(validReading()), $firstAt)
    );
    expectSame(
        ['kind' => 'data', 'id' => 1],
        $processor->process(
            'sm-wa/1/data',
            encodeJson(validReading([
                'ppl' => 1.25,
                'vazao' => 2.5,
                'consumo' => 1255.5,
                'rssi_wifi' => -62.0,
            ])),
            $secondAt
        )
    );

    expectSame(2, (int) $database->query('SELECT COUNT(*) FROM sensor_readings')->fetchColumn());
    $current = $repository->current(1, $secondAt->modify('+1 second'));
    expectTrue($current !== null, 'A leitura atual deveria existir.');
    expectSame(1, $current['device']['id']);
    expectSame('online', $current['device']['status']);
    expectSame(1, $current['data']['id']);
    expectNear(1.25, $current['data']['ppl']);
    expectNear(2.5, $current['data']['vazao']);
    expectNear(1255.5, $current['data']['consumo']);
    expectNear(-62.0, $current['data']['rssi_wifi']);
    expectSame('2026-08-20T09:00:30-03:00', $current['data']['timestamp']);

    $history = $repository->history(1, $firstAt->modify('-1 second'), 10);
    expectSame(1, $history['id']);
    expectSame(2, count($history['data']));
    expectNear(1255.5, $history['data'][0]['consumo']);
    expectNear(1253.0, $history['data'][1]['consumo']);

    expectSame(
        ['kind' => 'status', 'id' => 1, 'status' => 'offline'],
        $processor->process(
            'sm-wa/1/status',
            encodeJson(['id' => 1, 'status' => 'offline']),
            $secondAt->modify('+5 seconds')
        )
    );
    expectSame('offline', $repository->status(1, $secondAt->modify('+6 seconds'))['status']);
});

test('Timeout de comunicacao altera status calculado para offline', static function (): void {
    [, $repository, $processor] = testContext();
    $receivedAt = new DateTimeImmutable('2026-08-20 12:00:00', new DateTimeZone('UTC'));
    $processor->process('sm-wa/1/data', encodeJson(validReading()), $receivedAt);

    expectSame('online', $repository->status(1, $receivedAt->modify('+89 seconds'))['status']);
    expectSame('offline', $repository->status(1, $receivedAt->modify('+90 seconds'))['status']);
});

test('Status retido nao cria dispositivo fantasma nem altera last_seen', static function (): void {
    [$database, $repository, $processor] = testContext();
    $receivedAt = new DateTimeImmutable('2026-08-20 12:00:00', new DateTimeZone('UTC'));

    expectSame(
        ['kind' => 'status', 'id' => 1, 'status' => 'offline', 'retained' => true, 'stored' => false],
        $processor->process(
            'sm-wa/1/status',
            encodeJson(['id' => 1, 'status' => 'offline']),
            $receivedAt,
            true
        )
    );
    expectSame(0, (int) $database->query('SELECT COUNT(*) FROM devices')->fetchColumn());

    $processor->process('sm-wa/1/data', encodeJson(validReading()), $receivedAt);
    $lastSeenBefore = $database->query('SELECT last_seen FROM devices WHERE id = 1')->fetchColumn();
    $result = $processor->process(
        'sm-wa/1/status',
        encodeJson(['id' => 1, 'status' => 'offline']),
        $receivedAt->modify('+1 hour'),
        true
    );
    expectSame(true, $result['stored']);
    expectSame($lastSeenBefore, $database->query('SELECT last_seen FROM devices WHERE id = 1')->fetchColumn());
    expectSame('offline', $repository->status(1, $receivedAt->modify('+1 hour'))['status']);
});

test('Consultas sem id escolhem o dispositivo visto mais recentemente', static function (): void {
    [, $repository, $processor] = testContext();
    $base = new DateTimeImmutable('2026-08-20 12:00:00', new DateTimeZone('UTC'));
    $processor->process('sm-wa/1/data', encodeJson(validReading()), $base);
    $processor->process(
        'sm-wa/2/data',
        encodeJson(validReading(['id' => 2, 'consumo' => 2000.0])),
        $base->modify('+1 minute')
    );

    expectSame(2, $repository->current(null, $base->modify('+61 seconds'))['device']['id']);
    expectSame(2, $repository->status(null, $base->modify('+61 seconds'))['id']);
    expectSame(2, $repository->history(null, $base->modify('-1 second'), 10)['id']);
});

$failures = 0;
foreach ($tests as $testCase) {
    try {
        $testCase['callback']();
        fwrite(STDOUT, sprintf("[OK] %s%s", $testCase['name'], PHP_EOL));
    } catch (Throwable $exception) {
        $failures++;
        fwrite(STDERR, sprintf("[FALHA] %s: %s%s", $testCase['name'], $exception->getMessage(), PHP_EOL));
    }
}

fwrite(STDOUT, sprintf(
    "%d teste(s), %d falha(s).%s",
    count($tests),
    $failures,
    PHP_EOL
));
exit($failures === 0 ? 0 : 1);
