// Diagnostic summaries contain counts and states only. Detailed output is an
// explicit operator choice because device identifiers and readings are private.
export function diagnosticSummary(command, result) {
  if (command === 'devices')
    return {
      devices: result.data.length,
      page: result.page,
      totalPages: result.totalPages,
      totalElements: result.totalElements,
      hasNext: result.hasNext,
    };
  if (command === 'structure')
    return {
      devices: result.length,
      devicesWithMac: result.filter((device) => device.mac_value_paths.length > 0).length,
    };
  if (command === 'attributes')
    return { attributes: result.keys.length, macAttributes: result.mac_attributes.length };
  if (command === 'keys') return { keys: result.length };
  const series = command === 'history' ? result.series : result;
  return {
    series: Object.keys(series).length,
    points: Object.values(series).reduce((sum, points) => sum + points.length, 0),
    ...(command === 'history' ? { possiblyTruncated: result.possiblyTruncated === true } : {}),
  };
}

const errorCodes = new Set([
  'MONITORIE_AUTH_BUSY',
  'MONITORIE_AUTH_INVALID_DATA',
  'MONITORIE_AUTH_UNAVAILABLE',
  'MONITORIE_LOGIN_REJECTED',
  'MONITORIE_NOT_CONFIGURED',
  'MONITORIE_ACCESS_DENIED',
  'MONITORIE_DEVICE_NOT_FOUND',
  'MONITORIE_INVALID_DATA',
  'MONITORIE_RATE_LIMITED',
  'MONITORIE_TIMEOUT',
  'MONITORIE_TOKEN_EXPIRED',
  'MONITORIE_TOKEN_REJECTED',
  'MONITORIE_UNAVAILABLE',
]);

export function diagnosticError(error, fallback = 'MONITORIE_PROBE_FAILED') {
  return errorCodes.has(error?.code) ? error.code : fallback;
}

export function diagnosticEndpoint(path) {
  if (['/api/auth/login', '/api/auth/token', '/api/user/devices'].includes(path)) return path;
  if (/^\/api\/plugins\/telemetry\/DEVICE\/[^/]+\//.test(path)) return 'device_telemetry';
  return 'other';
}

// The structure probe reads an unnormalized provider response; bound its body
// before parsing just as the production MonitorIE transport does.
export async function readDiagnosticJson(response, maximum = 1024 * 1024) {
  const invalid = () => new Error('MONITORIE_INVALID_DATA');
  if (Number(response.headers.get('Content-Length')) > maximum) throw invalid();
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw invalid();
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
