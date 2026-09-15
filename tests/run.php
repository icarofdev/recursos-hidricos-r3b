<?php

declare(strict_types=1);

use R3B\DeviceRepository;
use R3B\Auth\AuthService;
use R3B\Auth\PasswordResetService;
use R3B\Auth\UserRepository;
use R3B\Database\SchemaMigrator;
use R3B\Http\HttpException;
use R3B\Mail\TransactionalMailer;
use R3B\Mqtt\MessageProcessor;
use R3B\Mqtt\PayloadValidator;
use R3B\Mqtt\TopicMatcher;
use R3B\Mqtt\ValidationException;
use R3B\ReservoirRepository;
use R3B\Security\RateLimiter;

require dirname(__DIR__) . DIRECTORY_SEPARATOR . 'vendor' . DIRECTORY_SEPARATOR . 'autoload.php';

final class TestFailure extends RuntimeException
{
}

final class FakeMailer implements TransactionalMailer
{
    /** @var list<array{name:string,email:string,url:string,ttl:int}> */
    public array $messages = [];

    public function sendPasswordReset(string $recipientName, string $recipientEmail, string $resetUrl, int $ttlMinutes): void
    {
        $this->messages[] = [
            'name' => $recipientName,
            'email' => $recipientEmail,
            'url' => $resetUrl,
            'ttl' => $ttlMinutes,
        ];
    }
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

/** @return array{id:int,distancia:float,nivel:float,volume:float,rssi_wifi:float} */
function validReading(array $overrides = []): array
{
    return array_replace([
        'id' => 1,
        'distancia' => 42.5,
        'nivel' => 75.0,
        'volume' => 1253.0,
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
    $processor = new MessageProcessor($repository, $validator, 'sm-wu/+/data', 'sm-wu/+/status');
    return [$database, $repository, $processor];
}

test('TopicMatcher extrai o id do nivel curinga', static function (): void {
    expectSame('1', TopicMatcher::deviceId('sm-wu/1/data', 'sm-wu/+/data'));
    expectSame(null, TopicMatcher::deviceId('sm-wu/1/status', 'sm-wu/+/data'));
    expectSame(null, TopicMatcher::deviceId('sm-wu//data', 'sm-wu/+/data'));
});

test('Payload de dados aceita exatamente os cinco campos reais', static function (): void {
    $validator = new PayloadValidator(4096, ['1']);
    $reading = $validator->validateData('sm-wu/1/data', encodeJson(validReading()), 'sm-wu/+/data');

    expectSame(1, $reading['id']);
    expectNear(42.5, $reading['distancia']);
    expectNear(75.0, $reading['nivel']);
    expectNear(1253.0, $reading['volume']);
    expectNear(-60.0, $reading['rssi_wifi']);
    expectSame(['id', 'distancia', 'nivel', 'volume', 'rssi_wifi'], array_keys($reading));
});

test('Todos os campos de telemetria sao obrigatorios', static function (): void {
    $validator = new PayloadValidator(4096, ['1']);
    foreach (['distancia', 'nivel', 'volume', 'rssi_wifi'] as $field) {
        $reading = validReading();
        unset($reading[$field]);
        expectThrows(
            ValidationException::class,
            static fn () => $validator->validateData('sm-wu/1/data', encodeJson($reading), 'sm-wu/+/data'),
            $field
        );
    }
});

test('Tipos numericos em texto e id textual sao rejeitados', static function (): void {
    $validator = new PayloadValidator(4096, ['1']);
    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData(
            'sm-wu/1/data',
            encodeJson(validReading(['distancia' => '42.5'])),
            'sm-wu/+/data'
        ),
        'distancia'
    );
    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData(
            'sm-wu/1/data',
            encodeJson(validReading(['id' => '1'])),
            'sm-wu/+/data'
        ),
        'inteiro positivo'
    );
});

test('Id deve coincidir com o topico e estar autorizado', static function (): void {
    $validator = new PayloadValidator(4096, ['1']);
    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData('sm-wu/2/data', encodeJson(validReading()), 'sm-wu/+/data'),
        'nao corresponde'
    );
    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData(
            'sm-wu/2/data',
            encodeJson(validReading(['id' => 2])),
            'sm-wu/+/data'
        ),
        'nao esta autorizado'
    );
});

test('Campos desconhecidos nao entram no contrato MQTT', static function (): void {
    $validator = new PayloadValidator(4096, ['1']);
    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData(
            'sm-wu/1/data',
            encodeJson(validReading(['campo_extra' => 25.0])),
            'sm-wu/+/data'
        ),
        'campo nao reconhecido'
    );
});

test('Faixas basicas rejeitam valores impossiveis', static function (): void {
    $validator = new PayloadValidator(4096, ['1']);
    foreach ([
        ['distancia', -1.0],
        ['nivel', -0.1],
        ['nivel', 100.1],
        ['volume', -0.1],
        ['rssi_wifi', -201.0],
        ['rssi_wifi', 1.0],
    ] as [$field, $value]) {
        expectThrows(
            ValidationException::class,
            static fn () => $validator->validateData(
                'sm-wu/1/data',
                encodeJson(validReading([$field => $value])),
                'sm-wu/+/data'
            ),
            $field
        );
    }
});

test('JSON invalido, lista, payload grande e leitura retida sao rejeitados', static function (): void {
    $validator = new PayloadValidator(128, ['1']);
    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData('sm-wu/1/data', '{', 'sm-wu/+/data'),
        'JSON valido'
    );
    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData('sm-wu/1/data', '[1,2]', 'sm-wu/+/data'),
        'objeto'
    );
    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateData('sm-wu/1/data', str_repeat('x', 129), 'sm-wu/+/data'),
        'limite'
    );

    [, , $processor] = testContext();
    expectThrows(
        ValidationException::class,
        static fn () => $processor->process('sm-wu/1/data', encodeJson(validReading()), null, true),
        'retidas'
    );
});

test('Status usa id e aceita somente online ou offline', static function (): void {
    $validator = new PayloadValidator(4096, ['1']);
    expectSame(
        ['id' => 1, 'status' => 'online'],
        $validator->validateStatus(
            'sm-wu/1/status',
            encodeJson(['id' => 1, 'status' => 'online']),
            'sm-wu/+/status'
        )
    );
    expectThrows(
        ValidationException::class,
        static fn () => $validator->validateStatus(
            'sm-wu/1/status',
            encodeJson(['id' => 1, 'status' => 'sleeping']),
            'sm-wu/+/status'
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
        $processor->process('sm-wu/1/data', encodeJson(validReading()), $firstAt)
    );
    expectSame(
        ['kind' => 'data', 'id' => 1],
        $processor->process(
            'sm-wu/1/data',
            encodeJson(validReading([
                'distancia' => 40.0,
                'nivel' => 80.0,
                'volume' => 1255.5,
                'rssi_wifi' => -55.0,
            ])),
            $secondAt
        )
    );

    expectSame(2, (int) $database->query('SELECT COUNT(*) FROM smwu_readings')->fetchColumn());
    $current = $repository->current(1, $secondAt->modify('+1 second'));
    expectTrue($current !== null, 'A leitura atual deveria existir.');
    expectSame(1, $current['device']['id']);
    expectSame('online', $current['device']['status']);
    expectSame(1, $current['data']['id']);
    expectNear(40.0, $current['data']['distancia']);
    expectNear(80.0, $current['data']['nivel']);
    expectNear(1255.5, $current['data']['volume']);
    expectNear(-55.0, $current['data']['rssi_wifi']);
    expectSame('2026-08-20T09:00:30-03:00', $current['data']['timestamp']);

    $history = $repository->history(1, $firstAt->modify('-1 second'), 10);
    expectSame(1, $history['id']);
    expectSame(2, count($history['data']));
    expectNear(1255.5, $history['data'][0]['volume']);
    expectNear(1253.0, $history['data'][1]['volume']);

    expectSame(
        ['kind' => 'status', 'id' => 1, 'status' => 'offline'],
        $processor->process(
            'sm-wu/1/status',
            encodeJson(['id' => 1, 'status' => 'offline']),
            $secondAt->modify('+5 seconds')
        )
    );
    expectSame('offline', $repository->status(1, $secondAt->modify('+6 seconds'))['status']);
});

test('Fluxo HTTPS usa o mesmo contrato e persiste leitura atual', static function (): void {
    [, $repository, $processor] = testContext();
    $receivedAt = new DateTimeImmutable('2026-08-20 12:00:00', new DateTimeZone('UTC'));

    expectSame(
        ['kind' => 'data', 'id' => 1, 'inserted' => true],
        $processor->processHttpData(encodeJson(validReading()), $receivedAt)
    );

    $current = $repository->current(1, $receivedAt->modify('+1 second'));
    expectTrue($current !== null, 'A leitura HTTPS deveria existir.');
    expectSame('online', $current['device']['status']);
    expectNear(1253.0, $current['data']['volume']);
});

test('Fluxo HTTPS normaliza numeros serializados como strings pelo firmware', static function (): void {
    [, $repository, $processor] = testContext();
    $receivedAt = new DateTimeImmutable('2026-08-20 12:00:00', new DateTimeZone('UTC'));

    expectSame(
        ['kind' => 'data', 'id' => 1, 'inserted' => true],
        $processor->processHttpData(encodeJson([
            'id' => '1',
            'd' => '42.5',
            'NIVEL' => '75.0',
            'VOLUME' => '1253.0',
            'rssi_wifi' => '-60.0',
        ]), $receivedAt)
    );

    $current = $repository->current(1, $receivedAt->modify('+1 second'));
    expectTrue($current !== null, 'A leitura HTTPS normalizada deveria existir.');
    expectNear(42.5, $current['data']['distancia']);
    expectNear(75.0, $current['data']['nivel']);
    expectNear(1253.0, $current['data']['volume']);
    expectNear(-60.0, $current['data']['rssi_wifi']);
});

test('Timeout de comunicacao altera status calculado para offline', static function (): void {
    [, $repository, $processor] = testContext();
    $receivedAt = new DateTimeImmutable('2026-08-20 12:00:00', new DateTimeZone('UTC'));
    $processor->process('sm-wu/1/data', encodeJson(validReading()), $receivedAt);

    expectSame('online', $repository->status(1, $receivedAt->modify('+89 seconds'))['status']);
    expectSame('offline', $repository->status(1, $receivedAt->modify('+90 seconds'))['status']);
});

test('Status retido nao cria dispositivo fantasma nem altera last_seen', static function (): void {
    [$database, $repository, $processor] = testContext();
    $receivedAt = new DateTimeImmutable('2026-08-20 12:00:00', new DateTimeZone('UTC'));

    expectSame(
        ['kind' => 'status', 'id' => 1, 'status' => 'offline', 'retained' => true, 'stored' => false],
        $processor->process(
            'sm-wu/1/status',
            encodeJson(['id' => 1, 'status' => 'offline']),
            $receivedAt,
            true
        )
    );
    expectSame(0, (int) $database->query('SELECT COUNT(*) FROM devices')->fetchColumn());

    $processor->process('sm-wu/1/data', encodeJson(validReading()), $receivedAt);
    $lastSeenBefore = $database->query('SELECT last_seen FROM devices WHERE id = 1')->fetchColumn();
    $result = $processor->process(
        'sm-wu/1/status',
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
    $processor->process('sm-wu/1/data', encodeJson(validReading()), $base);
    $processor->process(
        'sm-wu/2/data',
        encodeJson(validReading(['id' => 2, 'volume' => 2000.0])),
        $base->modify('+1 minute')
    );

    expectSame(2, $repository->current(null, $base->modify('+61 seconds'))['device']['id']);
    expectSame(2, $repository->status(null, $base->modify('+61 seconds'))['id']);
    expectSame(2, $repository->history(null, $base->modify('-1 second'), 10)['id']);
});

test('Migração multiusuário é incremental e idempotente no schema legado', static function (): void {
    $database = new PDO('sqlite::memory:');
    $database->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $database->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $database->exec('CREATE TABLE devices (
        id INTEGER PRIMARY KEY, reported_status TEXT NOT NULL, last_seen TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )');
    $database->exec('CREATE TABLE smwu_readings (
        reading_id INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER NOT NULL,
        distancia REAL NOT NULL, nivel REAL NOT NULL, volume REAL NOT NULL,
        rssi_wifi REAL NOT NULL, created_at TEXT NOT NULL
    )');
    $database->exec("INSERT INTO devices VALUES (1, 'online', '2026-08-20 12:00:00', '2026-08-20 12:00:00', '2026-08-20 12:00:00')");

    $migrator = new SchemaMigrator($database);
    $migrator->migrate();
    $migrator->migrate();

    expectSame(1, (int) $database->query('SELECT COUNT(*) FROM devices')->fetchColumn(), 'O dispositivo legado deve ser preservado.');
    expectSame(1, (int) $database->query('SELECT COUNT(*) FROM schema_migrations')->fetchColumn());
    expectSame('users', (string) $database->query("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")->fetchColumn());
    $columns = array_column($database->query('PRAGMA table_info(smwu_readings)')->fetchAll(), 'name');
    expectTrue(in_array('reservoir_id', $columns, true), 'A leitura deve receber a coluna de escopo.');
});

test('Cadastro, login e credenciais inválidas usam hash seguro', static function (): void {
    $database = testDatabase();
    $users = new UserRepository($database);
    $auth = new AuthService($users);
    $created = $auth->register('  Maria   da Silva  ', ' MARIA@EXEMPLO.COM ', 'SenhaForte2026', 'SenhaForte2026');

    expectSame('Maria da Silva', $created['name']);
    expectSame('maria@exemplo.com', $created['email']);
    $stored = $users->findByEmail('maria@exemplo.com');
    expectTrue($stored !== null && $stored['password_hash'] !== 'SenhaForte2026', 'Senha não pode ser armazenada em texto puro.');
    expectTrue(password_verify('SenhaForte2026', $stored['password_hash']), 'Hash deve validar a senha.');
    expectSame($created['id'], $auth->login('maria@exemplo.com', 'SenhaForte2026')['id']);
    expectThrows(HttpException::class, static fn () => $auth->login('maria@exemplo.com', 'incorreta'), 'inválidos');
    expectThrows(HttpException::class, static fn () => $auth->register('Outro', 'maria@exemplo.com', 'OutraSenha2026', 'OutraSenha2026'), 'Já existe');
});

test('Recuperação não enumera contas e armazena somente hash do token', static function (): void {
    $database = testDatabase();
    $users = new UserRepository($database);
    $auth = new AuthService($users);
    $auth->register('Paulo Lima', 'paulo@example.com', 'SenhaForte2026', 'SenhaForte2026');
    $mailer = new FakeMailer();
    $service = new PasswordResetService($database, $users, $mailer, 'https://hidra.example', 20);
    $now = new DateTimeImmutable('2026-09-15 12:00:00', new DateTimeZone('UTC'));

    $service->request('nao-existe@example.com', $now);
    expectSame(0, count($mailer->messages), 'Conta inexistente não envia mensagem.');
    $service->request('paulo@example.com', $now);
    expectSame(1, count($mailer->messages));
    expectSame(20, $mailer->messages[0]['ttl']);
    $query = parse_url($mailer->messages[0]['url'], PHP_URL_QUERY);
    parse_str((string) $query, $parameters);
    $token = (string) ($parameters['token'] ?? '');
    expectTrue(strlen($token) === 43, 'Token deve conter 256 bits codificados.');
    $stored = $database->query('SELECT token_hash FROM password_reset_tokens')->fetchColumn();
    expectSame(hash('sha256', $token), $stored);
    expectTrue(!str_contains((string) $stored, $token), 'O token puro não pode estar no banco.');
    expectTrue($service->isValid($token, $now->modify('+19 minutes')), 'Token deve ser válido antes do vencimento.');
    expectTrue(!$service->isValid('token-invalido', $now), 'Token malformado deve ser rejeitado.');
});

test('Token de senha válido é único, expira e revoga sessões anteriores', static function (): void {
    $database = testDatabase();
    $users = new UserRepository($database);
    $auth = new AuthService($users);
    $user = $auth->register('Ana Souza', 'ana@example.com', 'SenhaAntiga2026', 'SenhaAntiga2026');
    $mailer = new FakeMailer();
    $service = new PasswordResetService($database, $users, $mailer, 'https://hidra.example', 20);
    $now = new DateTimeImmutable('2026-09-15 12:00:00', new DateTimeZone('UTC'));
    $service->request('ana@example.com', $now);
    parse_str((string) parse_url($mailer->messages[0]['url'], PHP_URL_QUERY), $parameters);
    $token = (string) $parameters['token'];

    $service->reset($token, 'SenhaNova2026', 'SenhaNova2026', $now->modify('+5 minutes'));
    expectSame($user['session_version'] + 1, $users->findById($user['id'])['session_version']);
    expectSame($user['id'], $auth->login('ana@example.com', 'SenhaNova2026')['id']);
    expectThrows(HttpException::class, static fn () => $service->reset($token, 'OutraSenha2026', 'OutraSenha2026', $now->modify('+6 minutes')), 'utilizado');

    $service->request('ana@example.com', $now);
    parse_str((string) parse_url($mailer->messages[1]['url'], PHP_URL_QUERY), $secondParameters);
    $expiredToken = (string) $secondParameters['token'];
    expectTrue(!$service->isValid($expiredToken, $now->modify('+21 minutes')), 'Token expirado deve ser rejeitado.');
    expectThrows(HttpException::class, static fn () => $service->reset($expiredToken, 'TerceiraSenha2026', 'TerceiraSenha2026', $now->modify('+21 minutes')), 'expirou');
});

test('Pareamento, isolamento contra IDOR, renomeação e desvinculação preservam histórico', static function (): void {
    $database = testDatabase();
    $users = new UserRepository($database);
    $auth = new AuthService($users);
    $owner = $auth->register('Proprietário A', 'a@example.com', 'SenhaForte2026', 'SenhaForte2026');
    $other = $auth->register('Proprietário B', 'b@example.com', 'SenhaForte2026', 'SenhaForte2026');
    $devices = new DeviceRepository($database, 90, new DateTimeZone('America/Sao_Paulo'));
    $processor = new MessageProcessor($devices, new PayloadValidator(4096, ['1']), 'sm-wu/+/data', 'sm-wu/+/status');
    $now = new DateTimeImmutable('now', new DateTimeZone('UTC'));
    $processor->process('sm-wu/1/data', encodeJson(validReading()), $now);
    $reservoirs = new ReservoirRepository($database, 90, new DateTimeZone('America/Sao_Paulo'));

    $pairingCode = $reservoirs->provisionPairingCode(1, 60);
    expectSame('online', $reservoirs->validatePairingCode($pairingCode, $now)['status']);
    expectThrows(HttpException::class, static fn () => $reservoirs->validatePairingCode('HIDRA-AAAA-BBBB-CCCC-DDDD'), 'inválido');
    $reservoir = $reservoirs->connect($owner['id'], $pairingCode, ' Caixa   superior ', $now);
    expectSame('Caixa superior', $reservoir['name']);
    expectTrue($devices->currentForReservoir($reservoir['id'], $owner['id'], $now->modify('+1 second')) !== null, 'Proprietário deve acessar a própria leitura.');
    expectSame(null, $devices->currentForReservoir($reservoir['id'], $other['id'], $now->modify('+1 second')), 'Usuário B não pode ler recurso de A.');
    expectSame(null, $reservoirs->findOwned($reservoir['id'], $other['id']), 'Usuário B não pode descobrir recurso de A.');
    expectThrows(HttpException::class, static fn () => $reservoirs->connect($other['id'], $pairingCode, 'Invasão', $now), 'já está vinculado');

    $renamed = $reservoirs->rename($reservoir['id'], $owner['id'], 'Reserva técnica');
    expectSame('Reserva técnica', $renamed['name']);
    expectThrows(HttpException::class, static fn () => $reservoirs->rename($reservoir['id'], $other['id'], 'Outro nome'), 'não encontrado');
    $reservoirs->unlink($reservoir['id'], $owner['id'], $now->modify('+1 minute'));
    expectSame(null, $reservoirs->findOwned($reservoir['id'], $owner['id']));
    expectSame(1, (int) $database->query('SELECT COUNT(*) FROM smwu_readings WHERE reservoir_id IS NOT NULL')->fetchColumn(), 'Desvincular não apaga nem remove o escopo histórico.');
    expectThrows(HttpException::class, static fn () => $reservoirs->validatePairingCode($pairingCode), 'inválido');
});

test('Rate limiting bloqueia excesso sem armazenar identificador em claro', static function (): void {
    $database = testDatabase();
    $limiter = new RateLimiter($database, 'segredo-de-teste');
    expectSame(0, $limiter->consume('login', 'Pessoa@Example.com', 2, 60, 1000));
    expectSame(0, $limiter->consume('login', 'pessoa@example.com', 2, 60, 1001));
    expectSame(58, $limiter->consume('login', 'pessoa@example.com', 2, 60, 1002));
    $storedKey = (string) $database->query('SELECT key_hash FROM rate_limits')->fetchColumn();
    expectTrue(!str_contains($storedKey, 'pessoa'), 'Identificador deve ser armazenado apenas como HMAC.');
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
