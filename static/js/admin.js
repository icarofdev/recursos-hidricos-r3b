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
                    <td><strong>${escapeHTML(dev.device_code)}</strong></td>
                    <td><span class="badge-model ${badgeClass}">${escapeHTML(dev.device_type)}</span></td>
                    <td><code>${escapeHTML(dev.external_id || '—')}</code></td>
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
    const deviceCode = document.getElementById('device-code').value.trim();
    const externalId = document.getElementById('external-id').value.trim() || null;
    const source = document.getElementById('device-source').value;

    try {
      await request('/api/admin/devices', {
        method: 'POST',
        data: {
          device_type: deviceType,
          device_code: deviceCode,
          external_id: externalId,
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

  document.getElementById('devices-table-body')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const actions = { generateCode, revokeCode, unlinkDevice, transferDevice };
    const id = Number(button.dataset.deviceId);
    if (Number.isSafeInteger(id) && id > 0) void actions[button.dataset.action]?.(id);
  });
});
