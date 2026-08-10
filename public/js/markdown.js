// 零依赖、轻量 Markdown 渲染（只覆盖 Acaily 回复里常见语法）。
// 设计原则：先做 HTML 转义，再做受控替换，避免 XSS。
// 支持：**bold**、*italic*、`code`、 [text](url) 链接（http/https/相对/#）、
//       -/* 无序列表、 1. 有序列表、 空行分段、 单换行 → <br>。
// 不支持：标题（# / ##）—— 系统提示里已禁止模型使用。
// 不支持：图片、表格、引用、水平线、脚注——避免误解析与安全风险。
// 用法：<script src="/static/js/markdown.js"></script> → window.AcailyMd.mdToHtml(text)

(function (global) {
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
  }

  // 链接白名单：只允许 http(s)、根相对(/)、页内锚(#)
  function safeLink(url) {
    if (!url) return null;
    if (/^(https?:\/\/|\/|#)/i.test(url)) return url;
    return null;
  }

  function mdToHtml(src) {
    if (!src) return '';
    let s = escHtml(src);

    // 1) 行内代码：先处理，避免被后续 ** / * 替换污染
    s = s.replace(/`([^`\n]+)`/g, (_, c) => '<code>' + c + '</code>');

    // 2) 链接 [text](url)
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (_m, t, u) {
      var safe = safeLink(u);
      if (!safe) return _m;
      return '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + t + '</a>';
    });

    // 3) 加粗 **text**
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

    // 4) 斜体 *text*（避免吃掉加粗里残留的 *）
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

    // 5) 块级结构（按行扫描）
    var lines = s.split('\n');
    var out = [];
    var inList = null; // 'ul' | 'ol' | null
    var para = [];

    var flushPara = function () {
      if (para.length) {
        out.push('<p>' + para.join('<br>') + '</p>');
        para = [];
      }
    };
    var closeList = function () {
      if (inList) { out.push('</' + inList + '>'); inList = null; }
    };

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var ul = line.match(/^\s*[-*]\s+(.*)$/);
      var ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ul) {
        flushPara();
        if (inList !== 'ul') { closeList(); out.push('<ul>'); inList = 'ul'; }
        out.push('<li>' + ul[1] + '</li>');
      } else if (ol) {
        flushPara();
        if (inList !== 'ol') { closeList(); out.push('<ol>'); inList = 'ol'; }
        out.push('<li>' + ol[1] + '</li>');
      } else if (line.trim() === '') {
        closeList(); flushPara();
      } else {
        closeList();
        para.push(line);
      }
    }
    closeList();
    flushPara();
    return out.join('');
  }

  global.AcailyMd = { mdToHtml: mdToHtml, escHtml: escHtml };
})(window);