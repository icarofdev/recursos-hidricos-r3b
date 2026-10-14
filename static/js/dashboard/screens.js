import {
  dashboardState,
  getElement,
  getSelectedReservoir,
  escapeHTML,
  formatNumber,
  formatElapsed,
} from './model.js';

const routes = {
  '/': 'visao-geral',
  '/dispositivos': 'dispositivos',
  '/reservatorios': 'reservatorios',
  '/historico': 'historico',
  '/configuracoes': 'configuracoes',
};
const titles = {
  'visao-geral': 'Visão geral',
  dispositivos: 'Dispositivos',
  reservatorios: 'Reservatórios',
  historico: 'Histórico',
  configuracoes: 'Configurações',
};
const capacities = [100, 150, 250, 310, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000];
let services,
  formReservoirId = null,
  memberRequest = 0;

export function mountScreens(api) {
  services = api;
  const content = getElement('dashboard-content');
  for (const name of Object.values(routes)) {
    const screen = document.createElement('section');
    screen.id = `screen-${name}`;
    screen.className = 'app-screen';
    screen.dataset.screen = name;
    content.append(screen);
  }
  const move = (name, selectors) =>
    selectors.forEach((selector) => {
      const node = document.querySelector(selector);
      if (node) getElement(`screen-${name}`).append(node);
    });
  move('visao-geral', ['#system-status', '.reservoir-panel', '#monitoramento', '#alertas']);
  move('historico', ['.kpi-grid', '#historico', '.analytics-grid']);
  move('dispositivos', ['#dispositivos']);
  move('configuracoes', ['#configuracoes']);
  // Preferences remain accessible when the account has no connected devices.
  getElement('conteudo-principal').append(getElement('screen-configuracoes'));
  const reservoirScreen = getElement('screen-reservatorios');
  reservoirScreen.innerHTML = `<section class="surface configuration-panel"><div class="section-heading"><div><p class="eyebrow">Instalação e medição</p><h2>Configuração do reservatório</h2></div></div>
    <p id="geometry-owner-note" class="section-description"></p>
    <form id="geometry-form"><fieldset id="geometry-fields"><div class="configuration-grid">
    <label class="form-field">Instalação<select id="installation-type"><option value="elevated">Caixa residencial elevada</option><option value="building">Reservatório predial / condomínio</option><option value="underground">Cisterna enterrada</option><option value="custom">Instalação personalizada</option></select></label>
    <label class="form-field">Geometria<select id="reservoir-geometry"><option value="reported">Volume recebido da nuvem / dispositivo</option><option value="uniform">Seção uniforme (vertical / retangular)</option><option value="horizontal_cylinder">Cilindro horizontal</option><option value="calibration">Formato irregular: tabela de calibração</option></select></label>
    <label class="form-field">Capacidade inicial<select id="capacity-preset"><option value="">Personalizada / não informada</option>${capacities.map((value) => `<option value="${value}">${formatNumber(value, 0)} L</option>`).join('')}</select></label>
    <label class="form-field">Capacidade útil no nível máximo (L)<input id="geometry-capacity" type="number" min="0.01" max="1000000000000" step="any" placeholder="Informe a capacidade real"></label></div>
    <div id="distance-fields" class="configuration-grid" hidden>
      <label class="form-field">Sensor até o fundo, vazio (cm)<input id="empty-distance" type="number" min="0.01" step="any"></label>
      <label class="form-field">Sensor até o nível máximo (cm)<input id="full-distance" type="number" min="0" step="any"></label>
      <label class="form-field">Distância mínima válida do sensor (cm)<input id="sensor-min" type="number" min="0" step="any"></label>
      <label class="form-field">Tolerância nas extremidades (cm)<input id="distance-tolerance" type="number" min="0" step="any" value="0"></label>
      <label class="form-field" id="diameter-field" hidden>Diâmetro interno do cilindro (cm)<input id="cylinder-diameter" type="number" min="0.01" step="any"></label>
    </div>
    <p class="configuration-help" id="geometry-help">O volume reportado é preservado. As medidas usadas na nuvem não estão disponíveis neste projeto.</p>
    <label class="form-field" id="calibration-field" hidden>Calibração: altura da água (cm), volume (L), uma dupla por linha<textarea id="calibration-points" rows="6" placeholder="Use medições reais, do vazio ao nível máximo"></textarea></label>
    <button class="primary-button" type="submit">Salvar configuração</button></fieldset><p id="geometry-feedback" role="status" aria-live="polite"></p></form></section>`;
  const configPanel = reservoirScreen.querySelector('.configuration-panel');
  configPanel.append(getElement('capacity-form'), getElement('rename-reservoir'));
  getElement('dispositivos').insertAdjacentHTML(
    'beforeend',
    `<section class="membership-panel"><h3>Usuários associados</h3><p id="members-feedback" role="status">Carregando vínculos…</p><ul id="members-list"></ul><form id="member-form"><label class="form-field">E-mail da conta existente<input id="member-email" type="email" maxlength="254" required autocomplete="off"></label><button class="secondary-button" type="submit">Vincular usuário</button></form><p class="configuration-help">Até cinco contas, incluindo o proprietário. Usuários associados consultam leituras e podem sair do próprio vínculo. Só o proprietário gerencia a instalação e os demais vínculos.</p></section>`,
  );
  getElement('screen-visao-geral').insertAdjacentHTML(
    'beforeend',
    `<section class="surface device-directory"><div class="section-heading"><h2>Dispositivos cadastrados</h2><a class="text-button" href="/dispositivos" data-app-route>Ver todos →</a></div><div id="overview-devices"></div></section>`,
  );
  getElement('screen-dispositivos').prepend(document.createElement('div'));
  getElement('screen-dispositivos').firstElementChild.id = 'device-directory';
  document.querySelector('.lower-grid')?.remove();
  getElement('geometry-form').addEventListener('submit', saveConfiguration);
  getElement('reservoir-geometry').addEventListener('change', geometryFields);
  getElement('capacity-preset').addEventListener('change', () => {
    getElement('geometry-capacity').value = getElement('capacity-preset').value;
  });
  getElement('member-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await memberMutation('/api/devices/users/add', { email: getElement('member-email').value });
  });
  getElement('members-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-remove-member]');
    if (button)
      await memberMutation('/api/devices/users/remove', { user_id: Number(button.dataset.removeMember) });
  });
  document.addEventListener('click', async (event) => {
    const select = event.target.closest('[data-select-reservoir]');
    if (select) {
      await services.selectReservoir(Number(select.dataset.selectReservoir));
      navigate('/dispositivos');
    }
    const link = event.target.closest('a.nav-link,a[data-app-route]');
    if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    event.preventDefault();
    navigate(link.getAttribute('href'));
  });
  window.addEventListener('popstate', () => showScreen());
  showScreen();
}

function navigate(path) {
  if (location.pathname + location.hash !== path) window.history.pushState({}, '', path);
  showScreen(true);
}

function showScreen(focus = false) {
  const current = routes[location.pathname.replace(/\/$/, '') || '/'] || 'visao-geral';
  document.querySelectorAll('.app-screen').forEach((node) => {
    node.hidden = node.dataset.screen !== current;
  });
  getElement('page-intro-title').textContent = titles[current];
  getElement('screen-breadcrumb').textContent = titles[current];
  document.title = `${titles[current]} · Hidra FJK`;
  document.querySelectorAll('.nav-link').forEach((link) => {
    const active = link.dataset.section === current;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  // The same chart instance serves the overview summary and the dedicated history route.
  getElement(`screen-${current === 'historico' ? 'historico' : 'visao-geral'}`).prepend(
    getElement('monitoramento'),
  );
  if (current === 'visao-geral')
    getElement('screen-visao-geral').insertBefore(getElement('monitoramento'), getElement('alertas'));
  if (current === 'historico') {
    dashboardState.historyVisible = true;
    dashboardState.historyRequestPending = true;
    void services.updateDashboard();
  }
  if (current === 'dispositivos') void loadMembers();
  window.dispatchEvent(new Event('hidra-screen-change'));
  if (focus) {
    getElement('conteudo-principal').focus();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  window.dispatchEvent(new Event('resize'));
}

export function renderScreens() {
  if (!services) return;
  const selected = getSelectedReservoir();
  const html =
    dashboardState.reservoirs
      .map((reservoir) => {
        const device =
          reservoir.id === selected?.id && dashboardState.device ? dashboardState.device : reservoir.device;
        const unavailable = device.telemetry_linked === false;
        const status = unavailable
          ? 'Telemetria não vinculada'
          : device.status === 'online'
            ? 'Online'
            : device.status === 'unknown'
              ? 'Comunicação não confirmada'
              : 'Sem comunicação';
        return `<div class="directory-row"><span class="directory-symbol" aria-hidden="true"><svg><use href="#icon-device"></use></svg></span><div><strong>${escapeHTML(reservoir.name)}</strong><small><span class="technical-value">${escapeHTML(reservoir.device.code)}</span> · ${escapeHTML(reservoir.device.type)}</small></div><span class="status-badge ${device.status === 'online' ? 'is-normal' : 'is-warning'}">${status}</span><span class="directory-contact">${escapeHTML(formatElapsed(device.last_seen))}</span><button class="text-button" data-select-reservoir="${reservoir.id}" type="button">Abrir<span class="sr-only"> ${escapeHTML(reservoir.name)}</span></button></div>`;
      })
      .join('') || '<p>Nenhum dispositivo cadastrado.</p>';
  getElement('overview-devices').innerHTML = html;
  getElement('device-directory').innerHTML = html;
  getElement('screen-configuracoes').hidden =
    (routes[location.pathname.replace(/\/$/, '') || '/'] || 'visao-geral') !== 'configuracoes';
  if (!selected) return;
  const changed = formReservoirId !== selected.id;
  if (changed) {
    formReservoirId = selected.id;
    getElement('installation-type').value = selected.installation_type;
    getElement('reservoir-geometry').value = selected.geometry;
    getElement('geometry-capacity').value = selected.capacity_liters ?? '';
    getElement('capacity-preset').value = capacities.includes(selected.capacity_liters)
      ? String(selected.capacity_liters)
      : '';
    const config = selected.measurement_config || {};
    for (const [id, key] of [
      ['empty-distance', 'empty_distance_cm'],
      ['full-distance', 'full_distance_cm'],
      ['sensor-min', 'sensor_min_cm'],
      ['distance-tolerance', 'tolerance_cm'],
      ['cylinder-diameter', 'diameter_cm'],
    ])
      getElement(id).value = config[key] ?? (key === 'tolerance_cm' ? 0 : '');
    getElement('calibration-points').value = (config.points || [])
      .map((point) => `${point.height_cm}, ${point.liters}`)
      .join('\n');
    geometryFields();
    if (location.pathname === '/dispositivos') void loadMembers();
  }
  getElement('geometry-fields').disabled = !selected.can_manage;
  getElement('capacity-form').hidden =
    !selected.can_manage || selected.device.type === 'SM-WA' || selected.geometry !== 'reported';
  getElement('rename-reservoir').hidden = !selected.can_manage;
  getElement('geometry-owner-note').textContent = selected.can_manage
    ? `${selected.name} · ${selected.device.code}`
    : 'Esta conta tem acesso às leituras. A configuração é gerenciada pelo proprietário.';
  getElement('geometry-form').hidden = selected.device.type === 'SM-WA';
}

function geometryFields() {
  const geometry = getElement('reservoir-geometry').value;
  getElement('distance-fields').hidden = geometry === 'reported';
  getElement('diameter-field').hidden = geometry !== 'horizontal_cylinder';
  getElement('calibration-field').hidden = geometry !== 'calibration';
  getElement('geometry-help').textContent =
    geometry === 'reported'
      ? 'O volume reportado é preservado. As medidas usadas na nuvem não estão disponíveis neste projeto.'
      : 'A diferença entre sensor–fundo e sensor–nível máximo define a altura útil. A segunda distância inclui o afastamento de instalação; respeite a faixa mínima do fabricante. Tolerância até 5% da altura útil só absorve ruído nas extremidades. Fora da faixa, o volume fica indisponível. Para paredes inclinadas ou fundo curvo, use calibração com pontos reais de (0, 0) até (altura útil, capacidade útil).';
  for (const id of ['empty-distance', 'full-distance', 'sensor-min', 'distance-tolerance'])
    getElement(id).required = geometry !== 'reported';
  getElement('cylinder-diameter').required = geometry === 'horizontal_cylinder';
  getElement('calibration-points').required = geometry === 'calibration';
}

async function saveConfiguration(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  const feedback = getElement('geometry-feedback');
  feedback.textContent = 'Salvando…';
  try {
    const geometry = getElement('reservoir-geometry').value;
    let config = null;
    if (geometry !== 'reported') {
      config = {
        empty_distance_cm: Number(getElement('empty-distance').value),
        full_distance_cm: Number(getElement('full-distance').value),
        sensor_min_cm: Number(getElement('sensor-min').value),
        tolerance_cm: Number(getElement('distance-tolerance').value),
      };
      if (geometry === 'horizontal_cylinder')
        config.diameter_cm = Number(getElement('cylinder-diameter').value);
      if (geometry === 'calibration')
        config.points = getElement('calibration-points')
          .value.trim()
          .split(/\n/)
          .map((line) => {
            const parts = line.trim().split(/[,;\s]+/);
            if (parts.length !== 2)
              throw new Error('Informe uma dupla de altura e litros por linha, usando ponto decimal.');
            return { height_cm: Number(parts[0]), liters: Number(parts[1]) };
          });
    }
    const payload = await services.requestJSON('/api/reservoirs/configuration', {
      method: 'POST',
      body: {
        reservoir_id: dashboardState.selectedReservoirId,
        installation_type: getElement('installation-type').value,
        geometry,
        capacity_liters:
          getElement('geometry-capacity').value === '' ? null : Number(getElement('geometry-capacity').value),
        measurement_config: config,
      },
    });
    dashboardState.reservoirs = dashboardState.reservoirs.map((item) =>
      item.id === payload.data.id ? payload.data : item,
    );
    feedback.textContent = 'Configuração salva. A próxima atualização usará estas medidas.';
    await services.refresh();
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function loadMembers() {
  const row = getSelectedReservoir();
  if (!row) return;
  const request = ++memberRequest;
  getElement('members-feedback').textContent = 'Carregando vínculos…';
  getElement('members-list').replaceChildren();
  try {
    const payload = await services.requestJSON(`/api/devices/users?reservoir_id=${row.id}`);
    if (request !== memberRequest || row.id !== dashboardState.selectedReservoirId) return;
    getElement('members-feedback').textContent =
      `${payload.data.length} de 5 contas vinculadas${payload.data.length >= 5 ? ' · Limite atingido. Remova um vínculo para adicionar outra.' : ''}`;
    getElement('members-list').innerHTML = payload.data
      .map(
        (member) =>
          `<li><div><strong>${escapeHTML(member.name)}${member.is_owner ? ' · Proprietário' : ''}</strong><small>${escapeHTML(member.email || 'Conta associada')}</small></div>${row.can_manage && !member.is_owner ? `<button class="text-button danger-text" type="button" data-remove-member="${member.id}">Remover<span class="sr-only"> ${escapeHTML(member.name)}</span></button>` : ''}</li>`,
      )
      .join('');
    getElement('member-form').hidden = !row.can_manage;
    getElement('member-form').querySelector('button').disabled = payload.data.length >= 5;
  } catch (error) {
    if (request === memberRequest) getElement('members-feedback').textContent = error.message;
  }
}

async function memberMutation(path, body) {
  const button = getElement('member-form').querySelector('button');
  button.disabled = true;
  try {
    const result = await services.requestJSON(path, {
      method: 'POST',
      body: { reservoir_id: dashboardState.selectedReservoirId, ...body },
    });
    getElement('member-email').value = '';
    await loadMembers();
    await services.refresh();
    if (result.message) getElement('members-feedback').textContent = result.message;
  } catch (error) {
    getElement('members-feedback').textContent = error.message;
  } finally {
    button.disabled = (getSelectedReservoir()?.user_count ?? 0) >= 5;
  }
}
