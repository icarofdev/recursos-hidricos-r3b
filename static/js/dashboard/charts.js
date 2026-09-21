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
} from './model.js';
let historyChart = null;
let consumptionChart = null;
function showChartState(stageId, titleId, descriptionId, title, description) {
  getElement(stageId).classList.add('has-state');
  getElement(titleId).textContent = title;
  getElement(descriptionId).textContent = description;
}

function hideChartState(stageId) {
  getElement(stageId).classList.remove('has-state');
}

function getChartColors() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    grid: isDark ? 'rgba(255, 255, 255, 0.08)' : '#e6eef1',
    tick: isDark ? '#8ea3b0' : '#788b95',
    tooltipBg: isDark ? '#05141f' : '#0b2638',
  };
}

function baseChartOptions() {
  const colors = getChartColors();
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 260 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        displayColors: false,
        backgroundColor: colors.tooltipBg,
        titleColor: '#ffffff',
        bodyColor: '#d9e7ed',
        padding: 12,
        cornerRadius: 8,
        titleMarginBottom: 7,
        bodySpacing: 4,
      },
    },
    scales: {
      x: {
        border: { display: false },
        grid: { display: false },
        ticks: { color: colors.tick, maxTicksLimit: 8, maxRotation: 0, autoSkip: true, font: { size: 10 } },
      },
      y: {
        beginAtZero: true,
        border: { display: false },
        grid: { color: colors.grid, drawTicks: false },
        ticks: { color: colors.tick, padding: 9, maxTicksLimit: 5, font: { size: 10 } },
      },
    },
  };
}

function initializeCharts() {
  if (typeof Chart === 'undefined') {
    showChartState(
      'chart-stage',
      'chart-state-title',
      'chart-state-description',
      'Gráfico indisponível',
      'A biblioteca de gráficos não pôde ser carregada. Os demais dados continuam acessíveis.',
    );
    showChartState(
      'consumption-chart-stage',
      'consumption-state-title',
      'consumption-state-description',
      'Gráfico indisponível',
      'Consulte os valores textuais desta página.',
    );
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
    },
  };

  historyChart = new Chart(getElement('history-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
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
          tension: 0.28,
        },
      ],
    },
    options: historyOptions,
  });

  const consumptionOptions = baseChartOptions();
  consumptionOptions.plugins.tooltip.callbacks = {
    title(items) {
      const series = getConsumptionSeries();
      return formatTooltipTitle(series.points[items[0]?.dataIndex]?.timestamp);
    },
    label(context) {
      return `Consumo: ${formatNumber(context.parsed.y, 2)} L`;
    },
  };
  consumptionOptions.scales.x.ticks.maxTicksLimit = 6;
  consumptionOptions.scales.y.ticks.callback = (value) => `${formatNumber(value, 0)} L`;

  consumptionChart = new Chart(getElement('consumption-chart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Consumo',
          data: [],
          backgroundColor: 'rgba(15, 159, 188, 0.72)',
          hoverBackgroundColor: '#0c7895',
          borderRadius: 5,
          borderSkipped: false,
          maxBarThickness: 28,
        },
      ],
    },
    options: consumptionOptions,
  });

  window.addEventListener('hidra-theme-change', () => {
    const colors = getChartColors();
    [historyChart, consumptionChart].forEach((chart) => {
      if (!chart) return;
      chart.options.scales.x.ticks.color = colors.tick;
      chart.options.scales.y.ticks.color = colors.tick;
      chart.options.scales.y.grid.color = colors.grid;
      chart.options.plugins.tooltip.backgroundColor = colors.tooltipBg;
      chart.update('none');
    });
  });
}

function renderChart() {
  const rangeHistory = getRangeHistory();

  if (dashboardState.historyError) {
    showChartState(
      'chart-stage',
      'chart-state-title',
      'chart-state-description',
      'Erro ao carregar o gráfico',
      'O histórico não pôde ser consultado. Use “Tentar novamente” no aviso acima.',
    );
    getElement('chart-summary').textContent =
      'O gráfico está temporariamente indisponível; a última leitura válida pode continuar visível acima.';
    return;
  }

  if (!historyChart) return;

  if (dashboardState.selectedMetric === 'consumo') {
    const consumption = getConsumptionSeries(rangeHistory);
    getElement('chart-legend-label').textContent = 'Consumo estimado';

    if (!consumption.available) {
      showChartState(
        'chart-stage',
        'chart-state-title',
        'chart-state-description',
        'Dados insuficientes para consumo',
        'São necessárias ao menos duas leituras válidas de volume no período.',
      );
      getElement('chart-summary').textContent = 'Dados insuficientes para análise de consumo neste período.';
      return;
    }

    dashboardState.mainChartRows = consumption.points;
    historyChart.data.labels = consumption.points.map((point) => formatChartLabel(point.timestamp));
    historyChart.data.datasets[0] = {
      type: 'bar',
      label: 'Consumo',
      data: consumption.points.map((point) => point.value),
      backgroundColor: 'rgba(15, 159, 188, 0.72)',
      hoverBackgroundColor: '#0c7895',
      borderColor: '#0f9fbc',
      borderWidth: 0,
      borderRadius: 5,
      borderSkipped: false,
      maxBarThickness: 30,
    };
    historyChart.options.scales.y.beginAtZero = true;
    historyChart.options.scales.y.suggestedMax = undefined;
    historyChart.options.scales.y.ticks.callback = (value) => `${formatNumber(value, 0)} L`;
    historyChart.update();
    getElement('history-chart').setAttribute(
      'aria-label',
      `Consumo estimado no período: ${formatNumber(consumption.total, 2)} litros.`,
    );
    getElement('chart-summary').textContent = consumption.points.length
      ? `Consumo estimado de ${formatNumber(consumption.total, 2)} L, calculado em ${consumption.intervals} intervalos entre leituras.`
      : `Nenhuma redução de volume foi detectada nos ${consumption.intervals} intervalos analisados.`;
    hideChartState('chart-stage');
    return;
  }

  const rows = rangeHistory.filter((item) => toFiniteNumber(item.nivel) !== null);
  getElement('chart-legend-label').textContent = 'Nível do reservatório';

  if (!rows.length) {
    showChartState(
      'chart-stage',
      'chart-state-title',
      'chart-state-description',
      'Nenhuma leitura no período',
      'Ainda não há valores válidos de nível para a faixa selecionada.',
    );
    getElement('chart-summary').textContent = 'Dados insuficientes para análise de nível neste período.';
    return;
  }

  const values = rows.map((item) => toFiniteNumber(item.nivel));
  const latestValue = values[values.length - 1];
  const trend = getLevelTrend(rows);
  dashboardState.mainChartRows = rows;
  historyChart.data.labels = rows.map((item) => formatChartLabel(item.timestamp));
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
    tension: 0.28,
  };
  historyChart.options.scales.y.beginAtZero = true;
  historyChart.options.scales.y.suggestedMax = 100;
  historyChart.options.scales.y.ticks.callback = (value) => `${formatNumber(value, 0)}%`;
  historyChart.update();

  const movement =
    !trend || trend.direction === 'stable'
      ? 'permaneceu estável'
      : `${trend.direction === 'up' ? 'subiu' : 'reduziu'} ${formatNumber(Math.abs(trend.change), 1)} p.p.`;
  const summary = `Nível atual de ${formatNumber(latestValue, 2)}%; ${movement} no período. Mínimo de ${formatNumber(Math.min(...values), 2)}% e máximo de ${formatNumber(Math.max(...values), 2)}%.`;
  getElement('history-chart').setAttribute(
    'aria-label',
    `Nível do reservatório ao longo do período. ${summary}`,
  );
  getElement('chart-summary').textContent = summary;
  hideChartState('chart-stage');
}

function renderConsumption() {
  const consumption = getConsumptionSeries();
  const totalBadge = getElement('consumption-period-total');

  if (dashboardState.historyError) {
    totalBadge.className = 'status-badge is-error';
    totalBadge.textContent = 'Indisponível';
    showChartState(
      'consumption-chart-stage',
      'consumption-state-title',
      'consumption-state-description',
      'Consumo indisponível',
      'O histórico não pôde ser carregado.',
    );
    return;
  }

  if (!consumption.available) {
    totalBadge.className = 'status-badge is-neutral';
    totalBadge.textContent = 'Dados insuficientes';
    showChartState(
      'consumption-chart-stage',
      'consumption-state-title',
      'consumption-state-description',
      'Dados insuficientes',
      'São necessárias ao menos duas leituras válidas de volume no período.',
    );
    return;
  }

  totalBadge.className = 'status-badge is-normal';
  totalBadge.textContent = `${formatNumber(consumption.total, 2)} L`;

  if (!consumptionChart) return;

  consumptionChart.data.labels = consumption.points.map((point) => formatChartLabel(point.timestamp));
  consumptionChart.data.datasets[0].data = consumption.points.map((point) => point.value);
  consumptionChart.update();
  getElement('consumption-chart').setAttribute(
    'aria-label',
    consumption.points.length
      ? `Consumo estimado de ${formatNumber(consumption.total, 2)} litros no período.`
      : 'Nenhuma redução de volume detectada no período.',
  );
  hideChartState('consumption-chart-stage');
}

export {
  historyChart,
  consumptionChart,
  showChartState,
  hideChartState,
  getChartColors,
  baseChartOptions,
  initializeCharts,
  renderChart,
  renderConsumption,
};
