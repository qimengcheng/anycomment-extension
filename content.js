// AnyComment 内容脚本：在页面右侧注入评论侧栏（iframe 指向 AnyComment 服务端 /widget）
(() => {
  if (window.top !== window) return; // 只在顶级页面运行

  // 固定服务器地址（不可修改）
  const SERVER = 'https://anycomment.qimengcheng-47e.workers.dev';
  const serverOrigin = safeOrigin(SERVER);

  let host, shadow, fab, badge, panel, iframe, quoteBtn;
  let opened = false;
  let iframeReady = false;
  let pendingQuote = null; // 划线评论：待提交的选中文字和上下文
  // URL 标记 #ac_c=<commentId>：从分享链接跳入时自动展开侧边栏并定位到该评论
  const shareFocusId = getUrlParam('ac_c');

  chrome.storage.local.get({ enabled: true }, (c) => {
    if (!serverOrigin) return;
    const isSelf = location.origin === serverOrigin;
    // 自身页面（manage / 直接打开的widget）只做消息中转，不注入评论侧栏
    if (isSelf) {
      window.addEventListener('message', onMessage);
      return;
    }
    if (!c.enabled) return;
    if (!/^https?:$/i.test(location.protocol)) return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
      mount();
    }
  });

  function safeOrigin(s) {
    try { return new URL(s).origin; } catch { return ''; }
  }

  function pageUrl() {
    return location.href.split('#')[0];
  }

  // 从 URL 查询串/片段读取参数（如 #ac_c=xxx 或 ?ac_c=xxx）
  function getUrlParam(name) {
    const re = new RegExp(`[#&]${name}=([^&]+)`);
    const m = location.href.match(re);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function mount() {
    host = document.createElement('div');
    host.style.cssText = 'all:initial; position:fixed; top:0; right:0; width:0; height:0; z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS_TEXT;

    fab = document.createElement('button');
    fab.className = 'ac-fab';
    fab.title = '打开评论区';
    fab.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3C6.5 3 2 6.9 2 11.7c0 2.1.9 4 2.4 5.5-.2 1.2-.8 2.4-1.9 3.3 2 .2 3.7-.3 5-1.1 1.4.6 2.9.9 4.5.9 5.5 0 10-3.9 10-8.6S17.5 3 12 3z"/>
      </svg><span class="ac-badge" hidden></span>`;

    panel = document.createElement('div');
    panel.className = 'ac-panel';
    iframe = document.createElement('iframe');
    iframe.title = 'AnyComment 评论区';
    iframe.allow = 'clipboard-write';
    panel.appendChild(iframe);

    // 划线评论：选中文字后弹出的浮动评论按钮
    quoteBtn = document.createElement('button');
    quoteBtn.className = 'ac-quote-btn';
    quoteBtn.title = '评论选中文字';
    quoteBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg><span>评论</span>`;
    quoteBtn.style.display = 'none';

    shadow.append(style, fab, panel, quoteBtn);
    document.documentElement.appendChild(host);
    badge = fab.querySelector('.ac-badge');

    fab.addEventListener('click', toggle);
    quoteBtn.addEventListener('click', onQuoteComment);
    document.addEventListener('mouseup', onTextSelect);
    document.addEventListener('mousedown', (e) => {
      // 点击 quoteBtn 时不隐藏按钮（避免点击事件被中断）
      const path = e.composedPath ? e.composedPath() : [];
      if (path.includes(quoteBtn)) return;
      setTimeout(() => { quoteBtn.style.display = 'none'; }, 10);
    });
    window.addEventListener('message', onMessage);
    hookHistory();
    refreshBadge();

    // 检查是否需要自动打开侧边栏（用户设置的网站）
    checkAutoOpen();

    // 页面空闲时预加载 iframe（只加载HTML/JS/CSS，不请求评论数据）
    const preload = () => { if (!iframe.src) iframe.src = SERVER + '/widget'; };
    if ('requestIdleCallback' in window) {
      requestIdleCallback(preload, { timeout: 3000 });
    } else {
      setTimeout(preload, 1500);
    }

    // 分享链接跳入：自动展开侧边栏并定位评论
    if (shareFocusId) {
      // 若页面还没就绪，等待 DOM 后续走挂载流程；已就绪则直接展开
      if (document.readyState !== 'loading') openForShare();
    }
  }

  // 从分享链接进入：确保播放数据就绪后触发展开（依赖 DOMContentLoaded 挂载已完成）
  function openForShare() {
    setTimeout(() => {
      if (!iframe.src) iframe.src = SERVER + '/widget';
      if (!opened) toggle();
    }, 300);
  }

  function toggle() {
    opened = !opened;
    panel.classList.toggle('open', opened);
    fab.classList.toggle('active', opened);
    if (opened) {
      // 兜底：如果空闲回调还没执行，点击时立即加载
      if (!iframe.src) iframe.src = SERVER + '/widget';
      // iframe 已就绪则立即发送页面信息，否则等 AC_READY 后再发
      if (iframeReady) sendPage();
    } else {
      refreshBadge();
    }
  }

  // 划线评论：监听用户选中文字，在选区旁边弹出评论按钮
  function onTextSelect() {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        quoteBtn.style.display = 'none';
        return;
      }
      const text = sel.toString().trim();
      if (!text || text.length < 1) {
        quoteBtn.style.display = 'none';
        return;
      }
      // 限制选中文字长度，避免过长
      if (text.length > 500) {
        quoteBtn.style.display = 'none';
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        quoteBtn.style.display = 'none';
        return;
      }
      // 计算按钮位置：在选区上方居中（fixed 定位相对于视口，不需要 scroll 偏移）
      const btnWidth = 80;
      const btnHeight = 32;
      let left = rect.left + rect.width / 2 - btnWidth / 2;
      let top = rect.top - btnHeight - 8;
      // 防止超出视口
      if (left < 8) left = 8;
      if (left + btnWidth > window.innerWidth - 8) left = window.innerWidth - btnWidth - 8;
      if (top < 8) top = rect.bottom + 8;
      quoteBtn.style.left = left + 'px';
      quoteBtn.style.top = top + 'px';
      quoteBtn.style.display = 'flex';
      // 保存选中的文字和上下文，供点击评论按钮时使用
      pendingQuote = {
        text: text,
        before: getContextBefore(range, 100),
        after: getContextAfter(range, 100),
      };
    }, 10);
  }

  // 获取选区前的上下文文字
  function getContextBefore(range, maxLen) {
    try {
      const container = range.startContainer;
      const text = container.nodeType === Node.TEXT_NODE ? container.textContent : '';
      const before = text ? text.slice(Math.max(0, range.startOffset - maxLen), range.startOffset) : '';
      return before.trim();
    } catch { return ''; }
  }

  // 获取选区后的上下文文字
  function getContextAfter(range, maxLen) {
    try {
      const container = range.endContainer;
      const text = container.nodeType === Node.TEXT_NODE ? container.textContent : '';
      const after = text ? text.slice(range.endOffset, range.endOffset + maxLen) : '';
      return after.trim();
    } catch { return ''; }
  }

  // 划线评论：点击浮动评论按钮，打开侧边栏并发送选中文字给 widget
  function onQuoteComment() {
    if (!pendingQuote) return;
    quoteBtn.style.display = 'none';
    // 打开侧边栏
    if (!opened) toggle();
    // 等待 iframe 就绪后发送划线评论信息
    const sendQuote = () => {
      iframe.contentWindow?.postMessage({
        type: 'AC_QUOTE',
        quote_text: pendingQuote.text,
        quote_before: pendingQuote.before,
        quote_after: pendingQuote.after,
      }, serverOrigin);
    };
    if (iframeReady) {
      sendQuote();
    } else {
      // 等待 AC_READY 后再发送
      const waitReady = (e) => {
        if (e.origin === serverOrigin && e.data?.type === 'AC_READY') {
          window.removeEventListener('message', waitReady);
          setTimeout(sendQuote, 100);
        }
      };
      window.addEventListener('message', waitReady);
    }
    // 清除选区
    window.getSelection()?.removeAllRanges();
    pendingQuote = null;
  }

  // ========== 划线评论第二期：网页文字定位与高亮 ==========

  // 收集页面中所有可见文本节点（跳过 script/style/不可见元素）
  function collectTextNodes(root = document.body) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA' || tag === 'INPUT') return NodeFilter.FILTER_REJECT;
        const style = window.getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  // 规范化空白字符：把换行、制表符、多个空格都换成单个空格，方便匹配
  function normalizeText(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  // 在单个文本节点中查找所有 quote_text 匹配，返回匹配列表
  function findAllInSingleNode(node, quoteText) {
    const matches = [];
    const text = node.textContent;
    const normalized = normalizeText(text);
    const normalizedQuote = normalizeText(quoteText);
    if (!normalizedQuote) return matches;
    let idx = normalized.indexOf(normalizedQuote);
    while (idx !== -1) {
      // 把规范化后的索引映射回原始文本的索引（简化处理：直接用规范化索引，因为大部分情况差异不大）
      matches.push({ node, start: idx, end: idx + normalizedQuote.length, normalized: true });
      idx = normalized.indexOf(normalizedQuote, idx + 1);
    }
    // 如果规范化匹配失败，尝试原始匹配
    if (matches.length === 0) {
      let rawIdx = text.indexOf(quoteText);
      while (rawIdx !== -1) {
        matches.push({ node, start: rawIdx, end: rawIdx + quoteText.length, normalized: false });
        rawIdx = text.indexOf(quoteText, rawIdx + 1);
      }
    }
    return matches;
  }

  // 计算匹配的上下文相似度（0-1，越高越匹配）
  function contextMatchScore(match, before, after) {
    if (!before && !after) return 1;
    const text = match.normalized ? normalizeText(match.node.textContent) : match.node.textContent;
    let score = 0;
    if (before) {
      const matchBefore = text.slice(Math.max(0, match.start - before.length), match.start);
      const normBefore = normalizeText(before);
      // 取末尾部分比较
      const compareLen = Math.min(matchBefore.length, normBefore.length);
      if (compareLen > 0 && matchBefore.slice(-compareLen) === normBefore.slice(-compareLen)) {
        score += 0.5;
      } else if (compareLen > 0) {
        // 部分匹配也给点分
        let common = 0;
        for (let i = 1; i <= compareLen; i++) {
          if (matchBefore.slice(-i) === normBefore.slice(-i)) common = i;
          else break;
        }
        score += 0.5 * (common / compareLen);
      }
    } else {
      score += 0.5;
    }
    if (after) {
      const matchAfter = text.slice(match.end, match.end + after.length);
      const normAfter = normalizeText(after);
      const compareLen = Math.min(matchAfter.length, normAfter.length);
      if (compareLen > 0 && matchAfter.slice(0, compareLen) === normAfter.slice(0, compareLen)) {
        score += 0.5;
      } else if (compareLen > 0) {
        let common = 0;
        for (let i = 1; i <= compareLen; i++) {
          if (matchAfter.slice(0, i) === normAfter.slice(0, i)) common = i;
          else break;
        }
        score += 0.5 * (common / compareLen);
      }
    } else {
      score += 0.5;
    }
    return score;
  }

  // 跨节点查找 quote_text（文字被标签分割的情况）
  function findAcrossNodes(textNodes, quoteText) {
    // 拼接所有文本节点内容，同时记录每个字符对应的节点和偏移
    let fullText = '';
    const charMap = [];
    for (const node of textNodes) {
      const text = node.textContent;
      for (let i = 0; i < text.length; i++) {
        fullText += text[i];
        charMap.push({ node, offset: i });
      }
      // 节点之间加一个空格，避免相邻节点的文字直接连在一起
      fullText += ' ';
      charMap.push({ node, offset: text.length, isGap: true });
    }
    const normalized = normalizeText(fullText);
    const normalizedQuote = normalizeText(quoteText);
    if (!normalizedQuote) return null;
    const idx = normalized.indexOf(normalizedQuote);
    if (idx === -1) return null;
    // 映射回原始字符索引（简化处理，直接用规范化索引）
    const startInfo = charMap[Math.min(idx, charMap.length - 1)];
    const endInfo = charMap[Math.min(idx + normalizedQuote.length - 1, charMap.length - 1)];
    if (!startInfo || !endInfo || startInfo.isGap || endInfo.isGap) return null;
    return {
      startNode: startInfo.node,
      startOffset: startInfo.offset,
      endNode: endInfo.node,
      endOffset: endInfo.offset + 1,
    };
  }

  // 在页面中查找 quote 对应的 Range，返回 Range 或 null
  function findQuoteRange(quote) {
    const quoteText = quote.quote_text;
    const before = quote.quote_before || null;
    const after = quote.quote_after || null;
    if (!quoteText) return null;

    const textNodes = collectTextNodes();
    if (textNodes.length === 0) return null;

    // 收集所有单节点匹配
    const allMatches = [];
    for (const node of textNodes) {
      const matches = findAllInSingleNode(node, quoteText);
      for (const m of matches) {
        allMatches.push({ ...m, score: contextMatchScore(m, before, after) });
      }
    }

    // 按上下文相似度排序，取最高的
    if (allMatches.length > 0) {
      allMatches.sort((a, b) => b.score - a.score);
      const best = allMatches[0];
      const range = document.createRange();
      if (best.normalized) {
        // 规范化匹配：尝试在原始文本中找到对应位置（简化处理，直接用规范化索引）
        range.setStart(best.node, Math.min(best.start, best.node.textContent.length));
        range.setEnd(best.node, Math.min(best.end, best.node.textContent.length));
      } else {
        range.setStart(best.node, best.start);
        range.setEnd(best.node, best.end);
      }
      return range;
    }

    // 单节点找不到，尝试跨节点查找
    const across = findAcrossNodes(textNodes, quoteText);
    if (across) {
      const range = document.createRange();
      try {
        range.setStart(across.startNode, across.startOffset);
        range.setEnd(across.endNode, across.endOffset);
        return range;
      } catch (e) {
        return null;
      }
    }

    return null;
  }

  // 高亮 Range 对应的文字，用 mark 标签包裹，返回创建的 mark 元素
  function highlightRange(range, commentId = null) {
    if (!range || range.collapsed) return null;
    try {
      const mark = document.createElement('mark');
      mark.className = 'ac-quote-highlight';
      if (commentId) mark.dataset.commentId = commentId;
      mark.style.cssText = 'background: #fff3a8; color: inherit; padding: 1px 0; border-radius: 2px; cursor: pointer;';
      range.surroundContents(mark);
      return mark;
    } catch (e) {
      // surroundContents 在跨节点时可能失败，用 extractContents + insertNode 替代
      try {
        const mark = document.createElement('mark');
        mark.className = 'ac-quote-highlight';
        if (commentId) mark.dataset.commentId = commentId;
        mark.style.cssText = 'background: #fff3a8; color: inherit; padding: 1px 0; border-radius: 2px; cursor: pointer;';
        const contents = range.extractContents();
        mark.appendChild(contents);
        range.insertNode(mark);
        return mark;
      } catch (e2) {
        return null;
      }
    }
  }

  // 滚动到 Range 对应的位置，居中显示
  function scrollToRange(range) {
    if (!range) return;
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    const targetY = rect.top + window.scrollY - window.innerHeight / 2 + rect.height / 2;
    window.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
  }

  // 划线评论第二期：点击评论引用，在网页中定位并高亮对应的划线文字
  function focusQuoteInPage(quote) {
    // 先清除之前的定位高亮（保留自动高亮的）
    document.querySelectorAll('.ac-quote-focus').forEach((el) => {
      const parent = el.parentNode;
      if (parent) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
      }
    });
    const range = findQuoteRange(quote);
    if (!range) {
      // 找不到时用 Toast 提示
      showExtToast('未在页面中找到对应的划线文字');
      return;
    }
    const mark = highlightRange(range, quote.comment_id || null);
    if (mark) {
      mark.classList.add('ac-quote-focus');
      mark.style.background = '#ffd54f';
      mark.style.boxShadow = '0 0 0 2px #ffb300';
      // 3 秒后恢复普通高亮样式
      setTimeout(() => {
        if (mark.parentNode) {
          mark.style.background = '#fff3a8';
          mark.style.boxShadow = 'none';
          mark.classList.remove('ac-quote-focus');
        }
      }, 3000);
    }
    scrollToRange(range);
  }

  // 划线评论第二期：页面加载后自动高亮所有划线评论的引用文字
  function highlightAllQuotes(quotes) {
    if (!Array.isArray(quotes) || quotes.length === 0) return;
    // 延迟执行，确保页面内容已渲染完成
    setTimeout(() => {
      for (const quote of quotes) {
        if (!quote.quote_text) continue;
        const range = findQuoteRange(quote);
        if (range) {
          highlightRange(range, quote.comment_id || null);
        }
      }
    }, 500);
  }

  // 扩展内的简易 Toast 提示（不依赖 widget）
  function showExtToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.8);color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;z-index:2147483647;font-family:system-ui,sans-serif;';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  }

  // 检查当前网站是否在用户的自动打开列表中，是则自动展开侧边栏
  function checkAutoOpen() {
    chrome.storage.local.get({ ac_token: '' }, (r) => {
      if (!r.ac_token) return; // 未登录不自动打开
      const currentDomain = location.host.toLowerCase();
      fetch(SERVER + '/api/me/auto-open-sites', {
        headers: { 'Authorization': 'Bearer ' + r.ac_token },
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!data || !Array.isArray(data.sites)) return;
          // 子域名也匹配：存 google.com 时 www.google.com / docs.google.com 都命中（精确相等或 .domain 结尾）
          const match = data.sites.some((s) => {
            if (!s.site_domain || s.enabled === false) return false;
            const d = s.site_domain.toLowerCase();
            return currentDomain === d || currentDomain.endsWith('.' + d);
          });
          if (match) {
            // 延迟一点打开，确保 iframe 预加载完成
            setTimeout(() => { if (!opened) toggle(); }, 500);
          }
        })
        .catch(() => { /* 静默失败 */ });
    });
  }

  function sendPage() {
    if (!iframe || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage(
      { type: 'AC_PAGE', url: pageUrl(), title: document.title, site: location.host, focus_comment_id: shareFocusId || null },
      serverOrigin,
    );
  }

  function onMessage(e) {
    if (e.origin !== serverOrigin) return;
    const d = e.data || {};
    if (d.type === 'AC_READY') {
      iframeReady = true;
      // 只有评论区已打开时才发送页面信息（避免预加载时就请求评论数据）
      if (opened) sendPage();
    } else if (d.type === 'AC_CLOSE') {
      opened = false;
      panel.classList.remove('open');
      fab.classList.remove('active');
      refreshBadge();
    } else if (d.type === 'AC_OPEN_URL' && typeof d.url === 'string') {
      // 从 widget 分享通知打开分享页面（新标签）
      window.open(d.url, '_blank', 'noopener');
    } else if (d.type === 'AC_COUNT' && typeof d.count === 'number') {
      setBadge(d.count);
    } else if (d.type === 'AC_TOKEN_GET') {
      // iframe/页面请求扩展存储的登录token
      chrome.storage.local.get({ ac_token: '', ac_user: null }, (r) => {
        e.source?.postMessage({ type: 'AC_TOKEN_RESULT', token: r.ac_token, user: r.ac_user }, serverOrigin);
      });
    } else if (d.type === 'AC_TOKEN_SET' && typeof d.token === 'string') {
      // iframe/页面登录成功，把token存到扩展存储（跨站点共享）
      chrome.storage.local.set({ ac_token: d.token, ac_user: d.user || null });
    } else if (d.type === 'AC_USER_UPDATE' && typeof d.user === 'object' && d.user) {
      // iframe/页面改名等更新了用户信息，同步扩展存储里的用户快照，避免刷新后回退旧名
      chrome.storage.local.set({ ac_user: d.user });
    } else if (d.type === 'AC_TOKEN_CLEAR') {
      // 退出登录，清除扩展存储的token
      chrome.storage.local.remove(['ac_token', 'ac_user']);
    } else if (d.type === 'AC_QUOTE_FOCUS' && d.quote_text) {
      // 划线评论第二期：点击评论引用，在网页中定位并高亮对应的划线文字
      focusQuoteInPage(d);
    } else if (d.type === 'AC_QUOTE_HIGHLIGHT_ALL' && Array.isArray(d.quotes)) {
      // 划线评论第二期：页面加载后自动高亮所有划线评论的引用文字
      highlightAllQuotes(d.quotes);
    }
  }

  function refreshBadge() {
    fetch(SERVER + '/api/comments/count?page_url=' + encodeURIComponent(pageUrl()))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && typeof d.count === 'number') setBadge(d.count); })
      .catch(() => { /* 页面 CSP 可能拦截跨域请求，静默降级 */ });
  }

  function setBadge(n) {
    badge.hidden = !(n > 0);
    badge.textContent = n > 99 ? '99+' : String(n);
  }

  // SPA 路由变化时同步页面信息
  function hookHistory() {
    const fire = () => setTimeout(() => (opened ? sendPage() : refreshBadge()), 100);
    for (const m of ['pushState', 'replaceState']) {
      const orig = history[m].bind(history);
      history[m] = (...args) => {
        orig(...args);
        fire();
      };
    }
    window.addEventListener('popstate', fire);
  }

  const CSS_TEXT = `
    :host { all: initial; }
    .ac-fab {
      position: absolute; top: 50%; right: 8px; transform: translateY(-50%);
      width: 42px; height: 42px; border-radius: 50%; border: none; cursor: pointer;
      background: #4f6ef7; color: #fff; box-shadow: 0 4px 16px rgba(31,36,48,.25);
      display: flex; align-items: center; justify-content: center;
      transition: right .22s ease, transform .15s ease;
    }
    .ac-fab:hover { transform: translateY(-50%) scale(1.06); }
    .ac-fab.active { right: 412px; }
    .ac-fab svg { width: 21px; height: 21px; fill: #fff; }
    .ac-badge {
      position: absolute; top: -4px; left: -4px; min-width: 18px; height: 18px;
      padding: 0 4px; border-radius: 9px; background: #ff4d5e; color: #fff;
      font: 600 11px/18px system-ui, sans-serif; text-align: center;
    }
    .ac-panel {
      position: absolute; top: 0; right: 0; height: 100vh; width: 400px; max-width: 92vw;
      background: #fff; box-shadow: -8px 0 28px rgba(31,36,48,.14);
      transform: translateX(110%); transition: transform .25s ease;
    }
    .ac-panel.open { transform: translateX(0); }
    .ac-panel iframe { width: 100%; height: 100%; border: none; display: block; }
    .ac-quote-btn {
      position: fixed; z-index: 2147483647;
      display: flex; align-items: center; gap: 4px;
      padding: 6px 12px; border-radius: 16px; border: none; cursor: pointer;
      background: #4f6ef7; color: #fff; font: 600 12px/1 system-ui, sans-serif;
      box-shadow: 0 4px 12px rgba(31,36,48,.25);
      transition: transform .15s ease, box-shadow .15s ease;
    }
    .ac-quote-btn:hover { transform: scale(1.05); box-shadow: 0 6px 16px rgba(31,36,48,.3); }
    .ac-quote-btn svg { width: 14px; height: 14px; fill: #fff; }
  `;
})();
