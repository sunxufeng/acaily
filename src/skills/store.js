// Skill 扩展信息存储：为内置工具（TOOL_REGISTRY 中的每一项）附加「其他信息」。
//
// 参考主流 Agent Skills 的目录结构（SKILL.md + assets/ + references/ + scripts/），
// 在 data/skills/<toolName>/ 下维护每个工具的：
//   - skill.json    元数据（备注 / 标签 / 是否在列表中高亮等，描述仍以来自代码注册表为准）
//   - SKILL.md      该工具的详细说明（何时用、怎么用、参数约定、示例）
//   - assets/       模板 / 图片等随工具下发的资源文件
//   - references/   领域参考文档（Markdown 等，供阅读）
//   - scripts/      可执行脚本（仅展示 / 下载，不在服务端自动执行）
//
// 与代码注册表解耦：工具名 + 基础描述始终来自 src/tools/*.js（注册表），
// 这里只承载「可运维 / 可富化的附加信息」，缺失即代表使用默认。
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  createReadStream,
  rmSync,
} from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ACAILY_SKILLS_DIR || join(__dirname, '..', '..', 'data', 'skills');

// 工具名只允许这些字符，杜绝路径穿越 / 目录注入。
const NAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;
// 文件名同样不能含路径分隔符或 `..`，避免写到目录之外。
const FILE_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;
export const SKILL_KINDS = ['assets', 'references', 'scripts'];

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 单文件 10MB
const ALLOWED_EXT = new Set([
  '.md', '.txt', '.json', '.csv', '.yaml', '.yml', '.html', '.htm',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.pdf', '.docx', '.xlsx',
  '.js', '.mjs', '.ts', '.py', '.sh', '.sql', '.zip',
]);

function assertName(name) {
  if (!NAME_RE.test(name || '')) throw new Error('非法的工具名');
}
function assertKind(kind) {
  if (!SKILL_KINDS.includes(kind)) throw new Error('非法的资源类别（应为 assets/references/scripts 之一）');
}
function assertFile(name) {
  if (!FILE_RE.test(name || '')) throw new Error('非法的文件名（不能含路径分隔符或 ..）');
}

function skillDir(name) {
  return join(ROOT, name);
}
function kindDir(name, kind) {
  return join(skillDir(name), kind);
}

function ensureDir(name, kind) {
  mkdirSync(kindDir(name, kind), { recursive: true });
}
function ensureSkillDir(name) {
  mkdirSync(skillDir(name), { recursive: true });
}

// ---- 元数据 skill.json ----
export function getMeta(name) {
  assertName(name);
  const p = join(skillDir(name), 'skill.json');
  if (!existsSync(p)) return {};
  try {
    const obj = JSON.parse(readFileSync(p, 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

export function saveMeta(name, meta) {
  assertName(name);
  ensureSkillDir(name);
  const clean = {};
  if (meta && typeof meta === 'object') {
    for (const k of ['note', 'tags', 'highlight', 'category', 'description']) {
      if (k in meta) clean[k] = meta[k];
    }
  }
  writeFileSync(join(skillDir(name), 'skill.json'), JSON.stringify(clean, null, 2));
  return clean;
}

// ---- SKILL.md ----
export function getMarkdown(name) {
  assertName(name);
  const p = join(skillDir(name), 'SKILL.md');
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf8');
}

export function saveMarkdown(name, md) {
  assertName(name);
  ensureSkillDir(name);
  const text = typeof md === 'string' ? md : '';
  writeFileSync(join(skillDir(name), 'SKILL.md'), text);
  return text;
}

export function hasMarkdown(name) {
  assertName(name);
  return existsSync(join(skillDir(name), 'SKILL.md'));
}

// ---- 文件（assets / references / scripts）----
export function listFiles(name, kind) {
  assertName(name);
  assertKind(kind);
  const dir = kindDir(name, kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .map((f) => {
      try {
        const st = statSync(join(dir, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// 保存上传文件；返回 { name, size }。校验文件名 / 扩展名 / 大小。
export function saveFile(name, kind, filename, buffer) {
  assertName(name);
  assertKind(kind);
  assertFile(filename);
  const ext = extname(filename).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) throw new Error('不支持的文件类型：' + (ext || '(无扩展名)'));
  if (!Buffer.isBuffer(buffer)) throw new Error('文件内容无效');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('文件过大（上限 10MB）');
  ensureDir(name, kind);
  writeFileSync(join(kindDir(name, kind), filename), buffer);
  return { name: filename, size: buffer.length };
}

export function deleteFile(name, kind, filename) {
  assertName(name);
  assertKind(kind);
  assertFile(filename);
  const p = join(kindDir(name, kind), filename);
  if (!existsSync(p)) throw new Error('文件不存在');
  unlinkSync(p);
  return true;
}

// 下载：返回绝对路径（调用方自行流式输出），含存在性校验。
export function filePath(name, kind, filename) {
  assertName(name);
  assertKind(kind);
  assertFile(filename);
  const p = normalize(join(kindDir(name, kind), filename));
  // 二次防线：解析后必须仍落在 kindDir 之内。
  const base = normalize(kindDir(name, kind));
  if (p !== base && !p.startsWith(base + '/')) throw new Error('非法路径');
  if (!existsSync(p)) throw new Error('文件不存在');
  return p;
}

export function fileStream(name, kind, filename) {
  return createReadStream(filePath(name, kind, filename));
}

// 组装某个工具的完整「扩展信息」视图（供列表 / 详情接口）。
export function getSkillExtras(name) {
  return {
    meta: getMeta(name),
    hasMarkdown: hasMarkdown(name),
    files: {
      assets: listFiles(name, 'assets'),
      references: listFiles(name, 'references'),
      scripts: listFiles(name, 'scripts'),
    },
  };
}

// 列出 data/skills/ 下所有合法子目录（含内置与自定义）。
export function listSkillDirs() {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT)
    .filter((n) => {
      try {
        return statSync(join(ROOT, n)).isDirectory() && NAME_RE.test(n);
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b));
}

// 递归删除整个技能目录（用于删除「自定义技能」）；内置工具不可删（由调用方拦截）。
export function deleteSkill(name) {
  assertName(name);
  const p = skillDir(name);
  if (!existsSync(p)) throw new Error('技能不存在');
  rmSync(p, { recursive: true, force: true });
  return true;
}
