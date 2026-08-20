<?php

declare(strict_types=1);

namespace R3B\Http;

use RuntimeException;

final class HttpException extends RuntimeException
{
    public function __construct(
        public readonly int $statusCode,
        public readonly string $errorCode,
        string $message
    ) {
        parent::__construct($message);
    }
}

