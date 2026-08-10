// 后台 Service Worker：侧边栏行为 + 右键菜单
const APP_URL = "https://acplugin.areteailab.com/";

// 点击工具栏图标即打开侧边栏
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

function pageMessage(tab) {
  const title = (tab.title || tab.url || "当前页面").trim();
  return `请总结这个网页：\n标题：${title}\n链接：${tab.url || ""}`;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "acaily-summarize-page", title: "用 acaily 总结此页面", contexts: ["page"] });
  chrome.contextMenus.create({ id: "acaily-summarize-selection", title: "用 acaily 总结选中文字", contexts: ["selection"] });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  let text = "";
  if (info.menuItemId === "acaily-summarize-page") text = pageMessage(tab);
  else if (info.menuItemId === "acaily-summarize-selection" && info.selectionText)
    text = `请总结/解读下面这段内容：\n\n${info.selectionText.trim()}`;
  // 把待发送内容暂存到 session storage，侧边栏打开后自动读取填入
  chrome.storage.session.set({ pendingCompose: text }).catch(() => {});
  // 打开侧边栏（若本 tab 可用）
  if (tab && tab.id) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});
