// AnyComment 内容脚本：在页面右侧注入评论侧栏（iframe 指向 AnyComment 服务端 /widget）
(() => {
  if (window.top !== window) return; // 只在顶级页面运行

  // 固定服务器地址（不可修改）
  const SERVER = 'https://anycomment.qimengcheng-47e.workers.dev';
  const serverOrigin = safeOrigin(SERVER);
  const card = globalThis.__acCard; // 绘制与预览原语见 card.js（同一隔离世界，manifest 先加载）

  // 节日/节气背景开关 + 纪念日背景开关 + 无命中兜底风格：模块级镜像读取（与 capture.js 同模式），
  // 生成卡片的点击链路保持同步，不在点击后临时查 storage —— showPreview 的自动复制依赖 user gesture 不能等回调
  let festiveBg = true;
  let memorialBg = false;
  let defaultTheme = '';
  let glassMode = false;
  let glassBlur = 5;
  let glassAlpha = 55;
  chrome.storage.local.get({ card_festival_bg: true, card_memorial_bg: false, card_default_theme: '', card_glass_mode: false, card_glass_blur: 5, card_glass_alpha: 55 }, (r) => {
    if (r) {
      if (r.card_festival_bg === false) festiveBg = false;
      memorialBg = r.card_memorial_bg === true;
      defaultTheme = r.card_default_theme || '';
      glassMode = r.card_glass_mode === true;
      glassBlur = typeof r.card_glass_blur === 'number' ? r.card_glass_blur : 5;
      glassAlpha = typeof r.card_glass_alpha === 'number' ? r.card_glass_alpha : 55;
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.card_festival_bg) festiveBg = changes.card_festival_bg.newValue !== false;
    if (changes.card_memorial_bg) memorialBg = changes.card_memorial_bg.newValue === true;
    if (changes.card_default_theme) defaultTheme = changes.card_default_theme.newValue || '';
    if (changes.card_glass_mode) glassMode = changes.card_glass_mode.newValue === true;
    if (changes.card_glass_blur) glassBlur = typeof changes.card_glass_blur.newValue === 'number' ? changes.card_glass_blur.newValue : 5;
    if (changes.card_glass_alpha) glassAlpha = typeof changes.card_glass_alpha.newValue === 'number' ? changes.card_glass_alpha.newValue : 55;
  });

  // 截图时临时隐藏扩展自身 UI：capture.js 与本脚本同隔离世界，直接走全局钩子。
  // 用 visibility 不用 display —— display:none 会让 iframe 卸载，评论区要重新加载
  globalThis.__acUi = {
    hide() { if (host) host.style.visibility = 'hidden'; },
    show() { if (host) host.style.visibility = ''; },
  };

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
      // path/index 是强兜底锚点：上下文区分不出来时（同名短词）按元素路径 + 第 n 处命中定位
      const hostEl = anchorElement(range);
      pendingQuote = {
        text: text,
        before: getContextBefore(range, 100),
        after: getContextAfter(range, 100),
        path: buildElementPath(hostEl),
        index: occurrenceIndex(hostEl, range, text),
      };
    }, 10);
  }

  // 获取选区前的上下文文字（跨节点向前收集，选区落在链接/段落开头时也能拿到上文）
  function getContextBefore(range, maxLen) {
    try {
      let collected = '';
      if (range.startContainer.nodeType === Node.TEXT_NODE) {
        collected = range.startContainer.textContent.slice(Math.max(0, range.startOffset - maxLen), range.startOffset);
      }
      if (collected.length < maxLen) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        walker.currentNode = range.startContainer.nodeType === Node.TEXT_NODE
          ? range.startContainer
          : range.startContainer;
        let n;
        const prev = [];
        let remaining = maxLen - collected.length;
        while ((n = walker.previousNode()) && remaining > 0) {
          if (!n.textContent || !n.textContent.trim()) continue;
          const tag = n.parentElement ? n.parentElement.tagName : '';
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA' || tag === 'INPUT') continue;
          prev.unshift(n.textContent);
          remaining -= n.textContent.length;
        }
        collected = prev.join('') + collected;
      }
      return normalizeText(collected).slice(-maxLen);
    } catch { return ''; }
  }

  // 获取选区后的上下文文字（跨节点向后收集）
  function getContextAfter(range, maxLen) {
    try {
      let collected = '';
      if (range.endContainer.nodeType === Node.TEXT_NODE) {
        collected = range.endContainer.textContent.slice(range.endOffset, range.endOffset + maxLen);
      }
      if (collected.length < maxLen) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        walker.currentNode = range.endContainer.nodeType === Node.TEXT_NODE
          ? range.endContainer
          : range.endContainer;
        let n;
        let remaining = maxLen - collected.length;
        while ((n = walker.nextNode()) && remaining > 0) {
          if (!n.textContent || !n.textContent.trim()) continue;
          const tag = n.parentElement ? n.parentElement.tagName : '';
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA' || tag === 'INPUT') continue;
          collected += n.textContent;
          remaining -= n.textContent.length;
        }
      }
      return normalizeText(collected).slice(0, maxLen);
    } catch { return ''; }
  }

  // 选区的宿主元素：用于记录 DOM 路径锚点（commonAncestorContainer 可能是文本节点）
  function anchorElement(range) {
    let n = range.commonAncestorContainer;
    if (n && n.nodeType !== 1) n = n.parentElement;
    return n && n !== document.body && n !== document.documentElement ? n : null;
  }

  // 选区是宿主元素内第几处相同文字（0 起），与 findCandidates 的候选顺序同一口径（都按规范化文本数）
  function occurrenceIndex(hostEl, range, text) {
    if (!hostEl) return 0;
    try {
      const pre = document.createRange();
      pre.setStart(hostEl, 0);
      pre.setEnd(range.startContainer, range.startOffset);
      const hay = normalizeText(pre.toString());
      const needle = normalizeText(text);
      if (!needle) return 0;
      let n = 0;
      let i = hay.indexOf(needle);
      while (i !== -1) {
        n += 1;
        i = hay.indexOf(needle, i + 1);
      }
      return n;
    } catch (e) {
      return 0;
    }
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
        quote_path: pendingQuote.path || null,
        quote_index: pendingQuote.index || 0,
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

  // 划线分享：生成卡片 + 预览浮层（下载/复制），登录态下记录并即时标虚线
  function onQuoteShare() {
    if (!pendingQuote) return;
    const q = pendingQuote;
    quoteBtn.style.display = 'none';
    window.getSelection()?.removeAllRanges();
    pendingQuote = null;
    try {
      const dataUrl = card.drawShareCard({ text: q.text, title: document.title, site: location.host, url: pageUrl(), festive: festiveBg, memorial: memorialBg, defaultTheme, glass: glassMode, glassBlur, glassAlpha });
      // 主题包随机换图：有可用包才出按钮，点一次随机抽一张重合成（避开当前这张）
      const actions = [];
      if (globalThis.__acThemePacks?.randomReady?.()) {
        let lastPack = globalThis.__acThemePack ? `${globalThis.__acThemePack.packId}:${globalThis.__acThemePack.key}` : '';
        actions.push({
          label: '换一张背景',
          onClick: async (updateImg) => {
            const e = await globalThis.__acThemePacks.randomEntry(lastPack);
            if (!e) throw new Error('no-pack-art');
            lastPack = `${e.packId}:${e.key}`;
            updateImg(card.drawShareCard({ text: q.text, title: document.title, site: location.host, url: pageUrl(), festive: festiveBg, memorial: memorialBg, defaultTheme, glass: glassMode, glassBlur, glassAlpha, packArt: e }));
            return '换一张背景';
          },
        });
      }
      card.showPreview(shadow, dataUrl, { alt: '划线分享卡片预览', actions });
      recordQuoteShare(q); // 记录划线（登录态），并即时给页面加虚线
    } catch (e) {
      showExtToast('生成分享卡片失败');
    }
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
          quote_path: q.path || null,
          quote_index: Number.isInteger(q.index) ? q.index : 0,
        }),
      }).then((res) => (res.ok ? res.json() : null)).then((d) => {
        if (!d) return;
        if (d.rewarded) showExtToast('分享成功，+0.5 积分');
        paintShareQuote(q); // 记录成功后给本页文字加虚线
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

  // 给单条划线记录文字加虚线（locateQuote 复用评论定位算法）
  function paintShareQuote(q) {
    const hit = locateQuote({
      quote_text: q.text,
      quote_before: q.before,
      quote_after: q.after,
      quote_path: q.path,
      quote_index: q.index,
    });
    if (!hit) return false;
    const mark = highlightRange(hit.range, null, 'share');
    if (mark) {
      mark.classList.add('ac-share-highlight');
      mark.dataset.acAnchor = hit.level; // 记录当次实际生效的定位级别，便于排查
    }
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
            paintShareQuote({ text: s.quote_text, before: s.quote_before, after: s.quote_after, path: s.quote_path, index: s.quote_index });
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

  // 打分比较时彻底剥掉空白：捕获上下文时节点之间**不加**分隔符（getContextBefore 直接 join('')），
  // 而拼接全文定位时每个节点后**加了一个空格**，两侧空白口径不一致会让公共前后缀在节点交界处断掉，
  // 最长只能 match 到 2 个字 —— 这是同名短词（如"小米"）被定位到标题上的放大器。比较前统一剥掉即可免疫。
  function stripWs(text) {
    return (text || '').replace(/\s+/g, '');
  }

  // 规范化文本并建立「规范化索引 → 原始索引」映射
  // 之前直接拿规范化索引当原始索引用，页面文本带换行/缩进时虚线会整体偏移（歪掉）
  function buildNormalized(text) {
    const chars = [];
    const map = []; // map[i] = 规范化第 i 个字符在原始文本中的下标
    let start = 0, end = text.length;
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    let pendingSpace = false;
    for (let j = start; j < end; j++) {
      if (/\s/.test(text[j])) { pendingSpace = true; continue; }
      if (pendingSpace) { chars.push(' '); map.push(j); pendingSpace = false; }
      chars.push(text[j]);
      map.push(j);
    }
    return { normalized: chars.join(''), map };
  }

  // 在单个文本节点中查找所有 quote_text 匹配，返回匹配列表
  function findAllInSingleNode(node, quoteText) {
    const matches = [];
    const text = node.textContent;
    const { normalized, map } = buildNormalized(text);
    const normalizedQuote = normalizeText(quoteText);
    if (!normalizedQuote) return matches;
    let idx = normalized.indexOf(normalizedQuote);
    while (idx !== -1) {
      const startRaw = map[idx];
      const endRaw = map[idx + normalizedQuote.length - 1] + 1;
      matches.push({ node, start: startRaw, end: endRaw, normalized: true });
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

  // 末尾/开头部分匹配的得分（0~0.5）：完整相等给满，部分相同按比例给分
  // 分母取 min(两侧长度)：之前固定用 ref.length（上下文 100 字），节点局部上下文只有几个字时
  // 所有候选的分数都被压成 0.00x 的噪声 → 同分并列 → 稳定排序按文档顺序取到标题上
  function partialScore(slice, ref, fromEnd) {
    if (!ref) return 0.5;
    if (slice === ref) return 0.5;
    const len = Math.min(slice.length, ref.length);
    let common = 0;
    for (let i = 1; i <= len; i++) {
      const a = fromEnd ? slice.slice(-i) : slice.slice(0, i);
      const b = fromEnd ? ref.slice(-i) : ref.slice(0, i);
      if (a === b) common = i;
      else break;
    }
    return len ? 0.5 * (common / len) : 0;
  }

  // 结构先验：标题/导航/页脚里的文字通常不是用户在正文里划的那段，同分时往后排。
  // 只压 0.08 的小分，不足以翻盘真实的上下文分差，仅在并列时起作用
  const NON_BODY_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'BUTTON', 'FIGCAPTION', 'TITLE']);
  const NON_BODY_ROLES = new Set(['navigation', 'banner', 'contentinfo']);
  function structuralPenalty(node) {
    let el = node ? node.parentElement : null;
    for (let depth = 0; el && el !== document.body && depth < 6; depth += 1, el = el.parentElement) {
      if (NON_BODY_TAGS.has(el.tagName)) return 0.08;
      const role = el.getAttribute ? (el.getAttribute('role') || '').toLowerCase() : '';
      if (role && NON_BODY_ROLES.has(role)) return 0.08;
    }
    return 0;
  }

  // 把一组文本节点拼成「全文 + 索引」，供跨节点定位与上下文打分共用
  function buildTextIndex(textNodes) {
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
    const { normalized, map } = buildNormalized(fullText);
    return { fullText, charMap, normalized, map };
  }

  // 在拼接索引里找 quote_text 的全部出现位置（含被标签分割、跨节点的情况）
  function findCandidates(index, quoteText) {
    const normalizedQuote = normalizeText(quoteText);
    if (!normalizedQuote) return [];
    const candidates = [];
    let idx = index.normalized.indexOf(normalizedQuote);
    while (idx !== -1) {
      const startRaw = index.map[idx];
      const endRaw = index.map[idx + normalizedQuote.length - 1] + 1;
      const startInfo = index.charMap[startRaw];
      const endInfo = index.charMap[endRaw - 1];
      if (startInfo && endInfo && !startInfo.isGap && !endInfo.isGap) {
        candidates.push({
          startNode: startInfo.node,
          startOffset: startInfo.offset,
          endNode: endInfo.node,
          endOffset: endInfo.offset + 1,
          ctxStart: startRaw,
          ctxEnd: endRaw,
        });
      }
      idx = index.normalized.indexOf(normalizedQuote, idx + 1);
    }
    return candidates;
  }

  // 候选的上下文相似度（0-1）：在拼接全文上取左右窗口，两侧都先剥空白再比前后缀
  // before/after 都缺失时无法区分（所有候选同分 1），由 hasContext 判定为不可信
  function contextScore(index, cand, before, after) {
    const refBefore = stripWs(before);
    const refAfter = stripWs(after);
    if (!refBefore && !refAfter) return 1;
    let score = 0;
    if (refBefore) {
      // 窗口多切 30 字符：节点间隙空格会占位，后缀比较容忍多切
      score += partialScore(stripWs(index.fullText.slice(Math.max(0, cand.ctxStart - before.length - 30), cand.ctxStart)), refBefore, true);
    } else {
      score += 0.5;
    }
    if (refAfter) {
      score += partialScore(stripWs(index.fullText.slice(cand.ctxEnd, cand.ctxEnd + after.length + 30)), refAfter, false);
    } else {
      score += 0.5;
    }
    return score;
  }

  function hasContext(before, after) {
    return !!(stripWs(before) || stripWs(after));
  }

  // ---------- DOM 路径 hint：创建划线时记下所在元素，定位失败时按路径兜底 ----------
  // 路径形如 "div:2/div:1/p:3/strong:1"：每级是 标签名:第几个同标签兄弟（nth-of-type），
  // 比 nth-child 稳（页面插广告/推荐位时同标签序号一般不变）
  function buildElementPath(el) {
    if (!el || el.nodeType !== 1 || el === document.body) return '';
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 24) {
      let nth = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) nth += 1;
        sib = sib.previousElementSibling;
      }
      parts.unshift(cur.tagName.toLowerCase() + ':' + nth);
      cur = cur.parentElement;
    }
    return parts.join('/');
  }

  function resolveElementPath(path) {
    if (!path) return null;
    let el = document.body;
    for (const seg of String(path).split('/')) {
      if (!seg || !el) return null;
      const pos = seg.lastIndexOf(':');
      const tag = (pos > 0 ? seg.slice(0, pos) : seg).toLowerCase();
      const want = parseInt(pos > 0 ? seg.slice(pos + 1) : '1', 10) || 1;
      let nth = 0;
      let found = null;
      for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
        if (c.tagName.toLowerCase() === tag) {
          nth += 1;
          if (nth === want) { found = c; break; }
        }
      }
      if (!found) return null;
      el = found;
    }
    return el;
  }

  function spanRange(startNode, startOffset, endNode, endOffset) {
    try {
      const range = document.createRange();
      range.setStart(startNode, Math.min(startOffset, startNode.textContent.length));
      range.setEnd(endNode, Math.min(endOffset, endNode.textContent.length));
      return range;
    } catch (e) {
      return null;
    }
  }

  // 分级定位：从简单到复杂依次尝试，哪一级能给出可信结果就当场用哪一级，不写死单一算法
  //   L1 单节点唯一命中 → L2 节点局部上下文 → L3 全页拼接上下文 → L4 DOM 路径 hint → L5 兜底
  const CONF_MIN = 0.55; // 最佳候选至少要这么高（满分 1.0 = 上下文完全吻合）
  const CONF_GAP = 0.25; // 且要领先第二名这么多，避免并列时按文档顺序撞到标题上

  function locateQuote(quote) {
    const quoteText = quote.quote_text;
    const before = quote.quote_before || null;
    const after = quote.quote_after || null;
    if (!quoteText) return null;

    const textNodes = collectTextNodes();
    if (textNodes.length === 0) return null;

    // --- L1：单节点内唯一命中，不依赖上下文 ---
    const local = [];
    for (const node of textNodes) {
      for (const m of findAllInSingleNode(node, quoteText)) local.push({ ...m, node });
    }
    if (local.length === 1) {
      const range = spanRange(local[0].node, local[0].start, local[0].node, local[0].end);
      if (range) return { range, level: 'L1-unique' };
    }

    // --- L2：节点局部上下文打分（最轻量；正文文字没被行内标签割裂时这一级就够）---
    let fallback = null;
    if (local.length > 1) {
      const refBefore = stripWs(before);
      const refAfter = stripWs(after);
      const scored = local
        .map((m) => {
          const text = m.node.textContent;
          let score = 0;
          score += refBefore
            ? partialScore(stripWs(text.slice(Math.max(0, m.start - 130), m.start)), refBefore, true)
            : 0.5;
          score += refAfter
            ? partialScore(stripWs(text.slice(m.end, m.end + 130)), refAfter, false)
            : 0.5;
          return { ...m, score: score - structuralPenalty(m.node) };
        })
        .sort((a, b) => b.score - a.score);
      const range = spanRange(scored[0].node, scored[0].start, scored[0].node, scored[0].end);
      if (range) fallback = { range, level: 'L2-local' };
      if (range && hasContext(before, after)
        && scored[0].score >= CONF_MIN
        && scored[0].score - (scored[1] ? scored[1].score : 0) >= CONF_GAP) {
        return { range, level: 'L2-local' };
      }
    }

    // --- L3：全页拼接上下文打分（正文里的"小米"被 strong/a 等行内标签割裂时靠这级）---
    const index = buildTextIndex(textNodes);
    const cands = findCandidates(index, quoteText);
    if (cands.length > 0) {
      const scored = cands
        .map((c) => ({ ...c, score: contextScore(index, c, before, after) - structuralPenalty(c.startNode) }))
        .sort((a, b) => b.score - a.score);
      const range = spanRange(scored[0].startNode, scored[0].startOffset, scored[0].endNode, scored[0].endOffset);
      if (range && !fallback) fallback = { range, level: 'L3-full' };
      if (range && hasContext(before, after)
        && scored[0].score >= CONF_MIN
        && scored[0].score - (scored[1] ? scored[1].score : 0) >= CONF_GAP) {
        return { range, level: 'L3-full' };
      }
    }

    // --- L4：DOM 路径 hint（上下文区分不出来时的强兜底）---
    if (quote.quote_path) {
      const host = resolveElementPath(quote.quote_path);
      if (host) {
        const sub = buildTextIndex(collectTextNodes(host));
        const cs = findCandidates(sub, quoteText);
        const nth = Number.isInteger(quote.quote_index) && quote.quote_index >= 0 ? quote.quote_index : 0;
        const pick = cs[nth] || cs[0];
        if (pick) {
          const range = spanRange(pick.startNode, pick.startOffset, pick.endNode, pick.endOffset);
          if (range) return { range, level: 'L4-path' };
        }
      }
    }

    // --- L5：兜底，用前面算出的最佳猜测（老划线没有上下文/没有路径时保持原行为）---
    // 走到这里说明上面几级都没给出可信结果，标签统一标成 L5 便于区分
    return fallback ? { range: fallback.range, level: 'L5-fallback' } : null;
  }

  // 在页面中查找 quote 对应的 Range，返回 Range 或 null
  function findQuoteRange(quote) {
    const hit = locateQuote(quote);
    return hit ? hit.range : null;
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
    const hit = locateQuote(quote);
    if (!hit) {
      // 找不到时用 Toast 提示
      showExtToast('未在页面中找到对应的划线文字');
      return;
    }
    const range = hit.range;
    const mark = highlightRange(range, quote.comment_id || null);
    if (mark) {
      mark.dataset.acAnchor = hit.level;
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
        const hit = locateQuote(quote);
        if (hit) {
          const mark = highlightRange(hit.range, quote.comment_id || null);
          if (mark) mark.dataset.acAnchor = hit.level;
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
    /* 预览浮层样式在 card.js 的 PREVIEW_CSS 中，由 showPreview 注入所在 shadow root */
  `;
})();
