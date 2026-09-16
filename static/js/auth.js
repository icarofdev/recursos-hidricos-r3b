(() => {
    'use strict';

    const apiBase = window.__API_BASE__ || document.querySelector('meta[name="api-base"]')?.content || '';
    function apiUrl(endpoint) {
        if (!apiBase || endpoint.startsWith('http://') || endpoint.startsWith('https://')) return endpoint;
        return `${apiBase.replace(/\/+$/, '')}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
    }

    let csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
    if (csrfToken === '{{csrf}}') csrfToken = '';

    async function getCsrfToken() {
        if (csrfToken) return csrfToken;
        try {
            const response = await fetch(apiUrl('/api/auth/csrf'), {
                credentials: 'include',
                headers: { Accept: 'application/json' }
            });
            const payload = await response.json();
            if (payload?.csrf_token) {
                csrfToken = payload.csrf_token;
                let meta = document.querySelector('meta[name="csrf-token"]');
                if (!meta) {
                    meta = document.createElement('meta');
                    meta.name = 'csrf-token';
                    document.head.append(meta);
                }
                meta.content = csrfToken;
            }
        } catch { /* fallback */ }
        return csrfToken;
    }

    async function request(url, options = {}) {
        const token = options.method === 'POST' ? await getCsrfToken() : '';
        const response = await fetch(apiUrl(url), {
            credentials: 'include',
            headers: {
                Accept: 'application/json',
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...(options.method === 'POST' && token ? { 'X-CSRF-Token': token } : {})
            },
            ...options
        });
        let payload = null;
        try { payload = await response.json(); } catch { /* resposta inválida tratada abaixo */ }
        if (!response.ok || !payload?.success) {
            const error = new Error(payload?.error?.message || 'Não foi possível concluir. Tente novamente.');
            error.code = payload?.error?.code || 'REQUEST_FAILED';
            throw error;
        }
        if (payload?.csrf_token) {
            csrfToken = payload.csrf_token;
            const meta = document.querySelector('meta[name="csrf-token"]');
            if (meta) meta.content = csrfToken;
        }
        return payload;
    }

    function formPayload(form) {
        const data = Object.fromEntries(new FormData(form));
        form.querySelectorAll('input[type="checkbox"]').forEach(input => { data[input.name] = input.checked; });
        return data;
    }

    document.querySelectorAll('.auth-form[data-endpoint]').forEach(form => {
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (!form.reportValidity()) return;
            const button = form.querySelector('button[type="submit"]');
            const error = form.querySelector('[data-form-error]');
            if (error) error.textContent = '';
            button.disabled = true;
            button.classList.add('is-submitting');
            try {
                const result = await request(form.dataset.endpoint, {
                    method: 'POST',
                    body: JSON.stringify(formPayload(form))
                });
                if (form.dataset.success === 'message') {
                    form.querySelectorAll('label, button[type="submit"]').forEach(element => { element.hidden = true; });
                    const panel = form.querySelector('[data-success-panel]');
                    panel.hidden = false;
                    panel.querySelector('[data-success-message]').textContent = result.message;
                } else {
                    window.location.assign(result.redirect || '/');
                }
            } catch (requestError) {
                if (error) error.textContent = requestError.message;
            } finally {
                button.disabled = false;
                button.classList.remove('is-submitting');
            }
        });
    });

    const nextInput = document.querySelector('input[name="next"]');
    if (nextInput) {
        const urlNext = new URLSearchParams(window.location.search).get('next');
        if (urlNext) nextInput.value = urlNext;
    }

    const resetForm = document.getElementById('reset-form');
    if (resetForm) {
        const urlToken = new URLSearchParams(window.location.search).get('token') || '';
        const tokenInput = resetForm.elements.token;
        const token = (tokenInput && tokenInput.value && tokenInput.value !== '{{token}}') ? tokenInput.value : urlToken;
        if (tokenInput) tokenInput.value = token;
        // O formulário retém o token; removê-lo da barra evita compartilhamento acidental.
        if (urlToken) window.history.replaceState(null, '', '/redefinir-senha');
        request(`/api/auth/reset-password?token=${encodeURIComponent(token)}`)
            .then(result => {
                document.getElementById('token-status').textContent = result.valid
                    ? 'O link é válido. Defina uma senha forte para continuar.'
                    : 'Não foi possível validar este link.';
                resetForm.hidden = !result.valid;
                document.getElementById('invalid-token').hidden = result.valid;
            })
            .catch(() => {
                document.getElementById('token-status').textContent = 'Não foi possível validar este link.';
                document.getElementById('invalid-token').hidden = false;
            });
    }

    if (document.getElementById('reset-success') && new URLSearchParams(location.search).get('reset') === 'success') {
        document.getElementById('reset-success').hidden = false;
    }

    const pathname = window.location.pathname;
    if (['/login', '/cadastro'].some(p => pathname === p || pathname.endsWith(p))) {
        fetch(apiUrl('/api/auth/me'), { credentials: 'include', headers: { Accept: 'application/json' } })
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (data?.user) {
                    const next = new URLSearchParams(window.location.search).get('next') || '/';
                    window.location.assign(next.startsWith('/') && !next.startsWith('//') ? next : '/');
                }
            })
            .catch(() => {});
    }
})();
