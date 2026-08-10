const APP_URL = "https://acplugin.areteailab.com/";

function openCompose(message, auto = true) {
  const u = new URL(APP_URL);
  u.searchParams.set("compose", message);
  if (auto) u.searchParams.set("auto", "1");
  chrome.tabs.create({ url: u.toString() });
}

function pageMessage(tab) {
  const title = (tab.title || tab.url || "当前页面").trim();
  return `请总结这个网页：\n标题：${title}\n链接：${tab.url || ""}`;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "acaily-summarize-page",
    title: "用 acaily 总结此页面",
    contexts: ["page"],
  });
  chrome.contextMenus.create({
    id: "acaily-summarize-selection",
    title: "用 acaily 总结选中文字",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "acaily-summarize-page") {
    openCompose(pageMessage(tab), true);
  } else if (info.menuItemId === "acaily-summarize-selection" && info.selectionText) {
    openCompose(`请总结/解读下面这段内容：\n\n${info.selectionText.trim()}`, true);
  }
});
