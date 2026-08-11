// 实时信息工具：天气（open-meteo，无需 API Key）+ 联网搜索（Sogou 网页抓取）
// 这两个工具让 Acaily 能回答天气、新闻、股价、最新事件等实时问题。

const WMO = {
  0: '晴', 1: '大致晴朗', 2: '部分多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
  56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '强阵雨', 82: '暴雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨伴冰雹',
};

async function fetchJson(url, timeoutMs = 10000, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1000));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

// 查询城市天气与未来几天预报
export async function getWeather({ city, days = 2 } = {}) {
  if (!city) return '请提供城市名，例如：TOOL: get_weather({"city":"上海"})';
  const d = Math.max(1, Math.min(7, Number(days) || 2));
  try {
    const geo = await fetchJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`
    );
    if (!geo.results || !geo.results.length) return `未找到城市：${city}`;
    const r = geo.results[0];
    const fc = await fetchJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${r.latitude}&longitude=${r.longitude}` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
        `&timezone=${encodeURIComponent(r.timezone || 'auto')}&forecast_days=${d}`
    );
    const dd = fc.daily;
    if (!dd || !dd.time) return `获取 ${r.name} 天气失败`;
    let out = `📍 ${r.name}（${r.country_code || '—'}）未来${dd.time.length}天天气：\n`;
    for (let i = 0; i < dd.time.length; i++) {
      out +=
        `\n${dd.time[i]}：${WMO[dd.weather_code[i]] || '未知'}，` +
        `${dd.temperature_2m_min[i]}~${dd.temperature_2m_max[i]}°C，` +
        `降水概率 ${dd.precipitation_probability_max?.[i] ?? '—'}%`;
    }
    return out;
  } catch (e) {
    return `天气查询失败：${e.message}`;
  }
}

// 联网搜索（Sogou 网页结果抓取，服务器侧直连）
export async function webSearch({ query, top = 5 } = {}) {
  if (!query) return '请提供搜索关键词';
  const url = 'https://www.sogou.com/web?query=' + encodeURIComponent(query);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  let html;
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    html = await res.text();
  } catch (e) {
    return `联网搜索失败（网络不可用）：${e.message}`;
  } finally {
    clearTimeout(t);
  }

  const results = [];
  const h3re = /<h3 class="vr-title"[^>]*>([\s\S]*?)<\/h3>/g;
  let m;
  while ((m = h3re.exec(html)) !== null && results.length < top) {
    const title = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/<!--[^>]*-->/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) continue;
    const after = html.slice(m.index);
    const snip = after.match(
      /<(div|p)[^>]*class="[^"]*(text-layout|space-txt|fz-mid)[^"]*"[^>]*>([\s\S]*?)<\/\1>/
    );
    let snippet = snip
      ? snip[3].replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim()
      : '';
    if (snippet.length > 160) snippet = snippet.slice(0, 160) + '…';
    results.push(`- ${title}${snippet ? '：' + snippet : ''}`);
  }

  if (!results.length) return `未找到关于「${query}」的搜索结果（搜索服务暂不可用）。`;
  return `关于「${query}」的搜索结果：\n` + results.join('\n');
}

// 读取并提取网页正文（移植自 acplugin 的 Readability「总结/问当前页」能力：
// 抓链接 → 去脚本/导航/广告 → 抽取干净正文 → 交给模型总结/翻译/问答）
export async function readWebPage({ url, maxChars = 12000 } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return '请提供合法的网页链接（以 http(s):// 开头），例如：TOOL: web_read({"url":"https://example.com/article"})';
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  let html;
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) return `抓取网页失败：HTTP ${res.status} (${url})`;
    html = await res.text();
  } catch (e) {
    return `抓取网页失败（网络不可用或链接无效）：${e.message}`;
  } finally {
    clearTimeout(t);
  }

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? titleMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    : '';
  let text = extractMainText(html);
  if (!text) text = '（未能从页面提取到正文，可能是需要登录的页面或纯脚本渲染的站点）';
  const n = Math.max(500, Number(maxChars) || 12000);
  const clipped = text.length > n ? text.slice(0, n) + '…（正文已截断）' : text;
  return (
    `📄 网页：${title || url}\n链接：${url}\n\n` +
    `正文内容如下，请基于它来总结 / 翻译 / 回答，不要编造：\n\n${clipped}`
  );
}

// 依赖免费的「轻量 Readability」：去脚本/样式/噪音区块，抽取 body 文本并压缩空白。
function extractMainText(html) {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  // 移除导航/页脚/侧栏/表单等整块
  cleaned = cleaned.replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ');
  // 移除带噪音语义 class/id 的标签块（正确捕获完整标签名用于闭合回溯）
  cleaned = cleaned.replace(
    /<([a-z][a-z0-9]*)[^>]*(?:class|id)="[^"]*(?:sidebar|menu|nav|footer|header|advert|banner|comment|popup|cookie|share|recommend|related)[\s\S]*?<\/\1>/gi,
    ' '
  );
  const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : cleaned;
  let text = body
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&[a-z]+;/gi, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

// 导出为 Acaily AgentRuntime 工具定义
export const webTools = [
  {
    name: 'get_weather',
    description:
      '查询指定城市的天气与未来几天预报（气温、天气状况、降水概率）。参数：{"city":"城市名（中文或英文）","days":天数(1-7，默认2)}。用于回答天气、气温、是否下雨下雪、出行建议等。',
    run: getWeather,
  },
  {
    name: 'web_search',
    description:
      '联网搜索实时信息（新闻、股价、赛事、最新事件、可能过期的事实等）。参数：{"query":"搜索关键词","top":返回条数(默认5)}。当问题涉及实时或可能变化的信息时优先使用，不要凭记忆编造。',
    run: webSearch,
  },
  {
    name: 'web_read',
    description:
      '读取并提取指定网页链接的正文内容（自动去除脚本/导航/广告，保留文章主体），用于总结、翻译或问答该网页。参数：{"url":"网页链接(以 http(s):// 开头)","maxChars":最大抽取字数(默认12000)}。当用户发来一个链接并希望总结/翻译/解读该页面时使用，不要自己编造内容。',
    run: readWebPage,
  },
];
