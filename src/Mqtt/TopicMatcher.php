<?php

declare(strict_types=1);

namespace R3B\Mqtt;

final class TopicMatcher
{
    public static function deviceId(string $topic, string $filter): ?string
    {
        $topicLevels = explode('/', $topic);
        $filterLevels = explode('/', $filter);

        if (count($topicLevels) !== count($filterLevels)) {
            return null;
        }

        $capturedDeviceId = null;
        foreach ($filterLevels as $index => $filterLevel) {
            $topicLevel = $topicLevels[$index];

            if ($filterLevel === '+') {
                if ($capturedDeviceId !== null || $topicLevel === '') {
                    return null;
                }
                $capturedDeviceId = $topicLevel;
                continue;
            }

            if ($filterLevel === '#' || $filterLevel !== $topicLevel) {
                return null;
            }
        }

        return $capturedDeviceId;
    }
}

