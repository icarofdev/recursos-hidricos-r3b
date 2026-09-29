const API_BASE = window.__API_BASE__ || document.querySelector('meta[name="api-base"]')?.content || '';
function apiUrl(endpoint) {
  if (!API_BASE || endpoint.startsWith('http://') || endpoint.startsWith('https://')) return endpoint;
  return `${API_BASE.replace(/\/+$/, '')}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
}

let CSRF_TOKEN = '';

function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function request(url, { method = 'GET', data = null } = {}) {
  const isMutation = method !== 'GET' && method !== 'HEAD';
  const payloadData = data !== null ? data : isMutation ? {} : null;
  const res = await fetch(apiUrl(url), {
    method,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(payloadData !== null ? { 'Content-Type': 'application/json' } : {}),
      ...(isMutation && CSRF_TOKEN ? { 'X-CSRF-Token': CSRF_TOKEN } : {}),
    },
    ...(payloadData !== null ? { body: JSON.stringify(payloadData) } : {}),
  });

  if (res.status === 401) {
    window.location.assign(`/login?next=${encodeURIComponent(location.pathname)}`);
    throw new Error('Não autenticado');
  }

  const payload = await res.json().catch(() => ({}));
  if (payload?.csrf_token) CSRF_TOKEN = payload.csrf_token;

  if (!res.ok) {
    const err = new Error(payload?.error?.message || `Erro ${res.status}`);
    err.status = res.status;
    err.code = payload?.error?.code;
    throw err;
  }
  return payload;
}

async function loadAuth() {
  try {
    const me = await request('/api/auth/me');
    if (me?.csrf_token) CSRF_TOKEN = me.csrf_token;
    if (me?.user?.role !== 'admin') {
      document.getElementById('admin-unauthorized').hidden = false;
      document.getElementById('admin-content').hidden = true;
      return false;
    }
    document.getElementById('admin-unauthorized').hidden = true;
    document.getElementById('admin-content').hidden = false;
    return true;
  } catch {
    document.getElementById('admin-unauthorized').hidden = false;
    document.getElementById('admin-content').hidden = true;
    return false;
  }
}

async function loadDevices() {
  const tbody = document.getElementById('devices-table-body');
  try {
    const res = await request('/api/admin/devices');
    const select = document.getElementById('associate-device');
    if (select) {
      const previous = select.value;
      select.replaceChildren();
      for (const dev of res.data || []) {
        if (dev.source === 'monitorie' && dev.mac_address) {
          select.add(
            new Option(`${dev.device_type} · ${dev.mac_address}`, String(dev.id)),
          );
        }
      }
      if ([...select.options].some((option) => option.value === previous)) select.value = previous;
    }
    if (!res.data?.length) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="table-empty">Nenhum dispositivo cadastrado até o momento.</td></tr>';
      return;
    }

    tbody.innerHTML = res.data
      .map((dev) => {
        const isSMWA = dev.device_type === 'SM-WA';
        const badgeClass = isSMWA ? 'badge-smwa' : 'badge-smwu';
        const ownerDisplay = dev.owner
          ? `<strong>${escapeHTML(dev.owner.name)}</strong><br><small>${escapeHTML(dev.owner.email)}</small>`
          : '<span data-tone="admin-tone-1">Disponível</span>';

        const activeCode = dev.activation_code?.active
          ? `<span data-tone="admin-tone-2">Sim (expira ${new Date(dev.activation_code.expires_at).toLocaleDateString()})</span>`
          : '<span data-tone="admin-tone-3">Não</span>';

        let actions = '';
        if (!dev.mac_address) {
          actions += `<button class="btn-sm" data-action="fillMac" data-device-id="${dev.id}" data-linked="${Boolean(dev.owner)}">Informar MAC</button>`;
        }
        if (!dev.owner && !dev.activation_code?.active) {
          actions += `<button class="btn-sm btn-generate" data-action="generateCode" data-device-id="${dev.id}">Gerar Código</button>`;
        }
        if (dev.activation_code?.active) {
          actions += `<button class="btn-sm btn-revoke" data-action="revokeCode" data-device-id="${dev.id}">Revogar Código</button>`;
        }
        if (dev.owner) {
          actions += `<button class="btn-sm btn-revoke" data-action="unlinkDevice" data-device-id="${dev.id}">Desvincular</button>`;
          actions += `<button class="btn-sm btn-transfer" data-action="transferDevice" data-device-id="${dev.id}">Transferir</button>`;
        }

        return `
                <tr>
                    <td><strong>${escapeHTML(dev.mac_address || 'MAC não registrado (legado)')}</strong></td>
                    <td><span class="badge-model ${badgeClass}">${escapeHTML(dev.device_type)}</span></td>
                    <td>${dev.source === 'monitorie' ? (dev.external_id ? 'Telemetria vinculada' : '<span data-tone="admin-tone-2">Telemetria não vinculada</span>') : 'Local'}</td>
                    <td>${dev.status === 'online' ? '<span data-tone="admin-tone-4">● Online</span>' : '<span data-tone="admin-tone-5">○ Offline</span>'}</td>
                    <td>${ownerDisplay}</td>
                    <td>${activeCode}</td>
                    <td><div class="action-buttons">${actions || '—'}</div></td>
                </tr>
            `;
      })
      .join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="table-empty" data-tone="admin-tone-6">Erro ao carregar dispositivos: ${escapeHTML(err.message)}</td></tr>`;
  }
}

async function loadAudit() {
  const tbody = document.getElementById('audit-table-body');
  try {
    const res = await request('/api/admin/audit-logs?limit=30');
    if (!res.data?.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty">Nenhum registro de auditoria.</td></tr>';
      return;
    }

    tbody.innerHTML = res.data
      .map((log) => {
        const author = log.author
          ? `${escapeHTML(log.author.name)} (${escapeHTML(log.author.email)})`
          : 'Sistema / Anônimo';
        const device = log.device ? `${escapeHTML(log.device.type)} - ${escapeHTML(log.device.code)}` : '—';
        const date = new Date(log.created_at).toLocaleString();
        const details = log.details
          ? `<small><code>${escapeHTML(JSON.stringify(log.details))}</code></small>`
          : '—';

        return `
                <tr>
                    <td><small>${date}</small></td>
                    <td><strong>${escapeHTML(log.action)}</strong></td>
                    <td>${device}</td>
                    <td>${author}</td>
                    <td><code>${escapeHTML(log.ip || '—')}</code></td>
                    <td>${details}</td>
                </tr>
            `;
      })
      .join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty" data-tone="admin-tone-6">Erro ao carregar auditoria: ${escapeHTML(err.message)}</td></tr>`;
  }
}

async function generateCode(deviceId) {
  try {
    const res = await request(`/api/admin/devices/${deviceId}/generate-code`, { method: 'POST' });
    showCodeModal(res.activation_code, res.expires_at);
    await loadDevices();
    await loadAudit();
  } catch (err) {
    alert(`Erro ao gerar código: ${err.message}`);
  }
}

async function fillMac(deviceId, linked) {
  const mac = prompt('Informe o MAC físico confirmado para este equipamento legado:');
  if (mac === null) return;
  if (linked && !confirm('Este equipamento já está vinculado a um cliente. Confirma o MAC físico informado?'))
    return;
  try {
    await request(`/api/admin/devices/${deviceId}/update`, {
      method: 'POST',
      data: { mac_address: mac, confirm_linked_modification: linked },
    });
    await loadDevices();
    await loadAudit();
  } catch (error) {
    alert(`Erro ao registrar MAC: ${error.message}`);
  }
}

async function revokeCode(deviceId) {
  if (!confirm('Deseja realmente revogar o código de ativação pendente deste dispositivo?')) return;
  try {
    await request(`/api/admin/devices/${deviceId}/revoke-code`, { method: 'POST' });
    await loadDevices();
    await loadAudit();
  } catch (err) {
    alert(`Erro ao revogar código: ${err.message}`);
  }
}

async function unlinkDevice(deviceId) {
  if (
    !confirm(
      'Deseja desvincular administrativamente este dispositivo do cliente atual? O histórico do cliente será preservado em sua conta, mas o dispositivo ficará liberado.',
    )
  )
    return;
  try {
    await request(`/api/admin/devices/${deviceId}/unlink`, { method: 'POST' });
    await loadDevices();
    await loadAudit();
  } catch (err) {
    alert(`Erro ao desvincular dispositivo: ${err.message}`);
  }
}

async function transferDevice(deviceId) {
  if (
    !confirm(
      'Iniciar transferência de titularidade? O cliente atual será desvinculado imediatamente e um NOVO código de ativação de uso único será gerado para o próximo cliente. O novo cliente não terá acesso às leituras antigas.',
    )
  )
    return;
  try {
    const res = await request(`/api/admin/devices/${deviceId}/transfer`, { method: 'POST' });
    showCodeModal(res.activation_code, res.expires_at);
    await loadDevices();
    await loadAudit();
  } catch (err) {
    alert(`Erro ao transferir dispositivo: ${err.message}`);
  }
}

function showCodeModal(code, expiresAt) {
  document.getElementById('display-activation-code').textContent = code;
  document.getElementById('display-code-expires').textContent =
    `Válido até: ${new Date(expiresAt).toLocaleString()}`;
  document.getElementById('code-modal').hidden = false;
}

document.addEventListener('DOMContentLoaded', async () => {
  const isAuthed = await loadAuth();
  if (!isAuthed) return;

  await loadDevices();
  await loadAudit();

  document.getElementById('btn-refresh-devices')?.addEventListener('click', async () => {
    await loadDevices();
    await loadAudit();
  });

  document.getElementById('btn-copy-code')?.addEventListener('click', () => {
    const code = document.getElementById('display-activation-code').textContent;
    navigator.clipboard.writeText(code).then(() => {
      alert('Código copiado para a área de transferência!');
    });
  });

  document.getElementById('btn-close-code-modal')?.addEventListener('click', () => {
    document.getElementById('code-modal').hidden = true;
  });

  document.getElementById('admin-logout')?.addEventListener('click', async () => {
    await request('/api/auth/logout', { method: 'POST' });
    window.location.assign('/login');
  });

  document.getElementById('create-device-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const feedback = document.getElementById('create-feedback');
    feedback.textContent = 'Cadastrando dispositivo…';
    feedback.dataset.tone = 'info';

    const deviceType = document.getElementById('device-type').value;
    const macAddress = document.getElementById('device-mac').value.trim();
    const source = document.getElementById('device-source').value;

    try {
      await request('/api/admin/devices', {
        method: 'POST',
        data: {
          device_type: deviceType,
          mac_address: macAddress,
          source,
        },
      });
      feedback.textContent = 'Dispositivo cadastrado com sucesso!';
      feedback.dataset.tone = 'success';
      document.getElementById('create-device-form').reset();
      await loadDevices();
      await loadAudit();
    } catch (err) {
      feedback.textContent = `Erro: ${err.message}`;
      feedback.dataset.tone = 'error';
    }
  });

  const associationForm = document.getElementById('associate-monitorie-form');
  const associationFeedback = document.getElementById('associate-feedback');
  associationForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    associationFeedback.textContent = 'Consultando a MonitorIE…';
    associationFeedback.dataset.tone = 'info';
    const deviceId = Number(document.getElementById('associate-device').value);
    try {
      const result = await request(`/api/admin/devices/${deviceId}/monitorie-discover`, { method: 'POST' });
      associationFeedback.textContent = result.status === 'linked'
        ? 'Telemetria vinculada: MAC exato confirmado em um único dispositivo acessível.'
        : result.status === 'scanning'
          ? `Consulta em andamento (${result.checked} dispositivos verificados). Aguarde 70 segundos e consulte a próxima etapa.`
          : result.reason || 'Telemetria não vinculada.';
      associationFeedback.dataset.tone = result.status === 'linked' ? 'success' : 'info';
      if (result.status === 'linked') { await loadDevices(); await loadAudit(); }
    } catch (error) {
      associationFeedback.textContent = `Erro: ${error.message}`;
      associationFeedback.dataset.tone = 'error';
    }
  });

  document.getElementById('devices-table-body')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const actions = { generateCode, revokeCode, unlinkDevice, transferDevice, fillMac };
    const id = Number(button.dataset.deviceId);
    if (Number.isSafeInteger(id) && id > 0)
      void actions[button.dataset.action]?.(id, button.dataset.linked === 'true');
  });
});
