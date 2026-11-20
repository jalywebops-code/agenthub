// Two looks, each chosen per device and applied before the stylesheets load, so the page never flashes the wrong one:
//  - theme: light or dark; "system" (the default) follows the computer or phone. html[data-theme].
//  - style: "classic" (the default) or "tactile", the embossed look in tactile.css. html[data-style].
// app.js changes them with window.agenthubTheme.set(…) and .setStyle(…); the page address can too (see below).
(function () {
  const KEY = 'agenthub_theme';
  const STYLE_KEY = 'agenthub_style';
  // The browser's own bar (phones) in the page colour: [light, dark] for each style.
  const BAR = { classic: ['#f5f6f8', '#0f1115'], tactile: ['#e3e5e9', '#0b0c0e'] };
  const root = document.documentElement;
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  const read = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
  const save = (key, value, fallback) => {
    try { if (value === fallback) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* private window: this visit only */ }
  };
  // The page address can pick either one (?theme=light|dark, ?style=tactile|classic): handy for a demo link or a
  // screenshot. It counts as a choice on this device, so it is saved like one.
  let asked = {};
  try { const q = new URLSearchParams(window.location.search); asked = { theme: q.get('theme'), style: q.get('style') }; } catch { /* no address to read */ }
  if (['light', 'dark'].includes(asked.theme)) save(KEY, asked.theme, 'system'); else asked.theme = null;
  if (['classic', 'tactile'].includes(asked.style)) save(STYLE_KEY, asked.style, 'classic'); else asked.style = null;
  let choice = asked.theme || read(KEY, 'system');
  let style = (asked.style || read(STYLE_KEY, 'classic')) === 'tactile' ? 'tactile' : 'classic';

  function apply() {
    const theme = choice === 'light' || choice === 'dark' ? choice : (dark.matches ? 'dark' : 'light');
    root.dataset.theme = theme;
    root.dataset.style = style;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = BAR[style][theme === 'light' ? 0 : 1];
    window.dispatchEvent(new CustomEvent('agenthub-theme', { detail: { theme, choice, style } }));
  }

  dark.addEventListener('change', () => { if (choice === 'system') apply(); });
  window.agenthubTheme = {
    /** 'system' | 'light' | 'dark' */
    choice: () => choice,
    /** The theme showing now: 'light' | 'dark'. */
    current: () => root.dataset.theme,
    set(next) {
      choice = ['light', 'dark'].includes(next) ? next : 'system';
      save(KEY, choice, 'system');
      apply();
    },
    /** 'classic' | 'tactile' */
    style: () => style,
    setStyle(next) {
      style = next === 'tactile' ? 'tactile' : 'classic';
      save(STYLE_KEY, style, 'classic');
      apply();
    },
  };
  apply();
})();
