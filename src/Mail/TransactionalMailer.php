<?php

declare(strict_types=1);

namespace R3B\Mail;

interface TransactionalMailer
{
    public function sendPasswordReset(string $recipientName, string $recipientEmail, string $resetUrl, int $ttlMinutes): void;
}
