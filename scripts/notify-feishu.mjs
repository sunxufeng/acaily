// 部署后飞书状态通知脚本。
// 复用 src/feishu/client.js 的 sendMarkdown，把一条状态消息推送给管理员（ACAILY_ADMIN_OPEN_IDS）。
// 用法：
//   node scripts/notify-feishu.mjs "标题" "正文（支持换行，用 \n 表示）"
//   echo "正文" | node scripts/notify-feishu.mjs "标题"
// 依赖环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET（与 acaily 服务同源，通常由 .env 提供）。
// 收件人：ACAILU_ADMIN_OPEN_IDS（逗号分隔）；若未设置则回退到 Richard 的 open_id。

import { sendMarkdown } from '../src/feishu/client.js';

const FALLBACK_ADMIN = 'ou_f973ad6351688c93d073b95f83cfc3c8';

function getRecipients() {
  const raw = process.env.ACAILY_ADMIN_OPEN_IDS || '';
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length) return ids;
  return [FALLBACK_ADMIN];
}

async function main() {
  let title = process.argv[2];
  let body = process.argv[3];
  if (body == null) {
    // 没有第三个参数：尝试从 stdin 读正文
    if (!process.stdin.isTTY) {
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      body = Buffer.concat(chunks).toString('utf8').trim();
    }
  }
  if (!title && !body) {
    console.error('用法: node scripts/notify-feishu.mjs "标题" "正文"');
    process.exit(2);
  }
  title = title || 'Acaily 部署通知';
  body = (body || '').replace(/\\n/g, '\n');

  if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
    console.error('[notify] 未检测到 FEISHU_APP_ID / FEISHU_APP_SECRET，跳过飞书推送。');
    process.exit(3);
  }

  const recipients = getRecipients();
  let ok = 0;
  for (const id of recipients) {
    try {
      const r = await sendMarkdown(id, body, null, { title });
      if (r && (r.ok || r.skipped)) {
        console.log(`[notify] 已推送 -> ${id} (card=${!!r.card})`);
        ok++;
      } else {
        console.error(`[notify] 推送失败 -> ${id}:`, r);
      }
    } catch (e) {
      console.error(`[notify] 推送异常 -> ${id}:`, e.message);
    }
  }
  process.exit(ok ? 0 : 4);
}

main();
