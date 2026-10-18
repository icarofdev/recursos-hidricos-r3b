const scriptURL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading;

function loadWidget() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = window.setTimeout(fail, 10000);
    function fail() {
      window.clearTimeout(timer);
      script.remove();
      loading = null;
      reject(new Error('Não foi possível carregar a verificação. Recarregue e tente novamente.'));
    }
    script.src = scriptURL;
    script.async = true;
    script.onload = () => {
      window.clearTimeout(timer);
      if (!window.turnstile?.render) {
        fail();
        return;
      }
      resolve(window.turnstile);
    };
    script.onerror = fail;
    document.head.append(script);
  });
  return loading;
}

/** One widget and one token per attempt. No automatic credential resubmission. */
export function createLoginChallenge(panel, container, status) {
  let details = null,
    widget = null,
    token = '',
    generation = 0;
  function clear() {
    generation++;
    token = '';
    details = null;
    if (widget !== null) window.turnstile?.remove(widget);
    widget = null;
    panel.hidden = true;
  }
  async function show(value) {
    if (
      !value ||
      !/^[A-Za-z0-9_-]{3,256}$/.test(value.site_key) ||
      value.action !== 'login' ||
      !/^[a-f0-9]{64}$/.test(value.cdata)
    )
      throw new Error('Verificação indisponível. Tente novamente.');
    details = value;
    token = '';
    const current = ++generation;
    panel.hidden = false;
    status.textContent = 'Conclua a verificação e pressione Entrar.';
    const api = await loadWidget();
    if (current !== generation) return;
    if (widget !== null) api.remove(widget);
    widget = api.render(container, {
      sitekey: value.site_key,
      action: value.action,
      cData: value.cdata,
      'response-field': false,
      callback(value) {
        if (current !== generation) return;
        token = value;
        status.textContent = 'Verificação concluída. Pressione Entrar.';
      },
      'expired-callback'() {
        if (current !== generation) return;
        token = '';
        status.textContent = 'Verificação expirada. Conclua novamente.';
        api.reset(widget);
      },
      'error-callback'() {
        if (current !== generation) return;
        token = '';
        status.textContent = 'Verificação indisponível. Use Recarregar verificação.';
      },
      'timeout-callback'() {
        if (current !== generation) return;
        token = '';
        status.textContent = 'Tempo de verificação encerrado. Use Recarregar verificação.';
      },
    });
  }
  return {
    get required() {
      return details !== null;
    },
    takeToken() {
      if (details && !token) throw new Error('Conclua a verificação de segurança antes de entrar.');
      const result = token;
      token = '';
      return result;
    },
    show,
    async refresh() {
      if (details) await show(details);
    },
    clear,
  };
}
