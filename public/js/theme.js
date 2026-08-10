/* Acaily 主题切换：深色 / 浅色（月之暗面 / 月之明面）
 * 选择持久化到 localStorage，跨页面保持一致；默认跟随系统偏好。
 * 渲染右上角的 pill 按钮（图标 + 文字）。 */
(function () {
  const KEY = 'acaily-theme';
  // 在主题 t 下，按钮"提示的"是相反侧（当前在亮色，按钮说"去暗面"）
  const MOON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  const SUN_SVG  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
  function apply(t) {
    document.documentElement.setAttribute('data-theme', t);
    const btn = document.getElementById('themeBtn');
    if (!btn) return;
    // 显示的目标主题（点这个按钮要切到的样子）
    const target = t === 'dark' ? 'light' : 'dark';
    const ic = btn.querySelector('#themeIcon');
    const txt = btn.querySelector('#themeText');
    if (ic) ic.innerHTML = target === 'dark' ? MOON_SVG : SUN_SVG;
    if (txt) txt.textContent = target === 'dark' ? '月之暗面' : '月之明面';
    btn.title = target === 'dark' ? '切换到月之暗面（深色）' : '切换到月之明面（浅色）';
  }
  let t = localStorage.getItem(KEY);
  if (!t) {
    t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  apply(t);
  // 事件委托：点击 pill 切换主题
  document.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('#themeBtn') : null;
    if (!el) return;
    const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const next = cur === 'dark' ? 'light' : 'dark';
    localStorage.setItem(KEY, next);
    apply(next);
  });
})();
