const dashboardState = {
  latest: null,
  device: null,
  history: [],
  backendAlerts: [],
  selectedRangeHours: 24,
  selectedMetric: 'nivel',
  currentPage: 1,
  pageSize: 7,
  refreshMilliseconds: 60000,
  refreshTimer: null,
  elapsedTimer: null,
  historyMeta: null,
  historyVisible: false,
  units: {},
  snapshotLastStarted: new Map(),
  historyError: false,
  latestError: false,
  statusError: false,
  alertsError: false,
  apiAvailable: null,
  updateInProgress: false,
  historyRequestId: 0,
  historyUpdateInProgress: false,
  historyLastLoadedAt: 0,
  historyLoadedRangeHours: null,
  mainChartRows: [],
  reservoirs: [],
  selectedReservoirId: null,
  pairingCode: null,
};

const HISTORY_REFRESH_MILLISECONDS = 300000;
function unit(field) {
  return dashboardState.units[field] || 'unidade não confirmada';
}

function getElement(id) {
  return document.getElementById(id);
}

function getSelectedReservoir() {
  return dashboardState.reservoirs.find((item) => item.id === dashboardState.selectedReservoirId) || null;
}

function reservoirEndpoint(endpoint, extra = {}) {
  if (!dashboardState.selectedReservoirId) throw new Error('Nenhum reservatório selecionado');
  const query = new URLSearchParams({ reservoir_id: String(dashboardState.selectedReservoirId), ...extra });
  return `${endpoint}?${query}`;
}

function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function parseDate(value) {
  if (!value) return null;

  let normalizedValue = value;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const numericValue = Number(value);
    normalizedValue = Math.abs(numericValue) < 1e12 ? numericValue * 1000 : numericValue;
  }

  const date = new Date(normalizedValue);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatNumber(value, digits = 1) {
  const number = toFiniteNumber(value);
  if (number === null) return '—';

  return number.toLocaleString('pt-BR', {
    minimumFractionDigits: number % 1 === 0 ? 0 : digits,
    maximumFractionDigits: digits,
  });
}

function formatDateTime(value, includeSeconds = false) {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return 'Horário não informado';

  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(includeSeconds ? { second: '2-digit' } : {}),
  });
}

function formatTime(value, includeSeconds = true) {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return 'Sem leitura';

  return date.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    ...(includeSeconds ? { second: '2-digit' } : {}),
  });
}

function formatElapsed(value) {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return 'sem leitura';

  const seconds = Math.max(Math.floor((Date.now() - date.getTime()) / 1000), 0);
  if (seconds < 5) return 'agora';
  if (seconds < 60) return `há ${seconds} segundos`;

  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return 'há 1 minuto';
  if (minutes < 60) return `há ${minutes} minutos`;

  const hours = Math.floor(minutes / 60);
  if (hours === 1) return 'há 1 hora';
  if (hours < 24) return `há ${hours} horas`;

  const days = Math.floor(hours / 24);
  return days === 1 ? 'há 1 dia' : `há ${days} dias`;
}

function formatChartLabel(timestamp) {
  const date = parseDate(timestamp);
  if (!date) return '—';

  if (dashboardState.selectedRangeHours <= 24) {
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  if (dashboardState.selectedRangeHours <= 168) {
    return date.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit' });
  }

  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function formatTooltipTitle(timestamp) {
  const date = parseDate(timestamp);
  if (!date) return 'Horário não informado';

  const datePart = date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const timePart = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `${datePart} • ${timePart}`;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function isSameLocalDay(first, second) {
  return first && second && first.toDateString() === second.toDateString();
}

function getChronologicalHistory(history = dashboardState.history) {
  return [...history]
    .filter((item) => parseDate(item?.timestamp))
    .sort(
      (first, second) =>
        (parseDate(first.timestamp)?.getTime() ?? 0) - (parseDate(second.timestamp)?.getTime() ?? 0),
    );
}

function getRangeHistory() {
  const ordered = getChronologicalHistory();
  if (dashboardState.selectedRangeHours !== 24) return ordered;

  const now = new Date();
  return ordered.filter((item) => isSameLocalDay(parseDate(item.timestamp), now));
}

function getTodayHistory() {
  const now = new Date();
  return getChronologicalHistory().filter((item) => isSameLocalDay(parseDate(item.timestamp), now));
}

function getLevelStatus(level) {
  const value = toFiniteNumber(level);
  if (value === null) return { label: 'Aguardando', shortLabel: 'Sem leitura', className: 'is-waiting' };
  if (value < 20) return { label: 'Nível crítico', shortLabel: 'Crítico', className: 'is-critical' };
  if (value < 40) return { label: 'Nível baixo', shortLabel: 'Baixo', className: 'is-warning' };
  return { label: 'Nível normal', shortLabel: 'Normal', className: 'is-normal' };
}

function getLevelTrend(history = getRangeHistory()) {
  const valid = history
    .map((item) => ({ value: toFiniteNumber(item.nivel), timestamp: item.timestamp }))
    .filter((item) => item.value !== null);

  if (valid.length < 2) return null;

  const change = valid[valid.length - 1].value - valid[0].value;
  const direction = Math.abs(change) < 0.5 ? 'stable' : change > 0 ? 'up' : 'down';
  return { change, direction, first: valid[0], last: valid[valid.length - 1] };
}

function getConsumptionSeries(history = getRangeHistory()) {
  if (dashboardState.historyMeta?.aggregation !== 'none' || dashboardState.units.volume !== 'L')
    return { available: false, points: [], total: 0, intervals: 0 };
  const ordered = getChronologicalHistory(history).filter((item) => toFiniteNumber(item.volume) !== null);
  if (ordered.length < 2) return { available: false, points: [], total: 0, intervals: 0 };

  const points = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previousVolume = toFiniteNumber(ordered[index - 1].volume);
    const currentVolume = toFiniteNumber(ordered[index].volume);
    const reduction = previousVolume - currentVolume;

    if (reduction > 0) {
      points.push({
        timestamp: ordered[index].timestamp,
        previousTimestamp: ordered[index - 1].timestamp,
        value: reduction,
        id: ordered[index].id,
      });
    }
  }

  return {
    available: true,
    points,
    total: points.reduce((sum, point) => sum + point.value, 0),
    intervals: ordered.length - 1,
  };
}

function shouldRefreshFullHistory(hours = dashboardState.selectedRangeHours) {
  if (dashboardState.historyUpdateInProgress) return false;
  if (dashboardState.historyError || dashboardState.historyLastLoadedAt === 0) return true;
  if (dashboardState.historyLoadedRangeHours !== hours) return true;
  return Date.now() - dashboardState.historyLastLoadedAt >= HISTORY_REFRESH_MILLISECONDS;
}

function getMonitoredDeviceId() {
  return dashboardState.device?.id || dashboardState.latest?.id || null;
}

function getDeviceLastSeen() {
  return dashboardState.device?.last_seen || dashboardState.latest?.timestamp || null;
}

function isDeviceDisconnected() {
  return (
    String(dashboardState.device?.status || '')
      .trim()
      .toLowerCase() !== 'online'
  );
}

export {
  dashboardState,
  unit,
  getElement,
  getSelectedReservoir,
  reservoirEndpoint,
  escapeHTML,
  parseDate,
  toFiniteNumber,
  formatNumber,
  formatDateTime,
  formatTime,
  formatElapsed,
  formatChartLabel,
  formatTooltipTitle,
  clamp,
  isSameLocalDay,
  getChronologicalHistory,
  getRangeHistory,
  getTodayHistory,
  getLevelStatus,
  getLevelTrend,
  getConsumptionSeries,
  shouldRefreshFullHistory,
  getMonitoredDeviceId,
  getDeviceLastSeen,
  isDeviceDisconnected,
};
