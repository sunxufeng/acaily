/* Acaily 主题切换：深色 / 浅色（月之暗面 / 月之明面）
 * 选择持久化到 localStorage，跨页面保持一致；默认跟随系统偏好。 */
(function () {
  const KEY = 'acaily-theme';
  function apply(t) {
    document.documentElement.setAttribute('data-theme', t);
    const btn = document.getElementById('themeBtn');
    if (btn) btn.textContent = t === 'dark' ? '☀️' : '🌙';
    if (btn) btn.title = t === 'dark' ? '切换到浅色' : '切换到深色';
  }
  let t = localStorage.getItem(KEY);
  if (!t) {
    t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  apply(t);
  // 事件委托，等待 DOM 中 #themeBtn 出现即可生效
  document.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('#themeBtn') : null;
    if (el) {
      const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      const next = cur === 'dark' ? 'light' : 'dark';
      localStorage.setItem(KEY, next);
      apply(next);
    }
  });
})();
