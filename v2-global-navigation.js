(() => {
  'use strict';

  const path = String(window.location.pathname || '').toLowerCase();
  const publicPages = new Set([
    '/', '/index.html', '/login.html', '/register.html', '/estimate.html',
    '/invoice.html', '/receipt.html', '/repair-authorization.html'
  ]);
  if (publicPages.has(path) || path.startsWith('/marketing/')) return;

  function installDashboardButton() {
    if (!document.body || document.getElementById('garavexGlobalDashboardBtn')) return;
    if (path === '/dashboard.html' || path === '/v2-dashboard.html') return;

    const style = document.createElement('style');
    style.id = 'garavexGlobalDashboardStyle';
    style.textContent = `
      #garavexGlobalDashboardBtn {
        position: fixed;
        top: 14px;
        right: 18px;
        z-index: 2147483646;
        display: inline-flex;
        align-items: center;
        gap: 7px;
        min-height: 38px;
        padding: 8px 14px;
        border: 1px solid rgba(255,255,255,.28);
        border-radius: 8px;
        background: #0879a8;
        color: #fff;
        box-shadow: 0 4px 14px rgba(0,0,0,.25);
        font: 700 13px/1.1 Arial, Helvetica, sans-serif;
        text-decoration: none;
        cursor: pointer;
      }
      #garavexGlobalDashboardBtn:hover { filter: brightness(1.12); }
      #garavexGlobalDashboardBtn:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }
      @media (max-width: 700px) {
        #garavexGlobalDashboardBtn { top: 8px; right: 8px; padding: 8px 10px; }
      }
    `;
    document.head.appendChild(style);

    const link = document.createElement('a');
    link.id = 'garavexGlobalDashboardBtn';
    link.href = '/dashboard.html';
    link.setAttribute('aria-label', 'Return to Garavex dashboard');
    link.innerHTML = '<span aria-hidden="true">⌂</span><span>Dashboard</span>';
    document.body.appendChild(link);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installDashboardButton, { once: true });
  } else {
    installDashboardButton();
  }
})();
