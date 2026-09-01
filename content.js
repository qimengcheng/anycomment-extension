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
          const match = data.sites.some((s) => s.site_domain && s.enabled !== false && currentDomain === s.site_domain.toLowerCase());
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
