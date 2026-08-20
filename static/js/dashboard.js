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

function getReservoirStatus(percentual) {
    const value = Number(percentual);
    if (!Number.isFinite(value)) {
        return { label: 'Aguardando', description: 'Sem classificação', className: 'is-waiting' };
    }
    if (value < 20) {
        return { label: 'Crítico', description: 'Nível crítico — reabastecimento necessário', className: 'is-critical' };
    }
    if (value < 50) {
        return { label: 'Atenção', description: 'Nível abaixo do recomendado', className: 'is-warning' };
    }
    return { label: 'Normal', description: 'Volume dentro da faixa recomendada', className: 'is-normal' };
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
        const deviceId = item.sensor_id || item.device_id || 'unknown';
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
    return dashboardState.device?.id || dashboardState.latest?.sensor_id || null;
}

function isDeviceDisconnected() {
    const backendStatus = String(dashboardState.device?.status || '').trim().toLowerCase();
    return backendStatus !== 'online';
}

function hasAbruptDrop(history = dashboardState.history) {
    const ordered = getChronologicalHistory(history);
    for (let index = Math.max(1, ordered.length - 8); index < ordered.length; index += 1) {
        const previous = ordered[index - 1];
        const current = ordered[index];
        const previousDate = parseDate(previous.timestamp);
        const currentDate = parseDate(current.timestamp);
        const elapsedHours = (currentDate - previousDate) / 36e5;
        const drop = Number(previous.percentual) - Number(current.percentual);

        if (elapsedHours > 0 && elapsedHours <= 0.5 && drop >= 10) return true;
    }
    return false;
}

function calculateConsumption(history) {
    const ordered = getChronologicalHistory(history);
    let total = 0;
    let validIntervals = 0;
    const series = [];

    ordered.forEach((item, index) => {
        if (index === 0) {
            series.push(0);
            return;
        }

        const previousVolume = Number(ordered[index - 1].volume_litros);
        const currentVolume = Number(item.volume_litros);
        if (!Number.isFinite(previousVolume) || !Number.isFinite(currentVolume)) {
            series.push(total);
            return;
        }

        const delta = previousVolume - currentVolume;
        if (delta > 0) total += delta;
        validIntervals += 1;
        series.push(total);
    });

    return {
        total,
        series,
        hasData: ordered.length >= 2 && validIntervals > 0
    };
}

function calculateTrend(history = dashboardState.history) {
    const ordered = getChronologicalHistory(history);
    if (ordered.length < 2) {
        return { label: 'Sem tendência', context: 'Histórico insuficiente', direction: 'neutral' };
    }

    const recent = ordered.slice(-12);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const firstDate = parseDate(first.timestamp);
    const lastDate = parseDate(last.timestamp);
    const hours = (lastDate - firstDate) / 36e5;
    const firstLevel = Number(first.percentual);
    const lastLevel = Number(last.percentual);

    if (hours <= 0 || !Number.isFinite(firstLevel) || !Number.isFinite(lastLevel)) {
        return { label: 'Sem tendência', context: 'Histórico insuficiente', direction: 'neutral' };
    }

    const rate = (lastLevel - firstLevel) / hours;
    if (rate < -0.1) {
        return {
            label: 'Em queda',
            context: `${formatNumber(Math.abs(rate), 1)} ponto percentual por hora`,
            direction: 'falling'
        };
    }
    if (rate > 0.1) {
        return {
            label: 'Reabastecendo',
            context: `${formatNumber(rate, 1)} ponto percentual por hora`,
            direction: 'rising'
        };
    }
    return { label: 'Estável', context: 'Sem variação relevante', direction: 'stable' };
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
    const percentual = latest ? Number(latest.percentual) : NaN;

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

    if (Number.isFinite(percentual) && percentual < 20) {
        container.classList.add('is-critical');
        title.textContent = 'Nível de água crítico';
        description.textContent = 'O reservatório está abaixo de 20%. Verifique o abastecimento imediatamente.';
        return;
    }

    if (hasAbruptDrop()) {
        container.classList.add('is-warning');
        title.textContent = 'Possível interrupção ou consumo atípico';
        description.textContent = 'Foi detectada uma queda rápida nas leituras mais recentes.';
        return;
    }

    if (Number.isFinite(percentual) && percentual < 50) {
        container.classList.add('is-warning');
        title.textContent = 'Nível abaixo do recomendado';
        description.textContent = 'Há água disponível, mas o reservatório está abaixo de 50% da capacidade em altura.';
        return;
    }

    title.textContent = 'Sistema funcionando normalmente';
    description.textContent = 'Dispositivo conectado e nível de água dentro da faixa recomendada.';
}

function renderLatest() {
    const latest = dashboardState.latest;
    const tank = getElement('tank-visual');
    const tankWater = getElement('tank-water');
    const statusBadge = getElement('reservoir-status');

    if (!latest) {
        document.documentElement.style.setProperty('--water-level', '0%');
        tank.setAttribute('aria-label', 'Nível do reservatório sem leitura disponível');
        tankWater.className = 'tank-water';
        statusBadge.className = 'status-badge is-waiting';
        statusBadge.textContent = 'Aguardando';
        getElement('level-reading').textContent = '—';
        getElement('level-height').textContent = '—';
        getElement('volume-reading').textContent = '—';
        getElement('level-classification').textContent = 'Aguardando classificação';
        getElement('monitored-device').textContent = dashboardState.device?.id
            ? `Dispositivo ${dashboardState.device.id} · Sem leitura atual`
            : 'Nenhum dispositivo identificado';
        getElement('metric-timestamp').textContent = 'Sem leitura';
        return;
    }

    const percentual = Number(latest.percentual);
    const nivelCm = Number(latest.nivel_cm);
    const capacidadeCm = Number(latest.capacidade_cm);
    const volume = Number(latest.volume_litros);
    const safePercentual = Number.isFinite(percentual) ? clamp(percentual, 0, 100) : 0;
    const status = getReservoirStatus(percentual);
    const sensorName = getMonitoredDeviceId() || 'Dispositivo sem identificação';

    document.documentElement.style.setProperty('--water-level', `${safePercentual}%`);
    tank.setAttribute('aria-label', `Nível atual do reservatório: ${formatNumber(percentual, 0)} por cento. Estado: ${status.label}.`);
    tankWater.className = `tank-water ${status.className}`;
    statusBadge.className = `status-badge ${status.className}`;
    statusBadge.textContent = status.label;
    getElement('level-reading').textContent = Number.isFinite(percentual) ? `${formatNumber(percentual, 0)}%` : '—';
    getElement('level-classification').textContent = status.description;
    getElement('level-height').textContent = Number.isFinite(nivelCm) && Number.isFinite(capacidadeCm)
        ? `${formatNumber(nivelCm)} de ${formatNumber(capacidadeCm)} cm`
        : 'Não informado';
    getElement('volume-reading').textContent = Number.isFinite(volume) ? `${formatNumber(volume)} L` : 'Não informado';
    getElement('monitored-device').textContent = `Dispositivo ${sensorName} · Local não informado`;
    getElement('metric-timestamp').textContent = formatDateTime(latest.timestamp);
}

function renderMetrics() {
    const todayHistory = getChronologicalHistory().filter(item => {
        const date = parseDate(item.timestamp);
        return date && date.toDateString() === new Date().toDateString();
    });
    const consumption = calculateConsumption(todayHistory);
    const trend = calculateTrend();
    const device = dashboardState.device;
    const lastSeen = parseDate(getDeviceLastSeen());

    getElement('daily-consumption').textContent = consumption.hasData ? formatNumber(consumption.total) : '—';
    getElement('daily-consumption-unit').textContent = consumption.hasData ? 'litros' : 'sem dados suficientes';
    getElement('consumption-context').textContent = consumption.hasData
        ? 'Estimado pelas reduções de volume desde 00:00'
        : 'São necessárias ao menos duas leituras de hoje';

    getElement('trend-reading').textContent = trend.label;
    getElement('trend-context').textContent = trend.context;

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
                label: 'Nível',
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
                            const suffix = dashboardState.selectedMetric === 'nivel' ? '%' : ' L';
                            const label = dashboardState.selectedMetric === 'nivel' ? 'Nível' : 'Consumo acumulado';
                            return `${label}: ${formatNumber(context.parsed.y)}${suffix}`;
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
                    max: 100,
                    border: { display: false },
                    grid: { color: '#e6edf0', drawTicks: false },
                    ticks: {
                        padding: 9,
                        maxTicksLimit: 5,
                        callback: value => `${value}%`
                    }
                }
            }
        }
    });
}

function renderChart() {
    const metric = dashboardState.selectedMetric;
    const rangeHistory = getRangeHistory();

    if (metric === 'vazao' || metric === 'pressao') {
        const label = metric === 'vazao' ? 'vazão' : 'pressão';
        showChartState(`${label[0].toUpperCase()}${label.slice(1)} indisponível`, `O contrato atual da API não fornece dados de ${label}. Nenhum valor foi estimado ou simulado.`, '—');
        getElement('chart-summary').textContent = `Resumo: o sensor de ${label} ainda não está integrado ao sistema.`;
        return;
    }

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

    let values;
    let datasetLabel;
    let axisSuffix;
    let summary;

    if (metric === 'consumo') {
        const consumption = calculateConsumption(rangeHistory);
        if (!consumption.hasData) {
            showChartState('Histórico insuficiente', 'São necessárias ao menos duas leituras de volume para calcular o consumo.', '—');
            getElement('chart-summary').textContent = 'Resumo: o consumo não pode ser calculado com os registros disponíveis.';
            return;
        }
        values = consumption.series;
        datasetLabel = 'Consumo acumulado';
        axisSuffix = ' L';
        summary = `Consumo estimado no período: ${formatNumber(consumption.total)} litros, calculado somente a partir das reduções de volume registradas.`;
    } else {
        const validLevels = rangeHistory.map(item => Number(item.percentual)).filter(Number.isFinite);
        if (!validLevels.length) {
            showChartState('Nível indisponível', 'Os registros do período não possuem percentual de nível válido.', '—');
            getElement('chart-summary').textContent = 'Resumo: nenhum percentual de nível válido foi encontrado.';
            return;
        }
        values = rangeHistory.map(item => Number.isFinite(Number(item.percentual)) ? Number(item.percentual) : null);
        datasetLabel = 'Nível';
        axisSuffix = '%';
        const latestLevel = validLevels[validLevels.length - 1];
        summary = `Nível atual de ${formatNumber(latestLevel, 0)}%, variando entre ${formatNumber(Math.min(...validLevels), 0)}% e ${formatNumber(Math.max(...validLevels), 0)}% no período.`;
    }

    historyChart.data.labels = rangeHistory.map(item => formatChartLabel(item.timestamp));
    historyChart.data.datasets[0].label = datasetLabel;
    historyChart.data.datasets[0].data = values;
    historyChart.options.scales.y.max = metric === 'nivel' ? 100 : undefined;
    historyChart.options.scales.y.ticks.callback = value => `${formatNumber(value, 0)}${axisSuffix}`;
    historyChart.update();
    getElement('history-chart').setAttribute('aria-label', `${datasetLabel} ao longo do período selecionado. ${summary}`);
    getElement('chart-summary').textContent = summary;
    hideChartState();
}

function getAlertTitle(alert) {
    const message = String(alert.message || '');
    if (/offline|comunica|dispositivo/i.test(message)) return 'Dispositivo offline';
    if (/nível|nivel|água|agua/i.test(message)) {
        return alert.type === 'critical' ? 'Nível crítico' : 'Nível baixo';
    }
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
        sensorId: alert.device_id || sensorId,
        state: 'Pendente'
    }));

    const percentual = latest ? Number(latest.percentual) : NaN;
    const hasLevelAlert = alerts.some(alert => /nível|nivel|água|agua/i.test(alert.title + alert.message));
    if (!hasLevelAlert && Number.isFinite(percentual) && percentual < 50) {
        alerts.push({
            type: percentual < 20 ? 'critical' : 'warning',
            title: percentual < 20 ? 'Nível crítico' : 'Nível baixo',
            message: percentual < 20 ? 'Reservatório abaixo de 20%.' : 'Reservatório abaixo de 50%.',
            timestamp: latestDate,
            sensorId,
            state: 'Pendente'
        });
    }

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

    if (hasAbruptDrop()) {
        alerts.push({
            type: 'warning',
            title: 'Queda rápida de nível',
            message: 'Redução de ao menos 10 pontos percentuais em até 30 minutos.',
            timestamp: latestDate,
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
        getElement('detail-sensor-id').textContent = '—';
        getElement('detail-last-reading').textContent = '—';
        getElement('detail-capacity').textContent = '—';
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
    getElement('detail-sensor-id').textContent = sensorId;
    getElement('detail-last-reading').textContent = latest ? formatDateTime(latest.timestamp) : 'Sem leitura atual';
    getElement('detail-capacity').textContent = latest && Number.isFinite(Number(latest.capacidade_cm))
        ? `${formatNumber(latest.capacidade_cm)} cm`
        : 'Não informada';
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
            <td data-label="Dispositivo">${escapeHTML(item.sensor_id || 'Não identificado')}</td>
            <td data-label="Nível" class="numeric">${Number.isFinite(Number(item.percentual)) ? `${escapeHTML(formatNumber(item.percentual, 0))}%` : '—'}</td>
            <td data-label="Altura" class="numeric">${Number.isFinite(Number(item.nivel_cm)) ? `${escapeHTML(formatNumber(item.nivel_cm))} cm` : '—'}</td>
            <td data-label="Volume" class="numeric">${Number.isFinite(Number(item.volume_litros)) ? `${escapeHTML(formatNumber(item.volume_litros))} L` : '—'}</td>
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
        sensor_id: reading.sensor_id || reading.device_id || fallbackDeviceId || null
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
    return payload.data.map(item => normalizeReading(item, payload.device_id));
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
