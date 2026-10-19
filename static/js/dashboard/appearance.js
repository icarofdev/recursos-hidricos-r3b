// Presentation controls retain the existing select/input elements and their events.
export function enhanceReservoirPicker() {
  const select = document.getElementById('reservoir-select');
  const picker = select.closest('.reservoir-picker');
  const wrapper = document.createElement('div');
  wrapper.className = 'reservoir-combobox';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'reservoir-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'reservoir-options');
  const value = document.createElement('span');
  trigger.append(value);
  const list = document.createElement('div');
  list.id = 'reservoir-options';
  list.className = 'reservoir-options';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Reservatórios disponíveis');
  list.hidden = true;
  wrapper.append(trigger, list);
  picker.append(wrapper);
  select.hidden = true;
  let active = 0;
  let search = '';
  let searchTime = 0;
  const options = () => Array.from(select.options);

  function highlight(index) {
    const entries = options();
    if (!entries.length) return;
    active = Math.max(0, Math.min(index, entries.length - 1));
    list.querySelectorAll('[role="option"]').forEach((option, i) => {
      option.classList.toggle('is-focused', i === active);
    });
    trigger.setAttribute('aria-activedescendant', `reservoir-option-${active}`);
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  function close() {
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
  }

  function sync() {
    value.textContent = select.selectedOptions[0]?.textContent || 'Selecionar reservatório';
    trigger.disabled = select.disabled;
    trigger.setAttribute('aria-label', `${select.getAttribute('aria-label')}: ${value.textContent}`);
    list.replaceChildren();
    options().forEach((option, index) => {
      const row = document.createElement('div');
      row.id = `reservoir-option-${index}`;
      row.className = 'reservoir-option';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-label', option.textContent);
      row.setAttribute('aria-selected', String(option.selected));
      row.setAttribute('aria-disabled', String(option.disabled));
      row.textContent = option.textContent;
      row.addEventListener('pointermove', () => highlight(index));
      row.addEventListener('click', () => choose(index));
      list.append(row);
    });
    if (trigger.disabled) close();
    else if (!list.hidden) highlight(select.selectedIndex);
  }

  function open() {
    if (trigger.disabled) return;
    sync();
    list.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    highlight(select.selectedIndex);
  }

  function choose(index) {
    if (!options()[index] || options()[index].disabled) return;
    select.selectedIndex = index;
    close();
    sync();
    trigger.focus();
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  trigger.addEventListener('click', () => (list.hidden ? open() : close()));
  picker.addEventListener('click', (event) => {
    // The native label still names the original select; focus its visible replacement.
    if (!wrapper.contains(event.target)) trigger.focus();
  });
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') return close();
    if (event.key === 'Escape') {
      event.preventDefault();
      return close();
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (list.hidden) open();
      else if (event.key === 'ArrowDown') highlight(active + 1);
      else if (event.key === 'ArrowUp') highlight(active - 1);
      if (event.key === 'Home') highlight(0);
      if (event.key === 'End') highlight(options().length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (list.hidden) open();
      else choose(active);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (list.hidden) open();
      search = Date.now() - searchTime > 700 ? event.key : search + event.key;
      searchTime = Date.now();
      const index = options().findIndex((option) =>
        option.text.toLocaleLowerCase('pt-BR').startsWith(search.toLocaleLowerCase('pt-BR')),
      );
      if (index >= 0) highlight(index);
    }
  });
  document.addEventListener('click', (event) => {
    if (!picker.contains(event.target)) close();
  });
  window.addEventListener('popstate', close);
  select.addEventListener('change', sync);
  new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true });
  sync();
}

export function enhanceNumberInputs() {
  document.querySelectorAll('input[type="number"]').forEach((input) => {
    const wrapper = document.createElement('span');
    wrapper.className = 'number-control';
    input.before(wrapper);
    wrapper.append(input);
    const controls = document.createElement('span');
    controls.className = 'number-arrows';
    for (const [direction, label] of [
      [1, 'Aumentar valor'],
      [-1, 'Diminuir valor'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = direction === 1 ? 'number-up' : 'number-down';
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-controls', input.id);
      button.addEventListener('click', () => {
        if (input.disabled || input.readOnly || input.closest('fieldset:disabled')) return;
        if (input.step === 'any') {
          const min = input.min ? Number(input.min) : -Infinity;
          const max = input.max ? Number(input.max) : Infinity;
          input.value = String(Math.min(max, Math.max(min, (Number(input.value) || 0) + direction)));
        } else {
          if (direction === 1) input.stepUp();
          else input.stepDown();
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.focus();
      });
      controls.append(button);
    }
    wrapper.append(controls);
  });
}

export function bindSidebar() {
  const mobile = window.matchMedia('(max-width: 960px)');
  const button = document.getElementById('menu-button');
  const sidebar = document.getElementById('sidebar');
  const shell = document.querySelector('.app-shell');
  const closeButton = document.getElementById('sidebar-close');
  let collapsed = false;
  try {
    collapsed = localStorage.getItem('hidra_sidebar_collapsed') === 'true';
  } catch {}
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.dataset.tooltip = link.textContent.trim();
    link.setAttribute('aria-label', link.textContent.trim());
  });

  function sync() {
    const open = document.body.classList.contains('menu-open');
    const expanded = mobile.matches ? open : !document.body.classList.contains('sidebar-collapsed');
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-label', expanded ? 'Recolher navegação' : 'Abrir navegação');
    button.title = expanded ? 'Recolher navegação' : 'Abrir navegação';
    sidebar.inert = mobile.matches && !open;
    // Keep keyboard focus inside the navigation drawer while it is open.
    shell.inert = mobile.matches && open;
    document.getElementById('mobile-overlay').setAttribute('aria-hidden', String(!open));
  }

  function close(restore = false) {
    document.body.classList.remove('menu-open');
    sync();
    if (restore) button.focus();
  }

  button.addEventListener('click', () => {
    if (mobile.matches) {
      document.body.classList.toggle('menu-open');
      sync();
      if (document.body.classList.contains('menu-open')) closeButton.focus();
    } else {
      collapsed = !document.body.classList.contains('sidebar-collapsed');
      document.body.classList.toggle('sidebar-collapsed', collapsed);
      try {
        localStorage.setItem('hidra_sidebar_collapsed', String(collapsed));
      } catch {}
      sync();
      window.dispatchEvent(new Event('resize'));
    }
  });
  closeButton.addEventListener('click', () => close(true));
  document.getElementById('mobile-overlay').addEventListener('click', () => close(true));
  document.addEventListener('keydown', (event) => {
    if (!mobile.matches || !document.body.classList.contains('menu-open')) return;
    if (event.key === 'Escape') close(true);
    if (event.key === 'Tab') {
      const links = [...sidebar.querySelectorAll('a[href], button:not([disabled])')];
      const first = links[0],
        last = links[links.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  window.addEventListener('hidra-screen-change', () => close());
  mobile.addEventListener('change', () => close());
  sync();
}
