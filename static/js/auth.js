(() => {
    'use strict';

    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';

    async function request(url, options = {}) {
        const response = await fetch(url, {
            credentials: 'same-origin',
            headers: {
                Accept: 'application/json',
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...(options.method === 'POST' ? { 'X-CSRF-Token': csrfToken } : {})
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

    const resetForm = document.getElementById('reset-form');
    if (resetForm) {
        const token = resetForm.elements.token.value;
        request(`/api/auth/reset-password.php?token=${encodeURIComponent(token)}`)
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
})();
