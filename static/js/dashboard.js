const dashboardState = {
    latest: null,
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
    apiAvailable: null
};

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
    const date = new Date(value);
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

function isDeviceDisconnected(latest = dashboardState.latest) {
    const timestamp = latest ? parseDate(latest.timestamp) : null;
    if (!timestamp) return true;
    return (Date.now() - timestamp.getTime()) > 2 * 60 * 1000;
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
    const latestDate = dashboardState.latest ? parseDate(dashboardState.latest.timestamp) : null;

    if (dashboardState.apiAvailable === false) {
        setStatusDot(dot, 'is-error');
        label.textContent = 'API indisponível';
        updated.textContent = 'Não foi possível atualizar';
        return;
    }

    if (!dashboardState.latest) {
        setStatusDot(dot, 'is-waiting');
        label.textContent = 'Sem leituras';
        updated.textContent = 'Aguardando dispositivo';
        return;
    }

    if (isDeviceDisconnected()) {
        setStatusDot(dot, 'is-error');
        label.textContent = 'Desconectado';
        updated.textContent = `Última leitura ${formatElapsed(latestDate)}`;
        return;
    }

    setStatusDot(dot, '');
    label.textContent = 'Conectado';
    updated.textContent = `Atualizado ${formatElapsed(latestDate)}`;
}

function renderSystemStatus() {
    const container = getElement('system-status');
    const title = getElement('system-status-title');
    const description = getElement('system-status-description');
    const time = getElement('system-status-time');
    const latest = dashboardState.latest;
    const latestDate = latest ? parseDate(latest.timestamp) : null;
    const percentual = latest ? Number(latest.percentual) : NaN;

    container.className = 'system-status';
    time.textContent = latestDate ? formatElapsed(latestDate) : 'Sem leitura';

    if (dashboardState.apiAvailable === false) {
        container.classList.add('is-error');
        title.textContent = 'API temporariamente indisponível';
        description.textContent = 'A dashboard não conseguiu consultar os dados. Uma nova tentativa será feita automaticamente.';
        return;
    }

    if (!latest) {
        container.classList.add('is-neutral');
        title.textContent = 'Aguardando a primeira leitura';
        description.textContent = 'O painel está disponível, mas nenhum dado foi recebido do dispositivo.';
        return;
    }

    if (isDeviceDisconnected(latest)) {
        container.classList.add('is-critical');
        title.textContent = 'Sensor sem comunicação';
        description.textContent = `O dispositivo ${latest.sensor_id || 'monitorado'} não envia dados ${formatElapsed(latestDate)}.`;
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
        statusBadge.className = 'status-badge is-waiting';
        statusBadge.textContent = 'Aguardando';
        getElement('level-reading').textContent = '—';
        getElement('level-height').textContent = '—';
        getElement('volume-reading').textContent = '—';
        getElement('level-classification').textContent = 'Aguardando classificação';
        getElement('monitored-device').textContent = 'Nenhum dispositivo identificado';
        getElement('metric-timestamp').textContent = 'Sem leitura';
        return;
    }

    const percentual = Number(latest.percentual);
    const nivelCm = Number(latest.nivel_cm);
    const capacidadeCm = Number(latest.capacidade_cm);
    const volume = Number(latest.volume_litros);
    const safePercentual = Number.isFinite(percentual) ? clamp(percentual, 0, 100) : 0;
    const status = getReservoirStatus(percentual);
    const sensorName = latest.sensor_id || 'Dispositivo sem identificação';

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
    const hasLatest = Boolean(dashboardState.latest);

    getElement('daily-consumption').textContent = consumption.hasData ? formatNumber(consumption.total) : '—';
    getElement('daily-consumption-unit').textContent = consumption.hasData ? 'litros' : 'sem dados suficientes';
    getElement('consumption-context').textContent = consumption.hasData
        ? 'Estimado pelas reduções de volume desde 00:00'
        : 'São necessárias ao menos duas leituras de hoje';

    getElement('trend-reading').textContent = trend.label;
    getElement('trend-context').textContent = trend.context;

    if (!hasLatest) {
        getElement('device-state-reading').textContent = 'Sem dados';
        getElement('device-state-context').textContent = 'Nenhum dispositivo identificado';
    } else if (isDeviceDisconnected()) {
        getElement('device-state-reading').textContent = 'Desconectado';
        getElement('device-state-context').textContent = `Último contato ${formatElapsed(dashboardState.latest.timestamp)}`;
    } else {
        getElement('device-state-reading').textContent = 'Operacional';
        getElement('device-state-context').textContent = `Último contato ${formatElapsed(dashboardState.latest.timestamp)}`;
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

function normalizeAlerts() {
    const latest = dashboardState.latest;
    const latestDate = latest ? latest.timestamp : null;
    const sensorId = latest?.sensor_id || 'Dispositivo não identificado';
    const alerts = dashboardState.backendAlerts.map(alert => ({
        type: alert.type === 'critical' ? 'critical' : alert.type === 'warning' ? 'warning' : 'info',
        title: alert.type === 'critical' ? 'Nível crítico' : alert.type === 'warning' ? 'Nível baixo' : 'Evento do sistema',
        message: alert.message || 'Alerta informado pela API.',
        timestamp: latestDate,
        sensorId,
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

    if (!latest || isDeviceDisconnected(latest)) {
        alerts.push({
            type: 'critical',
            title: 'Sensor sem comunicação',
            message: latestDate ? `Nenhuma nova leitura ${formatElapsed(latestDate)}.` : 'Nenhuma leitura foi recebida do dispositivo.',
            timestamp: latestDate,
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

    if (!alerts.length) {
        container.innerHTML = `
            <div class="empty-state">
                <span class="empty-state-icon" aria-hidden="true">✓</span>
                <strong>Nenhum alerta ativo</strong>
                <span>A leitura mais recente está dentro dos limites configurados. O backend atual não mantém histórico de alertas resolvidos.</span>
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
    const detailsButton = getElement('device-details-button');

    if (!latest) {
        getElement('devices-count').textContent = '0 identificados';
        getElement('device-name').textContent = 'Nenhum dispositivo identificado';
        getElement('device-status').textContent = 'Sem dados';
        getElement('device-last-seen').textContent = 'Aguardando a primeira comunicação';
        setStatusDot(getElement('device-dot'), 'is-waiting');
        detailsButton.disabled = true;
        return;
    }

    const disconnected = isDeviceDisconnected(latest);
    const sensorId = latest.sensor_id || 'Sem identificador';
    getElement('devices-count').textContent = '1 identificado';
    getElement('device-name').textContent = sensorId;
    getElement('device-status').textContent = disconnected ? 'Desconectado' : 'Online';
    getElement('device-last-seen').textContent = `Última comunicação ${formatElapsed(latest.timestamp)}`;
    setStatusDot(getElement('device-dot'), disconnected ? 'is-error' : '');
    detailsButton.disabled = false;
    getElement('detail-sensor-id').textContent = sensorId;
    getElement('detail-last-reading').textContent = formatDateTime(latest.timestamp);
    getElement('detail-capacity').textContent = Number.isFinite(Number(latest.capacidade_cm))
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

function renderAll() {
    renderConnection();
    renderSystemStatus();
    renderLatest();
    renderMetrics();
    renderChart();
    renderAlerts();
    renderDevice();
    renderHistoryTable();
    document.body.classList.remove('is-loading');
}

async function requestJSON(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
        const error = new Error(`Falha HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return response.json();
}

async function fetchLatestData() {
    try {
        return await requestJSON('/api/latest');
    } catch (error) {
        if (error.status === 404) return null;
        throw error;
    }
}

async function fetchHistoryData() {
    const limit = RANGE_LIMITS[dashboardState.selectedRangeHours] || 500;
    return requestJSON(`/api/history?hours=${dashboardState.selectedRangeHours}&limit=${limit}`);
}

async function fetchAlertsData() {
    return requestJSON('/api/alerts');
}

async function updateDashboard() {
    const [latestResult, historyResult, alertsResult] = await Promise.allSettled([
        fetchLatestData(),
        fetchHistoryData(),
        fetchAlertsData()
    ]);

    dashboardState.latestError = latestResult.status === 'rejected';
    dashboardState.historyError = historyResult.status === 'rejected';
    dashboardState.apiAvailable = !(dashboardState.latestError && dashboardState.historyError);

    if (latestResult.status === 'fulfilled') dashboardState.latest = latestResult.value;
    if (historyResult.status === 'fulfilled') dashboardState.history = Array.isArray(historyResult.value) ? historyResult.value : [];
    if (alertsResult.status === 'fulfilled') {
        dashboardState.backendAlerts = Array.isArray(alertsResult.value) ? alertsResult.value : [];
    }

    renderAll();
}

async function updateHistoryForRange() {
    dashboardState.historyError = false;
    showChartState('Carregando período', 'Consultando as leituras da faixa selecionada.', '…');
    getElement('table-state').hidden = false;
    getElement('table-state').textContent = 'Carregando registros…';
    getElement('history-table-wrapper').hidden = true;

    try {
        const history = await fetchHistoryData();
        dashboardState.history = Array.isArray(history) ? history : [];
        dashboardState.currentPage = 1;
    } catch (error) {
        dashboardState.historyError = true;
    }

    renderMetrics();
    renderChart();
    renderHistoryTable();
    renderAlerts();
    renderSystemStatus();
}

function resetRefreshTimer() {
    if (dashboardState.refreshTimer) window.clearInterval(dashboardState.refreshTimer);
    dashboardState.refreshTimer = window.setInterval(updateDashboard, dashboardState.refreshMilliseconds);
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
            updateHistoryForRange();
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
        updateDashboard();
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initializeChart();
    bindNavigation();
    bindChartControls();
    bindTableControls();
    bindDeviceDetails();
    bindRefreshPreference();
    updateDashboard();
    resetRefreshTimer();
    dashboardState.elapsedTimer = window.setInterval(updateElapsedLabels, 1000);
});
