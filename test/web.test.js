import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWebPage } from '../src/tools/web.js';

const HTML = `<!DOCTYPE html><html><head><title>测试文章页</title></head><body>
  <nav><ul><li>首页</li><li>关于</li></ul></nav>
  <div class="advert">立即购买限时优惠</div>
  <header><h1>站点头部</h1></header>
  <article>
    <p>这是正文第一段，讲飞书 AI 助手的核心能力。</p>
    <p>这是正文第二段，讲如何配置模型 Provider。</p>
  </article>
  <footer><p>版权所有 © 2026</p></footer>
</body></html>`;

function mockFetchHtml(html, { ok = true, status = 200 } = {}) {
  global.fetch = async () => ({ ok, status, text: async () => html });
}

test('web_read：抓取并抽取正文，去除导航/广告/页脚', async () => {
  mockFetchHtml(HTML);
  const out = await readWebPage({ url: 'https://example.com/article' });
  assert.match(out, /📄 网页：测试文章页/);
  assert.match(out, /这是正文第一段/);
  assert.match(out, /这是正文第二段/);
  assert.doesNotMatch(out, /立即购买限时优惠/); // 广告被去除
  assert.doesNotMatch(out, /首页/); // 导航被去除
  assert.doesNotMatch(out, /版权所有/); // 页脚被去除
});

test('web_read：非法链接返回提示而非报错', async () => {
  const out = await readWebPage({ url: 'not-a-url' });
  assert.match(out, /合法的网页链接/);
});

test('web_read：抓取失败（HTTP 404）返回友好错误', async () => {
  mockFetchHtml('not found', { ok: false, status: 404 });
  const out = await readWebPage({ url: 'https://example.com/missing' });
  assert.match(out, /抓取网页失败/);
});
