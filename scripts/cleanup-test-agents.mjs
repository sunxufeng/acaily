// 一次性清理 E2E 测试残留智能体及其关联数据
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';

const ids = [
  '341d6fb7-4c85-4b9a-8ea4-3032879ade90', // E2E-8tab (org)
  'e1df0a6d-b60f-4123-9929-bc695833342a', // 未命名智能体 (org)
  'add67822-c377-49f3-ae13-7b5efb2033a5', // E2E-Arete (Arete)
];

// 1) 删除 agents.json 中的测试智能体
const AGENT_FILE = process.env.ACAILY_AGENT_STORE || '/opt/acaily/app/data/agents.json';
const aj = JSON.parse(readFileSync(AGENT_FILE, 'utf8'));
const before = Object.keys(aj.agents || {}).length;
for (const id of ids) delete aj.agents[id];
const after = Object.keys(aj.agents || {}).length;
writeFileSync(AGENT_FILE, JSON.stringify(aj, null, 2));
console.log(`agents.json: ${before} -> ${after} (删除 ${before - after})`);

// 2) 删除关联心跳自动化（hb-<id> 或 agentId 指向测试智能体）
const AUTO_FILE = process.env.ACAILY_AUTOMATION_STORE || '/opt/acaily/data/automations.json';
if (existsSync(AUTO_FILE)) {
  const j = JSON.parse(readFileSync(AUTO_FILE, 'utf8'));
  const arr = Array.isArray(j) ? j : (j.automations || Object.values(j));
  const removed = arr.filter(a => ids.some(id => a.id === 'hb-' + id || (a.agentId || a.agent_id) === id));
  const kept = arr.filter(a => !ids.some(id => a.id === 'hb-' + id || (a.agentId || a.agent_id) === id));
  const out = Array.isArray(j) ? kept : { ...j, automations: kept };
  writeFileSync(AUTO_FILE, JSON.stringify(out, null, 2));
  console.log(`automations: 删除 ${removed.length} 条关联心跳 (${removed.map(a => a.id).join(', ')})`);
} else {
  console.log('automations.json 不存在，跳过');
}

// 3) 删除关联会话文件
const SESS_DIR = '/opt/acaily/app/data/sessions';
if (existsSync(SESS_DIR)) {
  let cnt = 0;
  for (const f of readdirSync(SESS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(readFileSync(SESS_DIR + '/' + f, 'utf8'));
      if (s.agentId && ids.includes(s.agentId)) { rmSync(SESS_DIR + '/' + f); cnt++; }
    } catch {}
  }
  console.log(`sessions: 删除 ${cnt} 个关联会话文件`);
} else {
  console.log('sessions 目录不存在，跳过');
}

console.log('cleanup done');
