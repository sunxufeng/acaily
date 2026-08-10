// 侧边栏 = 内嵌 acaily 网页版（/settings?embed=1）。
// 登录与网页版共用同一飞书会话（后端已将会话 Cookie 设为 SameSite=None），
// 因此侧边栏天然复用「acaily.areteailab.com 的飞书认证登录」，无需单独登录。
// 右键菜单带入的「待总结内容」通过 chrome.storage.session 注入到 ?compose= 参数，
// 由网页版自带逻辑自动填入并发送。
const BASE = 'https://acaily.areteailab.com/settings?embed=1';

function mount(src) {
  const f = document.createElement('iframe');
  f.src = src;
  f.setAttribute('allow', 'clipboard-read; clipboard-write');
  document.body.appendChild(f);
}

(function () {
  let src = BASE;
  try {
    chrome.storage.session.get(['pendingCompose'], (r) => {
      const t = r && r.pendingCompose;
      if (t) {
        src = BASE + '&compose=' + encodeURIComponent(t) + '&auto=1';
        chrome.storage.session.remove(['pendingCompose']);
      }
      mount(src);
    });
  } catch (e) {
    mount(src);
  }
})();
