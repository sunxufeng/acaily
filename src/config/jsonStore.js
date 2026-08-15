// 轻量 JSON 文件存储：内存缓存 + 按 mtime/size 自动失效。
//
// 解决的问题：此前各 store 用 `let cache = null; load()` 一次性载入、永不失效，
// 导致「外部手工改 JSON 文件（vim / 运维直接 Edit）后，运行中的服务读不到新值」——
// 必须重启进程才能生效。这是一个隐蔽的运维陷阱（例如清理脏数据时改了 providers.json，
// 但页面仍显示旧记录）。
//
// 设计：
//  - persist() 由进程内 API 写入触发，写入后同步刷新 mtime/size 标记，因此不会误判失效；
//  - load() 每次比较文件 mtime + size，外部编辑使二者任一变化 → 自动重新读取；
//  - invalidate() 供测试 / 管理端「放弃外部改动」等场景强制下次重载；
//  - 仍保持「返回缓存对象引用」的语义，调用方对返回对象的就地修改 + persist() 落盘照旧工作。
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export function createJsonStore(storePath, defaultData = {}) {
  let cache = null;
  let mtime = 0;
  let size = 0;

  const fresh = () =>
    typeof defaultData === 'function' ? defaultData() : { ...defaultData };

  function load() {
    try {
      if (!existsSync(storePath)) {
        if (!cache) cache = fresh();
        return cache;
      }
      const st = statSync(storePath);
      // 命中缓存：文件未被外部改动（mtime + size 双重校验）
      if (cache && st.mtimeMs === mtime && st.size === size) return cache;
      cache = JSON.parse(readFileSync(storePath, 'utf8'));
      mtime = st.mtimeMs;
      size = st.size;
    } catch {
      cache = fresh();
      mtime = 0;
      size = 0;
    }
    return cache;
  }

  function persist() {
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, JSON.stringify(cache, null, 2));
    // 同步刷新时间戳标记：避免下一次 load() 把我们刚写的内容误判为「外部改动」而重读
    try {
      const st = statSync(storePath);
      mtime = st.mtimeMs;
      size = st.size;
    } catch {
      mtime = 0;
      size = 0;
    }
  }

  // 强制下次 load() 重新读取磁盘（测试 / 主动放弃缓存）
  function invalidate() {
    cache = null;
    mtime = 0;
    size = 0;
  }

  // 只读拿到当前缓存引用（一般无需；保留以备 Inspector / 调试）
  function peek() {
    return cache;
  }

  return { load, persist, invalidate, peek };
}
