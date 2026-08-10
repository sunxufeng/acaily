const BASE = "https://acplugin.areteailab.com/";
const AGENTS_KEY = "acaily_agents";
const ACTIVE_KEY = "acaily_active_agent";

const $ = (id) => document.getElementById(id);
const chatText = $("chatText");
const messagesEl = $("messages");
const modelSelect = $("modelSelect");
const micBtn = $("micBtn");
const sendBtn = $("sendBtn");
const loginBanner = $("loginBanner");
const openWeb = $("openWeb");
const openWebBtn = $("openWebBtn");

let me = null;
let sessionId = null;
let agents = [];
let activeAgentId = null;
let editingId = null;

// ---------- 通用 ----------
function showLoginBanner(show) { loginBanner.classList.toggle("hidden", !show); }

async function api(method, path, body) {
  const opts = { method, credentials: "include" };
  if (body !== undefined) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  if (res.status === 401) { me = null; refreshLoginUI(); throw new Error("未登录或会话失效"); }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

function openWebApp() { chrome.tabs.create({ url: BASE }); }

// ---------- 登录 / 模型 ----------
async function checkLogin() {
  try {
    const r = await api("GET", "/api/me");
    me = r;
    $("whoami").textContent = r.name || r.openId || "—";
    $("loginState").textContent = "已登录";
    showLoginBanner(false);
  } catch (e) {
    me = null;
    $("whoami").textContent = "—";
    $("loginState").textContent = "未登录";
    showLoginBanner(true);
  }
}

async function loadModels() {
  try {
    const r = await api("GET", "/api/models");
    modelSelect.innerHTML = '<option value="">默认模型</option>';
    const list = Array.isArray(r.models) ? r.models : [];
    list.forEach((m) => {
      const o = document.createElement("option");
      o.value = m; o.textContent = m;
      if (m === r.model) o.selected = true;
      modelSelect.appendChild(o);
    });
    // 自定义模型项
    const custom = document.createElement("option");
    custom.value = "__custom__"; custom.textContent = "自定义…";
    modelSelect.appendChild(custom);
  } catch (e) { /* 未登录等：忽略，保留默认项 */ }
}

function refreshLoginUI() {
  $("loginState").textContent = "未登录";
  $("whoami").textContent = "—";
  showLoginBanner(true);
}

// 自定义模型：切换为自定义时弹出输入
modelSelect.addEventListener("change", () => {
  if (modelSelect.value === "__custom__") {
    const v = prompt("输入自定义模型名：");
    if (v && v.trim()) {
      const o = document.createElement("option");
      o.value = v.trim(); o.textContent = v.trim(); o.selected = true;
      modelSelect.insertBefore(o, modelSelect.lastElementChild);
    } else {
      modelSelect.value = "";
    }
  }
});

// ---------- 对话 ----------
function addMsg(role, text, thinking) {
  const d = document.createElement("div");
  d.className = "msg " + role + (thinking ? " thinking" : "");
  d.textContent = text;
  messagesEl.appendChild(d);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return d;
}

async function send() {
  const text = chatText.value.trim();
  if (!text) return;
  if (!me) { showLoginBanner(true); openWebApp(); return; }
  addMsg("user", text);
  chatText.value = "";
  const bubble = addMsg("bot", "思考中…", true);
  const body = { text };
  if (modelSelect.value) body.model = modelSelect.value;
  const ag = getActiveAgent();
  if (ag) body.systemPrompt = agentSystemPrompt(ag);
  if (sessionId) body.sessionId = sessionId;
  try {
    const r = await api("POST", "/agent/chat", body);
    bubble.classList.remove("thinking");
    if (r && r.answer !== undefined) {
      bubble.textContent = r.answer;
      if (r.sessionId) sessionId = r.sessionId;
    } else {
      bubble.textContent = "⚠️ 未获取到回复";
    }
  } catch (e) {
    bubble.classList.remove("thinking");
    bubble.textContent = "⚠️ " + e.message;
  }
}

sendBtn.onclick = send;
chatText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});

// ---------- 语音输入 ----------
let recognition = null;
let recording = false;
micBtn.onclick = () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $("voiceStatus").textContent = "当前环境不支持语音输入"; return; }
  if (recording) { recognition && recognition.stop(); return; }
  recognition = new SR();
  recognition.lang = "zh-CN";
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.onresult = (e) => {
    let t = "";
    for (let i = e.resultIndex; i < e.results.length; i++) t += e.results[i][0].transcript;
    chatText.value = t;
  };
  recognition.onerror = (e) => { $("voiceStatus").textContent = "语音错误：" + e.error; };
  recognition.onend = () => { recording = false; micBtn.classList.remove("recording"); $("voiceStatus").textContent = ""; };
  recognition.start();
  recording = true;
  micBtn.classList.add("recording");
  $("voiceStatus").textContent = "聆听中…";
};

// ---------- 智能体 ----------
function agentSystemPrompt(a) {
  const parts = [];
  if (a.name) parts.push(`你是「${a.name}」。`);
  if (a.desc) parts.push(a.desc);
  if (a.identity) parts.push(`# 身份（IDENTITY）\n${a.identity}`);
  if (a.user) parts.push(`# 用户（USER）\n${a.user}`);
  if (a.soul) parts.push(`# 灵魂（SOUL）\n${a.soul}`);
  return parts.join("\n\n");
}

async function loadAgents() {
  const data = await chrome.storage.local.get([AGENTS_KEY, ACTIVE_KEY]);
  agents = data[AGENTS_KEY] || [];
  activeAgentId = data[ACTIVE_KEY] || null;
  renderAgents();
  renderActiveAgentBar();
}

function renderAgents() {
  const list = $("agentList");
  list.innerHTML = "";
  if (!agents.length) {
    list.innerHTML = '<div style="color:#8f959e;text-align:center;padding:20px;">还没有智能体，点右上角「+ 创建智能体」。</div>';
    return;
  }
  agents.forEach((a) => {
    const card = document.createElement("div");
    card.className = "agent-card" + (a.id === activeAgentId ? " active" : "");
    const isActive = a.id === activeAgentId;
    card.innerHTML = `
      <div class="row1">
        <span class="emoji">${a.emoji || "🤖"}</span>
        <span class="name">${escapeHtml(a.name || "未命名智能体")}</span>
      </div>
      <div class="desc">${escapeHtml(a.desc || "暂无描述")}</div>
      <div class="acts">
        <button class="ghost-btn" data-act="use">${isActive ? "使用中" : "使用"}</button>
        <button class="ghost-btn" data-act="edit">编辑</button>
        <button class="ghost-btn" data-act="del">删除</button>
      </div>`;
    card.querySelector('[data-act="use"]').onclick = () => setActive(a.id);
    card.querySelector('[data-act="edit"]').onclick = () => openEditor(a.id);
    card.querySelector('[data-act="del"]').onclick = () => delAgent(a.id);
    list.appendChild(card);
  });
}

async function setActive(id) {
  activeAgentId = (activeAgentId === id) ? null : id;
  await chrome.storage.local.set({ [ACTIVE_KEY]: activeAgentId });
  renderAgents();
  renderActiveAgentBar();
}

function getActiveAgent() { return agents.find((a) => a.id === activeAgentId) || null; }

function renderActiveAgentBar() {
  const bar = $("activeAgent");
  const ag = getActiveAgent();
  if (ag) {
    bar.classList.remove("hidden");
    bar.textContent = `${ag.emoji || "🤖"} 当前智能体：${ag.name}`;
  } else {
    bar.classList.add("hidden");
  }
}

function openEditor(id) {
  editingId = id || null;
  const a = id ? agents.find((x) => x.id === id) : {};
  $("editorTitle").textContent = id ? "编辑智能体" : "创建智能体";
  $("agName").value = a.name || "";
  $("agDesc").value = a.desc || "";
  $("agEmoji").value = a.emoji || "🤖";
  $("agIdentity").value = a.identity || "";
  $("agUser").value = a.user || "";
  $("agSoul").value = a.soul || "";
  $("agentEditor").classList.remove("hidden");
}

function closeEditor() { $("agentEditor").classList.add("hidden"); editingId = null; }

$("newAgent").onclick = () => openEditor(null);
$("agCancel").onclick = closeEditor;
$("agSave").onclick = async () => {
  const a = {
    id: editingId || ("ag_" + Date.now()),
    name: $("agName").value.trim(),
    desc: $("agDesc").value.trim(),
    emoji: $("agEmoji").value.trim() || "🤖",
    identity: $("agIdentity").value.trim(),
    user: $("agUser").value.trim(),
    soul: $("agSoul").value.trim(),
  };
  if (!a.name) { alert("请填写名称"); return; }
  if (editingId) agents = agents.map((x) => (x.id === editingId ? a : x));
  else agents.push(a);
  await chrome.storage.local.set({ [AGENTS_KEY]: agents });
  closeEditor();
  renderAgents();
};

async function delAgent(id) {
  if (!confirm("确定删除该智能体？")) return;
  agents = agents.filter((x) => x.id !== id);
  if (activeAgentId === id) activeAgentId = null;
  await chrome.storage.local.set({ [AGENTS_KEY]: agents, [ACTIVE_KEY]: activeAgentId });
  renderAgents();
  renderActiveAgentBar();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- 标签页切换 ----------
document.querySelectorAll(".tab").forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".view").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $(t.dataset.tab).classList.add("active");
  };
});
function switchTab(name) {
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (tab) tab.click();
}

// ---------- 入口 ----------
openWeb.onclick = (e) => { e.preventDefault(); openWebApp(); };
openWebBtn.onclick = openWebApp;

(async () => {
  await loadAgents();
  await checkLogin();
  await loadModels();
  // 右键菜单带入的待发送内容
  try {
    const d = await chrome.storage.session.get("pendingCompose");
    if (d.pendingCompose) {
      chatText.value = d.pendingCompose;
      chrome.storage.session.remove("pendingCompose");
      switchTab("chat");
    }
  } catch (e) {}
})();
