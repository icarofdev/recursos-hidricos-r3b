<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="Painel de monitoramento hídrico em tempo real do dispositivo SM-WA da R3B.">
    <title>Hidra R3B — Monitoramento hídrico</title>
    <link rel="stylesheet" href="static/css/dashboard.css">
    <script defer src="static/js/vendor/chart.umd.min.js"></script>
    <script defer src="static/js/dashboard.js"></script>
</head>
<body class="is-loading">
    <a class="skip-link" href="#conteudo-principal">Ir para o conteúdo principal</a>

    <div class="mobile-overlay" id="mobile-overlay" aria-hidden="true"></div>

    <aside class="sidebar" id="sidebar" aria-label="Navegação principal">
        <div class="brand">
            <span class="brand-mark" aria-hidden="true"><span></span></span>
            <span class="brand-copy">
                <strong>Hidra</strong>
                <small>monitoramento R3B</small>
            </span>
            <button class="icon-button sidebar-close" id="sidebar-close" type="button" aria-label="Fechar menu">
                <span aria-hidden="true">×</span>
            </button>
        </div>

        <nav class="primary-nav" aria-label="Seções da dashboard">
            <a class="nav-link is-active" href="#visao-geral" data-section="visao-geral" aria-current="page">
                <span class="nav-icon" aria-hidden="true">⌂</span>
                <span>Visão geral</span>
            </a>
            <a class="nav-link" href="#monitoramento" data-section="monitoramento">
                <span class="nav-icon" aria-hidden="true">≋</span>
                <span>Monitoramento</span>
            </a>
            <a class="nav-link" href="#historico" data-section="historico">
                <span class="nav-icon" aria-hidden="true">↺</span>
                <span>Histórico</span>
            </a>
            <a class="nav-link" href="#alertas" data-section="alertas">
                <span class="nav-icon" aria-hidden="true">!</span>
                <span>Alertas</span>
                <span class="nav-count" id="nav-alert-count" aria-label="0 alertas">0</span>
            </a>
            <a class="nav-link" href="#dispositivos" data-section="dispositivos">
                <span class="nav-icon" aria-hidden="true">▣</span>
                <span>Dispositivos</span>
            </a>
            <a class="nav-link" href="#configuracoes" data-section="configuracoes">
                <span class="nav-icon" aria-hidden="true">⚙</span>
                <span>Configurações</span>
            </a>
        </nav>

        <div class="sidebar-footer">
            <span class="sidebar-footer-dot" aria-hidden="true"></span>
            <span>
                <strong>Coleta automática</strong>
                <small>Fonte: dispositivo SM-WA</small>
            </span>
        </div>
    </aside>

    <div class="app-shell">
        <header class="topbar">
            <div class="topbar-title">
                <button class="icon-button menu-button" id="menu-button" type="button" aria-label="Abrir menu" aria-controls="sidebar" aria-expanded="false">
                    <span aria-hidden="true">☰</span>
                </button>
                <div>
                    <p class="eyebrow">Central de monitoramento</p>
                    <h1>Visão geral</h1>
                </div>
            </div>

            <div class="topbar-actions">
                <div class="connection-brief" id="connection-brief" role="status" aria-live="polite">
                    <span class="status-dot is-waiting" id="connection-dot" aria-hidden="true"></span>
                    <span>
                        <strong id="connection-label">Conectando</strong>
                        <small id="updated-label">Aguardando dados</small>
                    </span>
                </div>
                <div class="local-profile" aria-label="Sessão sem autenticação">
                    <span class="profile-avatar" aria-hidden="true">R3</span>
                    <span>
                        <strong>Sessão local</strong>
                        <small>Sem autenticação</small>
                    </span>
                </div>
            </div>
        </header>

        <main id="conteudo-principal" tabindex="-1">
            <section class="page-intro" id="visao-geral" aria-labelledby="page-intro-title">
                <div>
                    <p class="eyebrow">Telemetria SM-WA</p>
                    <h2 id="page-intro-title">Situação do consumo</h2>
                    <p class="location-line" id="monitored-device">Identificando dispositivo SM-WA…</p>
                </div>
                <div class="page-intro-meta">
                    <span>Atualização automática</span>
                    <strong id="refresh-rate-label">a cada 5 segundos</strong>
                </div>
            </section>

            <section class="system-status is-loading" id="system-status" aria-live="assertive" aria-atomic="true">
                <span class="system-status-icon" aria-hidden="true">•</span>
                <div>
                    <strong id="system-status-title">Verificando o sistema</strong>
                    <span id="system-status-description">Buscando a leitura mais recente e o histórico do dispositivo.</span>
                </div>
                <span class="system-status-time" id="system-status-time">Agora</span>
            </section>

            <section class="overview-layout" aria-label="Resumo do sistema">
                <article class="surface reservoir-panel">
                    <div class="section-heading">
                        <div>
                            <p class="eyebrow">Leitura mais recente</p>
                            <h2>Consumo registrado</h2>
                        </div>
                        <span class="status-badge is-waiting" id="telemetry-status">Aguardando</span>
                    </div>

                    <div class="reservoir-content">
                        <div class="tank-visual" role="img" aria-label="Sinal Wi-Fi aguardando leitura" id="signal-visual">
                            <span class="tank-tick tick-75" aria-hidden="true">-60</span>
                            <span class="tank-tick tick-50" aria-hidden="true">-75</span>
                            <span class="tank-tick tick-25" aria-hidden="true">-90</span>
                            <div class="tank-shell">
                                <div class="tank-water" id="signal-fill"></div>
                            </div>
                        </div>

                        <div class="reservoir-reading">
                            <div class="primary-reading skeleton-text" id="consumption-reading">—</div>
                            <p id="telemetry-classification">Aguardando telemetria</p>
                            <dl class="reservoir-details">
                                <div>
                                    <dt>Vazão</dt>
                                    <dd id="flow-reading">—</dd>
                                </div>
                                <div>
                                    <dt>RSSI Wi-Fi</dt>
                                    <dd id="wifi-reading">—</dd>
                                </div>
                            </dl>
                        </div>
                    </div>
                </article>

                <section class="metrics-panel" aria-labelledby="metrics-title">
                    <div class="section-heading compact-heading">
                        <div>
                            <p class="eyebrow">Leituras essenciais</p>
                            <h2 id="metrics-title">Agora</h2>
                        </div>
                        <span class="section-note" id="metric-timestamp">Sem leitura</span>
                    </div>

                    <div class="metric-primary">
                        <div>
                            <span class="metric-label">PPL</span>
                            <strong class="metric-value skeleton-text" id="ppl-reading">—</strong>
                            <span class="metric-unit" id="ppl-unit">valor informado</span>
                        </div>
                        <span class="metric-context" id="ppl-context">Aguardando leitura do dispositivo</span>
                    </div>

                    <div class="metrics-split">
                        <div class="metric-secondary">
                            <span class="metric-label">Vazão atual</span>
                            <strong class="skeleton-text" id="flow-metric">—</strong>
                            <small id="flow-context">Aguardando leitura</small>
                        </div>
                        <div class="metric-secondary">
                            <span class="metric-label">Dispositivo</span>
                            <strong class="skeleton-text" id="device-state-reading">—</strong>
                            <small id="device-state-context">Verificando comunicação</small>
                        </div>
                    </div>

                    <div class="unavailable-readings" aria-label="Demais valores da leitura atual">
                        <div>
                            <span class="metric-label">Consumo</span>
                            <strong id="consumption-metric">—</strong>
                            <small>Valor recebido do SM-WA</small>
                        </div>
                        <div>
                            <span class="metric-label">RSSI Wi-Fi</span>
                            <strong id="rssi-metric">—</strong>
                            <small>Intensidade de sinal recebida</small>
                        </div>
                    </div>
                </section>
            </section>

            <section class="surface chart-panel" id="monitoramento" aria-labelledby="chart-title">
                <div class="chart-toolbar">
                    <div>
                        <p class="eyebrow">Série temporal</p>
                        <h2 id="chart-title">Histórico de telemetria</h2>
                    </div>
                    <div class="range-filters" role="group" aria-label="Período do gráfico">
                        <button class="range-filter is-active" type="button" data-hours="24" aria-pressed="true">Hoje</button>
                        <button class="range-filter" type="button" data-hours="168" aria-pressed="false">7 dias</button>
                        <button class="range-filter" type="button" data-hours="720" aria-pressed="false">30 dias</button>
                    </div>
                </div>

                <div class="metric-tabs" role="group" aria-label="Métrica exibida no gráfico">
                    <button class="metric-tab is-active" type="button" data-metric="consumo" aria-pressed="true">Consumo</button>
                    <button class="metric-tab" type="button" data-metric="vazao" aria-pressed="false">Vazão</button>
                    <button class="metric-tab" type="button" data-metric="ppl" aria-pressed="false">PPL</button>
                    <button class="metric-tab" type="button" data-metric="rssi_wifi" aria-pressed="false">RSSI Wi-Fi</button>
                </div>

                <div class="chart-stage" id="chart-stage">
                    <canvas id="history-chart" aria-label="Gráfico das leituras do SM-WA ao longo do tempo" role="img"></canvas>
                    <div class="chart-state" id="chart-state" aria-live="polite">
                        <span class="chart-state-icon" aria-hidden="true">≋</span>
                        <strong id="chart-state-title">Carregando histórico</strong>
                        <span id="chart-state-description">Preparando a visualização das leituras.</span>
                    </div>
                </div>
                <p class="chart-summary" id="chart-summary">O resumo textual do gráfico aparecerá após o carregamento.</p>
            </section>

            <div class="lower-grid">
                <section class="surface alerts-panel" id="alertas" aria-labelledby="alerts-title">
                    <div class="section-heading">
                        <div>
                            <p class="eyebrow">Ocorrências</p>
                            <h2 id="alerts-title">Alertas ativos</h2>
                        </div>
                        <span class="status-badge is-neutral" id="alerts-count">0 ativos</span>
                    </div>
                    <div class="alerts-list" id="alerts-list" aria-live="polite" aria-busy="true">
                        <div class="empty-state loading-state">
                            <span class="empty-state-icon" aria-hidden="true">…</span>
                            <strong>Verificando alertas</strong>
                            <span>Consultando o estado atual do sistema.</span>
                        </div>
                    </div>
                </section>

                <section class="surface devices-panel" id="dispositivos" aria-labelledby="devices-title">
                    <div class="section-heading">
                        <div>
                            <p class="eyebrow">Infraestrutura conectada</p>
                            <h2 id="devices-title">Dispositivos</h2>
                        </div>
                        <span class="section-note" id="devices-count">—</span>
                    </div>
                    <div class="device-card" id="device-card">
                        <div class="device-main">
                            <span class="device-symbol" aria-hidden="true">▣</span>
                            <span>
                                <strong id="device-name">Aguardando identificação</strong>
                                <small id="device-type">Dispositivo de monitoramento hídrico SM-WA</small>
                            </span>
                        </div>
                        <div class="device-health">
                            <span class="status-dot is-waiting" id="device-dot" aria-hidden="true"></span>
                            <span>
                                <strong id="device-status">Verificando</strong>
                                <small id="device-last-seen">Sem comunicação registrada</small>
                            </span>
                        </div>
                        <button class="text-button" id="device-details-button" type="button" aria-expanded="false" aria-controls="device-details" disabled>Ver detalhes</button>
                    </div>
                    <div class="device-details" id="device-details" hidden>
                        <dl>
                            <div><dt>Identificador</dt><dd id="detail-device-id">—</dd></div>
                            <div><dt>Última leitura</dt><dd id="detail-last-reading">—</dd></div>
                            <div><dt>PPL</dt><dd id="detail-ppl">—</dd></div>
                            <div><dt>Vazão</dt><dd id="detail-vazao">—</dd></div>
                            <div><dt>RSSI Wi-Fi</dt><dd id="detail-rssi">—</dd></div>
                        </dl>
                    </div>
                </section>
            </div>

            <section class="surface history-panel" id="historico" aria-labelledby="history-title">
                <div class="section-heading history-heading">
                    <div>
                        <p class="eyebrow">Registros recebidos</p>
                        <h2 id="history-title">Histórico recente</h2>
                    </div>
                    <span class="section-note" id="history-count">Aguardando dados</span>
                </div>

                <div class="table-state" id="table-state" aria-live="polite">Carregando registros…</div>
                <div class="table-wrapper" id="history-table-wrapper" hidden>
                    <table>
                        <thead>
                            <tr>
                                <th scope="col">Data e hora</th>
                                <th scope="col">Dispositivo</th>
                                <th scope="col" class="numeric">PPL</th>
                                <th scope="col" class="numeric">Vazão</th>
                                <th scope="col" class="numeric">Consumo</th>
                                <th scope="col" class="numeric">RSSI Wi-Fi</th>
                            </tr>
                        </thead>
                        <tbody id="history-table-body"></tbody>
                    </table>
                </div>
                <div class="table-pagination" id="table-pagination" hidden>
                    <span id="pagination-label">Página 1</span>
                    <div>
                        <button class="pagination-button" id="previous-page" type="button" aria-label="Página anterior">Anterior</button>
                        <button class="pagination-button" id="next-page" type="button" aria-label="Próxima página">Próxima</button>
                    </div>
                </div>
            </section>

            <section class="settings-row" id="configuracoes" aria-labelledby="settings-title">
                <div>
                    <p class="eyebrow">Preferências locais</p>
                    <h2 id="settings-title">Atualização da tela</h2>
                    <p>Esta preferência altera apenas a frequência de consulta desta dashboard.</p>
                </div>
                <label class="select-field" for="refresh-interval">
                    <span>Intervalo de atualização</span>
                    <select id="refresh-interval">
                        <option value="5000">A cada 5 segundos</option>
                        <option value="15000">A cada 15 segundos</option>
                        <option value="30000">A cada 30 segundos</option>
                    </select>
                </label>
            </section>
        </main>
    </div>

    <noscript>
        <div class="noscript-message">Ative o JavaScript para acompanhar as leituras do sistema.</div>
    </noscript>
</body>
</html>
