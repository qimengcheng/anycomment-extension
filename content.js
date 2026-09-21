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
  let markerOn = true;
  let doodleOn = true;
  chrome.storage.local.get({ card_festival_bg: true, card_memorial_bg: false, card_default_theme: '', card_glass_mode: false, card_glass_blur: 5, card_glass_alpha: 55, card_marker: true, card_doodle: true }, (r) => {
    if (r) {
      if (r.card_festival_bg === false) festiveBg = false;
      memorialBg = r.card_memorial_bg === true;
      defaultTheme = r.card_default_theme || '';
      glassMode = r.card_glass_mode === true;
      glassBlur = typeof r.card_glass_blur === 'number' ? r.card_glass_blur : 5;
      glassAlpha = typeof r.card_glass_alpha === 'number' ? r.card_glass_alpha : 55;
      markerOn = r.card_marker !== false;
      doodleOn = r.card_doodle !== false;
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
    if (changes.card_marker) markerOn = changes.card_marker.newValue !== false;
    if (changes.card_doodle) doodleOn = changes.card_doodle.newValue !== false;
    // 隐藏名单与图标位置可能在别的标签页（或别的站点）里被改过，同步到当前页面
    if (changes.ac_hidden_sites) {
      fabHiddenSite = hiddenMatch(readHiddenCache(changes.ac_hidden_sites.newValue).sites, siteKey);
      applyFabVisibility();
    }
    if (changes.ac_fab_pos && !fabDragging) {
      fabPos = readPos(changes.ac_fab_pos.newValue, siteKey);
      applyFabPos();
    }
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

  // ---- 悬浮图标：拖动位置（按站点记）、右键菜单、「不显示图标的网站」----
  const FAB_SIZE = 42;         // 与 CSS 里 .ac-fab 的宽高保持一致
  const FAB_MARGIN = 8;        // 贴边留白
  const FAB_POS_MAX = 100;     // 位置记录最多保留 100 个站点，超了淘汰最久没动的，避免无限膨胀
  const HIDDEN_TTL = 60_000;   // 隐藏名单本地缓存 60s（与服务端 memo 同口径），期内不再重复请求
  const siteKey = location.host.toLowerCase();
  let fabPos = null;           // 本站的自定义位置 { l, t }；null = 默认（贴右边距、垂直居中）
  let fabCur = null;           // 图标当前实际坐标（视口坐标），由 JS 记账，不回头读布局
  let fabHiddenTab = false;    // 右键「本次隐藏」：只作用于当前页面，刷新即恢复，不落存储
  let fabHiddenSite = false;   // 命中服务端「不显示图标的网站」
  let fabMenu = null;          // 右键菜单节点
  let suppressFabClick = false; // 拖动收尾那一下 click 要吃掉，不能当成「打开侧栏」

  chrome.storage.local.get({ enabled: true, ac_hidden_sites: null, ac_fab_pos: null }, (c) => {
    if (!serverOrigin) return;
    const isSelf = location.origin === serverOrigin;
    // 自身页面（manage / 直接打开的widget）只做消息中转，不注入评论侧栏
    if (isSelf) {
      window.addEventListener('message', onMessage);
      return;
    }
    if (!c.enabled) return;
    if (!/^https?:$/i.test(location.protocol)) return;
    // 先用本地缓存的名单和位置判定，命中隐藏就不必等接口返回，避免图标闪一下再消失
    fabHiddenSite = hiddenMatch(readHiddenCache(c.ac_hidden_sites).sites, siteKey);
    fabPos = readPos(c.ac_fab_pos, siteKey);
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

  /* ------------- 悬浮图标：位置 / 拖动 / 右键菜单 / 不显示图标的网站 ------------- */

  /** 「不显示图标的网站」本地缓存：{ sites: string[], ts: number } */
  function readHiddenCache(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sites)) return { sites: [], ts: 0 };
    const sites = raw.sites
      .map((s) => (typeof s === 'string' ? s.trim().toLowerCase() : ''))
      .filter(Boolean);
    return { sites, ts: typeof raw.ts === 'number' ? raw.ts : 0 };
  }

  /** 命中判定：精确相等或子域名（存 example.com 时 www.example.com / blog.example.com 都命中），与自动打开名单同口径 */
  function hiddenMatch(sites, host) {
    const h = String(host || '').toLowerCase();
    if (!h) return false;
    return (sites || []).some((s) => h === s || h.endsWith('.' + s));
  }

  /** 读取某个站点的位置记录；没有或字段非法 → null（表示用默认位置） */
  function readPos(map, key) {
    const v = map && typeof map === 'object' ? map[key] : null;
    if (!v || typeof v.l !== 'number' || typeof v.t !== 'number') return null;
    return { l: v.l, t: v.t };
  }

  /** 把坐标夹回视口内（窗口缩小后图标不至于被推出屏幕外） */
  function clampPos(p) {
    const maxL = Math.max(FAB_MARGIN, window.innerWidth - FAB_MARGIN - FAB_SIZE);
    const maxT = Math.max(FAB_MARGIN, window.innerHeight - FAB_MARGIN - FAB_SIZE);
    return {
      l: Math.min(Math.max(FAB_MARGIN, Math.round(p.l)), maxL),
      t: Math.min(Math.max(FAB_MARGIN, Math.round(p.t)), maxT),
    };
  }

  /**
   * 默认位置：贴右边距、垂直居中。
   * 原实现把 `top:50%` 交给了一个 0 高度的宿主（position:fixed + width/height:0），
   * 百分比按 0 解析，再叠 translateY(-50%) 就把图标顶到视口上沿、只剩下半截露在外面。
   * 改成显式坐标，默认位置才是原本想要的效果。
   */
  function fabDefaultPos() {
    return {
      l: Math.max(FAB_MARGIN, window.innerWidth - FAB_MARGIN - FAB_SIZE),
      t: Math.max(FAB_MARGIN, Math.round(window.innerHeight / 2 - FAB_SIZE / 2)),
    };
  }

  /** 落位：侧栏展开且图标会被盖住时左移一个侧栏宽度（本来就在左边的图标不动） */
  function applyFabPos() {
    if (!fab) return;
    const base = clampPos(fabPos || fabDefaultPos());
    let left = base.l;
    if (opened) {
      const panelW = Math.min(400, Math.round(window.innerWidth * 0.92));
      if (base.l + FAB_SIZE > window.innerWidth - panelW) left = Math.max(FAB_MARGIN, base.l - panelW - 12);
    }
    fabCur = { l: left, t: base.t };
    fab.style.left = left + 'px';
    fab.style.top = base.t + 'px';
  }

  /** 隐藏图标 = 「本次隐藏」或命中服务端名单；只藏图标，选中文字的评论/分享入口与页面划线标记照旧 */
  function applyFabVisibility() {
    if (!fab) return;
    const hide = fabHiddenTab || fabHiddenSite;
    fab.style.display = hide ? 'none' : '';
    if (hide) closeFabMenu();
  }

  /** 记住本站的图标位置（每个站点各记一份） */
  function saveFabPos(p) {
    chrome.storage.local.get({ ac_fab_pos: null }, (r) => {
      const map = (r && r.ac_fab_pos && typeof r.ac_fab_pos === 'object') ? { ...r.ac_fab_pos } : {};
      map[siteKey] = { l: p.l, t: p.t, at: Date.now() };
      const keys = Object.keys(map);
      if (keys.length > FAB_POS_MAX) {
        keys.sort((a, b) => ((map[a] && map[a].at) || 0) - ((map[b] && map[b].at) || 0));
        for (const k of keys.slice(0, keys.length - FAB_POS_MAX)) delete map[k];
      }
      chrome.storage.local.set({ ac_fab_pos: map });
    });
  }

  /** 清掉本站的位置记录，回到默认位置 */
  function resetFabPos() {
    chrome.storage.local.get({ ac_fab_pos: null }, (r) => {
      const map = (r && r.ac_fab_pos && typeof r.ac_fab_pos === 'object') ? { ...r.ac_fab_pos } : {};
      delete map[siteKey];
      chrome.storage.local.set({ ac_fab_pos: map });
    });
    fabPos = null;
    applyFabPos();
  }

  // ---- 拖动：指针事件 + 指针捕获，拖动中关掉过渡保证跟手 ----
  let fabDragging = false;
  let fabDragMoved = false;
  let fabDragStart = null; // { x, y, l, t } 按下瞬间的鼠标位置与图标左上角
  let fabDragLast = null;  // 拖动过程中最后一次算出的落点

  function onFabPointerDown(e) {
    if (e.button !== 0) return; // 右键留给 contextmenu
    const r = fab.getBoundingClientRect();
    const cur = fabCur || { l: r.left, t: r.top };
    fabDragStart = { x: e.clientX, y: e.clientY, l: cur.l, t: cur.t };
    fabDragLast = null;
    fabDragMoved = false;
    fabDragging = true;
    try { fab.setPointerCapture(e.pointerId); } catch { /* 不支持指针捕获则退化为普通拖动 */ }
    if (e.cancelable) e.preventDefault(); // 抑制原生拖拽与文本选中
  }

  function onFabPointerMove(e) {
    if (!fabDragging || !fabDragStart) return;
    const dx = e.clientX - fabDragStart.x;
    const dy = e.clientY - fabDragStart.y;
    if (!fabDragMoved) {
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return; // 3px 以内仍算点击，不算拖动
      fabDragMoved = true;
      fab.classList.add('ac-drag');
      closeFabMenu();
    }
    const p = clampPos({ l: fabDragStart.l + dx, t: fabDragStart.t + dy });
    fabCur = p;
    fabDragLast = p;
    fab.style.left = p.l + 'px';
    fab.style.top = p.t + 'px';
  }

  function onFabPointerUp(e) {
    if (!fabDragging) return;
    fabDragging = false;
    try { fab.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (!fabDragMoved) return; // 没真正移动 → 交给 click 去打开侧栏
    suppressFabClick = true;
    fab.classList.remove('ac-drag');
    // 用拖动过程中记下的落点，不回头读 getBoundingClientRect：
    // 过渡刚恢复那一帧读回的是动画中间值，会把位置记错
    fabPos = clampPos(fabDragLast || fabCur || fabDefaultPos());
    fabCur = fabPos;
    fabDragLast = null;
    fab.style.left = fabPos.l + 'px';
    fab.style.top = fabPos.t + 'px';
    saveFabPos(fabPos);
  }

  // ---- 右键菜单（自绘，不用浏览器原生菜单）----
  function onFabContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    openFabMenu(e.clientX, e.clientY);
  }

  function openFabMenu(x, y) {
    closeFabMenu();
    fabMenu = document.createElement('div');
    fabMenu.className = 'ac-fab-menu';
    const items = [
      { act: 'once', label: '本次隐藏' },
      { act: 'site', label: '本网站都隐藏' },
    ];
    // 只有拖过图标才给「恢复默认位置」，没拖过不必占菜单
    if (fabPos) items.push({ act: 'reset', label: '恢复默认位置', sep: true });
    for (const it of items) {
      if (it.sep) {
        const hr = document.createElement('div');
        hr.className = 'ac-menu-sep';
        fabMenu.appendChild(hr);
      }
      const btn = document.createElement('button');
      btn.className = 'ac-menu-item';
      btn.dataset.act = it.act;
      btn.textContent = it.label;
      fabMenu.appendChild(btn);
    }
    fabMenu.addEventListener('click', onFabMenuClick);
    shadow.appendChild(fabMenu);
    // 先量出尺寸再落位：贴着鼠标弹出，越界就贴边
    const r = fabMenu.getBoundingClientRect();
    fabMenu.style.left = Math.min(Math.max(4, x), Math.max(4, window.innerWidth - r.width - 4)) + 'px';
    fabMenu.style.top = Math.min(Math.max(4, y), Math.max(4, window.innerHeight - r.height - 4)) + 'px';
    fabMenu.style.visibility = 'visible';
  }

  function onFabMenuClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    const act = btn.dataset.act;
    closeFabMenu();
    if (act === 'once') hideFabThisPage();
    else if (act === 'site') hideFabOnThisSite();
    else if (act === 'reset') { resetFabPos(); showExtToast('图标位置已恢复默认'); }
  }

  function closeFabMenu() {
    if (!fabMenu) return;
    fabMenu.remove();
    fabMenu = null;
  }

  /** 本次隐藏：只影响当前页面，刷新即恢复，不写任何存储 */
  function hideFabThisPage() {
    fabHiddenTab = true;
    applyFabVisibility();
    showExtToast('已隐藏图标（刷新后恢复）');
  }

  /** 本网站都隐藏：写进服务端名单，并在本地缓存里同步；www. 前缀去掉，让子域名一起命中 */
  function hideFabOnThisSite() {
    const domain = siteKey.replace(/^www\./, '');
    chrome.storage.local.get({ ac_token: '' }, (r) => {
      if (!r.ac_token) {
        showExtToast('请先在 AnyComment 评论区登录，再设置不显示图标的网站');
        return;
      }
      fetch(SERVER + '/api/me/hidden-sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + r.ac_token },
        body: JSON.stringify({ site_domain: domain }),
      })
        .then((res) => res.json()
          .then((d) => ({ ok: res.ok, status: res.status, data: d }))
          .catch(() => ({ ok: res.ok, status: res.status, data: null })))
        .then(({ ok, status, data }) => {
          // 409 = 本来就在名单里，用户意图已经达成，按成功处理
          if (!ok && status !== 409) throw new Error((data && data.error) || '设置失败');
          const saved = (data && data.site_domain) || domain;
          chrome.storage.local.get({ ac_hidden_sites: null }, (s) => {
            const cache = readHiddenCache(s.ac_hidden_sites);
            if (!cache.sites.includes(saved)) cache.sites.unshift(saved);
            chrome.storage.local.set({ ac_hidden_sites: { sites: cache.sites, ts: Date.now() } });
          });
          fabHiddenSite = hiddenMatch([saved], siteKey);
          applyFabVisibility();
          showExtToast('已隐藏「' + saved + '」的图标，可在个人中心恢复');
        })
        .catch((err) => { showExtToast((err && err.message) || '设置失败'); });
    });
  }

  /** 后台刷新隐藏名单：未登录、或 60s 内刚同步过就跳过，避免每个页面都多一次请求 */
  function refreshHiddenSites() {
    chrome.storage.local.get({ ac_token: '', ac_hidden_sites: null }, (r) => {
      if (!r.ac_token) return;
      if (Date.now() - readHiddenCache(r.ac_hidden_sites).ts < HIDDEN_TTL) return;
      fetch(SERVER + '/api/me/hidden-sites', { headers: { 'Authorization': 'Bearer ' + r.ac_token } })
        .then((res) => (res.ok ? res.json() : null))
        .then((d) => {
          if (!d || !Array.isArray(d.sites)) return;
          const sites = d.sites
            .map((s) => (s && s.site_domain ? String(s.site_domain).trim().toLowerCase() : ''))
            .filter(Boolean);
          chrome.storage.local.set({ ac_hidden_sites: { sites, ts: Date.now() } });
          fabHiddenSite = hiddenMatch(sites, siteKey);
          applyFabVisibility();
        })
        .catch(() => { /* 名单拉不到就按「不隐藏」处理，静默降级 */ });
    });
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
    // 先定好位与可见性再入 DOM，避免图标先从左上角跳一下、或先闪出来再被隐藏
    applyFabPos();
    applyFabVisibility();
    document.documentElement.appendChild(host);
    badge = fab.querySelector('.ac-badge');

    fab.addEventListener('click', () => {
      if (suppressFabClick) { suppressFabClick = false; return; } // 拖动收尾那一下不算打开侧栏
      toggle();
    });
    fab.addEventListener('pointerdown', onFabPointerDown);
    fab.addEventListener('pointermove', onFabPointerMove);
    fab.addEventListener('pointerup', onFabPointerUp);
    fab.addEventListener('pointercancel', onFabPointerUp);
    fab.addEventListener('contextmenu', onFabContextMenu);
    // 首帧过去后再开过渡：否则初始位置会被当成一次位移动画播出来
    requestAnimationFrame(() => { if (fab) fab.classList.add('ac-anim'); });
    window.addEventListener('resize', () => {
      if (fabDragging) return;
      applyFabPos();
      closeFabMenu();
    });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFabMenu(); });
    // 点菜单以外的地方收起菜单（捕获阶段，页面 stopPropagation 也拦不住）
    document.addEventListener('mousedown', (e) => {
      if (!fabMenu) return;
      const path = e.composedPath ? e.composedPath() : [];
      if (path.includes(fabMenu) || path.includes(fab)) return;
      closeFabMenu();
    }, true);
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

    // 检查是否需要自动打开侧边栏（用户设置的网站）；站点在「不显示图标的网站」名单里时不再自动展开
    if (!fabHiddenSite) checkAutoOpen();
    // 名单可能已过期：后台拉一次最新的（未登录或 60s 内刚同步过则跳过）
    refreshHiddenSites();
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
      if (!opened) setOpened(true);
    }, 300);
  }

  /**
   * 侧栏开合的**唯一入口**。
   * ⚠️ 开合有 3 条触发路径：点悬浮图标、iframe 内点「收起」（postMessage AC_CLOSE）、
   * 分享链接跳入（openForShare）。它们必须都走这里——任何一条漏掉 applyFabPos()，
   * 图标就会卡在「避让侧栏」后的那个位置上回不去（关掉侧栏图标仍偏左）。
   */
  function setOpened(v) {
    opened = v;
    panel.classList.toggle('open', opened);
    fab.classList.toggle('active', opened);
    applyFabPos(); // 展开时让开右下角，收起时立即归位
    if (opened) {
      // 兜底：如果空闲回调还没执行，点击时立即加载
      if (!iframe.src) iframe.src = SERVER + '/widget';
      // iframe 已就绪则立即发送页面信息，否则等 AC_READY 后再发
      if (iframeReady) sendPage();
    } else {
      refreshBadge();
    }
  }

  function toggle() {
    setOpened(!opened);
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
  // WALKER_VISIT_CAP 限制遍历的文本节点数：选区靠前时 previousNode 会扫过几乎整个文档，
  // 收集满 100 字才停无法约束这种最坏情况；到上限就用已收集的内容（上下文本就是尽力而为，
  // 定位还有 path/index 强兜底锚点）
  const WALKER_VISIT_CAP = 4000;

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
        let visited = 0;
        const prev = [];
        let remaining = maxLen - collected.length;
        while ((n = walker.previousNode()) && remaining > 0) {
          if (++visited > WALKER_VISIT_CAP) break;
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
        let visited = 0;
        let remaining = maxLen - collected.length;
        while ((n = walker.nextNode()) && remaining > 0) {
          if (++visited > WALKER_VISIT_CAP) break;
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

  // 命中预览卡片上被点击的词块：分数坐标 → 卡片像素 → 定位到 "行:块" key（供点词切换高亮）。
  // 依赖最近一次带划线 drawShareCard 记录的布局，绘制与命中同一套数字，点哪划哪不会跑偏
  function hitQuoteToken(fx, fy) {
    const L = card.lastQuoteLayout();
    if (!L) return null;
    const cx = fx * L.W, cy = fy * L.H;
    for (let i = 0; i < L.tokens.length; i++) {
      const yTop = L.quoteTop + i * L.lineH - 20;
      if (cy < yTop - 6 || cy > yTop + L.fs + 6) continue;
      const line = L.tokens[i];
      for (let ti = 0; ti < line.length; ti++) {
        const tok = line[ti];
        if (/^\s+$/.test(tok.t)) continue;
        const x0 = L.PAD + tok.x, x1 = x0 + tok.w;
        if (cx >= x0 - 1 && cx <= x1 + 1) return `${i}:${ti}`;
      }
      return null; // 落在该行文字区但不在具体词块上
    }
    return null;
  }

  // 划线分享：生成卡片 + 预览浮层（下载/复制），登录态下记录并即时标虚线。
  // 开启「划线强调」时，卡片给关键词上小红书风荧光笔划线：调色板（黄橙粉绿蓝紫 + 彩虹渐变）
  // 以悬浮工具条形式贴在卡片下缘（不占浮层高度），选中的颜色应用到之后点的词，
  // 再点已高亮的词取消；每个词各留自己的颜色
  function onQuoteShare() {
    if (!pendingQuote) return;
    const q = pendingQuote;
    quoteBtn.style.display = 'none';
    window.getSelection()?.removeAllRanges();
    pendingQuote = null;
    try {
      const useMarker = markerOn;
      const palette = card.MARKER_PALETTE || [];
      const autoMap = () => Object.fromEntries((useMarker ? card.autoHighlight(q.text) : []).map((k) => [k, 'yellow']));
      let hl = autoMap(); // { "行:块": colorId }
      let doodle = useMarker && doodleOn; // 手绘装饰开关（预览里可临时切换）
      let activeColor = 'yellow'; // 调色板当前选中色
      let curPack; // 手动「换一张背景」后的包条目；未换则 undefined 走自动路径
      const render = () => card.drawShareCard({
        text: q.text, title: document.title, site: location.host, url: pageUrl(),
        festive: festiveBg, memorial: memorialBg, defaultTheme, glass: glassMode, glassBlur, glassAlpha,
        packArt: curPack, marker: useMarker, doodle, highlight: hl,
      });
      // 底部按钮行只管「输出」类操作，调色板等编辑操作全部走图片上的悬浮工具条（见 buildFloatActions）
      const buildActions = () => {
        const acts = [];
        // 主题包随机换图：有可用包才出按钮，点一次随机抽一张重合成（避开当前这张）
        if (globalThis.__acThemePacks?.randomReady?.()) {
          let lastPack = globalThis.__acThemePack ? `${globalThis.__acThemePack.packId}:${globalThis.__acThemePack.key}` : '';
          acts.push({
            label: '换一张背景',
            onClick: async (updateImg) => {
              const e = await globalThis.__acThemePacks.randomEntry(lastPack);
              if (!e) throw new Error('no-pack-art');
              lastPack = `${e.packId}:${e.key}`;
              curPack = e;
              updateImg(render());
              return '换一张背景';
            },
          });
        }
        return acts;
      };
      // 悬浮工具条：7 个色点 + 分隔线 + 贴纸 / 装饰 / 重置（图标按钮）。浮在卡片下缘、不占额外高度。
      // selected 传函数：点击后就地刷新选中态，不重建浮层（换色不再闪一下）
      const ICON_STICKER = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2 3.5h7.5L14 8v5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 13v-9.5z"/><path d="M9.5 3.5V8H14" fill="none"/><path d="M4.5 6.5l1 1.5 1.5-1-1 1.5 1 .8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
      const ICON_DOODLE = '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><path d="M8 1.7l1.7 4.6L14.3 8l-4.6 1.7L8 14.3 6.3 9.7 1.7 8l4.6-1.7z"/></svg>';
      const ICON_RESET = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.4 6.7A5 5 0 1 1 8 13"/><path d="M3.4 2.7v4h4"/></svg>';
      let stickerOn = false;
      const buildFloatActions = () => {
        if (!useMarker) return [];
        // 点色块 = 把当前所有已高亮词重涂成选中色，并作为之后点词的新色
        const acts = palette.map((c) => ({
          kind: 'dot', label: c.name, bg: c.css,
          selected: () => c.id === activeColor,
          onClick: (updateImg) => { activeColor = c.id; for (const k in hl) hl[k] = c.id; updateImg(render()); },
        }));
        acts.push({ kind: 'sep' });
        acts.push({
          kind: 'sticker', icon: ICON_STICKER, label: '贴纸（点击添加手账贴纸）',
          selected: () => stickerOn,
          onClick: (updateImg, isOn) => { stickerOn = !!isOn; },
        });
        acts.push({
          kind: 'icon', icon: ICON_DOODLE, label: '手绘装饰（点击开关）',
          selected: () => doodle,
          onClick: (updateImg) => { doodle = !doodle; updateImg(render()); },
        });
        acts.push({
          kind: 'icon', icon: ICON_RESET, label: '重置划线',
          onClick: (updateImg) => { hl = autoMap(); updateImg(render()); },
        });
        return acts;
      };
      const onImageClick = useMarker ? (fx, fy, { updateImg }) => {
        const key = hitQuoteToken(fx, fy);
        if (!key) return;
        if (hl[key]) delete hl[key]; else hl[key] = activeColor; // 已高亮→取消，未高亮→用当前色划上
        updateImg(render());
      } : undefined;
      const open = () => card.showPreview(shadow, render(), {
        alt: '划线分享卡片预览', actions: buildActions(), floatActions: buildFloatActions(),
        annotate: true, onImageClick,
      });
      open();
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
          // 用户既然把这个站设成「不显示图标」，就别再自动展开侧栏去打扰他
          if (fabHiddenTab || fabHiddenSite) return;
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
      setOpened(false); // 走统一入口，否则图标会卡在避让侧栏后的位置
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
      // 退出登录，清除扩展存储的token（隐藏名单属于登录用户，一并清掉）
      chrome.storage.local.remove(['ac_token', 'ac_user', 'ac_hidden_sites']);
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
    /* 位置由 JS 写 left/top（见 applyFabPos），写进去的是视口坐标，所以这里必须 fixed：
       宿主是 position:fixed + right:0 + 0 尺寸的盒子，若图标用绝对定位，它的包含块原点
       会落在视口右边缘，同一个 left 会被再加一个 innerWidth（图标直接飞到屏幕外）。
       （用 top:50% 的老写法也是栽在同一个包含块上：0 高度的宿主要把所有百分比解析成 0） */
    .ac-fab {
      position: fixed; left: 0; top: 0;
      width: 42px; height: 42px; border-radius: 50%; border: none; cursor: grab;
      background: #4f6ef7; color: #fff; box-shadow: 0 4px 16px rgba(31,36,48,.25);
      display: flex; align-items: center; justify-content: center;
      touch-action: none; user-select: none; -webkit-user-select: none;
      padding: 0; outline: none;
    }
    /* 首帧之后才挂上过渡，避免初始位置被当成一次位移动画播出来 */
    .ac-fab.ac-anim { transition: left .22s ease, top .22s ease, transform .15s ease; }
    .ac-fab:hover { transform: scale(1.06); }
    .ac-fab.ac-drag { transition: none; cursor: grabbing; transform: scale(1.06); }
    .ac-fab svg { width: 21px; height: 21px; fill: #fff; pointer-events: none; }
    .ac-badge {
      position: absolute; top: -4px; left: -4px; min-width: 18px; height: 18px;
      padding: 0 4px; border-radius: 9px; background: #ff4d5e; color: #fff;
      font: 600 11px/18px system-ui, sans-serif; text-align: center; pointer-events: none;
    }
    /* 右键菜单：贴着鼠标弹出，定位同样由 JS 写 left/top */
    .ac-fab-menu {
      position: fixed; left: 0; top: 0; visibility: hidden;
      min-width: 136px; padding: 5px; border-radius: 10px;
      background: #fff; border: 1px solid rgba(31,36,48,.08);
      box-shadow: 0 8px 28px rgba(31,36,48,.22);
      font: 500 13px/1.4 system-ui, sans-serif; color: #1f2432;
    }
    .ac-menu-item {
      display: block; width: 100%; padding: 8px 10px; border: none; border-radius: 7px;
      background: transparent; color: #1f2432; font: inherit; text-align: left;
      white-space: nowrap; cursor: pointer;
    }
    .ac-menu-item:hover { background: #f2f4f8; }
    .ac-menu-sep { height: 1px; margin: 5px 6px; background: rgba(31,36,48,.08); }
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
