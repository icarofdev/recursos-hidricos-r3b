(function () {
    const STORAGE_KEY = 'hidra_theme';

    function getStoredTheme() {
        try {
            return localStorage.getItem(STORAGE_KEY) || 'auto';
        } catch {
            return 'auto';
        }
    }

    function getSystemTheme() {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    function resolveTheme(preference) {
        return preference === 'auto' ? getSystemTheme() : preference;
    }

    function applyTheme(preference) {
        const resolved = resolveTheme(preference);
        const root = document.documentElement;
        root.setAttribute('data-theme', resolved);
        root.setAttribute('data-theme-preference', preference);
        const metaThemeColor = document.querySelector('meta[name="theme-color"]');
        if (metaThemeColor) {
            metaThemeColor.setAttribute('content', resolved === 'dark' ? '#071722' : '#0b2638');
        }
    }

    // Aplica imediatamente antes do paint para evitar tela piscando (FOUC)
    const initialPreference = getStoredTheme();
    applyTheme(initialPreference);

    function syncSelectors(preference) {
        document.querySelectorAll('.theme-selector').forEach(group => {
            const buttons = group.querySelectorAll('.theme-option');
            buttons.forEach(btn => {
                const val = btn.getAttribute('data-theme-value');
                const isSelected = val === preference;
                btn.classList.toggle('is-selected', isSelected);
                btn.setAttribute('aria-checked', String(isSelected));
                btn.tabIndex = isSelected ? 0 : -1;
            });
        });
    }

    function setTheme(preference) {
        if (!['auto', 'light', 'dark'].includes(preference)) preference = 'auto';
        try {
            localStorage.setItem(STORAGE_KEY, preference);
        } catch {}
        applyTheme(preference);
        syncSelectors(preference);
        window.dispatchEvent(new CustomEvent('hidra-theme-change', {
            detail: { preference, resolved: resolveTheme(preference) }
        }));
    }

    window.__hidraTheme = {
        get: getStoredTheme,
        set: setTheme,
        resolve: resolveTheme,
        apply: () => applyTheme(getStoredTheme())
    };

    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if (getStoredTheme() === 'auto') {
                applyTheme('auto');
                window.dispatchEvent(new CustomEvent('hidra-theme-change', {
                    detail: { preference: 'auto', resolved: getSystemTheme() }
                }));
            }
        });
    }

    function initThemeSelectors() {
        const currentPref = getStoredTheme();
        syncSelectors(currentPref);

        document.querySelectorAll('.theme-selector').forEach(group => {
            const buttons = Array.from(group.querySelectorAll('.theme-option'));

            buttons.forEach((btn, index) => {
                btn.addEventListener('click', () => {
                    const val = btn.getAttribute('data-theme-value');
                    setTheme(val);
                });

                btn.addEventListener('keydown', event => {
                    let nextIndex = -1;
                    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                        event.preventDefault();
                        nextIndex = (index + 1) % buttons.length;
                    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                        event.preventDefault();
                        nextIndex = (index - 1 + buttons.length) % buttons.length;
                    } else if (event.key === 'Home') {
                        event.preventDefault();
                        nextIndex = 0;
                    } else if (event.key === 'End') {
                        event.preventDefault();
                        nextIndex = buttons.length - 1;
                    }

                    if (nextIndex >= 0) {
                        const nextBtn = buttons[nextIndex];
                        nextBtn.focus();
                        setTheme(nextBtn.getAttribute('data-theme-value'));
                    }
                });
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initThemeSelectors);
    } else {
        initThemeSelectors();
    }
})();
