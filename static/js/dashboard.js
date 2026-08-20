const dashboardState = {
    latest: null,
    device: null,
    history: [],
    backendAlerts: [],
    selectedRangeHours: 24,
    selectedMetric: 'consumo',
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
    historyLoadedRangeHours: null
};

const API_ENDPOINTS = {
    current: 'api/device/current.php',
    history: 'api/device/history.php',
    status: 'api/device/status.php',
    alerts: 'api/device/alerts.php'
};

const REQUEST_TIMEOUT_MILLISECONDS = 8000;
const HISTORY_REFRESH_MILLISECONDS = 30000;

const RANGE_LIMITS = {
    24: 300,
    168: 800,
    720: 1600
};

const CHART_METRICS = {
    consumo: { label: 'Consumo', suffix: '', beginAtZero: true },
    vazao: { label: 'Vazão', suffix: '', beginAtZero: true },
    ppl: { label: 'PPL', suffix: '', beginAtZero: true },
    rssi_wifi: { label: 'RSSI Wi-Fi', suffix: ' dBm', beginAtZero: false }
};

let historyChart = null;

function getElement(id) {
    return document.getElementById(id);
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

function formatNumber(value, digits = 1) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';

    return number.toLocaleString('pt-BR', {
        minimumFractionDigits: number % 1 === 0 ? 0 : digits,
        maximumFractionDigits: digits
    });
}

function formatDateTime(value) {
    const date = value instanceof Date ? value : parseDate(value);
    if (!date) return 'Horário não informado';

    return date.toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
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

function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
}

function getChronologicalHistory(history = dashboardState.history) {
    return [...history]
        .filter(item => parseDate(item.timestamp))
        .sort((first, second) => parseDate(first.timestamp) - parseDate(second.timestamp));
}

function getRangeHistory() {
    const ordered = getChronologicalHistory();
    if (dashboardState.selectedRangeHours !== 24) return ordered;

    const now = new Date();
    return ordered.filter(item => {
        const date = parseDate(item.timestamp);
        return date && date.toDateString() === now.toDateString();
    });
}

function getSignalStatus(rssiWifi) {
    const value = Number(rssiWifi);
    if (!Number.isFinite(value)) {
        return { label: 'Aguardando', description: 'Sem sinal informado', className: 'is-waiting' };
    }
    if (value < -85) {
        return { label: 'Sinal fraco', description: 'RSSI Wi-Fi baixo', className: 'is-critical' };
    }
    if (value < -70) {
        return { label: 'Sinal regular', description: 'RSSI Wi-Fi regular', className: 'is-warning' };
    }
    return { label: 'Sinal bom', description: 'RSSI Wi-Fi bom', className: 'is-normal' };
}

function getDeviceLastSeen() {
    return dashboardState.device?.last_seen || null;
}

function compactHistoryForRange(history, hours = dashboardState.selectedRangeHours) {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const readingsByKey = new Map();

    history.forEach(item => {
        const date = parseDate(item?.timestamp);
        if (!date || date.getTime() < cutoff) return;
        const deviceId = item.id || 'unknown';
        const key = `${deviceId}:${date.getTime()}`;
        readingsByKey.set(key, item);
    });

    const limit = RANGE_LIMITS[hours] || 500;
    return getChronologicalHistory([...readingsByKey.values()]).slice(-limit);
}

function mergeCurrentReadingIntoHistory(reading) {
    const candidates = reading ? [...dashboardState.history, reading] : dashboardState.history;
    const previousLength = dashboardState.history.length;
    dashboardState.history = compactHistoryForRange(candidates);
    return Boolean(reading) || dashboardState.history.length !== previousLength;
}

function shouldRefreshFullHistory(hours = dashboardState.selectedRangeHours) {
    if (dashboardState.historyUpdateInProgress) return false;
    if (dashboardState.historyError || dashboardState.historyLastLoadedAt === 0) return true;
    if (dashboardState.historyLoadedRangeHours !== hours) return true;
    return (Date.now() - dashboardState.historyLastLoadedAt) >= HISTORY_REFRESH_MILLISECONDS;
}

function getMonitoredDeviceId() {
    return dashboardState.device?.id || dashboardState.latest?.id || null;
}

function isDeviceDisconnected() {
    const backendStatus = String(dashboardState.device?.status || '').trim().toLowerCase();
    return backendStatus !== 'online';
}

function signalStrengthPercentage(rssiWifi) {
    const value = Number(rssiWifi);
    if (!Number.isFinite(value)) return 0;
    return clamp((value + 100) * 2, 0, 100);
}

function setStatusDot(element, statusClass) {
    element.className = `status-dot ${statusClass || ''}`.trim();
}

function renderConnection() {
    const dot = getElement('connection-dot');
    const label = getElement('connection-label');
    const updated = getElement('updated-label');
    const lastSeen = parseDate(getDeviceLastSeen());

    if (dashboardState.apiAvailable === false) {
        setStatusDot(dot, 'is-error');
        label.textContent = 'API indisponível';
        updated.textContent = 'Não foi possível atualizar';
        return;
    }

    if (dashboardState.statusError) {
        setStatusDot(dot, 'is-error');
        label.textContent = 'Status indisponível';
        updated.textContent = 'Aguardando nova consulta';
        return;
    }

    if (!dashboardState.device) {
        setStatusDot(dot, 'is-waiting');
        label.textContent = dashboardState.latest ? 'Sem status' : 'Sem dispositivo';
        updated.textContent = dashboardState.latest ? 'Status não informado' : 'Aguardando comunicação';
        return;
    }

    if (isDeviceDisconnected()) {
        setStatusDot(dot, 'is-error');
        label.textContent = 'Offline';
        updated.textContent = lastSeen ? `Último contato ${formatElapsed(lastSeen)}` : 'Sem comunicação registrada';
        return;
    }

    setStatusDot(dot, '');
    label.textContent = 'Online';
    updated.textContent = lastSeen ? `Último contato ${formatElapsed(lastSeen)}` : 'Comunicação ativa';
}

function renderSystemStatus() {
    const container = getElement('system-status');
    const title = getElement('system-status-title');
    const description = getElement('system-status-description');
    const time = getElement('system-status-time');
    const latest = dashboardState.latest;
    const latestDate = latest ? parseDate(latest.timestamp) : null;
    const lastSeen = parseDate(getDeviceLastSeen());

    container.className = 'system-status';
    time.textContent = lastSeen ? formatElapsed(lastSeen) : latestDate ? formatElapsed(latestDate) : 'Sem leitura';

    if (dashboardState.apiAvailable === false) {
        container.classList.add('is-error');
        title.textContent = 'API temporariamente indisponível';
        description.textContent = 'A dashboard não conseguiu consultar os dados. Uma nova tentativa será feita automaticamente.';
        return;
    }

    if (dashboardState.statusError) {
        container.classList.add('is-error');
        title.textContent = 'Status do dispositivo indisponível';
        description.textContent = 'A API de status não respondeu. Nenhum estado anterior será exibido como atual.';
        return;
    }

    if (dashboardState.device && isDeviceDisconnected()) {
        container.classList.add('is-critical');
        title.textContent = 'Dispositivo offline';
        description.textContent = lastSeen
            ? `O dispositivo ${getMonitoredDeviceId() || 'SM-WA'} está offline. Última comunicação ${formatElapsed(lastSeen)}.`
            : `O dispositivo ${getMonitoredDeviceId() || 'SM-WA'} está offline e não informou a última comunicação.`;
        return;
    }

    if (dashboardState.latestError) {
        container.classList.add('is-error');
        title.textContent = 'Leitura atual indisponível';
        description.textContent = 'O status do dispositivo foi consultado, mas a leitura atual não pôde ser carregada.';
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

    if (!dashboardState.device) {
        container.classList.add('is-neutral');
        title.textContent = 'Status do dispositivo não informado';
        description.textContent = 'A leitura atual foi carregada, mas a API de status não identificou o dispositivo.';
        return;
    }

    title.textContent = 'Sistema funcionando normalmente';
    description.textContent = 'Dispositivo conectado e telemetria SM-WA recebida pelo backend.';
}

function renderLatest() {
    const latest = dashboardState.latest;
    const signalVisual = getElement('signal-visual');
    const signalFill = getElement('signal-fill');
    const statusBadge = getElement('telemetry-status');

    if (!latest) {
        document.documentElement.style.setProperty('--water-level', '0%');
        signalVisual.setAttribute('aria-label', 'Sinal Wi-Fi sem leitura disponível');
        signalFill.className = 'tank-water';
        statusBadge.className = 'status-badge is-waiting';
        statusBadge.textContent = 'Aguardando';
        getElement('consumption-reading').textContent = '—';
        getElement('flow-reading').textContent = '—';
        getElement('wifi-reading').textContent = '—';
        getElement('telemetry-classification').textContent = 'Aguardando telemetria';
        getElement('monitored-device').textContent = dashboardState.device?.id
            ? `Dispositivo ${dashboardState.device.id} · Sem leitura atual`
            : 'Nenhum dispositivo identificado';
        getElement('metric-timestamp').textContent = 'Sem leitura';
        return;
    }

    const consumo = Number(latest.consumo);
    const vazao = Number(latest.vazao);
    const rssiWifi = Number(latest.rssi_wifi);
    const status = getSignalStatus(rssiWifi);
    const sensorName = getMonitoredDeviceId() || 'Dispositivo sem identificação';

    document.documentElement.style.setProperty('--water-level', `${signalStrengthPercentage(rssiWifi)}%`);
    signalVisual.setAttribute('aria-label', `RSSI Wi-Fi: ${formatNumber(rssiWifi)} dBm. Estado: ${status.label}.`);
    signalFill.className = `tank-water ${status.className}`;
    statusBadge.className = `status-badge ${status.className}`;
    statusBadge.textContent = status.label;
    getElement('consumption-reading').textContent = Number.isFinite(consumo) ? formatNumber(consumo, 2) : '—';
    getElement('telemetry-classification').textContent = 'Valor de consumo informado pelo SM-WA';
    getElement('flow-reading').textContent = Number.isFinite(vazao) ? formatNumber(vazao, 2) : 'Não informado';
    getElement('wifi-reading').textContent = Number.isFinite(rssiWifi) ? `${formatNumber(rssiWifi)} dBm` : 'Não informado';
    getElement('monitored-device').textContent = `Dispositivo SM-WA ${sensorName}`;
    getElement('metric-timestamp').textContent = formatDateTime(latest.timestamp);
}

function renderMetrics() {
    const latest = dashboardState.latest;
    const device = dashboardState.device;
    const lastSeen = parseDate(getDeviceLastSeen());

    getElement('ppl-reading').textContent = latest ? formatNumber(latest.ppl, 2) : '—';
    getElement('ppl-unit').textContent = latest ? 'valor informado' : 'sem leitura';
    getElement('ppl-context').textContent = latest
        ? 'Campo ppl recebido diretamente do dispositivo'
        : 'Aguardando leitura do dispositivo';
    getElement('flow-metric').textContent = latest ? formatNumber(latest.vazao, 2) : '—';
    getElement('flow-context').textContent = latest ? 'Campo vazao recebido do SM-WA' : 'Aguardando leitura';
    getElement('consumption-metric').textContent = latest ? formatNumber(latest.consumo, 2) : '—';
    getElement('rssi-metric').textContent = latest ? `${formatNumber(latest.rssi_wifi)} dBm` : '—';

    if (dashboardState.statusError) {
        getElement('device-state-reading').textContent = 'Indisponível';
        getElement('device-state-context').textContent = 'A API de status não respondeu';
    } else if (!device) {
        getElement('device-state-reading').textContent = dashboardState.latest ? 'Sem status' : 'Sem dados';
        getElement('device-state-context').textContent = dashboardState.latest
            ? 'A leitura não possui status associado'
            : 'Nenhum dispositivo identificado';
    } else if (isDeviceDisconnected()) {
        getElement('device-state-reading').textContent = 'Offline';
        getElement('device-state-context').textContent = lastSeen
            ? `Último contato ${formatElapsed(lastSeen)}`
            : 'Sem comunicação registrada';
    } else {
        getElement('device-state-reading').textContent = 'Online';
        getElement('device-state-context').textContent = lastSeen
            ? `Último contato ${formatElapsed(lastSeen)}`
            : 'Comunicação ativa';
    }
}

function showChartState(title, description, icon = '≋') {
    getElement('chart-stage').classList.add('has-state');
    getElement('chart-state-title').textContent = title;
    getElement('chart-state-description').textContent = description;
    getElement('chart-state').querySelector('.chart-state-icon').textContent = icon;
}

function hideChartState() {
    getElement('chart-stage').classList.remove('has-state');
}

function initializeChart() {
    if (typeof Chart === 'undefined') {
        showChartState('Gráfico indisponível', 'A biblioteca de gráficos não pôde ser carregada. Os demais dados continuam acessíveis.', '!');
        getElement('chart-summary').textContent = 'Não foi possível inicializar a visualização gráfica.';
        return;
    }

    const context = getElement('history-chart').getContext('2d');
    Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
    Chart.defaults.color = '#718391';

    historyChart = new Chart(context, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Consumo',
                data: [],
                borderColor: '#1598ad',
                backgroundColor: 'rgba(21, 152, 173, 0.08)',
                borderWidth: 2.25,
                pointRadius: 0,
                pointHoverRadius: 4,
                pointHoverBackgroundColor: '#123d5a',
                pointHoverBorderColor: '#ffffff',
                pointHoverBorderWidth: 2,
                fill: true,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 280 },
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    displayColors: false,
                    backgroundColor: '#10283b',
                    titleColor: '#ffffff',
                    bodyColor: '#dbe8ef',
                    padding: 11,
                    cornerRadius: 7,
                    callbacks: {
                        label(context) {
                            const metric = CHART_METRICS[dashboardState.selectedMetric] || CHART_METRICS.consumo;
                            return `${metric.label}: ${formatNumber(context.parsed.y, 2)}${metric.suffix}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    border: { display: false },
                    grid: { display: false },
                    ticks: { maxTicksLimit: 8, maxRotation: 0, autoSkip: true }
                },
                y: {
                    beginAtZero: true,
                    border: { display: false },
                    grid: { color: '#e6edf0', drawTicks: false },
                    ticks: {
                        padding: 9,
                        maxTicksLimit: 5,
                        callback: value => formatNumber(value, 0)
                    }
                }
            }
        }
    });
}

function renderChart() {
    const metric = dashboardState.selectedMetric;
    const rangeHistory = getRangeHistory();
    const metricDefinition = CHART_METRICS[metric] || CHART_METRICS.consumo;

    if (dashboardState.historyError) {
        showChartState('Erro ao carregar o gráfico', 'O histórico não pôde ser consultado. A dashboard tentará novamente automaticamente.', '!');
        getElement('chart-summary').textContent = 'O gráfico está temporariamente indisponível, mas a leitura mais recente pode continuar visível acima.';
        return;
    }

    if (!historyChart) {
        showChartState('Gráfico indisponível', 'A biblioteca de gráficos não foi carregada. Consulte o histórico tabular abaixo.', '!');
        return;
    }

    if (!rangeHistory.length) {
        showChartState('Nenhum registro no período', 'Ainda não há leituras disponíveis para a faixa selecionada.', '—');
        getElement('chart-summary').textContent = 'Resumo: nenhum dado disponível no período selecionado.';
        return;
    }

    const validValues = rangeHistory.map(item => Number(item[metric])).filter(Number.isFinite);
    if (!validValues.length) {
        showChartState(`${metricDefinition.label} indisponível`, `Os registros do período não possuem valores válidos para ${metricDefinition.label}.`, '—');
        getElement('chart-summary').textContent = `Resumo: nenhum valor de ${metricDefinition.label} foi encontrado.`;
        return;
    }

    const values = rangeHistory.map(item => Number.isFinite(Number(item[metric])) ? Number(item[metric]) : null);
    const latestValue = validValues[validValues.length - 1];
    const summary = `${metricDefinition.label}: valor atual ${formatNumber(latestValue, 2)}${metricDefinition.suffix}; mínimo ${formatNumber(Math.min(...validValues), 2)}${metricDefinition.suffix} e máximo ${formatNumber(Math.max(...validValues), 2)}${metricDefinition.suffix} no período.`;

    historyChart.data.labels = rangeHistory.map(item => formatChartLabel(item.timestamp));
    historyChart.data.datasets[0].label = metricDefinition.label;
    historyChart.data.datasets[0].data = values;
    historyChart.options.scales.y.beginAtZero = metricDefinition.beginAtZero;
    historyChart.options.scales.y.ticks.callback = value => `${formatNumber(value, 0)}${metricDefinition.suffix}`;
    historyChart.update();
    getElement('history-chart').setAttribute('aria-label', `${metricDefinition.label} ao longo do período selecionado. ${summary}`);
    getElement('chart-summary').textContent = summary;
    hideChartState();
}

function getAlertTitle(alert) {
    const message = String(alert.message || '');
    if (/offline|comunica|dispositivo/i.test(message)) return 'Dispositivo offline';
    return 'Evento do sistema';
}

function normalizeAlerts() {
    const latest = dashboardState.latest;
    const latestDate = latest ? latest.timestamp : null;
    const lastSeen = getDeviceLastSeen();
    const sensorId = getMonitoredDeviceId() || 'Dispositivo não identificado';
    const alerts = dashboardState.backendAlerts.map(alert => ({
        type: alert.type === 'critical' ? 'critical' : alert.type === 'warning' ? 'warning' : 'info',
        title: getAlertTitle(alert),
        message: alert.message || 'Alerta informado pela API.',
        timestamp: alert.timestamp || latestDate,
        sensorId: alert.id || sensorId,
        state: 'Pendente'
    }));

    const hasConfirmedCommunicationFailure = dashboardState.device
        ? isDeviceDisconnected()
        : !latest;
    if (!dashboardState.statusError && hasConfirmedCommunicationFailure) {
        alerts.push({
            type: 'critical',
            title: dashboardState.device ? 'Dispositivo offline' : 'Dispositivo sem comunicação',
            message: lastSeen
                ? `Nenhuma nova comunicação ${formatElapsed(lastSeen)}.`
                : 'Nenhuma comunicação foi registrada para o dispositivo.',
            timestamp: lastSeen || latestDate,
            sensorId,
            state: 'Pendente'
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
    getElement('nav-alert-count').textContent = String(alerts.length);
    getElement('nav-alert-count').setAttribute('aria-label', `${alerts.length} alertas`);
    getElement('nav-alert-count').classList.toggle('has-alerts', alerts.length > 0);
    container.setAttribute('aria-busy', 'false');

    if (dashboardState.alertsError && !alerts.length) {
        container.innerHTML = `
            <div class="empty-state">
                <span class="empty-state-icon" aria-hidden="true">!</span>
                <strong>Alertas indisponíveis</strong>
                <span>A API de alertas não respondeu. Uma nova tentativa será feita automaticamente.</span>
            </div>
        `;
        return;
    }

    if (!alerts.length) {
        container.innerHTML = `
            <div class="empty-state">
                <span class="empty-state-icon" aria-hidden="true">✓</span>
                <strong>Nenhum alerta ativo</strong>
                <span>Nenhum alerta ativo foi informado pela API ou identificado nas leituras atuais.</span>
            </div>
        `;
        return;
    }

    container.innerHTML = alerts.map(alert => `
        <article class="alert-item is-${escapeHTML(alert.type)}">
            <span class="alert-severity" aria-hidden="true">${alert.type === 'critical' ? '!' : alert.type === 'warning' ? '△' : 'i'}</span>
            <div class="alert-copy">
                <strong>${escapeHTML(alert.title)}</strong>
                <p>${escapeHTML(alert.message)}</p>
            </div>
            <div class="alert-meta">
                <span>${escapeHTML(alert.timestamp ? formatDateTime(alert.timestamp) : 'Sem horário')}</span>
                <span>${escapeHTML(alert.sensorId)}</span>
                <span class="alert-state">${escapeHTML(alert.state)}</span>
            </div>
        </article>
    `).join('');
}

function renderDevice() {
    const latest = dashboardState.latest;
    const device = dashboardState.device;
    const detailsButton = getElement('device-details-button');
    const details = getElement('device-details');
    const sensorId = getMonitoredDeviceId();
    const lastSeen = parseDate(getDeviceLastSeen());

    if (!sensorId) {
        getElement('devices-count').textContent = '0 identificados';
        getElement('device-name').textContent = 'Nenhum dispositivo identificado';
        getElement('device-status').textContent = dashboardState.statusError ? 'Status indisponível' : 'Sem dados';
        getElement('device-last-seen').textContent = dashboardState.statusError
            ? 'Não foi possível consultar a comunicação'
            : 'Aguardando a primeira comunicação';
        setStatusDot(getElement('device-dot'), dashboardState.statusError ? 'is-error' : 'is-waiting');
        detailsButton.disabled = true;
        detailsButton.textContent = 'Ver detalhes';
        detailsButton.setAttribute('aria-expanded', 'false');
        details.hidden = true;
        getElement('detail-device-id').textContent = '—';
        getElement('detail-last-reading').textContent = '—';
        getElement('detail-ppl').textContent = '—';
        getElement('detail-vazao').textContent = '—';
        getElement('detail-rssi').textContent = '—';
        return;
    }

    const disconnected = !dashboardState.statusError && device ? isDeviceDisconnected() : null;
    getElement('devices-count').textContent = '1 identificado';
    getElement('device-name').textContent = sensorId;
    getElement('device-status').textContent = dashboardState.statusError
        ? 'Status indisponível'
        : !device
            ? 'Sem status'
            : disconnected
                ? 'Offline'
                : 'Online';
    getElement('device-last-seen').textContent = lastSeen
        ? `Última comunicação ${formatElapsed(lastSeen)}`
        : 'Sem comunicação registrada';
    setStatusDot(
        getElement('device-dot'),
        dashboardState.statusError || disconnected ? 'is-error' : device ? '' : 'is-waiting'
    );
    detailsButton.disabled = false;
    getElement('detail-device-id').textContent = sensorId;
    getElement('detail-last-reading').textContent = latest ? formatDateTime(latest.timestamp) : 'Sem leitura atual';
    getElement('detail-ppl').textContent = latest ? formatNumber(latest.ppl, 2) : 'Não informado';
    getElement('detail-vazao').textContent = latest ? formatNumber(latest.vazao, 2) : 'Não informada';
    getElement('detail-rssi').textContent = latest ? `${formatNumber(latest.rssi_wifi)} dBm` : 'Não informado';
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
        tableState.textContent = 'Erro ao carregar o histórico. Uma nova tentativa será feita automaticamente.';
        getElement('history-count').textContent = 'Indisponível';
        return;
    }

    if (!ordered.length) {
        wrapper.hidden = true;
        pagination.hidden = true;
        tableState.hidden = false;
        tableState.textContent = 'Nenhum registro encontrado no período selecionado.';
        getElement('history-count').textContent = '0 registros';
        return;
    }

    const totalPages = Math.max(Math.ceil(ordered.length / dashboardState.pageSize), 1);
    dashboardState.currentPage = clamp(dashboardState.currentPage, 1, totalPages);
    const start = (dashboardState.currentPage - 1) * dashboardState.pageSize;
    const pageItems = ordered.slice(start, start + dashboardState.pageSize);

    getElement('history-table-body').innerHTML = pageItems.map(item => `
        <tr>
            <td data-label="Data e hora"><strong>${escapeHTML(formatDateTime(item.timestamp))}</strong></td>
            <td data-label="Dispositivo">${escapeHTML(item.id || 'Não identificado')}</td>
            <td data-label="PPL" class="numeric">${Number.isFinite(Number(item.ppl)) ? escapeHTML(formatNumber(item.ppl, 2)) : '—'}</td>
            <td data-label="Vazão" class="numeric">${Number.isFinite(Number(item.vazao)) ? escapeHTML(formatNumber(item.vazao, 2)) : '—'}</td>
            <td data-label="Consumo" class="numeric">${Number.isFinite(Number(item.consumo)) ? escapeHTML(formatNumber(item.consumo, 2)) : '—'}</td>
            <td data-label="RSSI Wi-Fi" class="numeric">${Number.isFinite(Number(item.rssi_wifi)) ? `${escapeHTML(formatNumber(item.rssi_wifi))} dBm` : '—'}</td>
        </tr>
    `).join('');

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
    if (includeHistory) renderChart();
    renderAlerts();
    renderDevice();
    if (includeHistory) renderHistoryTable();
    document.body.classList.remove('is-loading');
}

async function requestJSON(url, { allowNotFound = false } = {}) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MILLISECONDS);

    try {
        const response = await fetch(url, {
            cache: 'no-store',
            headers: { Accept: 'application/json' },
            signal: controller.signal
        });
        if (allowNotFound && response.status === 404) return null;
        if (!response.ok) {
            const error = new Error(`Falha HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return await response.json();
    } catch (error) {
        if (error.name === 'AbortError') {
            const timeoutError = new Error('Tempo limite excedido ao consultar a API');
            timeoutError.code = 'REQUEST_TIMEOUT';
            throw timeoutError;
        }
        throw error;
    } finally {
        window.clearTimeout(timeoutId);
    }
}

function requireSuccessfulPayload(payload, endpointName) {
    if (!payload || payload.success !== true) {
        throw new Error(`Resposta inválida do endpoint ${endpointName}`);
    }
    return payload;
}

function normalizeReading(reading, fallbackDeviceId = null) {
    if (!reading || typeof reading !== 'object' || Array.isArray(reading)) {
        throw new Error('Leitura inválida recebida da API');
    }
    return {
        ...reading,
        id: reading.id || fallbackDeviceId || null
    };
}

async function fetchLatestData() {
    const payload = await requestJSON(API_ENDPOINTS.current, { allowNotFound: true });
    if (payload === null) return null;
    requireSuccessfulPayload(payload, 'current');
    return normalizeReading(payload.data, payload.device?.id);
}

async function fetchStatusData() {
    const payload = await requestJSON(API_ENDPOINTS.status, { allowNotFound: true });
    if (payload === null) return null;
    requireSuccessfulPayload(payload, 'status');
    if (!payload.device || typeof payload.device !== 'object' || Array.isArray(payload.device)) {
        throw new Error('Dispositivo inválido recebido da API de status');
    }
    return { ...payload.device };
}

async function fetchHistoryData(hours = dashboardState.selectedRangeHours) {
    const limit = RANGE_LIMITS[hours] || 500;
    const query = new URLSearchParams({ hours: String(hours), limit: String(limit) });
    const payload = await requestJSON(`${API_ENDPOINTS.history}?${query}`);
    requireSuccessfulPayload(payload, 'history');
    if (!Array.isArray(payload.data)) throw new Error('Histórico inválido recebido da API');
    return payload.data.map(item => normalizeReading(item, payload.id));
}

async function fetchAlertsData() {
    const payload = await requestJSON(API_ENDPOINTS.alerts);
    requireSuccessfulPayload(payload, 'alerts');
    if (!Array.isArray(payload.data)) throw new Error('Alertas inválidos recebidos da API');
    return payload.data.filter(alert => alert && typeof alert === 'object' && !Array.isArray(alert));
}

async function updateDashboard() {
    if (dashboardState.updateInProgress) return;
    dashboardState.updateInProgress = true;
    const requestedHours = dashboardState.selectedRangeHours;
    const refreshFullHistory = shouldRefreshFullHistory(requestedHours);
    const historyRequestId = refreshFullHistory ? ++dashboardState.historyRequestId : null;
    if (refreshFullHistory) dashboardState.historyUpdateInProgress = true;

    try {
        const historyRequest = refreshFullHistory
            ? fetchHistoryData(requestedHours)
            : Promise.resolve(null);
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

        dashboardState.latest = latestResult.status === 'fulfilled' ? latestResult.value : null;
        dashboardState.device = statusResult.status === 'fulfilled' ? statusResult.value : null;
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
            } else {
                dashboardState.history = [];
                dashboardState.historyLastLoadedAt = 0;
                dashboardState.historyLoadedRangeHours = null;
            }
            dashboardState.historyUpdateInProgress = false;
        }

        const currentMerged = mergeCurrentReadingIntoHistory(dashboardState.latest);
        const includeHistory = !dashboardState.historyUpdateInProgress
            && (canApplyHistory || currentMerged);
        renderAll({ includeHistory });
    } finally {
        if (refreshFullHistory && historyRequestId === dashboardState.historyRequestId) {
            dashboardState.historyUpdateInProgress = false;
        }
        dashboardState.updateInProgress = false;
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
    showChartState('Carregando período', 'Consultando as leituras da faixa selecionada.', '…');
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
        dashboardState.history = [];
        dashboardState.historyLastLoadedAt = 0;
        dashboardState.historyLoadedRangeHours = null;
    } finally {
        if (historyRequestId === dashboardState.historyRequestId) {
            dashboardState.historyUpdateInProgress = false;
        }
    }

    renderMetrics();
    renderChart();
    renderHistoryTable();
    renderAlerts();
    renderSystemStatus();
}

function resetRefreshTimer() {
    if (dashboardState.refreshTimer) window.clearInterval(dashboardState.refreshTimer);
    dashboardState.refreshTimer = window.setInterval(() => {
        void updateDashboard();
    }, dashboardState.refreshMilliseconds);
}

function updateElapsedLabels() {
    renderConnection();
    renderSystemStatus();
    renderMetrics();
    renderDevice();
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
            const visible = entries
                .filter(entry => entry.isIntersecting)
                .sort((first, second) => second.intersectionRatio - first.intersectionRatio)[0];
            if (visible) setActiveNavigation(visible.target.id);
        }, { rootMargin: '-20% 0px -65% 0px', threshold: [0, 0.2, 0.5] });

        ['visao-geral', 'monitoramento', 'historico', 'alertas', 'dispositivos', 'configuracoes']
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
        event.currentTarget.textContent = willOpen ? 'Ocultar detalhes' : 'Ver detalhes';
    });
}

function bindRefreshPreference() {
    getElement('refresh-interval').addEventListener('change', event => {
        dashboardState.refreshMilliseconds = Number(event.target.value);
        const seconds = dashboardState.refreshMilliseconds / 1000;
        getElement('refresh-rate-label').textContent = `a cada ${seconds} segundos`;
        resetRefreshTimer();
        void updateDashboard();
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initializeChart();
    bindNavigation();
    bindChartControls();
    bindTableControls();
    bindDeviceDetails();
    bindRefreshPreference();
    void updateDashboard();
    resetRefreshTimer();
    dashboardState.elapsedTimer = window.setInterval(updateElapsedLabels, 1000);
});
