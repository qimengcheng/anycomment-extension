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

    // 划线工具条：选中文字后弹出的"评论 / 分享划线"按钮组
    quoteBtn = document.createElement('div');
    quoteBtn.className = 'ac-quote-btn';
    quoteBtn.innerHTML = `<button class="ac-qb" data-act="comment" title="评论选中文字"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg><span>评论</span></button><button class="ac-qb ac-qb-share" data-act="share" title="分享划线，生成金句卡片图片"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg><span>分享</span></button>`;
    quoteBtn.style.display = 'none';

    shadow.append(style, fab, panel, quoteBtn);
    document.documentElement.appendChild(host);
    badge = fab.querySelector('.ac-badge');

    fab.addEventListener('click', toggle);
    quoteBtn.addEventListener('click', (e) => {
      const act = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (!act) return;
      if (act.dataset.act === 'share') onQuoteShare();
      else onQuoteComment();
    });
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
    // 拉取本页被划线分享过的文字，标蓝色虚线
    refreshShareMarks();

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
      const btnWidth = 152;
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

  // ========== 划线分享：生成公众号风格金句卡片图片 ==========

  // 按最大宽度对文本做换行拆分（逐字测量，兼容中英文混排）
  function wrapText(ctx, text, maxWidth, maxLines) {
    const lines = [];
    let line = '';
    for (const ch of text) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = ch;
        if (lines.length >= maxLines) { lines[maxLines - 1] = lines[maxLines - 1].replace(/\s+$/, '') + '…'; return lines; }
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  // 生成网址二维码：库内部读取的是模块级 qrcode.stringToBytes（挂在实例上无效），
  // UTF-8 才能正确编码中文路径；网址过长时降低纠错率以控制二维码尺寸
  function buildQrMatrix(url) {
    if (!url || typeof qrcode !== 'function' || !qrcode.stringToBytesFuncs) return null;
    try {
      qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
      let qr = null;
      for (const ecl of ['M', 'L']) {
        qr = qrcode(0, ecl); // typeNumber 0 = 自动选尺寸
        qr.addData(String(url), 'Byte');
        qr.make();
        if (qr.getModuleCount() <= 45) return qr;
      }
      return null; // 仍过大则不画，降级为日期
    } catch (e) {
      return null;
    }
  }

  // 用 Canvas 绘制金句卡片，返回 dataURL(2x)
  function drawShareCard({ text, title, site, url }) {
    const W = 720, PAD = 56, DPR = 2;
    const fontMain = (size, weight = 600) => `${weight} ${size}px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;
    // 先用离屏 canvas 测量文字行数
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = fontMain(30);
    const lines = wrapText(meas, text, W - PAD * 2, 10);
    const lineH = 48;
    const quoteTop = 150;
    const dividerY = quoteTop + lines.length * lineH + 4; // 出处区上方的分隔线

    // 二维码模块边长取整像素（半格会糊出灰边，手机识别率骤降），静默区 2 模块
    const qr = buildQrMatrix(url);
    const QR_QUIET = 2;
    const qrCount = qr ? qr.getModuleCount() : 0;
    const qrTotal = qrCount + QR_QUIET * 2;
    const qrCell = qr ? Math.max(3, Math.min(4, Math.floor(104 / qrTotal))) : 0;
    const qrPx = qrCell * qrTotal;
    const qrTop = dividerY + 14;
    const qrLeft = W - PAD - qrPx;
    const hintY = qrTop + qrPx + 17;
    const srcTitleY = dividerY + 18;
    const srcDomainY = dividerY + 44;
    const H = dividerY + (qr ? Math.max(64, hintY - dividerY + 9) : 64) + 34; // 卡片底边 = H - 28

    const canvas = document.createElement('canvas');
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    const ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);

    // 渐变底 + 装饰圆
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#eef3ff');
    bg.addColorStop(1, '#f9fbff');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(79,110,247,0.08)';
    ctx.beginPath(); ctx.arc(W - 40, 40, 130, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(47,107,255,0.06)';
    ctx.beginPath(); ctx.arc(30, H - 30, 100, 0, Math.PI * 2); ctx.fill();

    // 白色圆角卡片
    const cx = 28, cy = 28, cw = W - 56, ch = H - 56, r = 20;
    ctx.save();
    ctx.shadowColor = 'rgba(31,36,48,0.10)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(cx + r, cy);
    ctx.arcTo(cx + cw, cy, cx + cw, cy + ch, r);
    ctx.arcTo(cx + cw, cy + ch, cx, cy + ch, r);
    ctx.arcTo(cx, cy + ch, cx, cy, r);
    ctx.arcTo(cx, cy, cx + cw, cy, r);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 顶部品牌条：蓝点 + AnyComment 划线分享
    ctx.fillStyle = '#2f6bff';
    ctx.beginPath(); ctx.arc(cx + 30, cy + 44, 7, 0, Math.PI * 2); ctx.fill();
    ctx.font = fontMain(15, 500);
    ctx.fillStyle = '#8a90a5';
    ctx.textBaseline = 'middle';
    ctx.fillText('AnyComment · 划线分享', cx + 46, cy + 45);

    // 大引号
    ctx.font = `700 64px Georgia, "Times New Roman", serif`;
    ctx.fillStyle = 'rgba(47,107,255,0.18)';
    ctx.fillText('“', PAD - 8, quoteTop - 22);

    // 引用文字
    ctx.font = fontMain(30, 600);
    ctx.fillStyle = '#1f2430';
    ctx.textBaseline = 'top';
    lines.forEach((ln, i) => ctx.fillText(ln, PAD, quoteTop + i * lineH - 20));

    // 出处：页面标题 + 站点（右侧留给二维码）
    ctx.strokeStyle = '#eceef4';
    ctx.beginPath(); ctx.moveTo(PAD, dividerY); ctx.lineTo(W - PAD, dividerY); ctx.stroke();
    ctx.font = fontMain(17, 500);
    ctx.fillStyle = '#4b5563';
    // 前缀也要计入测量，否则长标题会钻到二维码底下
    const srcText = `—— ${title || site || ''}`;
    ctx.fillText(wrapText(ctx, srcText, (qr ? qrLeft - PAD : W - PAD * 2) - 20, 1)[0] || '', PAD, srcTitleY);
    ctx.font = fontMain(14, 400);
    ctx.fillStyle = '#a5abc0';
    const domain = (site || '').replace(/^www\./, '');
    ctx.fillText(wrapText(ctx, domain, (qr ? qrLeft - PAD : W - PAD * 2) - 20, 1)[0] || '', PAD, srcDomainY);

    if (qr) {
      // 二维码白底（含静默区）+ 整像素模块
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(31,36,48,0.10)';
      ctx.shadowBlur = 12;
      ctx.fillRect(qrLeft - 8, qrTop - 8, qrPx + 16, qrPx + 16);
      ctx.restore();
      ctx.fillStyle = '#1f2430';
      for (let r = 0; r < qrCount; r++) {
        for (let c = 0; c < qrCount; c++) {
          if (qr.isDark(r, c)) ctx.fillRect(qrLeft + (c + QR_QUIET) * qrCell, qrTop + (r + QR_QUIET) * qrCell, qrCell, qrCell);
        }
      }
      ctx.textBaseline = 'alphabetic';
      ctx.font = fontMain(13, 400);
      ctx.fillStyle = '#a5abc0';
      const hint = '扫码阅读原文';
      ctx.fillText(hint, qrLeft + (qrPx - ctx.measureText(hint).width) / 2, hintY);
    } else {
      const d = new Date();
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      ctx.font = fontMain(13, 400);
      ctx.fillStyle = '#a5abc0';
      ctx.fillText(ds, W - PAD - ctx.measureText(ds).width, srcDomainY);
    }

    return canvas.toDataURL('image/png');
  }

  // 划线分享：生成卡片 + 预览浮层（下载/复制），登录态下记录并即时标虚线
  function onQuoteShare() {
    if (!pendingQuote) return;
    const q = pendingQuote;
    quoteBtn.style.display = 'none';
    window.getSelection()?.removeAllRanges();
    pendingQuote = null;
    try {
      const dataUrl = drawShareCard({ text: q.text, title: document.title, site: location.host, url: pageUrl() });
      showSharePreview(dataUrl, q);
      recordQuoteShare(q); // 记录划线（登录态），并即时给页面加虚线
    } catch (e) {
      showExtToast('生成分享卡片失败');
    }
  }

  function showSharePreview(dataUrl, q) {
    // 单例预览层
    shadow.querySelector('.ac-share-mask')?.remove();
    const mask = document.createElement('div');
    mask.className = 'ac-share-mask';
    const box = document.createElement('div');
    box.className = 'ac-share-card-box';
    const img = document.createElement('img');
    img.className = 'ac-share-img';
    img.src = dataUrl;
    img.alt = '划线分享卡片预览';
    const acts = document.createElement('div');
    acts.className = 'ac-share-actions';
    const btnDl = document.createElement('button');
    btnDl.className = 'ac-share-btn ac-share-primary';
    btnDl.textContent = '下载图片';
    btnDl.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `anycomment-quote-${Date.now()}.png`;
      a.click();
    });
    const btnCopy = document.createElement('button');
    btnCopy.className = 'ac-share-btn ac-share-ghost';
    btnCopy.textContent = '复制图片';
    btnCopy.addEventListener('click', async () => {
      try {
        // dataURL → Blob（content script 里 fetch(data:) 在部分环境被禁，手动解码更稳）
        const b64 = dataUrl.split(',')[1];
        const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
        btnCopy.textContent = '已复制 ✓';
      } catch {
        btnCopy.textContent = '复制失败，请下载';
      }
    });
    const btnClose = document.createElement('button');
    btnClose.className = 'ac-share-btn ac-share-close';
    btnClose.textContent = '关闭';
    btnClose.addEventListener('click', () => mask.remove());
    acts.append(btnDl, btnCopy, btnClose);
    box.append(img, acts);
    mask.append(box);
    mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
    shadow.appendChild(mask);
  }

  // 记录划线分享到服务端（登录态），成功后给本页文字加虚线
  function recordQuoteShare(q) {
    chrome.storage.local.get({ ac_token: '' }, (r) => {
      if (!r.ac_token) {
        showExtToast('登录后可让划线虚线同步给其他访客');
        return;
      }
      fetch(SERVER + '/api/quote-shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + r.ac_token },
        body: JSON.stringify({
          page_url: pageUrl(),
          page_title: document.title || null,
          quote_text: q.text,
          quote_before: q.before || null,
          quote_after: q.after || null,
        }),
      }).then((res) => {
        if (res.ok) paintShareQuote(q);
      }).catch(() => { /* 静默：不影响卡片生成 */ });
    });
  }

  // 移除页面中全部"分享划线"虚线标记（解包恢复原 DOM）
  function clearShareMarks() {
    document.querySelectorAll('mark.ac-share-highlight').forEach((el) => {
      const parent = el.parentNode;
      if (parent) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
      }
    });
  }

  // 给单条划线记录文字加虚线（findQuoteRange 复用评论定位算法）
  function paintShareQuote(q) {
    const range = findQuoteRange({ quote_text: q.text, quote_before: q.before, quote_after: q.after });
    if (!range) return false;
    const mark = highlightRange(range, null, 'share');
    if (mark) mark.classList.add('ac-share-highlight');
    return !!mark;
  }

  // 页面加载/路由变化时，拉取本页被分享过的划线并批量标虚线
  function refreshShareMarks() {
    fetch(SERVER + '/api/quote-shares?page_url=' + encodeURIComponent(pageUrl()))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || !Array.isArray(d.shares)) return;
        clearShareMarks();
        setTimeout(() => {
          for (const s of d.shares) {
            if (!s.quote_text) continue;
            paintShareQuote({ text: s.quote_text, before: s.quote_before, after: s.quote_after });
          }
        }, 300);
      })
      .catch(() => { /* CSP 拦截等场景静默降级 */ });
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
  // kind: 'comment'（划线评论，蓝色实线下划线）| 'share'（划线分享，蓝色虚线下划线）
  function markStyle(kind) {
    if (kind === 'share') return 'background: transparent; color: inherit; border-bottom: 2px dashed #2f6bff; cursor: pointer;';
    return 'background: transparent; color: inherit; border-bottom: 2px solid #2f6bff; cursor: pointer;';
  }
  function highlightRange(range, commentId = null, kind = 'comment') {
    if (!range || range.collapsed) return null;
    const css = markStyle(kind);
    try {
      const mark = document.createElement('mark');
      mark.className = 'ac-quote-highlight';
      if (commentId) mark.dataset.commentId = commentId;
      mark.style.cssText = css;
      range.surroundContents(mark);
      return mark;
    } catch (e) {
      // surroundContents 在跨节点时可能失败，用 extractContents + insertNode 替代
      try {
        const mark = document.createElement('mark');
        mark.className = 'ac-quote-highlight';
        if (commentId) mark.dataset.commentId = commentId;
        mark.style.cssText = css;
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
      mark.style.borderBottom = '2px solid #1d4ed8';
      mark.style.background = 'rgba(47,107,255,0.10)';
      // 3 秒后恢复普通划线样式
      setTimeout(() => {
        if (mark.parentNode) {
          mark.style.borderBottom = '2px solid #2f6bff';
          mark.style.background = 'transparent';
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
    const fire = () => setTimeout(() => {
      if (opened) sendPage(); else refreshBadge();
      refreshShareMarks(); // 换页后重新标记本页被分享过的划线
    }, 100);
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
      display: flex; align-items: center; gap: 6px;
    }
    .ac-qb {
      display: flex; align-items: center; gap: 4px;
      padding: 6px 12px; border-radius: 16px; border: none; cursor: pointer;
      background: #4f6ef7; color: #fff; font: 600 12px/1 system-ui, sans-serif;
      box-shadow: 0 4px 12px rgba(31,36,48,.25);
      transition: transform .15s ease, box-shadow .15s ease;
    }
    .ac-qb:hover { transform: scale(1.05); box-shadow: 0 6px 16px rgba(31,36,48,.3); }
    .ac-qb svg { width: 14px; height: 14px; fill: #fff; }
    .ac-qb-share { background: #10a37f; }
    .ac-share-mask {
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(15,18,28,.55);
      display: flex; align-items: center; justify-content: center;
      font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .ac-share-card-box {
      background: #fff; border-radius: 14px; padding: 16px;
      box-shadow: 0 12px 40px rgba(0,0,0,.35);
      display: flex; flex-direction: column; gap: 12px; align-items: center;
      max-width: 92vw;
    }
    .ac-share-img { max-height: 62vh; max-width: 100%; border-radius: 8px; border: 1px solid #eceef4; }
    .ac-share-actions { display: flex; gap: 10px; }
    .ac-share-btn {
      padding: 8px 18px; border-radius: 8px; border: none; cursor: pointer;
      font: 600 13px/1 system-ui, sans-serif;
    }
    .ac-share-primary { background: #4f6ef7; color: #fff; }
    .ac-share-ghost { background: #eef1fb; color: #4f6ef7; }
    .ac-share-close { background: #f3f4f6; color: #6b7280; }
  `;
})();
