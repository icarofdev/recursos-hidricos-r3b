<?php

declare(strict_types=1);

use R3B\DeviceRepository;
use R3B\Mqtt\ClientFactory;
use R3B\Mqtt\MessageProcessor;
use R3B\Mqtt\PayloadValidator;
use R3B\Mqtt\ValidationException;
use R3B\Support\ConsoleLogger;

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once dirname(__DIR__) . '/config/bootstrap.php';
require_once APP_ROOT . '/config/database.php';
require_once APP_ROOT . '/config/mqtt.php';

$logger = new ConsoleLogger();
$config = mqtt_config();
$offlineAfterSeconds = env_int('DEVICE_OFFLINE_AFTER_SECONDS', 90, 5, 86400);
$timezone = new DateTimeZone(env_value('APP_TIMEZONE', 'America/Sao_Paulo') ?: 'America/Sao_Paulo');
$buildProcessor = static function (bool $resetDatabase) use (
    $offlineAfterSeconds,
    $timezone,
    $config
): MessageProcessor {
    $repository = new DeviceRepository(
        database_connection($resetDatabase),
        $offlineAfterSeconds,
        $timezone
    );
    $validator = new PayloadValidator($config['max_payload_bytes'], $config['allowed_devices']);

    return new MessageProcessor(
        $repository,
        $validator,
        $config['data_topic'],
        $config['status_topic']
    );
};

$running = true;
$activeClient = null;
$processor = null;
$resetDatabaseConnection = false;
if (function_exists('pcntl_async_signals') && function_exists('pcntl_signal')) {
    pcntl_async_signals(true);
    pcntl_signal(SIGINT, static function () use (&$running, &$activeClient, $logger): void {
        $logger->info('MQTT', 'Shutdown requested.');
        $running = false;
        if ($activeClient !== null) {
            $activeClient->interrupt();
        }
    });
    pcntl_signal(SIGTERM, static function () use (&$running, &$activeClient, $logger): void {
        $logger->info('MQTT', 'Shutdown requested.');
        $running = false;
        if ($activeClient !== null) {
            $activeClient->interrupt();
        }
    });
}

$reconnectDelay = $config['reconnect_min'];
$databaseReconnectDelay = $config['reconnect_min'];
$databaseNeedsOperationProof = false;
while ($running) {
    if (!$processor instanceof MessageProcessor) {
        try {
            $logger->info('DB', 'Connecting...');
            $processor = $buildProcessor($resetDatabaseConnection);
            $resetDatabaseConnection = false;
            if (!$databaseNeedsOperationProof) {
                $databaseReconnectDelay = $config['reconnect_min'];
            }
            $logger->info('DB', 'Connected.');
        } catch (PDOException $exception) {
            $resetDatabaseConnection = true;
            $jitter = random_int(80, 120) / 100;
            $waitSeconds = $databaseReconnectDelay * $jitter;
            $logger->error('DB', 'Database unavailable.', ['reason' => $exception->getMessage()]);
            $logger->info('DB', 'Reconnecting...', ['delay_seconds' => round($waitSeconds, 2)]);
            usleep((int) round($waitSeconds * 1000000));
            $databaseReconnectDelay = min(
                $databaseReconnectDelay * 2,
                $config['reconnect_max']
            );
            continue;
        }
    }

    if (!$running) {
        break;
    }

    $connectedAt = null;
    $databaseFailure = false;
    try {
        $logger->info('MQTT', 'Connecting...', [
            'host' => $config['host'],
            'port' => $config['port'],
            'tls' => $config['tls'],
        ]);
        $connection = ClientFactory::create($config);
        $activeClient = $connection['client'];
        if (!$running) {
            break;
        }
        // Sessao persistente: o broker pode enfileirar QoS 1 durante reconexoes.
        $activeClient->connect($connection['settings'], false);
        $connectedAt = microtime(true);
        $logger->info('MQTT', 'Connected.');
        if (!$running) {
            $activeClient->disconnect();
            break;
        }

        $callback = static function (
            string $topic,
            string $message,
            bool $retained = false
        ) use (
            $processor,
            $logger,
            $config,
            &$databaseFailure,
            &$activeClient,
            &$databaseReconnectDelay,
            &$databaseNeedsOperationProof
        ): void {
            try {
                $result = $processor->process($topic, $message, null, $retained);
                $databaseReconnectDelay = $config['reconnect_min'];
                $databaseNeedsOperationProof = false;
                $logger->info('MQTT', 'Message received.', [
                    'id' => $result['id'],
                    'kind' => $result['kind'],
                    'retained' => $retained,
                ]);
                if (($result['stored'] ?? true) === false) {
                    $logger->info('DB', 'Retained status ignored until the first real device message.', [
                        'id' => $result['id'],
                    ]);
                    return;
                }
                $logger->info('DB', $result['kind'] === 'data' ? 'Reading stored.' : 'Device status stored.', [
                    'id' => $result['id'],
                ]);
            } catch (ValidationException $exception) {
                $logger->error('MQTT', 'Message rejected.', [
                    'topic' => $topic,
                    'reason' => $exception->getMessage(),
                ]);
            } catch (PDOException $exception) {
                $logger->error('DB', 'Message could not be stored.', [
                    'topic' => $topic,
                    'reason' => $exception->getMessage(),
                ]);
                $databaseFailure = true;
                if ($activeClient !== null) {
                    $activeClient->interrupt();
                }
            } catch (Throwable $exception) {
                $logger->error('MQTT', 'Message processing failed.', [
                    'topic' => $topic,
                    'reason' => $exception->getMessage(),
                ]);
            }
        };

        $activeClient->subscribe($config['data_topic'], $callback, $config['qos']);
        $activeClient->subscribe($config['status_topic'], $callback, $config['qos']);
        $logger->info('MQTT', 'Subscribed.', [
            'data_topic' => $config['data_topic'],
            'status_topic' => $config['status_topic'],
        ]);
        if (!$running) {
            $activeClient->disconnect();
            break;
        }

        $activeClient->loop(true);

        if ($activeClient->isConnected()) {
            $activeClient->disconnect();
        }
    } catch (Throwable $exception) {
        $logger->error('MQTT', 'Connection lost.', ['reason' => $exception->getMessage()]);
    } finally {
        $activeClient = null;
    }

    if (!$running) {
        break;
    }

    if ($databaseFailure) {
        // Sai do MQTT para o broker enfileirar as proximas mensagens da sessao persistente.
        $processor = null;
        $resetDatabaseConnection = true;
        $databaseNeedsOperationProof = true;
        $reconnectDelay = $config['reconnect_min'];
        $jitter = random_int(80, 120) / 100;
        $waitSeconds = $databaseReconnectDelay * $jitter;
        $logger->info('DB', 'Reconnecting...', ['delay_seconds' => round($waitSeconds, 2)]);
        usleep((int) round($waitSeconds * 1000000));
        $databaseReconnectDelay = min(
            $databaseReconnectDelay * 2,
            $config['reconnect_max']
        );
        continue;
    }

    if (
        $connectedAt !== null
        && (microtime(true) - $connectedAt) >= $config['reconnect_reset_after']
    ) {
        $reconnectDelay = $config['reconnect_min'];
    }

    $jitter = random_int(80, 120) / 100;
    $waitSeconds = $reconnectDelay * $jitter;
    $logger->info('MQTT', 'Reconnecting...', ['delay_seconds' => round($waitSeconds, 2)]);
    usleep((int) round($waitSeconds * 1000000));
    $reconnectDelay = min($reconnectDelay * 2, $config['reconnect_max']);
}

$logger->info('MQTT', 'Subscriber stopped.');
