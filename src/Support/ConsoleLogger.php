<?php

declare(strict_types=1);

namespace R3B\Support;

use DateTimeImmutable;
use DateTimeZone;

final class ConsoleLogger
{
    /** @param array<string, scalar|null> $context */
    public function info(string $scope, string $message, array $context = []): void
    {
        $this->write(STDOUT, $scope, $message, $context);
    }

    /** @param array<string, scalar|null> $context */
    public function error(string $scope, string $message, array $context = []): void
    {
        $this->write(STDERR, $scope, $message, $context);
    }

    /** @param resource $stream
     *  @param array<string, scalar|null> $context
     */
    private function write($stream, string $scope, string $message, array $context): void
    {
        $timestamp = (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format(DATE_ATOM);
        $suffix = '';
        if ($context !== []) {
            $pairs = [];
            foreach ($context as $key => $value) {
                $pairs[] = sprintf('%s=%s', $key, json_encode($value, JSON_UNESCAPED_SLASHES));
            }
            $suffix = ' ' . implode(' ', $pairs);
        }

        fwrite($stream, sprintf("%s [%s] %s%s%s", $timestamp, $scope, $message, $suffix, PHP_EOL));
    }
}

