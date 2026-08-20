<?php

declare(strict_types=1);

namespace R3B\Mqtt;

use PhpMqtt\Client\ConnectionSettings;
use PhpMqtt\Client\MqttClient;
use RuntimeException;

final class ClientFactory
{
    /** @param array<string, mixed> $config
     *  @return array{client:MqttClient,settings:ConnectionSettings}
     */
    public static function create(array $config, ?string $clientId = null): array
    {
        $resolvedClientId = $clientId ?? $config['client_id'];
        if (!is_string($resolvedClientId) || !preg_match('/^[A-Za-z0-9][A-Za-z0-9_-]{0,22}$/', $resolvedClientId)) {
            throw new RuntimeException('O client ID MQTT deve ter entre 1 e 23 caracteres portaveis.');
        }

        $settings = (new ConnectionSettings())
            ->setUsername($config['username'] !== '' ? $config['username'] : null)
            ->setPassword($config['password'] !== '' ? $config['password'] : null)
            ->setConnectTimeout($config['connect_timeout'])
            ->setSocketTimeout($config['socket_timeout'])
            ->setKeepAliveInterval($config['keep_alive'])
            ->setUseTls($config['tls'])
            ->setTlsVerifyPeer($config['tls_verify_peer'])
            ->setTlsVerifyPeerName($config['tls_verify_peer'])
            ->setTlsSelfSignedAllowed(false);

        if ($config['tls_ca_file'] !== null && $config['tls_ca_file'] !== '') {
            if (!is_file($config['tls_ca_file'])) {
                throw new RuntimeException('MQTT_TLS_CA_FILE nao aponta para um arquivo legivel.');
            }
            $settings = $settings->setTlsCertificateAuthorityFile($config['tls_ca_file']);
        }

        return [
            'client' => new MqttClient(
                $config['host'],
                $config['port'],
                $resolvedClientId,
                MqttClient::MQTT_3_1_1
            ),
            'settings' => $settings,
        ];
    }
}
