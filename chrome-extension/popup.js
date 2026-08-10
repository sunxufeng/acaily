const APP_URL = "https://acplugin.areteailab.com/";

// 组装要发给 acaily 的消息
function buildMessage(tab, instruction) {
  const title = (tab.title || tab.url || "当前页面").trim();
  const url = tab.url || "";
  let msg = `请总结这个网页：\n标题：${title}\n链接：${url}`;
  if (instruction && instruction.trim()) {
    msg += `\n\n附加要求：${instruction.trim()}`;
  }
  return msg;
}

// 打开 acaily 网页版并带入 compose 参数（网页版会自动填入并发送）
function sendToAcaily(message, auto = true) {
  const u = new URL(APP_URL);
  u.searchParams.set("compose", message);
  if (auto) u.searchParams.set("auto", "1");
  chrome.tabs.create({ url: u.toString() });
  window.close();
}

// 读取当前激活标签页
async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

document.addEventListener("DOMContentLoaded", async () => {
  let tab = await getCurrentTab();
  const titleEl = document.getElementById("pageTitle");
  const urlEl = document.getElementById("pageUrl");
  titleEl.textContent = tab.title || "(无标题)";
  urlEl.textContent = tab.url || "";

  document.getElementById("summarize").onclick = async () => {
    const instruction = document.getElementById("instruction").value;
    const msg = buildMessage(tab, instruction);
    sendToAcaily(msg, true);
  };

  document.getElementById("openApp").onclick = () => {
    chrome.tabs.create({ url: APP_URL });
    window.close();
  };
});
