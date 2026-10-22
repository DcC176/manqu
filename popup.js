const DEFAULTS = { enabled: true, colorize: false, badge: true };

const keys = ['enabled', 'colorize', 'badge'];

chrome.storage.local.get(DEFAULTS, (cfg) => {
  for (const k of keys) {
    const el = document.getElementById(k);
    el.classList.toggle('on', !!cfg[k]);
    el.addEventListener('click', () => {
      const next = !el.classList.contains('on');
      el.classList.toggle('on', next);
      chrome.storage.local.set({ [k]: next });
    });
  }
});
