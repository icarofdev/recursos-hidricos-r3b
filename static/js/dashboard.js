import {
  historyChart,
  consumptionChart,
  showChartState,
  hideChartState,
  getChartColors,
  baseChartOptions,
  initializeCharts,
  renderChart,
  renderConsumption,
} from './dashboard/charts.js';
import {
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
} from './dashboard/model.js';
import { safeRedirect } from './redirects.js';
const API_BASE = window.__API_BASE__ || document.querySelector('meta[name="api-base"]')?.content || '';
function apiUrl(endpoint) {
  if (!API_BASE || endpoint.startsWith('http://') || endpoint.startsWith('https://')) return endpoint;
  return `${API_BASE.replace(/\/+$/, '')}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
}

const API_ENDPOINTS = {
  history: '/api/device/history',
  snapshot: '/api/device/snapshot',
  reservoirs: '/api/reservoirs',
  rename: '/api/reservoirs/rename',
  validatePairing: '/api/devices/validate-pairing',
  connect: '/api/devices/connect',
  unlink: '/api/devices/unlink',
  logout: '/api/auth/logout',
};

let CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')?.content || '';
if (CSRF_TOKEN === '{{csrf}}') CSRF_TOKEN = '';

const REQUEST_TIMEOUT_MILLISECONDS = 8000;
const HISTORY_REFRESH_MILLISECONDS = 300000;
const ELAPSED_REFRESH_MILLISECONDS = 5000;

const RANGE_LIMITS = {
  24: 300,
  168: 800,
  720: 1600,
};

function setStatusDot(element, statusClass) {
  element.className = `status-dot ${statusClass || ''}`.trim();
}

function renderConnection() {
  const dot = getElement('connection-dot');
  const label = getElement('connection-label');
  const updated = getElement('updated-label');
  const lastSeen = parseDate(getDeviceLastSeen());

  updated.textContent = lastSeen ? formatTime(lastSeen) : 'Aguardando dados';

  if (dashboardState.updateInProgress && dashboardState.apiAvailable === false) {
    setStatusDot(dot, 'is-warning');
    label.textContent = 'Reconectando…';
    return;
  }

  if (dashboardState.apiAvailable === false) {
    setStatusDot(dot, 'is-error');
    label.textContent = 'API indisponível';
    return;
  }

  if (dashboardState.statusError) {
    setStatusDot(dot, 'is-error');
    label.textContent = 'Status indisponível';
    return;
  }

  if (!dashboardState.device) {
    setStatusDot(dot, 'is-waiting');
    label.textContent = dashboardState.latest ? 'Sem status' : 'Sem dispositivo';
    return;
  }

  if (isDeviceDisconnected()) {
    setStatusDot(dot, 'is-error');
    label.textContent = 'Offline';
    return;
  }

  setStatusDot(dot, '');
  label.textContent = 'Online';
}

function renderSystemStatus() {
  const container = getElement('system-status');
  const title = getElement('system-status-title');
  const description = getElement('system-status-description');
  const time = getElement('system-status-time');
  const retryButton = getElement('retry-button');
  const latest = dashboardState.latest;
  const latestDate = parseDate(latest?.timestamp);
  const lastSeen = parseDate(getDeviceLastSeen());

  container.className = 'system-status';
  time.textContent = lastSeen
    ? formatElapsed(lastSeen)
    : latestDate
      ? formatElapsed(latestDate)
      : 'Sem leitura';
  retryButton.hidden = true;
  retryButton.disabled = dashboardState.updateInProgress;

  if (dashboardState.updateInProgress && dashboardState.apiAvailable === false) {
    container.classList.add('is-warning');
    title.textContent = 'Reconectando…';
    description.textContent = 'Tentando restabelecer a comunicação com a API.';
    return;
  }

  if (dashboardState.apiAvailable === false) {
    container.classList.add('is-error');
    title.textContent = 'Não foi possível atualizar os dados';
    description.textContent = latest
      ? 'A última leitura válida continua visível. Tente novamente ou aguarde a próxima consulta automática.'
      : 'A dashboard não conseguiu consultar a API. Tente novamente em alguns instantes.';
    retryButton.hidden = false;
    return;
  }

  if (dashboardState.statusError) {
    container.classList.add('is-error');
    title.textContent = 'Status do dispositivo indisponível';
    description.textContent =
      'A leitura pode estar visível, mas o estado de conexão não pôde ser confirmado.';
    retryButton.hidden = false;
    return;
  }

  if (dashboardState.device && isDeviceDisconnected()) {
    container.classList.add('is-critical');
    title.textContent = 'Dispositivo offline';
    description.textContent = lastSeen
      ? `Última comunicação ${formatElapsed(lastSeen)}. As últimas medições permanecem disponíveis para consulta.`
      : 'Nenhuma comunicação válida foi registrada para o dispositivo.';
    return;
  }

  if (dashboardState.latestError) {
    container.classList.add('is-warning');
    title.textContent = 'Leitura atual não pôde ser atualizada';
    description.textContent = latest
      ? `Exibindo a última leitura válida, recebida ${formatElapsed(latestDate)}.`
      : 'O dispositivo foi consultado, mas a leitura atual não está disponível.';
    retryButton.hidden = false;
    return;
  }

  if (dashboardState.historyError) {
    container.classList.add('is-warning');
    title.textContent = 'Histórico temporariamente indisponível';
    description.textContent =
      'A leitura atual continua disponível, mas os gráficos e análises não puderam ser atualizados.';
    retryButton.hidden = false;
    return;
  }

  if (!latest) {
    container.classList.add('is-neutral');
    title.textContent = 'Aguardando a primeira leitura';
    description.textContent = dashboardState.device
      ? 'O dispositivo foi identificado, mas ainda não há medição disponível.'
      : 'O painel está disponível, mas nenhum dispositivo ou medição foi encontrado.';
    return;
  }

  title.textContent = 'Sistema operando normalmente';
  description.textContent = 'Dispositivo conectado e telemetria recebida pelo backend.';
}

function renderLatest() {
  const latest = dashboardState.latest;
  const signalVisual = getElement('signal-visual');
  const signalFill = getElement('signal-fill');
  const levelTrackFill = getElement('level-track-fill');
  const statusBadge = getElement('telemetry-status');

  if (!latest) {
    document.documentElement.style.setProperty('--water-level', '0%');
    signalVisual.setAttribute('aria-label', 'Nível do reservatório sem leitura disponível');
    signalFill.className = 'tank-water';
    levelTrackFill.className = '';
    statusBadge.className = 'status-badge is-waiting';
    statusBadge.textContent = 'Aguardando';
    getElement('consumption-reading').textContent = '—';
    getElement('flow-reading').textContent = '—';
    getElement('wifi-reading').textContent = '—';
    getElement('rssi-metric').textContent = '—';
    getElement('telemetry-classification').textContent = 'Aguardando telemetria';
    getElement('monitored-device').textContent = dashboardState.device?.id
      ? `${getSelectedReservoir()?.name || 'Reservatório'} · ${getSelectedReservoir()?.device?.code || `ID ${dashboardState.device.id}`} · Sem leitura atual`
      : 'Nenhum dispositivo identificado';
    getElement('metric-timestamp').textContent = 'Sem leitura';
    return;
  }

  const isSMWA = getSelectedReservoir()?.device?.type === 'SM-WA';
  const vazao = toFiniteNumber(latest.vazao);
  const consumo = toFiniteNumber(latest.consumo_acumulado);
  const volume = toFiniteNumber(latest.volume);
  const rssi = toFiniteNumber(latest.rssi_wifi);
  const sensorId = getMonitoredDeviceId();

  if (isSMWA) {
    document.documentElement.style.setProperty('--water-level', '50%');
    signalVisual.setAttribute(
      'aria-label',
      vazao === null
        ? 'Medidor de água SM-WA sem valor válido'
        : `Vazão do hidrômetro: ${formatNumber(vazao, 2)} ${unit('vazao')}.`,
    );
    signalFill.className = 'tank-water is-good';
    levelTrackFill.className = 'is-good';
    statusBadge.className = 'status-badge is-good';
    statusBadge.textContent = 'Hidrômetro';
    getElement('consumption-reading').textContent =
      vazao === null ? '—' : `${formatNumber(vazao, 2)} ${unit('vazao')}`;
    getElement('telemetry-classification').textContent =
      vazao === null ? 'Vazão não informada na última leitura' : 'Fluxo instantâneo reportado pelo SM-WA';
    getElement('flow-reading').textContent =
      consumo === null ? 'Não informado' : `${formatNumber(consumo, 2)} ${unit('consumo_acumulado')}`;
    getElement('wifi-reading').textContent =
      volume === null ? 'Não informado' : `${formatNumber(volume, 2)} ${unit('volume')}`;
    getElement('rssi-metric').textContent = rssi === null ? 'Não informado' : `${formatNumber(rssi)} dBm`;
    getElement('monitored-device').textContent = sensorId
      ? `${getSelectedReservoir()?.name || 'Medidor'} · ${getSelectedReservoir()?.device?.code || `ID ${sensorId}`}`
      : 'Dispositivo sem identificação';
    getElement('metric-timestamp').textContent = formatDateTime(latest.timestamp, true);
    return;
  }

  const nivel = toFiniteNumber(latest.nivel);
  const distancia = toFiniteNumber(latest.distancia);
  const status = getLevelStatus(nivel);
  const waterLevel = nivel === null ? 0 : clamp(nivel, 0, 100);

  document.documentElement.style.setProperty('--water-level', `${waterLevel}%`);
  signalVisual.setAttribute(
    'aria-label',
    nivel === null
      ? 'Nível do reservatório sem valor válido'
      : `Nível do reservatório: ${formatNumber(nivel, 2)}%. Estado: ${status.shortLabel}.`,
  );
  signalFill.className = `tank-water ${status.className}`;
  levelTrackFill.className = status.className;
  statusBadge.className = `status-badge ${status.className}`;
  statusBadge.textContent = status.shortLabel;
  getElement('consumption-reading').textContent = nivel === null ? '—' : `${formatNumber(nivel, 2)}%`;
  getElement('telemetry-classification').textContent =
    nivel === null
      ? 'Valor de nível inválido na última leitura'
      : 'Percentual informado pelo medidor ultrassônico';
  getElement('flow-reading').textContent =
    volume === null ? 'Não informado' : `${formatNumber(volume, 2)} ${unit('volume')}`;
  getElement('wifi-reading').textContent =
    distancia === null ? 'Não informada' : `${formatNumber(distancia, 2)} cm`;
  getElement('rssi-metric').textContent = rssi === null ? 'Não informado' : `${formatNumber(rssi)} dBm`;
  getElement('monitored-device').textContent = sensorId
    ? `${getSelectedReservoir()?.name || 'Reservatório'} · ${getSelectedReservoir()?.device?.code || `ID ${sensorId}`}`
    : 'Dispositivo sem identificação';
  getElement('metric-timestamp').textContent = formatDateTime(latest.timestamp, true);
}

function renderMetrics() {
  const latest = dashboardState.latest;
  const device = dashboardState.device;
  const isSMWA = getSelectedReservoir()?.device?.type === 'SM-WA';
  const lastSeen = parseDate(getDeviceLastSeen());

  if (isSMWA) {
    const vazao = toFiniteNumber(latest?.vazao);
    const consumo = toFiniteNumber(latest?.consumo_acumulado);
    const volume = toFiniteNumber(latest?.volume);

    const label1 = document
      .querySelector('#ppl-reading')
      ?.closest('.metric-card')
      ?.querySelector('.metric-label');
    if (label1) label1.textContent = 'Vazão atual';
    getElement('ppl-reading').textContent = vazao === null ? '—' : formatNumber(vazao, 2);
    getElement('ppl-unit').textContent = vazao === null ? '' : unit('vazao');
    getElement('ppl-context').textContent =
      vazao === null ? 'Aguardando leitura' : 'Fluxo instantâneo medido pelo SM-WA';

    const label2 = document
      .querySelector('#consumption-metric')
      ?.closest('.metric-card')
      ?.querySelector('.metric-label');
    if (label2) label2.textContent = 'Consumo acumulado';
    getElement('consumption-metric').textContent = consumo === null ? '—' : formatNumber(consumo, 2);
    getElement('volume-unit').textContent = consumo === null ? '' : unit('consumo_acumulado');
    getElement('volume-context').textContent = 'Total acumulado no hidrômetro';

    const label3 = document
      .querySelector('#daily-consumption-reading')
      ?.closest('.metric-card')
      ?.querySelector('.metric-label');
    if (label3) label3.textContent = 'Volume';
    getElement('daily-consumption-reading').textContent = volume === null ? '—' : formatNumber(volume, 2);
    getElement('daily-consumption-unit').textContent = volume === null ? '' : unit('volume');
    getElement('daily-consumption-context').textContent = 'Estimativa de volume';

    const label4 = document
      .querySelector('#level-state-reading')
      ?.closest('.metric-card')
      ?.querySelector('.metric-label');
    if (label4) label4.textContent = 'Estado do medidor';
    getElement('level-state-reading').textContent = device?.status === 'online' ? 'Operando' : 'Offline';
    getElement('level-state-reading').className =
      `metric-status ${device?.status === 'online' ? 'is-good' : 'is-critical'}`;
    getElement('level-state-context').textContent =
      device?.status === 'online' ? 'Comunicação regular SM-WA' : 'Sem sinal recente';

    getElement('flow-metric').textContent =
      vazao === null ? '—' : `${formatNumber(vazao, 2)} ${unit('vazao')}`;
    getElement('flow-context').textContent = 'Vazão reportada pelo SM-WA';
  } else {
    const label1 = document
      .querySelector('#ppl-reading')
      ?.closest('.metric-card')
      ?.querySelector('.metric-label');
    if (label1) label1.textContent = 'Nível atual';
    const label2 = document
      .querySelector('#consumption-metric')
      ?.closest('.metric-card')
      ?.querySelector('.metric-label');
    if (label2) label2.textContent = 'Volume atual';
    const label3 = document
      .querySelector('#daily-consumption-reading')
      ?.closest('.metric-card')
      ?.querySelector('.metric-label');
    if (label3) label3.textContent = 'Consumo hoje';
    const label4 = document
      .querySelector('#level-state-reading')
      ?.closest('.metric-card')
      ?.querySelector('.metric-label');
    if (label4) label4.textContent = 'Estado do reservatório';

    const level = toFiniteNumber(latest?.nivel);
    const volume = toFiniteNumber(latest?.volume);
    const distance = toFiniteNumber(latest?.distancia);
    const levelStatus = getLevelStatus(level);
    const trend = getLevelTrend();
    const todayHistory = getTodayHistory();
    const todayConsumption = getConsumptionSeries(todayHistory);
    const capacity = toFiniteNumber(getSelectedReservoir()?.capacity_liters);

    getElement('ppl-reading').textContent = level === null ? '—' : formatNumber(level, 2);
    getElement('ppl-unit').textContent = level === null ? '' : '%';
    getElement('ppl-context').textContent = trend
      ? trend.direction === 'stable'
        ? 'Estável no período selecionado'
        : `${trend.change > 0 ? 'Alta' : 'Queda'} de ${formatNumber(Math.abs(trend.change), 1)} p.p. no período`
      : latest
        ? 'Histórico insuficiente para tendência'
        : 'Aguardando leitura';

    getElement('consumption-metric').textContent = volume === null ? '—' : formatNumber(volume, 2);
    getElement('volume-unit').textContent = volume === null ? '' : 'L';
    getElement('volume-context').textContent =
      capacity === null ? 'Capacidade total não informada' : `Capacidade: ${formatNumber(capacity, 2)} L`;
    getElement('capacity-reading').textContent =
      capacity === null ? 'Não informada' : `${formatNumber(capacity, 2)} L`;

    getElement('daily-consumption-reading').textContent = todayConsumption.available
      ? formatNumber(todayConsumption.total, 2)
      : '—';
    getElement('daily-consumption-unit').textContent = todayConsumption.available ? 'L' : '';
    getElement('daily-consumption-context').textContent = todayConsumption.available
      ? `${todayConsumption.intervals} ${todayConsumption.intervals === 1 ? 'intervalo analisado' : 'intervalos analisados'}`
      : 'São necessárias duas leituras de hoje';

    getElement('level-state-reading').textContent = levelStatus.shortLabel;
    getElement('level-state-reading').className = `metric-status ${levelStatus.className}`;
    getElement('level-state-context').textContent =
      level === null
        ? 'Aguardando telemetria'
        : level < 40
          ? 'Requer acompanhamento'
          : 'Dentro da faixa normal';

    getElement('flow-metric').textContent = distance === null ? '—' : `${formatNumber(distance, 2)} cm`;
    getElement('flow-context').textContent =
      distance === null ? 'Valor não informado' : 'Distância reportada pelo SM-WU';
  }

  if (dashboardState.statusError) {
    getElement('device-state-reading').textContent = 'Indisponível';
    getElement('device-state-context').textContent = 'Status não confirmado';
  } else if (!device) {
    getElement('device-state-reading').textContent = latest ? 'Sem status' : 'Sem dispositivo';
    getElement('device-state-context').textContent = latest
      ? 'Leitura recebida sem estado associado'
      : 'Aguardando comunicação';
  } else if (isDeviceDisconnected()) {
    getElement('device-state-reading').textContent = 'Offline';
    getElement('device-state-context').textContent = lastSeen
      ? `Último contato ${formatElapsed(lastSeen)}`
      : 'Sem contato registrado';
  } else {
    getElement('device-state-reading').textContent = 'Online';
    getElement('device-state-context').textContent = lastSeen
      ? `Último contato ${formatElapsed(lastSeen)}`
      : 'Comunicação ativa';
  }
}

function renderInsights() {
  const container = getElement('insights-list');
  const history = getRangeHistory();
  const levelRows = history.filter((item) => toFiniteNumber(item.nivel) !== null);

  if (dashboardState.historyError) {
    container.innerHTML =
      '<div class="empty-state"><span class="empty-state-icon" aria-hidden="true">!</span><strong>Análise indisponível</strong><span>Não foi possível consultar o histórico deste período.</span></div>';
    return;
  }

  if (levelRows.length < 2) {
    container.innerHTML =
      '<div class="empty-state"><span class="empty-state-icon" aria-hidden="true">—</span><strong>Dados insuficientes</strong><span>São necessárias ao menos duas leituras para analisar este período.</span></div>';
    return;
  }

  const insights = [];
  const trend = getLevelTrend(levelRows);
  if (trend.direction === 'stable') {
    insights.push({
      title: 'Nível estável',
      text: 'A variação entre a primeira e a última leitura ficou abaixo de 0,5 ponto percentual.',
    });
  } else {
    insights.push({
      title: trend.direction === 'down' ? 'Redução de nível' : 'Elevação de nível',
      text: `O nível ${trend.direction === 'down' ? 'reduziu' : 'aumentou'} ${formatNumber(Math.abs(trend.change), 1)} pontos percentuais no período.`,
    });
  }

  let biggestDrop = null;
  for (let index = 1; index < levelRows.length; index += 1) {
    const drop = toFiniteNumber(levelRows[index - 1].nivel) - toFiniteNumber(levelRows[index].nivel);
    if (drop > 0 && (!biggestDrop || drop > biggestDrop.value)) {
      biggestDrop = { value: drop, from: levelRows[index - 1].timestamp, to: levelRows[index].timestamp };
    }
  }

  insights.push(
    biggestDrop
      ? {
          title: 'Maior queda registrada',
          text: `${formatNumber(biggestDrop.value, 1)} p.p. entre ${formatTime(biggestDrop.from, false)} e ${formatTime(biggestDrop.to, false)}.`,
        }
      : {
          title: 'Sem quedas registradas',
          text: 'Nenhum intervalo apresentou redução de nível no período selecionado.',
        },
  );

  const consumption = getConsumptionSeries(history);
  insights.push(
    consumption.available
      ? {
          title: 'Consumo calculado',
          text: consumption.points.length
            ? `${formatNumber(consumption.total, 2)} L em ${consumption.intervals} intervalos analisados.`
            : `Nenhuma redução de volume em ${consumption.intervals} intervalos analisados.`,
        }
      : {
          title: 'Consumo indisponível',
          text: 'O período não possui leituras de volume suficientes para o cálculo.',
        },
  );

  container.innerHTML = insights
    .map(
      (insight, index) => `
        <article class="insight-item">
            <span class="insight-index" aria-hidden="true">${index + 1}</span>
            <div><strong>${escapeHTML(insight.title)}</strong><p>${escapeHTML(insight.text)}</p></div>
        </article>
    `,
    )
    .join('');
}

function getAlertTitle(alert) {
  const message = String(alert.message || '');
  if (/nível|nivel/i.test(message)) return 'Nível do reservatório';
  if (/offline|comunica|dispositivo/i.test(message)) return 'Dispositivo offline';
  return 'Evento do sistema';
}

function normalizeAlerts() {
  const latestDate = dashboardState.latest?.timestamp || null;
  const lastSeen = getDeviceLastSeen();
  const sensorId = getMonitoredDeviceId() || 'Dispositivo não identificado';
  const alerts = dashboardState.backendAlerts.map((alert) => ({
    type: alert.type === 'critical' ? 'critical' : alert.type === 'warning' ? 'warning' : 'info',
    title: getAlertTitle(alert),
    message: alert.message || 'Alerta informado pela API.',
    timestamp: alert.timestamp || latestDate,
    sensorId: alert.id || sensorId,
  }));

  if (!dashboardState.statusError && dashboardState.device && isDeviceDisconnected()) {
    alerts.push({
      type: 'critical',
      title: 'Dispositivo offline',
      message: lastSeen
        ? `Nenhuma nova comunicação ${formatElapsed(lastSeen)}.`
        : 'Nenhuma comunicação foi registrada para o dispositivo.',
      timestamp: lastSeen || latestDate,
      sensorId,
    });
  }

  const unique = [];
  const fingerprints = new Set();
  alerts.forEach((alert) => {
    const fingerprint = `${alert.type}:${alert.title}`;
    if (!fingerprints.has(fingerprint)) {
      fingerprints.add(fingerprint);
      unique.push(alert);
    }
  });
  return unique.slice(0, 5);
}

function renderAlerts() {
  const container = getElement('alerts-list');
  const alerts = normalizeAlerts();
  const countLabel = `${alerts.length} ${alerts.length === 1 ? 'ativo' : 'ativos'}`;

  getElement('alerts-count').textContent = countLabel;
  getElement('alerts-count').className =
    `status-badge ${alerts.some((alert) => alert.type === 'critical') ? 'is-critical' : alerts.length ? 'is-warning' : 'is-neutral'}`;
  getElement('nav-alert-count').textContent = String(alerts.length);
  getElement('nav-alert-count').setAttribute('aria-label', `${alerts.length} alertas`);
  getElement('nav-alert-count').classList.toggle('has-alerts', alerts.length > 0);
  container.setAttribute('aria-busy', 'false');

  if (dashboardState.alertsError && !alerts.length) {
    container.innerHTML =
      '<div class="empty-state"><span class="empty-state-icon" aria-hidden="true">!</span><strong>Alertas indisponíveis</strong><span>A API de alertas não respondeu. Uma nova tentativa será feita automaticamente.</span></div>';
    return;
  }

  if (!alerts.length) {
    container.innerHTML =
      '<div class="empty-state"><span class="empty-state-icon" aria-hidden="true">✓</span><strong>Nenhum alerta ativo</strong><span>Sistema operando normalmente, sem ocorrências informadas pela API.</span></div>';
    return;
  }

  container.innerHTML = alerts
    .map((alert) => {
      const category =
        alert.type === 'critical' ? 'Crítico' : alert.type === 'warning' ? 'Atenção' : 'Informativo';
      return `
            <article class="alert-item is-${escapeHTML(alert.type)}">
                <span class="alert-severity" aria-hidden="true">${alert.type === 'critical' ? '!' : alert.type === 'warning' ? '△' : 'i'}</span>
                <div class="alert-copy"><strong>${escapeHTML(alert.title)}</strong><p>${escapeHTML(alert.message)}</p></div>
                <div class="alert-meta"><span>${escapeHTML(alert.timestamp ? formatDateTime(alert.timestamp) : 'Sem horário')}</span><span>SM-WU · ${escapeHTML(alert.sensorId)}</span><span class="alert-state">${category}</span></div>
            </article>
        `;
    })
    .join('');
}

function renderDevice() {
  const latest = dashboardState.latest;
  const device = dashboardState.device;
  const detailsButton = getElement('device-details-button');
  const details = getElement('device-details');
  const statusBadge = getElement('device-status-badge');
  const sensorId = getMonitoredDeviceId();
  const reservoir = getSelectedReservoir();
  const lastSeen = parseDate(getDeviceLastSeen());

  if (!sensorId) {
    getElement('devices-count').textContent =
      `${dashboardState.reservoirs.length} ${dashboardState.reservoirs.length === 1 ? 'conectado' : 'conectados'}`;
    getElement('device-name').textContent = 'Nenhum dispositivo identificado';
    getElement('device-status').textContent = dashboardState.statusError
      ? 'Status indisponível'
      : 'Sem dados';
    getElement('device-last-seen').textContent = dashboardState.statusError
      ? 'Não foi possível consultar a comunicação'
      : 'Aguardando a primeira comunicação';
    setStatusDot(getElement('device-dot'), dashboardState.statusError ? 'is-error' : 'is-waiting');
    statusBadge.className = 'device-status-badge is-waiting';
    detailsButton.disabled = true;
    detailsButton.setAttribute('aria-expanded', 'false');
    details.hidden = true;
    [
      'detail-device-id',
      'detail-last-reading',
      'detail-ppl',
      'detail-vazao',
      'detail-rssi',
      'detail-wifi',
    ].forEach((id) => {
      getElement(id).textContent = '—';
    });
    return;
  }

  const disconnected = !dashboardState.statusError && device ? isDeviceDisconnected() : null;
  const stateLabel = dashboardState.statusError
    ? 'Indisponível'
    : !device
      ? 'Sem status'
      : disconnected
        ? 'Offline'
        : 'Online';
  getElement('devices-count').textContent =
    `${dashboardState.reservoirs.length} ${dashboardState.reservoirs.length === 1 ? 'conectado' : 'conectados'}`;
  getElement('device-name').textContent =
    `Sensor ${reservoir?.name || 'Reservatório'} · ${reservoir?.device?.code || `ID ${sensorId}`}`;
  getElement('device-status').textContent = stateLabel;
  getElement('device-last-seen').textContent = lastSeen
    ? `${formatDateTime(lastSeen, true)} · ${formatElapsed(lastSeen)}`
    : 'Sem comunicação registrada';
  setStatusDot(
    getElement('device-dot'),
    dashboardState.statusError || disconnected ? 'is-error' : device ? '' : 'is-waiting',
  );
  statusBadge.className =
    `device-status-badge ${dashboardState.statusError || disconnected ? 'is-waiting' : ''}`.trim();
  const isSMWA = reservoir?.device?.type === 'SM-WA';
  const typeLabel = isSMWA ? 'Medidor de água / hidrômetro SM-WA' : 'Medidor de nível ultrassônico SM-WU';
  const deviceTypeEl = getElement('device-type');
  if (deviceTypeEl) deviceTypeEl.textContent = typeLabel;

  detailsButton.disabled = false;
  getElement('detail-device-id').textContent = reservoir?.device?.code || String(sensorId);
  getElement('detail-last-reading').textContent = latest
    ? formatDateTime(latest.timestamp, true)
    : 'Sem leitura atual';
  if (isSMWA) {
    getElement('detail-ppl').textContent =
      toFiniteNumber(latest?.vazao) === null
        ? 'Não informada'
        : `${formatNumber(latest.vazao, 2)} ${unit('vazao')}`;
    getElement('detail-vazao').textContent =
      toFiniteNumber(latest?.consumo_acumulado) === null
        ? 'Não informado'
        : `${formatNumber(latest.consumo_acumulado, 2)} ${unit('consumo_acumulado')}`;
    getElement('detail-rssi').textContent =
      toFiniteNumber(latest?.volume) === null ? 'Não informado' : `${formatNumber(latest.volume, 2)} L`;
  } else {
    getElement('detail-ppl').textContent =
      toFiniteNumber(latest?.nivel) === null ? 'Não informado' : `${formatNumber(latest.nivel, 2)}%`;
    getElement('detail-vazao').textContent =
      toFiniteNumber(latest?.distancia) === null
        ? 'Não informada'
        : `${formatNumber(latest.distancia, 2)} cm`;
    getElement('detail-rssi').textContent =
      toFiniteNumber(latest?.volume) === null ? 'Não informado' : `${formatNumber(latest.volume, 2)} L`;
  }
  getElement('detail-wifi').textContent =
    toFiniteNumber(latest?.rssi_wifi) === null ? 'Não informado' : `${formatNumber(latest.rssi_wifi)} dBm`;
}

function renderHistoryTable() {
  const ordered = [...getChronologicalHistory()].reverse();
  const wrapper = getElement('history-table-wrapper');
  const tableState = getElement('table-state');
  const pagination = getElement('table-pagination');

  if (dashboardState.historyError) {
    wrapper.hidden = true;
    pagination.hidden = true;
    tableState.hidden = false;
    tableState.textContent =
      'Não foi possível carregar o histórico. Use “Tentar novamente” no aviso do sistema.';
    getElement('history-count').textContent = 'Indisponível';
    return;
  }

  if (!ordered.length) {
    wrapper.hidden = true;
    pagination.hidden = true;
    tableState.hidden = false;
    tableState.textContent = 'Nenhuma leitura disponível para este período.';
    getElement('history-count').textContent = '0 registros';
    return;
  }

  const totalPages = Math.max(Math.ceil(ordered.length / dashboardState.pageSize), 1);
  dashboardState.currentPage = clamp(dashboardState.currentPage, 1, totalPages);
  const start = (dashboardState.currentPage - 1) * dashboardState.pageSize;
  const pageItems = ordered.slice(start, start + dashboardState.pageSize);

  const isSMWA = getSelectedReservoir()?.device?.type === 'SM-WA';
  const ths = document.querySelectorAll('#history-table-wrapper th');
  if (ths.length >= 6) {
    if (isSMWA) {
      ths[2].textContent = 'Vazão';
      ths[3].textContent = 'Consumo Acumulado';
      ths[4].textContent = 'Volume';
    } else {
      ths[2].textContent = 'Nível';
      ths[3].textContent = 'Distância';
      ths[4].textContent = 'Volume';
    }
  }

  getElement('history-table-body').innerHTML = pageItems
    .map((item) => {
      const deviceLabel = item.id ? `${isSMWA ? 'SM-WA' : 'SM-WU'} · ${item.id}` : 'Não identificado';
      if (isSMWA) {
        return `
                <tr>
                    <td data-label="Data e hora"><strong>${escapeHTML(formatDateTime(item.timestamp, true))}</strong></td>
                    <td data-label="Dispositivo">${escapeHTML(deviceLabel)}</td>
                    <td data-label="Vazão" class="numeric">${toFiniteNumber(item.vazao) === null ? '—' : `${escapeHTML(formatNumber(item.vazao, 2))} ${unit('vazao')}`}</td>
                    <td data-label="Consumo" class="numeric">${toFiniteNumber(item.consumo_acumulado) === null ? '—' : `${escapeHTML(formatNumber(item.consumo_acumulado, 2))} ${unit('consumo_acumulado')}`}</td>
                    <td data-label="Volume" class="numeric">${toFiniteNumber(item.volume) === null ? '—' : `${escapeHTML(formatNumber(item.volume, 2))} L`}</td>
                    <td data-label="Status"><span class="row-status is-good">Registrado</span></td>
                </tr>
            `;
      }
      const status = getLevelStatus(item.nivel);
      return `
            <tr>
                <td data-label="Data e hora"><strong>${escapeHTML(formatDateTime(item.timestamp, true))}</strong></td>
                <td data-label="Dispositivo">${escapeHTML(deviceLabel)}</td>
                <td data-label="Nível" class="numeric">${toFiniteNumber(item.nivel) === null ? '—' : `${escapeHTML(formatNumber(item.nivel, 2))}%`}</td>
                <td data-label="Distância" class="numeric">${toFiniteNumber(item.distancia) === null ? '—' : `${escapeHTML(formatNumber(item.distancia, 2))} cm`}</td>
                <td data-label="Volume" class="numeric">${toFiniteNumber(item.volume) === null ? '—' : `${escapeHTML(formatNumber(item.volume, 2))} L`}</td>
                <td data-label="Status"><span class="row-status ${status.className}">${escapeHTML(status.shortLabel)}</span></td>
            </tr>
        `;
    })
    .join('');

  wrapper.hidden = false;
  tableState.hidden = true;
  pagination.hidden = totalPages <= 1;
  const resolution = dashboardState.historyMeta?.resolution_seconds;
  getElement('history-count').textContent =
    `${resolution ? 'Médias a cada ' + resolution + ' s · ' : ''}${ordered.length} ${ordered.length === 1 ? 'registro' : 'registros'} no período`;
  getElement('pagination-label').textContent = `Página ${dashboardState.currentPage} de ${totalPages}`;
  getElement('previous-page').disabled = dashboardState.currentPage === 1;
  getElement('next-page').disabled = dashboardState.currentPage === totalPages;
}

function renderAll({ includeHistory = true } = {}) {
  renderConnection();
  renderSystemStatus();
  renderLatest();
  renderMetrics();
  if (includeHistory) {
    renderChart();
    renderConsumption();
    renderInsights();
    renderHistoryTable();
  }
  renderAlerts();
  renderDevice();
  document.body.classList.remove('is-loading');
}

async function requestJSON(url, { allowNotFound = false, method = 'GET', body = null } = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MILLISECONDS);

  try {
    const fullUrl = apiUrl(url);
    const response = await fetch(fullUrl, {
      cache: 'no-store',
      credentials: 'include',
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== null ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' && CSRF_TOKEN ? { 'X-CSRF-Token': CSRF_TOKEN } : {}),
      },
      ...(body !== null ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    if (allowNotFound && response.status === 404) return null;
    if (response.status === 401) {
      window.location.assign(`/login?next=${encodeURIComponent(location.pathname + location.hash)}`);
      throw new Error('Sessão expirada');
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* validado abaixo */
    }
    if (!response.ok) {
      const error = new Error(payload?.error?.message || `Falha HTTP ${response.status}`);
      error.status = response.status;
      error.code = payload?.error?.code || 'REQUEST_FAILED';
      throw error;
    }
    if (payload?.csrf_token) {
      CSRF_TOKEN = payload.csrf_token;
      const meta = document.querySelector('meta[name="csrf-token"]');
      if (meta) meta.content = CSRF_TOKEN;
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Tempo limite excedido ao consultar a API');
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function requireSuccessfulPayload(payload, endpointName) {
  if (!payload || payload.success !== true) throw new Error(`Resposta inválida do endpoint ${endpointName}`);
  return payload;
}

function normalizeReading(reading, fallbackDeviceId = null) {
  if (!reading || typeof reading !== 'object' || Array.isArray(reading))
    throw new Error('Leitura inválida recebida da API');
  return { ...reading, id: reading.id || fallbackDeviceId || null };
}

async function fetchHistoryData(hours = dashboardState.selectedRangeHours) {
  const limit = RANGE_LIMITS[hours] || 500;
  const payload = await requestJSON(
    reservoirEndpoint(API_ENDPOINTS.history, {
      hours: String(hours),
      limit: String(limit),
    }),
  );
  requireSuccessfulPayload(payload, 'history');
  if (!Array.isArray(payload.data)) throw new Error('Histórico inválido recebido da API');
  return { rows: payload.data.map((item) => normalizeReading(item, payload.id)), meta: payload.meta };
}

function resetTelemetryState() {
  dashboardState.historyRequestId++;
  dashboardState.historyMeta = null;
  dashboardState.historyUpdateInProgress = false;
  dashboardState.units = {};
  dashboardState.latest = null;
  dashboardState.device = null;
  dashboardState.history = [];
  dashboardState.backendAlerts = [];
  dashboardState.currentPage = 1;
  dashboardState.historyLastLoadedAt = 0;
  dashboardState.historyLoadedRangeHours = null;
  dashboardState.latestError = false;
  dashboardState.statusError = false;
  dashboardState.historyError = false;
  dashboardState.alertsError = false;
  dashboardState.apiAvailable = null;
}

function renderReservoirSelector() {
  const select = getElement('reservoir-select');
  const welcome = getElement('welcome-state');
  const content = getElement('dashboard-content');
  select.replaceChildren();

  if (dashboardState.reservoirs.length === 0) {
    const option = new Option('Nenhum reservatório', '');
    select.add(option);
    select.disabled = true;
    welcome.hidden = false;
    content.hidden = true;
    getElement('topbar-reservoir-name').textContent = 'Central de Monitoramento';
    getElement('monitored-device').textContent = 'Conecte seu primeiro Hidra R3B para começar.';
    getElement('connection-label').textContent = 'Sem dispositivo';
    setStatusDot(getElement('connection-dot'), 'is-waiting');
    getElement('updated-label').textContent = 'Sem leituras';
    document.body.classList.remove('is-loading');
    return;
  }

  dashboardState.reservoirs.forEach((reservoir) => {
    select.add(
      new Option(
        reservoir.name,
        String(reservoir.id),
        false,
        reservoir.id === dashboardState.selectedReservoirId,
      ),
    );
  });
  select.disabled = false;
  welcome.hidden = true;
  content.hidden = false;
  const selected = getSelectedReservoir();
  if (selected) {
    select.value = String(selected.id);
    getElement('capacity-input').value = selected.capacity_liters ?? '';
    getElement('capacity-feedback').textContent = '';
    getElement('topbar-reservoir-name').textContent = selected.name;
    getElement('page-intro-title').textContent = selected.name;
    getElement('devices-title').textContent = selected.name;
    getElement('devices-count').textContent =
      dashboardState.reservoirs.length === 1
        ? '1 conectado'
        : `${dashboardState.reservoirs.length} conectados`;
  }
}

async function loadReservoirs(preferredId = null) {
  const payload = requireSuccessfulPayload(await requestJSON(API_ENDPOINTS.reservoirs), 'reservoirs');
  if (!Array.isArray(payload.data)) throw new Error('Lista de reservatórios inválida');
  dashboardState.reservoirs = payload.data.filter((item) => item && Number.isInteger(item.id));
  const storedId = Number(localStorage.getItem('hidra:selected-reservoir'));
  const candidates = [Number(preferredId), storedId, dashboardState.reservoirs[0]?.id];
  dashboardState.selectedReservoirId =
    candidates.find((id) => dashboardState.reservoirs.some((item) => item.id === id)) || null;
  if (dashboardState.selectedReservoirId) {
    localStorage.setItem('hidra:selected-reservoir', String(dashboardState.selectedReservoirId));
  } else {
    localStorage.removeItem('hidra:selected-reservoir');
  }
  renderReservoirSelector();
}

async function selectReservoir(reservoirId) {
  if (reservoirId === dashboardState.selectedReservoirId) return;
  dashboardState.selectedReservoirId = reservoirId;
  localStorage.setItem('hidra:selected-reservoir', String(reservoirId));
  resetTelemetryState();
  renderReservoirSelector();
  document.body.classList.add('is-loading');
  await updateDashboard();
  historyChart?.resize();
  consumptionChart?.resize();
}

async function updateDashboard() {
  const id = dashboardState.selectedReservoirId;
  if (dashboardState.updateInProgress || !id || document.hidden) return;
  const last = dashboardState.snapshotLastStarted.get(id) || 0;
  if (Date.now() - last < 60000) return;
  dashboardState.snapshotLastStarted.set(id, Date.now());
  dashboardState.updateInProgress = true;
  try {
    const value = requireSuccessfulPayload(
      await requestJSON(reservoirEndpoint(API_ENDPOINTS.snapshot)),
      'snapshot',
    );
    if (id !== dashboardState.selectedReservoirId) return;
    dashboardState.latest = value.data;
    dashboardState.device = value.device;
    dashboardState.backendAlerts = value.alerts || [];
    dashboardState.units = value.units || {};
    dashboardState.apiAvailable = true;
    dashboardState.latestError = dashboardState.statusError = dashboardState.alertsError = false;
    const banner = document.querySelector('.demo-banner');
    if (banner) banner.hidden = !value.simulated;
    if (dashboardState.historyVisible && shouldRefreshFullHistory()) await updateHistoryForRange();
  } catch {
    if (id !== dashboardState.selectedReservoirId) return;
    dashboardState.apiAvailable = false;
    dashboardState.latestError = dashboardState.statusError = dashboardState.alertsError = true;
  } finally {
    dashboardState.updateInProgress = false;
    renderAll();
  }
}

async function updateHistoryForRange() {
  const requestedReservoir = dashboardState.selectedReservoirId;
  if (!requestedReservoir) return;
  const requestedHours = dashboardState.selectedRangeHours;
  const historyRequestId = ++dashboardState.historyRequestId;
  dashboardState.historyUpdateInProgress = true;
  dashboardState.historyError = false;
  dashboardState.history = [];
  dashboardState.historyLastLoadedAt = 0;
  dashboardState.historyLoadedRangeHours = null;
  dashboardState.currentPage = 1;

  showChartState(
    'chart-stage',
    'chart-state-title',
    'chart-state-description',
    'Carregando período',
    'Consultando as leituras da faixa selecionada.',
  );
  showChartState(
    'consumption-chart-stage',
    'consumption-state-title',
    'consumption-state-description',
    'Carregando período',
    'Calculando o consumo com as leituras recebidas.',
  );
  getElement('table-state').hidden = false;
  getElement('table-state').textContent = 'Carregando registros…';
  getElement('history-table-wrapper').hidden = true;

  try {
    const history = await fetchHistoryData(requestedHours);
    if (
      historyRequestId !== dashboardState.historyRequestId ||
      requestedReservoir !== dashboardState.selectedReservoirId
    )
      return;
    dashboardState.history = history.rows;
    dashboardState.historyMeta = history.meta;
    dashboardState.historyLastLoadedAt = Date.now();
    dashboardState.historyLoadedRangeHours = requestedHours;
  } catch (error) {
    if (
      historyRequestId !== dashboardState.historyRequestId ||
      requestedReservoir !== dashboardState.selectedReservoirId
    )
      return;
    dashboardState.historyError = true;
  } finally {
    if (historyRequestId === dashboardState.historyRequestId) dashboardState.historyUpdateInProgress = false;
  }

  renderMetrics();
  renderChart();
  renderConsumption();
  renderInsights();
  renderHistoryTable();
  renderSystemStatus();
}

function clearRefreshTimer() {
  if (dashboardState.refreshTimer) {
    window.clearInterval(dashboardState.refreshTimer);
    dashboardState.refreshTimer = null;
  }
}

function resetRefreshTimer() {
  clearRefreshTimer();
  if (document.hidden) return;
  dashboardState.refreshTimer = window.setInterval(
    () => void updateDashboard(),
    dashboardState.refreshMilliseconds,
  );
}

function updateElapsedLabels() {
  if (!dashboardState.selectedReservoirId) return;
  renderConnection();
  renderSystemStatus();
  renderDevice();
}

let lastModalTrigger = null;

function showToast(title, message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast${type === 'error' ? ' is-error' : ''}`;
  toast.innerHTML = `<span aria-hidden="true">${type === 'error' ? '!' : '✓'}</span><div><strong>${escapeHTML(title)}</strong><span>${escapeHTML(message)}</span></div>`;
  getElement('toast-region').append(toast);
  window.setTimeout(() => toast.remove(), 5000);
}

function openModal(id, trigger = document.activeElement) {
  lastModalTrigger = trigger;
  const modal = getElement(id);
  modal.hidden = false;
  document.body.classList.add('modal-open');
  window.requestAnimationFrame(() => modal.querySelector('input, button, [href]')?.focus());
}

function closeModal(id) {
  const modal = getElement(id);
  modal.hidden = true;
  document.body.classList.remove('modal-open');
  lastModalTrigger?.focus?.();
}

function bindAccountMenu() {
  const trigger = getElement('account-trigger');
  const dropdown = getElement('account-dropdown');
  const setOpen = (open) => {
    dropdown.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  };
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    setOpen(dropdown.hidden);
  });
  dropdown.addEventListener('click', (event) => {
    if (event.target.closest('a')) {
      setOpen(false);
    }
    event.stopPropagation();
  });
  document.addEventListener('click', () => setOpen(false));
  getElement('open-account').addEventListener('click', (event) => {
    setOpen(false);
    openModal('account-modal', event.currentTarget);
  });
  getElement('logout-button').addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      const payload = await requestJSON(API_ENDPOINTS.logout, { method: 'POST', body: {} });
      window.location.assign(safeRedirect(payload.redirect));
    } catch (error) {
      event.currentTarget.disabled = false;
      showToast('Não foi possível sair', error.message, 'error');
    }
  });
}

function bindModals() {
  document.querySelectorAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', () => closeModal(button.dataset.closeModal));
  });
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) closeModal(backdrop.id);
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const open = [...document.querySelectorAll('.modal-backdrop')].find((modal) => !modal.hidden);
    if (open) closeModal(open.id);
  });
}

function openPairing(trigger) {
  dashboardState.pairingCode = null;
  getElement('pairing-step-code').hidden = false;
  getElement('pairing-step-confirm').hidden = true;
  getElement('pairing-code-form').reset();
  getElement('pairing-confirm-form').reset();
  getElement('pairing-code-feedback').textContent = '';
  getElement('pairing-confirm-feedback').textContent = '';
  openModal('pairing-modal', trigger);
}

function bindPairing() {
  ['connect-device-top', 'connect-first-device', 'connect-device-panel'].forEach((id) => {
    getElement(id).addEventListener('click', (event) => openPairing(event.currentTarget));
  });

  getElement('pairing-code-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const feedback = getElement('pairing-code-feedback');
    const code = getElement('pairing-code').value.trim().toUpperCase();
    feedback.textContent = '';
    button.disabled = true;
    try {
      const payload = requireSuccessfulPayload(
        await requestJSON(API_ENDPOINTS.validatePairing, {
          method: 'POST',
          body: { pairing_code: code },
        }),
        'validate-pairing',
      );
      dashboardState.pairingCode = code;
      getElement('pairing-device-code').textContent = payload.data.device_code || 'Hidra R3B';
      const online = payload.data.status === 'online';
      setStatusDot(getElement('pairing-device-dot'), online ? '' : 'is-error');
      getElement('pairing-device-status').textContent = online
        ? `Online · última comunicação ${formatElapsed(payload.data.last_seen)}`
        : `Offline · última comunicação ${formatElapsed(payload.data.last_seen)}`;
      getElement('pairing-step-code').hidden = true;
      getElement('pairing-step-confirm').hidden = false;
      getElement('pairing-reservoir-name').focus();
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  getElement('pairing-back').addEventListener('click', () => {
    getElement('pairing-step-confirm').hidden = true;
    getElement('pairing-step-code').hidden = false;
    getElement('pairing-code').focus();
  });

  getElement('pairing-confirm-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const feedback = getElement('pairing-confirm-feedback');
    feedback.textContent = '';
    button.disabled = true;
    try {
      const payload = requireSuccessfulPayload(
        await requestJSON(API_ENDPOINTS.connect, {
          method: 'POST',
          body: {
            pairing_code: dashboardState.pairingCode,
            reservoir_name: getElement('pairing-reservoir-name').value,
          },
        }),
        'connect',
      );
      closeModal('pairing-modal');
      resetTelemetryState();
      await loadReservoirs(payload.data.id);
      await updateDashboard();
      showToast('Dispositivo conectado', `${payload.data.name} já está disponível no monitoramento.`);
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}

function bindReservoirManagement() {
  getElement('reservoir-select').addEventListener('change', (event) => {
    const id = Number(event.target.value);
    if (Number.isInteger(id) && id > 0) void selectReservoir(id);
  });

  getElement('capacity-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const feedback = getElement('capacity-feedback');
    try {
      const text = getElement('capacity-input').value.trim();
      const payload = await requestJSON('/api/reservoirs/capacity', {
        method: 'POST',
        body: {
          reservoir_id: dashboardState.selectedReservoirId,
          capacity_liters: text === '' ? null : Number(text),
        },
      });
      dashboardState.reservoirs = dashboardState.reservoirs.map((item) =>
        item.id === payload.data.id ? payload.data : item,
      );
      feedback.textContent = 'Capacidade salva.';
      renderMetrics();
    } catch (error) {
      feedback.textContent = error.message;
    }
  });
  getElement('rename-reservoir').addEventListener('click', (event) => {
    const reservoir = getSelectedReservoir();
    if (!reservoir) return;
    getElement('management-title').textContent = 'Renomear reservatório';
    getElement('management-description').textContent = 'O novo nome será atualizado em toda a dashboard.';
    getElement('rename-input').value = reservoir.name;
    getElement('rename-feedback').textContent = '';
    getElement('rename-form').hidden = false;
    getElement('unlink-form').hidden = true;
    openModal('management-modal', event.currentTarget);
  });

  getElement('unlink-device').addEventListener('click', (event) => {
    const reservoir = getSelectedReservoir();
    if (!reservoir) return;
    getElement('management-title').textContent = `Desvincular ${reservoir.name}?`;
    getElement('management-description').textContent =
      `O dispositivo ${reservoir.device?.code || ''} deixará de aparecer nesta conta.`;
    getElement('rename-form').hidden = true;
    getElement('unlink-form').hidden = false;
    getElement('unlink-feedback').textContent = '';
    openModal('management-modal', event.currentTarget);
  });

  getElement('rename-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const payload = requireSuccessfulPayload(
        await requestJSON(API_ENDPOINTS.rename, {
          method: 'POST',
          body: {
            reservoir_id: dashboardState.selectedReservoirId,
            name: getElement('rename-input').value,
          },
        }),
        'rename',
      );
      dashboardState.reservoirs = dashboardState.reservoirs.map((item) =>
        item.id === payload.data.id ? payload.data : item,
      );
      renderReservoirSelector();
      renderLatest();
      renderDevice();
      closeModal('management-modal');
      showToast('Nome atualizado', 'A alteração já aparece em toda a central.');
    } catch (error) {
      getElement('rename-feedback').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  getElement('unlink-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await requestJSON(API_ENDPOINTS.unlink, {
        method: 'POST',
        body: { reservoir_id: dashboardState.selectedReservoirId, confirmation: true },
      });
      closeModal('management-modal');
      resetTelemetryState();
      await loadReservoirs();
      if (dashboardState.selectedReservoirId) await updateDashboard();
      showToast('Dispositivo desvinculado', 'O histórico foi preservado e a associação foi encerrada.');
    } catch (error) {
      getElement('unlink-feedback').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}

function setActiveNavigation(sectionId) {
  document.querySelectorAll('.nav-link').forEach((link) => {
    const isActive = link.dataset.section === sectionId;
    link.classList.toggle('is-active', isActive);
    if (isActive) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function closeMobileMenu(restoreFocus = false) {
  document.body.classList.remove('menu-open');
  getElement('menu-button').setAttribute('aria-expanded', 'false');
  getElement('mobile-overlay').setAttribute('aria-hidden', 'true');
  if (restoreFocus) getElement('menu-button').focus();
}

function bindNavigation() {
  const menuButton = getElement('menu-button');
  const closeButton = getElement('sidebar-close');

  menuButton.addEventListener('click', () => {
    document.body.classList.add('menu-open');
    menuButton.setAttribute('aria-expanded', 'true');
    getElement('mobile-overlay').setAttribute('aria-hidden', 'false');
    closeButton.focus();
  });

  closeButton.addEventListener('click', () => closeMobileMenu(true));
  getElement('mobile-overlay').addEventListener('click', () => closeMobileMenu(true));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('menu-open')) closeMobileMenu(true);
  });

  document.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', () => {
      setActiveNavigation(link.dataset.section);
      closeMobileMenu(false);
      const target = getElement(link.dataset.section);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((first, second) => second.intersectionRatio - first.intersectionRatio)[0];
        if (visible) setActiveNavigation(visible.target.id);
      },
      { rootMargin: '-20% 0px -65% 0px', threshold: [0, 0.2, 0.5] },
    );

    ['visao-geral', 'monitoramento', 'alertas', 'dispositivos', 'historico', 'configuracoes']
      .map(getElement)
      .filter(Boolean)
      .forEach((section) => observer.observe(section));
  }
}

function bindChartControls() {
  document.querySelectorAll('.range-filter').forEach((button) => {
    button.addEventListener('click', () => {
      const hours = Number(button.dataset.hours);
      if (hours === dashboardState.selectedRangeHours) return;
      dashboardState.selectedRangeHours = hours;
      document.querySelectorAll('.range-filter').forEach((item) => {
        const active = item === button;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      void updateHistoryForRange();
    });
  });

  document.querySelectorAll('.metric-tab').forEach((button) => {
    button.addEventListener('click', () => {
      dashboardState.selectedMetric = button.dataset.metric;
      document.querySelectorAll('.metric-tab').forEach((item) => {
        const active = item === button;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      renderChart();
    });
  });
}

function bindTableControls() {
  getElement('previous-page').addEventListener('click', () => {
    dashboardState.currentPage -= 1;
    renderHistoryTable();
  });
  getElement('next-page').addEventListener('click', () => {
    dashboardState.currentPage += 1;
    renderHistoryTable();
  });
}

function bindDeviceDetails() {
  getElement('device-details-button').addEventListener('click', (event) => {
    const details = getElement('device-details');
    const willOpen = details.hidden;
    details.hidden = !willOpen;
    event.currentTarget.setAttribute('aria-expanded', String(willOpen));
    event.currentTarget.childNodes[0].nodeValue = willOpen ? 'Ocultar detalhes ' : 'Ver detalhes ';
  });
}

function bindRefreshControls() {
  getElement('refresh-interval').addEventListener('change', (event) => {
    dashboardState.refreshMilliseconds = Math.max(60000, Number(event.target.value) || 60000);
    const seconds = dashboardState.refreshMilliseconds / 1000;
    getElement('refresh-rate-label').textContent = `a cada ${seconds} segundos`;
    resetRefreshTimer();
    void updateDashboard();
  });

  getElement('retry-button').addEventListener('click', () => void updateDashboard());

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearRefreshTimer();
    } else {
      void updateDashboard();
      resetRefreshTimer();
    }
  });

  window.addEventListener(
    'pagehide',
    () => {
      clearRefreshTimer();
      if (dashboardState.elapsedTimer) window.clearInterval(dashboardState.elapsedTimer);
    },
    { once: true },
  );
}

async function loadCurrentUser() {
  try {
    const payload = await requestJSON('/api/auth/me');
    if (payload?.user) {
      if (payload.csrf_token) {
        CSRF_TOKEN = payload.csrf_token;
        const meta = document.querySelector('meta[name="csrf-token"]');
        if (meta) meta.content = CSRF_TOKEN;
      }
      const user = payload.user;
      const initial = [...(user.name || '')][0]?.toUpperCase() || 'U';
      document.querySelectorAll('.account-avatar').forEach((el) => {
        el.textContent = initial;
      });
      const titleEl = document.getElementById('account-title');
      if (titleEl) titleEl.textContent = user.name || '';
      document.querySelectorAll('.account-summary strong').forEach((el) => {
        el.textContent = user.name || '';
      });
      document.querySelectorAll('.account-summary small').forEach((el) => {
        el.textContent = user.email || '';
      });
      const emailEl = document.getElementById('account-email');
      if (emailEl) emailEl.textContent = user.email || '';
      document.querySelectorAll('.account-details dd').forEach((el, idx) => {
        if (idx === 0) el.textContent = user.email || '';
      });
      if (user.role === 'admin') {
        const adminLink = document.getElementById('admin-panel-link');
        if (adminLink) adminLink.hidden = false;
      }
    }
  } catch (error) {
    if (error?.status === 401 || error?.message === 'Sessão expirada') {
      window.location.assign(
        `/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`,
      );
    }
    throw error;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const historyObserver = new IntersectionObserver((entries) => {
    dashboardState.historyVisible = entries.some((entry) => entry.isIntersecting);
    if (dashboardState.historyVisible && dashboardState.selectedReservoirId && shouldRefreshFullHistory())
      void updateHistoryForRange();
  });
  historyObserver.observe(getElement('monitoramento'));
  initializeCharts();
  bindNavigation();
  bindChartControls();
  bindTableControls();
  bindDeviceDetails();
  bindRefreshControls();
  bindAccountMenu();
  bindModals();
  bindPairing();
  bindReservoirManagement();
  try {
    await loadCurrentUser();
    await loadReservoirs();
    if (dashboardState.selectedReservoirId) await updateDashboard();
  } catch (error) {
    getElement('dashboard-content').hidden = true;
    getElement('welcome-state').hidden = false;
    getElement('welcome-title').textContent = 'Não foi possível carregar sua conta';
    getElement('welcome-state').querySelector('p:not(.eyebrow)').textContent = error.message;
    getElement('connect-first-device').hidden = true;
    document.body.classList.remove('is-loading');
  }
  resetRefreshTimer();
  dashboardState.elapsedTimer = window.setInterval(updateElapsedLabels, ELAPSED_REFRESH_MILLISECONDS);
  if (location.hash) {
    const targetId = location.hash.replace('#', '');
    const target = getElement(targetId);
    if (target) {
      setActiveNavigation(targetId);
      window.setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    }
  }
});
