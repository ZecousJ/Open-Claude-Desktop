// (live claude.ai bundle, 2026-10-14, frame-shell-chrome-B45f-YAC.js and frame-shell-deferred-3KNGWgcu.js): artifact installation offers and browser steps.
(() => {
  const button = document.querySelector('[data-install-artifact]');
  if (!button) return;
  const messages = JSON.parse(document.querySelector('[data-install-messages]').textContent);
  const locale = navigator.languages?.find((language) => messages[language]) || navigator.language;
  const text = (value) => messages[locale]?.[value] || value;
  // The bar's other actions in the same language as Permissions and Install artifact.
  for (const label of document.querySelectorAll?.('[data-l10n]') ?? []) label.textContent = text(label.textContent);
  const reasons = {
    installed: 'Already installed and open in its own window.',
    chromium: 'This browser isn’t offering to install this artifact here. If you’ve installed it, open it from your desktop or app launcher. If this is a private window, open the page in a regular window.',
    dismissed: 'You closed the install dialog. Reload the page to try again.',
    no_icon: 'This browser couldn’t draw the artifact’s icon, and installing needs one. If a privacy setting or extension blocks it, turn that off, or try another browser.',
    old_safari: 'Adding to the Dock needs Safari 17 or later on macOS Sonoma or later.',
    unsupported: 'This browser doesn’t offer to install artifacts. Try Chrome or Edge.',
    pending: 'Checking whether this browser can install this artifact',
  };
  const labels = { home_screen: 'Add to Home Screen', android_home_screen: 'Add to Home screen', dock: 'Add to Dock', desktop: 'Install artifact' };
  const display = matchMedia('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui), (display-mode: window-controls-overlay)');
  try { if (new URLSearchParams(location.search).has('installed')) sessionStorage.setItem('frame-shell:installed-window', location.pathname); } catch {}
  const installed = () => {
    try { return sessionStorage.getItem('frame-shell:installed-window') === location.pathname && (navigator.standalone === true || display.matches); } catch { return false; }
  };
  let offered, dismissed = false, iconless = false, pending = true;
  function offer() {
    const agent = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(agent) || (agent.includes('Macintosh') && navigator.maxTouchPoints > 1);
    const android = !ios && /Android/.test(agent);
    const safari = /Version\/(\d+)(?:\.\d+)* (?:Mobile\/\S+ )?Safari\//.exec(agent);
    const promptApi = 'onbeforeinstallprompt' in window;
    const mac = !ios && agent.includes('Macintosh') && !promptApi && safari && !/Chrome\/|Chromium\/|Edg\/|Firefox\/|OPR\/|Ddg\//.test(agent);
    const target = ios ? 'home_screen' : android ? 'android_home_screen' : mac ? 'dock' : 'desktop';
    if (installed()) return { target, reason: 'installed' };
    if (offered) return { target, prompt: true };
    if (ios) return { target, steps: /CriOS\//.test(agent) ? [
      'Tap Share in Chrome’s address bar.',
      'Tap Add to Home Screen. You may need to scroll to find it.', 'Tap Add.',
    ] : [
      /FxiOS\/|EdgiOS\/|OPiOS\/|OPT\/|GSA\/|DuckDuckGo\/|Ddg\//.test(agent) || !/Safari\//.test(agent) ? 'Open your browser’s menu and tap Share.' : 'Tap Share in Safari’s toolbar. If you don’t see it, tap the More button (three dots) first.',
      'Tap Add to Home Screen. You may need to scroll to find it.', 'Tap Add.',
    ], notes: [ ...(/CriOS\//.test(agent) ? [] : ['If you don’t see Add to Home Screen, open this page in Safari and try again.']), 'Open it from your Home Screen. You may need to sign in again the first time.' ] };
    if (android) return { target, steps: [ /Chrome\//.test(agent) && !/SamsungBrowser\/|EdgA\/|OPR\/|YaBrowser\/|; wv\)/.test(agent) ? 'Tap Chrome’s More button (three dots).' : 'Open your browser’s menu.', 'Tap Add to Home screen, then follow the prompts.' ], notes: [] };
    if (mac) return Number(safari[1]) >= 17 ? { target, steps: ['In Safari’s menu bar, choose File, then Add to Dock. This needs macOS Sonoma or later.', 'Click Add.'], notes: ['Open it from your Dock. You may need to sign in again the first time.'] } : { target, reason: 'old_safari' };
    return { target, reason: promptApi ? iconless ? 'no_icon' : dismissed ? 'dismissed' : pending ? 'pending' : 'chromium' : 'unsupported' };
  }
  function update() {
    const state = offer();
    button.textContent = text(labels[state.target]);
    button.disabled = Boolean(state.reason);
    button.title = state.reason ? text(reasons[state.reason]) : '';
    document.querySelector('[data-install-reason]').textContent = button.title;
  }
  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); offered = event; dismissed = false; update(); });
  window.addEventListener('appinstalled', () => { offered = undefined; update(); });
  display.addEventListener('change', update);
  button.addEventListener('click', async () => {
    const state = offer();
    if (state.prompt) {
      const event = offered;
      offered = undefined;
      try {
        await event.prompt();
        dismissed = (await event.userChoice).outcome === 'dismissed';
      } catch (error) {
        if (error.name === 'NotAllowedError') offered = event;
      }
      update();
    } else if (state.steps) {
      const dialog = document.querySelector('[data-install-steps]');
      dialog.querySelector('h2').textContent = text(labels[state.target]);
      dialog.querySelector('ol').replaceChildren(...state.steps.map((step) => { const item = document.createElement('li'); item.textContent = text(step); return item; }));
      dialog.querySelector('p').textContent = state.notes.map(text).join(' ');
      dialog.querySelector('button').textContent = text('Done');
      dialog.querySelector('[data-install-close]')?.setAttribute('aria-label', text('Close'));
      dialog.showModal();
    }
  });
  async function icon(size) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('icon');
    const image = new Image();
    const loaded = new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
    image.src = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32"><rect width="32" height="32" fill="#f2f2f1"/><g color="#7b7974" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" transform="translate(4 4) scale(1.2)"><circle cx="5.671" cy="13.329" r="3.171"/><path d="M12.029 8.5L16.971 8.5C17.263 8.5 17.5 8.737 17.5 9.029L17.5 15.972C17.5 16.263 17.263 16.5 16.971 16.5L12.029 16.5C11.737 16.5 11.5 16.263 11.5 15.972L11.5 9.029C11.5 8.737 11.737 8.5 12.029 8.5Z"/><path d="M7.061 10C5.97 7.588 6.69 4.803 8.809 3.583C10.929 2.362 13.699 3.136 15.243 5.294C15.432 5.556 15.326 5.921 15.053 6.077L7.834 10.235C7.659 10.335 7.438 10.34 7.263 10.237C7.18 10.187 7.108 10.11 7.061 10Z"/></g></svg>`);
    await loaded;
    context.drawImage(image, 0, 0, size, size);
    const pixel = context.getImageData(1, 1, 1, 1).data;
    if (pixel[3] !== 255 || [242, 242, 241].some((value, index) => Math.abs(pixel[index] - value) > 2)) throw new Error('icon');
    const src = canvas.toDataURL('image/png');
    if (!src.startsWith('data:image/png')) throw new Error('icon');
    return { src, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' };
  }
  update();
  (async () => {
    let icons = [];
    try { icons = await Promise.all([192, 512].map(icon)); } catch { iconless = true; }
    const rawTitle = document.querySelector('.bar-title').textContent.replace(/[\u00AD\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu, '').replace(/[\s\p{Cc}\u2800\uFFFC\u{1D159}\u{13441}\u{13442}\u{16910}\u115F\u1160\u3164\uFFA0]+/gu, ' ').trim();
    const letters = Array.from(/[^\p{Cf}\p{Cc}\p{Mn}\p{Me}\s\u2800\uFFFC\u{1D159}\u{13441}\u{13442}\u{16910}\u115F\u1160\u3164\uFFA0]/u.test(rawTitle) ? rawTitle : '');
    const title = letters.length > 60 ? letters.slice(0, 59).join('').trimEnd() + '…' : letters.join('') || text('Untitled artifact');
    const link = document.createElement('link');
    link.rel = 'manifest';
    const scope = location.origin + location.pathname;
    link.href = 'data:application/manifest+json;charset=utf-8,' + encodeURIComponent(JSON.stringify({ id: location.origin + '/artifact/' + encodeURIComponent(location.pathname.split('/').pop().toLowerCase()), name: title + ' – ' + text('Claudex artifact'), short_name: title, start_url: scope + '?installed=1', scope, display: 'standalone', icons, theme_color: getComputedStyle(document.body).backgroundColor, background_color: getComputedStyle(document.body).backgroundColor }));
    document.head.append(link);
    if (icons.length) {
      const touch = document.createElement('link');
      touch.rel = 'apple-touch-icon';
      touch.href = await icon(180).then((image) => image.src).catch(() => icons[1].src);
      document.head.append(touch);
    }
    for (const [name, content] of [['apple-mobile-web-app-capable', 'yes'], ['apple-mobile-web-app-title', title]]) {
      const meta = document.createElement('meta'); meta.name = name; meta.content = content; document.head.append(meta);
    }
    setTimeout(() => { pending = false; update(); }, 5000);
    update();
  })();
})();
