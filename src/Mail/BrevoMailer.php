<?php

declare(strict_types=1);

namespace R3B\Mail;

use RuntimeException;

final class BrevoMailer implements TransactionalMailer
{
    public function __construct(
        private readonly string $apiKey,
        private readonly string $senderEmail,
        private readonly string $senderName,
        private readonly int $timeoutSeconds = 10
    ) {
    }

    public function sendPasswordReset(string $recipientName, string $recipientEmail, string $resetUrl, int $ttlMinutes): void
    {
        if ($this->apiKey === '' || filter_var($this->senderEmail, FILTER_VALIDATE_EMAIL) === false) {
            throw new RuntimeException('Brevo não está configurado.');
        }

        $safeName = htmlspecialchars($recipientName, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $safeUrl = htmlspecialchars($resetUrl, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $html = '<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f2f7fa;font-family:Arial,sans-serif;color:#173247">'
            . '<div style="max-width:560px;margin:32px auto;background:#fff;border:1px solid #dce8ee;border-radius:16px;overflow:hidden">'
            . '<div style="padding:24px;background:#0b3549;color:#fff"><strong style="font-size:22px">Hidra R3B</strong><br><span>Central de Monitoramento</span></div>'
            . '<div style="padding:28px"><h1 style="font-size:22px;margin:0 0 16px">Redefinição de senha</h1>'
            . '<p>Olá, ' . $safeName . '.</p><p>Recebemos uma solicitação para redefinir a senha da sua conta.</p>'
            . '<p style="margin:28px 0"><a href="' . $safeUrl . '" style="display:inline-block;background:#087ea4;color:#fff;text-decoration:none;padding:13px 20px;border-radius:9px;font-weight:bold">Redefinir minha senha</a></p>'
            . '<p>Este link expira em ' . $ttlMinutes . ' minutos e pode ser usado uma única vez.</p>'
            . '<p style="color:#587080;font-size:14px">Se você não fez esta solicitação, ignore este e-mail. Sua senha não será alterada.</p>'
            . '</div></div></body></html>';
        $text = "Hidra R3B — Redefinição de senha\n\n"
            . "Olá, {$recipientName}.\n\nAcesse o link abaixo para redefinir sua senha:\n{$resetUrl}\n\n"
            . "O link expira em {$ttlMinutes} minutos e pode ser usado uma única vez.\n"
            . "Se você não fez esta solicitação, ignore este e-mail.";

        $payload = json_encode([
            'sender' => ['name' => $this->senderName, 'email' => $this->senderEmail],
            'to' => [['name' => $recipientName, 'email' => $recipientEmail]],
            'subject' => 'Redefina sua senha — Hidra R3B',
            'htmlContent' => $html,
            'textContent' => $text,
        ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => implode("\r\n", [
                    'Accept: application/json',
                    'Content-Type: application/json',
                    'api-key: ' . $this->apiKey,
                    'Content-Length: ' . strlen($payload),
                ]),
                'content' => $payload,
                'timeout' => $this->timeoutSeconds,
                'ignore_errors' => true,
            ],
        ]);

        $response = @file_get_contents('https://api.brevo.com/v3/smtp/email', false, $context);
        $statusLine = $http_response_header[0] ?? '';
        if ($response === false || !preg_match('/\s2\d\d\s/', $statusLine)) {
            $status = preg_match('/\s(\d{3})\s/', $statusLine, $matches) ? $matches[1] : 'network';
            throw new RuntimeException('Falha no envio transacional Brevo (status ' . $status . ').');
        }
    }
}
