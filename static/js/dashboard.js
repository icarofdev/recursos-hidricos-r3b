const dashboardState = {
    latest: null,
    device: null,
    history: [],
    backendAlerts: [],
    selectedRangeHours: 24,
    selectedMetric: 'nivel',
    currentPage: 1,
    pageSize: 7,
    refreshMilliseconds: 5000,
    refreshTimer: null,
    elapsedTimer: null,
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
    pairingCode: null
};

const API_ENDPOINTS = {
    current: '/api/device/current.php',
    history: '/api/device/history.php',
    status: '/api/device/status.php',
    alerts: '/api/device/alerts.php',
    reservoirs: '/api/reservoirs/index.php',
    rename: '/api/reservoirs/rename.php',
    validatePairing: '/api/devices/validate-pairing.php',
    connect: '/api/devices/connect.php',
    unlink: '/api/devices/unlink.php',
    logout: '/api/auth/logout.php'
};

const CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')?.content || '';

const REQUEST_TIMEOUT_MILLISECONDS = 8000;
const HISTORY_REFRESH_MILLISECONDS = 30000;
const ELAPSED_REFRESH_MILLISECONDS = 5000;

const RANGE_LIMITS = {
    24: 300,
    168: 800,
    720: 1600
};

let historyChart = null;
let consumptionChart = null;

function getElement(id) {
    return document.getElementById(id);
}

function getSelectedReservoir() {
    return dashboardState.reservoirs.find(item => item.id === dashboardState.selectedReservoirId) || null;
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
        maximumFractionDigits: digits
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
        ...(includeSeconds ? { second: '2-digit' } : {})
    });
}

function formatTime(value, includeSeconds = true) {
    const date = value instanceof Date ? value : parseDate(value);
    if (!date) return 'Sem leitura';

    return date.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        ...(includeSeconds ? { second: '2-digit' } : {})
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
        year: 'numeric'
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
        .filter(item => parseDate(item?.timestamp))
        .sort((first, second) => parseDate(first.timestamp) - parseDate(second.timestamp));
}

function getRangeHistory() {
    const ordered = getChronologicalHistory();
    if (dashboardState.selectedRangeHours !== 24) return ordered;

    const now = new Date();
    return ordered.filter(item => isSameLocalDay(parseDate(item.timestamp), now));
}

function getTodayHistory() {
    const now = new Date();
    return getChronologicalHistory().filter(item => isSameLocalDay(parseDate(item.timestamp), now));
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
        .map(item => ({ value: toFiniteNumber(item.nivel), timestamp: item.timestamp }))
        .filter(item => item.value !== null);

    if (valid.length < 2) return null;

    const change = valid[valid.length - 1].value - valid[0].value;
    const direction = Math.abs(change) < 0.5 ? 'stable' : change > 0 ? 'up' : 'down';
    return { change, direction, first: valid[0], last: valid[valid.length - 1] };
}

function getConsumptionSeries(history = getRangeHistory()) {
    const ordered = getChronologicalHistory(history).filter(item => toFiniteNumber(item.volume) !== null);
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
                id: ordered[index].id
            });
        }
    }

    return {
        available: true,
        points,
        total: points.reduce((sum, point) => sum + point.value, 0),
        intervals: ordered.length - 1
    };
}

function compactHistoryForRange(history, hours = dashboardState.selectedRangeHours) {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const readingsByKey = new Map();

    history.forEach(item => {
        const date = parseDate(item?.timestamp);
        if (!date || date.getTime() < cutoff) return;
        const deviceId = item.id || 'unknown';
        readingsByKey.set(`${deviceId}:${date.getTime()}`, item);
    });

    const limit = RANGE_LIMITS[hours] || 500;
    return getChronologicalHistory([...readingsByKey.values()]).slice(-limit);
}

function mergeCurrentReadingIntoHistory(reading) {
    const incomingDate = parseDate(reading?.timestamp);
    const existingReading = incomingDate
        ? dashboardState.history.find(item => {
            const itemDate = parseDate(item?.timestamp);
            return itemDate
                && itemDate.getTime() === incomingDate.getTime()
                && String(item.id ?? '') === String(reading.id ?? '');
        })
        : null;
    const readingChanged = Boolean(reading) && (!existingReading
        || ['nivel', 'volume', 'distancia', 'rssi_wifi'].some(field => existingReading[field] !== reading[field]));
    const candidates = reading ? [...dashboardState.history, reading] : dashboardState.history;
    const previousLength = dashboardState.history.length;
    dashboardState.history = compactHistoryForRange(candidates);
    return readingChanged || dashboardState.history.length !== previousLength;
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
    return String(dashboardState.device?.status || '').trim().toLowerCase() !== 'online';
}

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
    time.textContent = lastSeen ? formatElapsed(lastSeen) : latestDate ? formatElapsed(latestDate) : 'Sem leitura';
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
        description.textContent = 'A leitura pode estar visível, mas o estado de conexão não pôde ser confirmado.';
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
        description.textContent = 'A leitura atual continua disponível, mas os gráficos e análises não puderam ser atualizados.';
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

    const nivel = toFiniteNumber(latest.nivel);
    const volume = toFiniteNumber(latest.volume);
    const distancia = toFiniteNumber(latest.distancia);
    const rssi = toFiniteNumber(latest.rssi_wifi);
    const status = getLevelStatus(nivel);
    const sensorId = getMonitoredDeviceId();
    const waterLevel = nivel === null ? 0 : clamp(nivel, 0, 100);

    document.documentElement.style.setProperty('--water-level', `${waterLevel}%`);
    signalVisual.setAttribute('aria-label', nivel === null
        ? 'Nível do reservatório sem valor válido'
        : `Nível do reservatório: ${formatNumber(nivel, 2)}%. Estado: ${status.shortLabel}.`);
    signalFill.className = `tank-water ${status.className}`;
    levelTrackFill.className = status.className;
    statusBadge.className = `status-badge ${status.className}`;
    statusBadge.textContent = status.shortLabel;
    getElement('consumption-reading').textContent = nivel === null ? '—' : `${formatNumber(nivel, 2)}%`;
    getElement('telemetry-classification').textContent = nivel === null
        ? 'Valor de nível inválido na última leitura'
        : 'Percentual informado pelo medidor ultrassônico';
    getElement('flow-reading').textContent = volume === null ? 'Não informado' : `${formatNumber(volume, 2)} L`;
    getElement('wifi-reading').textContent = distancia === null ? 'Não informada' : `${formatNumber(distancia, 2)} cm`;
    getElement('rssi-metric').textContent = rssi === null ? 'Não informado' : `${formatNumber(rssi)} dBm`;
    getElement('monitored-device').textContent = sensorId
        ? `${getSelectedReservoir()?.name || 'Reservatório'} · ${getSelectedReservoir()?.device?.code || `ID ${sensorId}`}`
        : 'Dispositivo sem identificação';
    getElement('metric-timestamp').textContent = formatDateTime(latest.timestamp, true);
}

function renderMetrics() {
    const latest = dashboardState.latest;
    const device = dashboardState.device;
    const level = toFiniteNumber(latest?.nivel);
    const volume = toFiniteNumber(latest?.volume);
    const distance = toFiniteNumber(latest?.distancia);
    const levelStatus = getLevelStatus(level);
    const trend = getLevelTrend();
    const todayHistory = getTodayHistory();
    const todayConsumption = getConsumptionSeries(todayHistory);
    const lastSeen = parseDate(getDeviceLastSeen());
    const capacity = toFiniteNumber(getSelectedReservoir()?.capacity_liters);

    getElement('ppl-reading').textContent = level === null ? '—' : formatNumber(level, 2);
    getElement('ppl-unit').textContent = level === null ? '' : '%';
    getElement('ppl-context').textContent = trend
        ? trend.direction === 'stable'
            ? 'Estável no período selecionado'
            : `${trend.change > 0 ? 'Alta' : 'Queda'} de ${formatNumber(Math.abs(trend.change), 1)} p.p. no período`
        : latest ? 'Histórico insuficiente para tendência' : 'Aguardando leitura';

    getElement('consumption-metric').textContent = volume === null ? '—' : formatNumber(volume, 2);
    getElement('volume-unit').textContent = volume === null ? '' : 'L';
    getElement('volume-context').textContent = capacity === null
        ? 'Capacidade total não informada'
        : `Capacidade: ${formatNumber(capacity, 2)} L`;
    getElement('capacity-reading').textContent = capacity === null ? 'Não informada' : `${formatNumber(capacity, 2)} L`;

    getElement('daily-consumption-reading').textContent = todayConsumption.available
        ? formatNumber(todayConsumption.total, 2)
        : '—';
    getElement('daily-consumption-unit').textContent = todayConsumption.available ? 'L' : '';
    getElement('daily-consumption-context').textContent = todayConsumption.available
        ? `${todayConsumption.intervals} ${todayConsumption.intervals === 1 ? 'intervalo analisado' : 'intervalos analisados'}`
        : 'São necessárias duas leituras de hoje';

    getElement('level-state-reading').textContent = levelStatus.shortLabel;
    getElement('level-state-reading').className = `metric-status ${levelStatus.className}`;
    getElement('level-state-context').textContent = level === null
        ? 'Aguardando telemetria'
        : level < 40 ? 'Requer acompanhamento' : 'Dentro da faixa normal';

    getElement('flow-metric').textContent = distance === null ? '—' : `${formatNumber(distance, 2)} cm`;
    getElement('flow-context').textContent = distance === null ? 'Valor não informado' : 'Distância reportada pelo SM-WU';

    if (dashboardState.statusError) {
        getElement('device-state-reading').textContent = 'Indisponível';
        getElement('device-state-context').textContent = 'Status não confirmado';
    } else if (!device) {
        getElement('device-state-reading').textContent = latest ? 'Sem status' : 'Sem dispositivo';
        getElement('device-state-context').textContent = latest ? 'Leitura recebida sem estado associado' : 'Aguardando comunicação';
    } else if (isDeviceDisconnected()) {
        getElement('device-state-reading').textContent = 'Offline';
        getElement('device-state-context').textContent = lastSeen ? `Último contato ${formatElapsed(lastSeen)}` : 'Sem contato registrado';
    } else {
        getElement('device-state-reading').textContent = 'Online';
        getElement('device-state-context').textContent = lastSeen ? `Último contato ${formatElapsed(lastSeen)}` : 'Comunicação ativa';
    }
}

function showChartState(stageId, titleId, descriptionId, title, description) {
    getElement(stageId).classList.add('has-state');
    getElement(titleId).textContent = title;
    getElement(descriptionId).textContent = description;
}

function hideChartState(stageId) {
    getElement(stageId).classList.remove('has-state');
}

function baseChartOptions() {
    return {
        responsive: true,
        maintainAspectRatio: false,
        animation: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 260 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: { display: false },
            tooltip: {
                displayColors: false,
                backgroundColor: '#0b2638',
                titleColor: '#ffffff',
                bodyColor: '#d9e7ed',
                padding: 12,
                cornerRadius: 8,
                titleMarginBottom: 7,
                bodySpacing: 4
            }
        },
        scales: {
            x: {
                border: { display: false },
                grid: { display: false },
                ticks: { color: '#788b95', maxTicksLimit: 8, maxRotation: 0, autoSkip: true, font: { size: 10 } }
            },
            y: {
                beginAtZero: true,
                border: { display: false },
                grid: { color: '#e6eef1', drawTicks: false },
                ticks: { color: '#788b95', padding: 9, maxTicksLimit: 5, font: { size: 10 } }
            }
        }
    };
}

function initializeCharts() {
    if (typeof Chart === 'undefined') {
        showChartState('chart-stage', 'chart-state-title', 'chart-state-description', 'Gráfico indisponível', 'A biblioteca de gráficos não pôde ser carregada. Os demais dados continuam acessíveis.');
        showChartState('consumption-chart-stage', 'consumption-state-title', 'consumption-state-description', 'Gráfico indisponível', 'Consulte os valores textuais desta página.');
        getElement('chart-summary').textContent = 'Não foi possível inicializar a visualização gráfica.';
        return;
    }

    Chart.defaults.font.family = 'Inter, Segoe UI, system-ui, sans-serif';
    Chart.defaults.color = '#788b95';

    const historyOptions = baseChartOptions();
    historyOptions.plugins.tooltip.callbacks = {
        title(items) {
            const row = dashboardState.mainChartRows[items[0]?.dataIndex];
            return formatTooltipTitle(row?.timestamp);
        },
        label(context) {
            return dashboardState.selectedMetric === 'consumo'
                ? `Consumo: ${formatNumber(context.parsed.y, 2)} L`
                : `Nível: ${formatNumber(context.parsed.y, 2)}%`;
        },
        afterLabel(context) {
            if (dashboardState.selectedMetric !== 'nivel') return '';
            const row = dashboardState.mainChartRows[context.dataIndex];
            const volume = toFiniteNumber(row?.volume);
            return volume === null ? 'Volume: não informado' : `Volume: ${formatNumber(volume, 2)} L`;
        }
    };

    historyChart = new Chart(getElement('history-chart').getContext('2d'), {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Nível',
                data: [],
                borderColor: '#0f9fbc',
                backgroundColor: 'rgba(15, 159, 188, 0.08)',
                borderWidth: 2.25,
                pointRadius: 0,
                pointHoverRadius: 4,
                pointHoverBackgroundColor: '#0c5674',
                pointHoverBorderColor: '#ffffff',
                pointHoverBorderWidth: 2,
                fill: true,
                tension: 0.28
            }]
        },
        options: historyOptions
    });

    const consumptionOptions = baseChartOptions();
    consumptionOptions.plugins.tooltip.callbacks = {
        title(items) {
            const series = getConsumptionSeries();
            return formatTooltipTitle(series.points[items[0]?.dataIndex]?.timestamp);
        },
        label(context) {
            return `Consumo: ${formatNumber(context.parsed.y, 2)} L`;
        }
    };
    consumptionOptions.scales.x.ticks.maxTicksLimit = 6;
    consumptionOptions.scales.y.ticks.callback = value => `${formatNumber(value, 0)} L`;

    consumptionChart = new Chart(getElement('consumption-chart').getContext('2d'), {
        type: 'bar',
        data: {
            labels: [],
            datasets: [{
                label: 'Consumo',
                data: [],
                backgroundColor: 'rgba(15, 159, 188, 0.72)',
                hoverBackgroundColor: '#0c7895',
                borderRadius: 5,
                borderSkipped: false,
                maxBarThickness: 28
            }]
        },
        options: consumptionOptions
    });
}

function renderChart() {
    const rangeHistory = getRangeHistory();

    if (dashboardState.historyError) {
        showChartState('chart-stage', 'chart-state-title', 'chart-state-description', 'Erro ao carregar o gráfico', 'O histórico não pôde ser consultado. Use “Tentar novamente” no aviso acima.');
        getElement('chart-summary').textContent = 'O gráfico está temporariamente indisponível; a última leitura válida pode continuar visível acima.';
        return;
    }

    if (!historyChart) return;

    if (dashboardState.selectedMetric === 'consumo') {
        const consumption = getConsumptionSeries(rangeHistory);
        getElement('chart-legend-label').textContent = 'Consumo estimado';

        if (!consumption.available) {
            showChartState('chart-stage', 'chart-state-title', 'chart-state-description', 'Dados insuficientes para consumo', 'São necessárias ao menos duas leituras válidas de volume no período.');
            getElement('chart-summary').textContent = 'Dados insuficientes para análise de consumo neste período.';
            return;
        }

        dashboardState.mainChartRows = consumption.points;
        historyChart.data.labels = consumption.points.map(point => formatChartLabel(point.timestamp));
        historyChart.data.datasets[0] = {
            type: 'bar',
            label: 'Consumo',
            data: consumption.points.map(point => point.value),
            backgroundColor: 'rgba(15, 159, 188, 0.72)',
            hoverBackgroundColor: '#0c7895',
            borderColor: '#0f9fbc',
            borderWidth: 0,
            borderRadius: 5,
            borderSkipped: false,
            maxBarThickness: 30
        };
        historyChart.options.scales.y.beginAtZero = true;
        historyChart.options.scales.y.suggestedMax = undefined;
        historyChart.options.scales.y.ticks.callback = value => `${formatNumber(value, 0)} L`;
        historyChart.update();
        getElement('history-chart').setAttribute('aria-label', `Consumo estimado no período: ${formatNumber(consumption.total, 2)} litros.`);
        getElement('chart-summary').textContent = consumption.points.length
            ? `Consumo estimado de ${formatNumber(consumption.total, 2)} L, calculado em ${consumption.intervals} intervalos entre leituras.`
            : `Nenhuma redução de volume foi detectada nos ${consumption.intervals} intervalos analisados.`;
        hideChartState('chart-stage');
        return;
    }

    const rows = rangeHistory.filter(item => toFiniteNumber(item.nivel) !== null);
    getElement('chart-legend-label').textContent = 'Nível do reservatório';

    if (!rows.length) {
        showChartState('chart-stage', 'chart-state-title', 'chart-state-description', 'Nenhuma leitura no período', 'Ainda não há valores válidos de nível para a faixa selecionada.');
        getElement('chart-summary').textContent = 'Dados insuficientes para análise de nível neste período.';
        return;
    }

    const values = rows.map(item => toFiniteNumber(item.nivel));
    const latestValue = values[values.length - 1];
    const trend = getLevelTrend(rows);
    dashboardState.mainChartRows = rows;
    historyChart.data.labels = rows.map(item => formatChartLabel(item.timestamp));
    historyChart.data.datasets[0] = {
        type: 'line',
        label: 'Nível',
        data: values,
        borderColor: '#0f9fbc',
        backgroundColor: 'rgba(15, 159, 188, 0.08)',
        borderWidth: 2.25,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: '#0c5674',
        pointHoverBorderColor: '#ffffff',
        pointHoverBorderWidth: 2,
        fill: true,
        tension: 0.28
    };
    historyChart.options.scales.y.beginAtZero = true;
    historyChart.options.scales.y.suggestedMax = 100;
    historyChart.options.scales.y.ticks.callback = value => `${formatNumber(value, 0)}%`;
    historyChart.update();

    const movement = !trend || trend.direction === 'stable'
        ? 'permaneceu estável'
        : `${trend.direction === 'up' ? 'subiu' : 'reduziu'} ${formatNumber(Math.abs(trend.change), 1)} p.p.`;
    const summary = `Nível atual de ${formatNumber(latestValue, 2)}%; ${movement} no período. Mínimo de ${formatNumber(Math.min(...values), 2)}% e máximo de ${formatNumber(Math.max(...values), 2)}%.`;
    getElement('history-chart').setAttribute('aria-label', `Nível do reservatório ao longo do período. ${summary}`);
    getElement('chart-summary').textContent = summary;
    hideChartState('chart-stage');
}

function renderConsumption() {
    const consumption = getConsumptionSeries();
    const totalBadge = getElement('consumption-period-total');

    if (dashboardState.historyError) {
        totalBadge.className = 'status-badge is-error';
        totalBadge.textContent = 'Indisponível';
        showChartState('consumption-chart-stage', 'consumption-state-title', 'consumption-state-description', 'Consumo indisponível', 'O histórico não pôde ser carregado.');
        return;
    }

    if (!consumption.available) {
        totalBadge.className = 'status-badge is-neutral';
        totalBadge.textContent = 'Dados insuficientes';
        showChartState('consumption-chart-stage', 'consumption-state-title', 'consumption-state-description', 'Dados insuficientes', 'São necessárias ao menos duas leituras válidas de volume no período.');
        return;
    }

    totalBadge.className = 'status-badge is-normal';
    totalBadge.textContent = `${formatNumber(consumption.total, 2)} L`;

    if (!consumptionChart) return;

    consumptionChart.data.labels = consumption.points.map(point => formatChartLabel(point.timestamp));
    consumptionChart.data.datasets[0].data = consumption.points.map(point => point.value);
    consumptionChart.update();
    getElement('consumption-chart').setAttribute('aria-label', consumption.points.length
        ? `Consumo estimado de ${formatNumber(consumption.total, 2)} litros no período.`
        : 'Nenhuma redução de volume detectada no período.');
    hideChartState('consumption-chart-stage');
}

function renderInsights() {
    const container = getElement('insights-list');
    const history = getRangeHistory();
    const levelRows = history.filter(item => toFiniteNumber(item.nivel) !== null);

    if (dashboardState.historyError) {
        container.innerHTML = '<div class="empty-state"><span class="empty-state-icon" aria-hidden="true">!</span><strong>Análise indisponível</strong><span>Não foi possível consultar o histórico deste período.</span></div>';
        return;
    }

    if (levelRows.length < 2) {
        container.innerHTML = '<div class="empty-state"><span class="empty-state-icon" aria-hidden="true">—</span><strong>Dados insuficientes</strong><span>São necessárias ao menos duas leituras para analisar este período.</span></div>';
        return;
    }

    const insights = [];
    const trend = getLevelTrend(levelRows);
    if (trend.direction === 'stable') {
        insights.push({ title: 'Nível estável', text: 'A variação entre a primeira e a última leitura ficou abaixo de 0,5 ponto percentual.' });
    } else {
        insights.push({
            title: trend.direction === 'down' ? 'Redução de nível' : 'Elevação de nível',
            text: `O nível ${trend.direction === 'down' ? 'reduziu' : 'aumentou'} ${formatNumber(Math.abs(trend.change), 1)} pontos percentuais no período.`
        });
    }

    let biggestDrop = null;
    for (let index = 1; index < levelRows.length; index += 1) {
        const drop = toFiniteNumber(levelRows[index - 1].nivel) - toFiniteNumber(levelRows[index].nivel);
        if (drop > 0 && (!biggestDrop || drop > biggestDrop.value)) {
            biggestDrop = { value: drop, from: levelRows[index - 1].timestamp, to: levelRows[index].timestamp };
        }
    }

    insights.push(biggestDrop
        ? { title: 'Maior queda registrada', text: `${formatNumber(biggestDrop.value, 1)} p.p. entre ${formatTime(biggestDrop.from, false)} e ${formatTime(biggestDrop.to, false)}.` }
        : { title: 'Sem quedas registradas', text: 'Nenhum intervalo apresentou redução de nível no período selecionado.' });

    const consumption = getConsumptionSeries(history);
    insights.push(consumption.available
        ? { title: 'Consumo calculado', text: consumption.points.length ? `${formatNumber(consumption.total, 2)} L em ${consumption.intervals} intervalos analisados.` : `Nenhuma redução de volume em ${consumption.intervals} intervalos analisados.` }
        : { title: 'Consumo indisponível', text: 'O período não possui leituras de volume suficientes para o cálculo.' });

    container.innerHTML = insights.map((insight, index) => `
        <article class="insight-item">
            <span class="insight-index" aria-hidden="true">${index + 1}</span>
            <div><strong>${escapeHTML(insight.title)}</strong><p>${escapeHTML(insight.text)}</p></div>
        </article>
    `).join('');
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
    const alerts = dashboardState.backendAlerts.map(alert => ({
        type: alert.type === 'critical' ? 'critical' : alert.type === 'warning' ? 'warning' : 'info',
        title: getAlertTitle(alert),
        message: alert.message || 'Alerta informado pela API.',
        timestamp: alert.timestamp || latestDate,
        sensorId: alert.id || sensorId
    }));

    if (!dashboardState.statusError && dashboardState.device && isDeviceDisconnected()) {
        alerts.push({
            type: 'critical',
            title: 'Dispositivo offline',
            message: lastSeen ? `Nenhuma nova comunicação ${formatElapsed(lastSeen)}.` : 'Nenhuma comunicação foi registrada para o dispositivo.',
            timestamp: lastSeen || latestDate,
            sensorId
        });
    }

    const unique = [];
    const fingerprints = new Set();
    alerts.forEach(alert => {
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
    getElement('alerts-count').className = `status-badge ${alerts.some(alert => alert.type === 'critical') ? 'is-critical' : alerts.length ? 'is-warning' : 'is-neutral'}`;
    getElement('nav-alert-count').textContent = String(alerts.length);
    getElement('nav-alert-count').setAttribute('aria-label', `${alerts.length} alertas`);
    getElement('nav-alert-count').classList.toggle('has-alerts', alerts.length > 0);
    container.setAttribute('aria-busy', 'false');

    if (dashboardState.alertsError && !alerts.length) {
        container.innerHTML = '<div class="empty-state"><span class="empty-state-icon" aria-hidden="true">!</span><strong>Alertas indisponíveis</strong><span>A API de alertas não respondeu. Uma nova tentativa será feita automaticamente.</span></div>';
        return;
    }

    if (!alerts.length) {
        container.innerHTML = '<div class="empty-state"><span class="empty-state-icon" aria-hidden="true">✓</span><strong>Nenhum alerta ativo</strong><span>Sistema operando normalmente, sem ocorrências informadas pela API.</span></div>';
        return;
    }

    container.innerHTML = alerts.map(alert => {
        const category = alert.type === 'critical' ? 'Crítico' : alert.type === 'warning' ? 'Atenção' : 'Informativo';
        return `
            <article class="alert-item is-${escapeHTML(alert.type)}">
                <span class="alert-severity" aria-hidden="true">${alert.type === 'critical' ? '!' : alert.type === 'warning' ? '△' : 'i'}</span>
                <div class="alert-copy"><strong>${escapeHTML(alert.title)}</strong><p>${escapeHTML(alert.message)}</p></div>
                <div class="alert-meta"><span>${escapeHTML(alert.timestamp ? formatDateTime(alert.timestamp) : 'Sem horário')}</span><span>SM-WU · ${escapeHTML(alert.sensorId)}</span><span class="alert-state">${category}</span></div>
            </article>
        `;
    }).join('');
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
        getElement('devices-count').textContent = `${dashboardState.reservoirs.length} ${dashboardState.reservoirs.length === 1 ? 'conectado' : 'conectados'}`;
        getElement('device-name').textContent = 'Nenhum dispositivo identificado';
        getElement('device-status').textContent = dashboardState.statusError ? 'Status indisponível' : 'Sem dados';
        getElement('device-last-seen').textContent = dashboardState.statusError ? 'Não foi possível consultar a comunicação' : 'Aguardando a primeira comunicação';
        setStatusDot(getElement('device-dot'), dashboardState.statusError ? 'is-error' : 'is-waiting');
        statusBadge.className = 'device-status-badge is-waiting';
        detailsButton.disabled = true;
        detailsButton.setAttribute('aria-expanded', 'false');
        details.hidden = true;
        ['detail-device-id', 'detail-last-reading', 'detail-ppl', 'detail-vazao', 'detail-rssi', 'detail-wifi'].forEach(id => { getElement(id).textContent = '—'; });
        return;
    }

    const disconnected = !dashboardState.statusError && device ? isDeviceDisconnected() : null;
    const stateLabel = dashboardState.statusError ? 'Indisponível' : !device ? 'Sem status' : disconnected ? 'Offline' : 'Online';
    getElement('devices-count').textContent = `${dashboardState.reservoirs.length} ${dashboardState.reservoirs.length === 1 ? 'conectado' : 'conectados'}`;
    getElement('device-name').textContent = `Sensor ${reservoir?.name || 'Reservatório'} · ${reservoir?.device?.code || `ID ${sensorId}`}`;
    getElement('device-status').textContent = stateLabel;
    getElement('device-last-seen').textContent = lastSeen ? `${formatDateTime(lastSeen, true)} · ${formatElapsed(lastSeen)}` : 'Sem comunicação registrada';
    setStatusDot(getElement('device-dot'), dashboardState.statusError || disconnected ? 'is-error' : device ? '' : 'is-waiting');
    statusBadge.className = `device-status-badge ${dashboardState.statusError || disconnected ? 'is-waiting' : ''}`.trim();
    detailsButton.disabled = false;
    getElement('detail-device-id').textContent = reservoir?.device?.code || String(sensorId);
    getElement('detail-last-reading').textContent = latest ? formatDateTime(latest.timestamp, true) : 'Sem leitura atual';
    getElement('detail-ppl').textContent = toFiniteNumber(latest?.nivel) === null ? 'Não informado' : `${formatNumber(latest.nivel, 2)}%`;
    getElement('detail-vazao').textContent = toFiniteNumber(latest?.distancia) === null ? 'Não informada' : `${formatNumber(latest.distancia, 2)} cm`;
    getElement('detail-rssi').textContent = toFiniteNumber(latest?.volume) === null ? 'Não informado' : `${formatNumber(latest.volume, 2)} L`;
    getElement('detail-wifi').textContent = toFiniteNumber(latest?.rssi_wifi) === null ? 'Não informado' : `${formatNumber(latest.rssi_wifi)} dBm`;
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
        tableState.textContent = 'Não foi possível carregar o histórico. Use “Tentar novamente” no aviso do sistema.';
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

    getElement('history-table-body').innerHTML = pageItems.map(item => {
        const status = getLevelStatus(item.nivel);
        const deviceLabel = item.id ? `SM-WU · ${item.id}` : 'Não identificado';
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
    }).join('');

    wrapper.hidden = false;
    tableState.hidden = true;
    pagination.hidden = totalPages <= 1;
    getElement('history-count').textContent = `${ordered.length} ${ordered.length === 1 ? 'registro' : 'registros'} no período`;
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
        const response = await fetch(url, {
            cache: 'no-store',
            credentials: 'same-origin',
            method,
            headers: {
                Accept: 'application/json',
                ...(body !== null ? { 'Content-Type': 'application/json' } : {}),
                ...(method !== 'GET' ? { 'X-CSRF-Token': CSRF_TOKEN } : {})
            },
            ...(body !== null ? { body: JSON.stringify(body) } : {}),
            signal: controller.signal
        });
        if (allowNotFound && response.status === 404) return null;
        if (response.status === 401) {
            window.location.assign(`/login?next=${encodeURIComponent(location.pathname + location.hash)}`);
            throw new Error('Sessão expirada');
        }
        let payload = null;
        try { payload = await response.json(); } catch { /* validado abaixo */ }
        if (!response.ok) {
            const error = new Error(payload?.error?.message || `Falha HTTP ${response.status}`);
            error.status = response.status;
            error.code = payload?.error?.code || 'REQUEST_FAILED';
            throw error;
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
    if (!reading || typeof reading !== 'object' || Array.isArray(reading)) throw new Error('Leitura inválida recebida da API');
    return { ...reading, id: reading.id || fallbackDeviceId || null };
}

async function fetchLatestData() {
    const payload = await requestJSON(reservoirEndpoint(API_ENDPOINTS.current), { allowNotFound: true });
    if (payload === null) return null;
    requireSuccessfulPayload(payload, 'current');
    return normalizeReading(payload.data, payload.device?.id);
}

async function fetchStatusData() {
    const payload = await requestJSON(reservoirEndpoint(API_ENDPOINTS.status), { allowNotFound: true });
    if (payload === null) return null;
    requireSuccessfulPayload(payload, 'status');
    if (!payload.device || typeof payload.device !== 'object' || Array.isArray(payload.device)) throw new Error('Dispositivo inválido recebido da API de status');
    return { ...payload.device };
}

async function fetchHistoryData(hours = dashboardState.selectedRangeHours) {
    const limit = RANGE_LIMITS[hours] || 500;
    const payload = await requestJSON(reservoirEndpoint(API_ENDPOINTS.history, {
        hours: String(hours),
        limit: String(limit)
    }));
    requireSuccessfulPayload(payload, 'history');
    if (!Array.isArray(payload.data)) throw new Error('Histórico inválido recebido da API');
    return payload.data.map(item => normalizeReading(item, payload.id));
}

async function fetchAlertsData() {
    const payload = await requestJSON(reservoirEndpoint(API_ENDPOINTS.alerts));
    requireSuccessfulPayload(payload, 'alerts');
    if (!Array.isArray(payload.data)) throw new Error('Alertas inválidos recebidos da API');
    return payload.data.filter(alert => alert && typeof alert === 'object' && !Array.isArray(alert));
}

function resetTelemetryState() {
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

    dashboardState.reservoirs.forEach(reservoir => {
        select.add(new Option(reservoir.name, String(reservoir.id), false, reservoir.id === dashboardState.selectedReservoirId));
    });
    select.disabled = false;
    welcome.hidden = true;
    content.hidden = false;
    const selected = getSelectedReservoir();
    if (selected) {
        select.value = String(selected.id);
        getElement('topbar-reservoir-name').textContent = selected.name;
        getElement('page-intro-title').textContent = selected.name;
        getElement('devices-title').textContent = selected.name;
        getElement('devices-count').textContent = dashboardState.reservoirs.length === 1
            ? '1 conectado'
            : `${dashboardState.reservoirs.length} conectados`;
    }
}

async function loadReservoirs(preferredId = null) {
    const payload = requireSuccessfulPayload(await requestJSON(API_ENDPOINTS.reservoirs), 'reservoirs');
    if (!Array.isArray(payload.data)) throw new Error('Lista de reservatórios inválida');
    dashboardState.reservoirs = payload.data.filter(item => item && Number.isInteger(item.id));
    const storedId = Number(localStorage.getItem('hidra:selected-reservoir'));
    const candidates = [Number(preferredId), storedId, dashboardState.reservoirs[0]?.id];
    dashboardState.selectedReservoirId = candidates.find(id => dashboardState.reservoirs.some(item => item.id === id)) || null;
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
    if (dashboardState.updateInProgress || !dashboardState.selectedReservoirId) return;

    dashboardState.updateInProgress = true;
    renderConnection();
    renderSystemStatus();

    const requestedHours = dashboardState.selectedRangeHours;
    const refreshFullHistory = shouldRefreshFullHistory(requestedHours);
    const historyRequestId = refreshFullHistory ? ++dashboardState.historyRequestId : null;
    let includeHistory = false;
    if (refreshFullHistory) dashboardState.historyUpdateInProgress = true;

    try {
        const historyRequest = refreshFullHistory ? fetchHistoryData(requestedHours) : Promise.resolve(null);
        const [latestResult, statusResult, alertsResult, historyResult] = await Promise.allSettled([
            fetchLatestData(),
            fetchStatusData(),
            fetchAlertsData(),
            historyRequest
        ]);

        dashboardState.latestError = latestResult.status === 'rejected';
        dashboardState.statusError = statusResult.status === 'rejected';
        dashboardState.alertsError = alertsResult.status === 'rejected';

        const availabilityResults = [latestResult, statusResult];
        if (refreshFullHistory) availabilityResults.push(historyResult);
        dashboardState.apiAvailable = availabilityResults.some(result => result.status === 'fulfilled');

        if (latestResult.status === 'fulfilled') dashboardState.latest = latestResult.value;
        if (statusResult.status === 'fulfilled') dashboardState.device = statusResult.value;
        dashboardState.backendAlerts = alertsResult.status === 'fulfilled' ? alertsResult.value : [];

        const canApplyHistory = refreshFullHistory
            && historyRequestId === dashboardState.historyRequestId
            && requestedHours === dashboardState.selectedRangeHours;

        if (canApplyHistory) {
            dashboardState.historyError = historyResult.status === 'rejected';
            if (historyResult.status === 'fulfilled') {
                dashboardState.history = compactHistoryForRange(historyResult.value, requestedHours);
                dashboardState.historyLastLoadedAt = Date.now();
                dashboardState.historyLoadedRangeHours = requestedHours;
            } else if (dashboardState.historyLoadedRangeHours !== requestedHours) {
                dashboardState.history = [];
                dashboardState.historyLastLoadedAt = 0;
                dashboardState.historyLoadedRangeHours = null;
            }
            dashboardState.historyUpdateInProgress = false;
        }

        const currentMerged = mergeCurrentReadingIntoHistory(dashboardState.latest);
        includeHistory = !dashboardState.historyUpdateInProgress && (canApplyHistory || currentMerged);
    } catch (error) {
        dashboardState.apiAvailable = false;
        dashboardState.latestError = true;
        dashboardState.statusError = true;
        dashboardState.alertsError = true;
        if (refreshFullHistory) dashboardState.historyError = true;
    } finally {
        if (refreshFullHistory && historyRequestId === dashboardState.historyRequestId) dashboardState.historyUpdateInProgress = false;
        dashboardState.updateInProgress = false;
        renderAll({ includeHistory: includeHistory || refreshFullHistory });
    }
}

async function updateHistoryForRange() {
    const requestedHours = dashboardState.selectedRangeHours;
    const historyRequestId = ++dashboardState.historyRequestId;
    dashboardState.historyUpdateInProgress = true;
    dashboardState.historyError = false;
    dashboardState.history = [];
    dashboardState.historyLastLoadedAt = 0;
    dashboardState.historyLoadedRangeHours = null;
    dashboardState.currentPage = 1;

    showChartState('chart-stage', 'chart-state-title', 'chart-state-description', 'Carregando período', 'Consultando as leituras da faixa selecionada.');
    showChartState('consumption-chart-stage', 'consumption-state-title', 'consumption-state-description', 'Carregando período', 'Calculando o consumo com as leituras recebidas.');
    getElement('table-state').hidden = false;
    getElement('table-state').textContent = 'Carregando registros…';
    getElement('history-table-wrapper').hidden = true;

    try {
        const history = await fetchHistoryData(requestedHours);
        if (historyRequestId !== dashboardState.historyRequestId) return;
        dashboardState.history = compactHistoryForRange(history, requestedHours);
        dashboardState.historyLastLoadedAt = Date.now();
        dashboardState.historyLoadedRangeHours = requestedHours;
        mergeCurrentReadingIntoHistory(dashboardState.latest);
    } catch (error) {
        if (historyRequestId !== dashboardState.historyRequestId) return;
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
    dashboardState.refreshTimer = window.setInterval(() => void updateDashboard(), dashboardState.refreshMilliseconds);
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
    document.body.style.overflow = 'hidden';
    window.requestAnimationFrame(() => modal.querySelector('input, button, [href]')?.focus());
}

function closeModal(id) {
    const modal = getElement(id);
    modal.hidden = true;
    document.body.style.overflow = '';
    lastModalTrigger?.focus?.();
}

function bindAccountMenu() {
    const trigger = getElement('account-trigger');
    const dropdown = getElement('account-dropdown');
    const setOpen = open => {
        dropdown.hidden = !open;
        trigger.setAttribute('aria-expanded', String(open));
    };
    trigger.addEventListener('click', event => {
        event.stopPropagation();
        setOpen(dropdown.hidden);
    });
    dropdown.addEventListener('click', event => event.stopPropagation());
    document.addEventListener('click', () => setOpen(false));
    getElement('open-account').addEventListener('click', event => {
        setOpen(false);
        openModal('account-modal', event.currentTarget);
    });
    getElement('logout-button').addEventListener('click', async event => {
        event.currentTarget.disabled = true;
        try {
            const payload = await requestJSON(API_ENDPOINTS.logout, { method: 'POST', body: {} });
            window.location.assign(payload.redirect || '/login');
        } catch (error) {
            event.currentTarget.disabled = false;
            showToast('Não foi possível sair', error.message, 'error');
        }
    });
}

function bindModals() {
    document.querySelectorAll('[data-close-modal]').forEach(button => {
        button.addEventListener('click', () => closeModal(button.dataset.closeModal));
    });
    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
        backdrop.addEventListener('mousedown', event => {
            if (event.target === backdrop) closeModal(backdrop.id);
        });
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        const open = [...document.querySelectorAll('.modal-backdrop')].find(modal => !modal.hidden);
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
    ['connect-device-top', 'connect-first-device', 'connect-device-panel'].forEach(id => {
        getElement(id).addEventListener('click', event => openPairing(event.currentTarget));
    });

    getElement('pairing-code-form').addEventListener('submit', async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector('button[type="submit"]');
        const feedback = getElement('pairing-code-feedback');
        const code = getElement('pairing-code').value.trim().toUpperCase();
        feedback.textContent = '';
        button.disabled = true;
        try {
            const payload = requireSuccessfulPayload(await requestJSON(API_ENDPOINTS.validatePairing, {
                method: 'POST', body: { pairing_code: code }
            }), 'validate-pairing');
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

    getElement('pairing-confirm-form').addEventListener('submit', async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector('button[type="submit"]');
        const feedback = getElement('pairing-confirm-feedback');
        feedback.textContent = '';
        button.disabled = true;
        try {
            const payload = requireSuccessfulPayload(await requestJSON(API_ENDPOINTS.connect, {
                method: 'POST',
                body: {
                    pairing_code: dashboardState.pairingCode,
                    reservoir_name: getElement('pairing-reservoir-name').value
                }
            }), 'connect');
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
    getElement('reservoir-select').addEventListener('change', event => {
        const id = Number(event.target.value);
        if (Number.isInteger(id) && id > 0) void selectReservoir(id);
    });

    getElement('rename-reservoir').addEventListener('click', event => {
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

    getElement('unlink-device').addEventListener('click', event => {
        const reservoir = getSelectedReservoir();
        if (!reservoir) return;
        getElement('management-title').textContent = `Desvincular ${reservoir.name}?`;
        getElement('management-description').textContent = `O dispositivo ${reservoir.device?.code || ''} deixará de aparecer nesta conta.`;
        getElement('rename-form').hidden = true;
        getElement('unlink-form').hidden = false;
        getElement('unlink-feedback').textContent = '';
        openModal('management-modal', event.currentTarget);
    });

    getElement('rename-form').addEventListener('submit', async event => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
            const payload = requireSuccessfulPayload(await requestJSON(API_ENDPOINTS.rename, {
                method: 'POST', body: {
                    reservoir_id: dashboardState.selectedReservoirId,
                    name: getElement('rename-input').value
                }
            }), 'rename');
            dashboardState.reservoirs = dashboardState.reservoirs.map(item => item.id === payload.data.id ? payload.data : item);
            renderReservoirSelector();
            renderLatest();
            renderDevice();
            closeModal('management-modal');
            showToast('Nome atualizado', 'A alteração já aparece em toda a central.');
        } catch (error) {
            getElement('rename-feedback').textContent = error.message;
        } finally { button.disabled = false; }
    });

    getElement('unlink-form').addEventListener('submit', async event => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
            await requestJSON(API_ENDPOINTS.unlink, {
                method: 'POST', body: { reservoir_id: dashboardState.selectedReservoirId, confirmation: true }
            });
            closeModal('management-modal');
            resetTelemetryState();
            await loadReservoirs();
            if (dashboardState.selectedReservoirId) await updateDashboard();
            showToast('Dispositivo desvinculado', 'O histórico foi preservado e a associação foi encerrada.');
        } catch (error) {
            getElement('unlink-feedback').textContent = error.message;
        } finally { button.disabled = false; }
    });
}

function setActiveNavigation(sectionId) {
    document.querySelectorAll('.nav-link').forEach(link => {
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
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && document.body.classList.contains('menu-open')) closeMobileMenu(true);
    });

    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', () => {
            setActiveNavigation(link.dataset.section);
            closeMobileMenu(false);
        });
    });

    if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver(entries => {
            const visible = entries.filter(entry => entry.isIntersecting).sort((first, second) => second.intersectionRatio - first.intersectionRatio)[0];
            if (visible) setActiveNavigation(visible.target.id);
        }, { rootMargin: '-20% 0px -65% 0px', threshold: [0, 0.2, 0.5] });

        ['visao-geral', 'monitoramento', 'alertas', 'dispositivos', 'historico', 'configuracoes']
            .map(getElement)
            .filter(Boolean)
            .forEach(section => observer.observe(section));
    }
}

function bindChartControls() {
    document.querySelectorAll('.range-filter').forEach(button => {
        button.addEventListener('click', () => {
            const hours = Number(button.dataset.hours);
            if (hours === dashboardState.selectedRangeHours) return;
            dashboardState.selectedRangeHours = hours;
            document.querySelectorAll('.range-filter').forEach(item => {
                const active = item === button;
                item.classList.toggle('is-active', active);
                item.setAttribute('aria-pressed', String(active));
            });
            void updateHistoryForRange();
        });
    });

    document.querySelectorAll('.metric-tab').forEach(button => {
        button.addEventListener('click', () => {
            dashboardState.selectedMetric = button.dataset.metric;
            document.querySelectorAll('.metric-tab').forEach(item => {
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
    getElement('device-details-button').addEventListener('click', event => {
        const details = getElement('device-details');
        const willOpen = details.hidden;
        details.hidden = !willOpen;
        event.currentTarget.setAttribute('aria-expanded', String(willOpen));
        event.currentTarget.childNodes[0].nodeValue = willOpen ? 'Ocultar detalhes ' : 'Ver detalhes ';
    });
}

function bindRefreshControls() {
    getElement('refresh-interval').addEventListener('change', event => {
        dashboardState.refreshMilliseconds = Number(event.target.value);
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

    window.addEventListener('pagehide', () => {
        clearRefreshTimer();
        if (dashboardState.elapsedTimer) window.clearInterval(dashboardState.elapsedTimer);
    }, { once: true });
}

document.addEventListener('DOMContentLoaded', async () => {
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
});
