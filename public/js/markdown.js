// 零依赖、轻量 Markdown 渲染（覆盖 Acaily 回复里常见的块级 + 行内语法）。
// 设计原则：先做 HTML 转义，再做受控替换，避免 XSS。
// 行内：**bold**、*italic*、`code`、[text](url) 链接（http/https/根相对/页内锚）。
// 块级：
//       # H1 / ## H2 / ### H3 / #### H4
//       > 引用块（单层，连续 `> ...` 合并）
//       - * 无序列表、 1. 有序列表
//       ```lang ... ``` 围栏代码块（取代段内代码）
//       空行分段、 单换行 → <br>、 相邻段落合并。
// 用法：<script src="/static/js/markdown.js"></script> → window.AcailyMd.mdToHtml(text)

(function (global) {
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[c];
    });
  }

  // 链接白名单：只允许 http(s)、根相对(/)、页内锚(#)；禁掉 javascript/data
  function safeLinkOk(url) {
    if (!url) return false;
    if (/^(javascript|data|vbscript):/i.test(url)) return false;
    return /^(https?:\/\/|\/|#)/i.test(url);
  }

  function mdToHtml(src) {
    if (!src) return '';
    var s = escHtml(String(src));

    // —— 先抽出围栏代码块，存为 token，行级处理时跳过它 ——
    var fenceTokens = [];
    s = s.replace(/```([a-zA-Z0-9_+\-]*)\n([\s\S]*?)```/g, function (_m, lang, code) {
      var idx = fenceTokens.length;
      fenceTokens.push('<pre class="md-code"><code class="lang-' + (lang || '') + '">' + escHtml(code.replace(/\n$/, '')) + '</code></pre>');
      return '\u0000FENCE_' + idx + '\u0000';
    });
    // 若模型用了单行 ``` 也支持一行的写法
    s = s.replace(/```([^\n`].*?)```/g, function (_m, code) {
      var idx = fenceTokens.length;
      fenceTokens.push('<pre class="md-code"><code>' + escHtml(code) + '</code></pre>');
      return '\u0000FENCE_' + idx + '\u0000';
    });

    // —— 行内代码（避免被后面的 ** / * / [ ] 污染）——
    s = s.replace(/`([^`\n]+)`/g, function (_m, c) { return '<code>' + c + '</code>'; });

    // —— 行内链接 [text](url) ——
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (_m, t, u) {
      if (!safeLinkOk(u)) return _m; // 不安全 / 不在白名单的原样返回
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>';
    });

    // —— 加粗 **text** ——
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

    // —— 斜体 *text*（避免吃掉加粗里的 *）——
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

    // —— 块级结构（按行扫描）——
    var lines = s.split('\n');
    var out = [];
    var inList = null; // 'ul' | 'ol' | null
    var para = [];
    var inQuote = null; // 当前是否在 blockquote，最后一行内容

    function flushPara() {
      if (para.length) {
        out.push('<p>' + para.join('<br>') + '</p>');
        para = [];
      }
    }
    function closeList() {
      if (inList) { out.push('</' + inList + '>'); inList = null; }
    }
    function flushQuote() {
      if (inQuote !== null) {
        out.push('<blockquote>' + inQuote.trim() + '</blockquote>');
        inQuote = null;
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // fenced code token 行：原样占位
      var fenceMatch = line.match(/^\u0000FENCE_(\d+)\u0000$/);
      if (fenceMatch) {
        flushPara(); closeList(); flushQuote();
        out.push(fenceTokens[Number(fenceMatch[1])]);
        continue;
      }

      // 标题 # H1 ~ #### H4
      var hMatch = line.match(/^(#{1,4})\s+(.*\S)\s*$/);
      if (hMatch) {
        flushPara(); closeList(); flushQuote();
        var level = hMatch[1].length;
        out.push('<h' + level + '>' + hMatch[2] + '</h' + level + '>');
        continue;
      }

      // 引用块：原始 '>' 已被 escHtml 转成 '&gt;'，两种都识别；
      // > text（支持连续 `>` 行合并；同段内行用 <br>）；取走时把 &gt; 还原为 >。
      var qMatch = line.match(/^(?:>|&gt;)\s?(.*)$/);
      if (qMatch) {
        flushPara(); closeList();
        var qLine = qMatch[1].replace(/^&gt;\s?/, '');
        inQuote = (inQuote === null ? '' : inQuote + '<br>') + qLine;
        continue;
      } else if (inQuote !== null) {
        flushQuote();
      }

      // 列表（无序 / 有序）
      var ul = line.match(/^\s*[-*]\s+(.*)$/);
      var ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ul) {
        flushPara(); flushQuote();
        if (inList !== 'ul') { closeList(); out.push('<ul>'); inList = 'ul'; }
        out.push('<li>' + ul[1] + '</li>');
      } else if (ol) {
        flushPara(); flushQuote();
        if (inList !== 'ol') { closeList(); out.push('<ol>'); inList = 'ol'; }
        out.push('<li>' + ol[1] + '</li>');
      } else if (line.trim() === '') {
        closeList(); flushPara(); flushQuote();
      } else {
        closeList(); flushQuote();
        para.push(line);
      }
    }
    closeList(); flushPara(); flushQuote();
    return out.join('');
  }

  global.AcailyMd = { mdToHtml: mdToHtml, escHtml: escHtml };
})(window);
