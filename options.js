// AnyComment 截图设置页：读写 chrome.storage.local 的 shot_* 配置 + 主题包开关 + 实时预览
(() => {
  const card = globalThis.__acCard;
  const packsApi = globalThis.__acThemePacks || null;
  const packs = (packsApi && packsApi.packs) || [];
  const $ = (id) => document.getElementById(id);
  const KEYS = Object.keys(card.SHOT_DEFAULTS);
  const SAMPLE_URL = 'https://anycomment.qimengcheng-47e.workers.dev/产品笔记/2026-09-网页截图';
  let cfg = { ...card.SHOT_DEFAULTS };

  const packDefaults = Object.fromEntries(packs.map((p) => [`pack_${p.id}`, false]));
  chrome.storage.local.get({ ...card.SHOT_DEFAULTS, ...packDefaults }, (v) => {
    cfg = { ...card.SHOT_DEFAULTS, ...v };
    render();
    buildPickers(); // cfg 就绪后才能按包开关收录分组（同步阶段的 buildPickers 只会看到空 cfg）
  });
  // 别处（如另一个设置页标签）改了立即同步
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let hit = false;
    for (const k of KEYS) {
      if (changes[k]) { cfg[k] = changes[k].newValue; hit = true; }
    }
    for (const p of packs) {
      const k = `pack_${p.id}`;
      if (changes[k]) { cfg[k] = changes[k].newValue; hit = true; }
    }
    if (hit) render();
  });

  function save(patch) {
    cfg = { ...cfg, ...patch };
    chrome.storage.local.set(patch);
    render();
  }

  function render() {
    $('shot_qr').checked = !!cfg.shot_qr;
    $('shot_time').checked = !!cfg.shot_time;
    $('shot_brand').checked = !!cfg.shot_brand;
    $('card_festival_bg').checked = cfg.card_festival_bg !== false;
    $('card_memorial_bg').checked = cfg.card_memorial_bg === true;
    for (const p of packs) {
      const el = $(`pack_${p.id}`);
      if (el) el.checked = cfg[`pack_${p.id}`] === true;
    }
    $(cfg.shot_qr_overlay ? 'pos_overlay' : 'pos_strip').checked = true;
    $('cornerBox').classList.toggle('off', !cfg.shot_qr_overlay || !cfg.shot_qr);
    const corner = document.querySelector(`input[name="corner"][value="${cfg.shot_qr_corner}"]`);
    if (corner) corner.checked = true;
    $('shot_default_mode').value = cfg.shot_default_mode;
    themePick.refresh(autoLabel());
    defaultPick.set(cfg.card_default_theme || ''); // 存储回显：不能只靠 buildPickers 的内部值
    defaultPick.refresh('默认蓝渐变');
    updatePackStatuses();
    drawPreview();
  }

  $('shot_qr').addEventListener('change', (e) => save({ shot_qr: e.target.checked }));
  $('shot_time').addEventListener('change', (e) => save({ shot_time: e.target.checked }));
  $('shot_brand').addEventListener('change', (e) => save({ shot_brand: e.target.checked }));
  $('card_festival_bg').addEventListener('change', (e) => save({ card_festival_bg: e.target.checked }));
  $('card_memorial_bg').addEventListener('change', (e) => save({ card_memorial_bg: e.target.checked }));
  // 主题包开关行由 buildPackRows 动态生成，监听也在此处绑定（行生成前 DOM 尚不存在）
  $('pos_overlay').addEventListener('change', () => save({ shot_qr_overlay: true }));
  $('pos_strip').addEventListener('change', () => save({ shot_qr_overlay: false }));
  document.querySelectorAll('input[name="corner"]').forEach((r) => {
    r.addEventListener('change', () => save({ shot_qr_corner: r.value }));
  });
  $('shot_default_mode').addEventListener('change', (e) => save({ shot_default_mode: e.target.value }));

  $('openShortcuts').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  const LABELS = {
    'capture-selection': '框选区域截图',
    'capture-viewport': '截取当前屏幕区域',
    'capture-fullpage': '完整页面',
  };
  chrome.commands.getAll((cmds) => {
    const rows = cmds
      .filter((c) => LABELS[c.name])
      .map((c) => `<tr><td class="k">${LABELS[c.name]}</td><td class="v">${c.shortcut || '未生效'}</td></tr>`)
      .join('');
    $('keys').tBodies[0].innerHTML = rows || '<tr><td class="k">未读到命令</td><td class="v">-</td></tr>';
  });

  // ========== 可搜索选择器：选项 500+（节日/节气/纪念日/主题包全量），原生 select 难用 ==========
  let openPicker = null; // 同一时间只开一个面板
  function makePicker(host, { onChange }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pk-btn';
    const lbl = document.createElement('span');
    lbl.className = 'pk-label';
    const caret = document.createElement('span');
    caret.className = 'pk-caret';
    caret.textContent = '▾';
    btn.append(lbl, caret);
    host.append(btn);
    let value = '';
    let fallback = '';
    let labels = new Map(); // value -> label
    let panel = null, search = null, list = null;

    function close() {
      if (panel) { panel.remove(); panel = null; }
      if (openPicker === close) openPicker = null;
      document.removeEventListener('mousedown', onDocDown, true);
    }
    function onDocDown(e) {
      if (panel && !panel.contains(e.target) && !btn.contains(e.target)) close();
    }
    function renderList(q) {
      list.innerHTML = '';
      let shown = 0;
      for (const g of groups) {
        const items = g.items.filter((it) => !q || it.label.toLowerCase().includes(q));
        if (!items.length) continue;
        const h = document.createElement('div');
        h.className = 'pk-group';
        h.textContent = g.label;
        list.append(h);
        for (const it of items) {
          const d = document.createElement('div');
          d.className = 'pk-item' + (it.value === value ? ' sel' : '');
          d.textContent = it.label;
          d.addEventListener('click', () => {
            value = it.value;
            lbl.textContent = it.label;
            close();
            onChange(value);
          });
          list.append(d);
          shown++;
        }
      }
      if (!shown) {
        const d = document.createElement('div');
        d.className = 'pk-empty';
        d.textContent = '没有匹配的选项';
        list.append(d);
      }
    }
    function open() {
      if (panel) return;
      if (openPicker) openPicker();
      panel = document.createElement('div');
      panel.className = 'pk-panel';
      search = document.createElement('input');
      search.className = 'pk-search';
      search.placeholder = '搜索：花名 / 主题 / 日期…';
      list = document.createElement('div');
      list.className = 'pk-list';
      panel.append(search, list);
      document.body.append(panel);
      const r = btn.getBoundingClientRect();
      const pw = Math.max(300, r.width);
      panel.style.width = pw + 'px';
      if (r.bottom + 396 > window.innerHeight && r.top > 400) panel.style.top = Math.max(8, r.top - 396) + 'px';
      else panel.style.top = r.bottom + 6 + 'px';
      panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8)) + 'px';
      search.addEventListener('input', () => renderList(search.value.trim().toLowerCase()));
      document.addEventListener('mousedown', onDocDown, true);
      openPicker = close;
      search.focus();
      renderList('');
      // 展开时定位到当前选中项（列表长达数百项，落在最前面要翻很久）
      const sel = list.querySelector('.pk-item.sel');
      if (sel) sel.scrollIntoView({ block: 'center' });
    }
    btn.addEventListener('click', () => (panel ? close() : open()));
    let groups = [];
    return {
      setOptions(g) { groups = g; labels = new Map(); for (const gr of g) for (const it of gr.items) labels.set(it.value, it.label); lbl.textContent = labels.get(value) || fallback; },
      refresh(fb) { fallback = fb || ''; if (!labels.has(value)) lbl.textContent = labels.get(value) || fallback; },
      // 从存储回显（buildPickers 完成前 labels 可能还没这一项，先显示原始值，清单到位后 refresh 修正）
      set(v) { value = v || ''; lbl.textContent = labels.has(value) ? labels.get(value) : (value || fallback); },
      get value() { return value; },
    };
  }

  // 预览指定主题：'' = 按今天日期（标签随命中动态变化）
  let previewTheme = '';
  const themePick = makePicker($('theme_pick'), {
    onChange: (v) => { previewTheme = v; drawPreview(); },
  });
  // 默认背景风格：'' = 默认蓝渐变；选项与预览指定主题一致（含纪念日与主题包条目）
  const defaultPick = makePicker($('card_default_theme'), {
    onChange: (v) => save({ card_default_theme: v }),
  });

  function themeGroups() {
    const withDate = (t) => `${t.name}（${card.themeDateInYear(t)}）`;
    return [
      { label: '节日', items: card.THEME_LIST.filter((t) => !t.isTerm && !t.isMemorial).map((t) => ({ value: t.name, label: withDate(t) })) },
      { label: '二十四节气', items: card.THEME_LIST.filter((t) => t.isTerm).map((t) => ({ value: t.name, label: withDate(t) })) },
      { label: '纪念日', items: card.THEME_LIST.filter((t) => t.isMemorial).map((t) => ({ value: t.name, label: withDate(t) })) },
    ];
  }
  // 主题包分组：清单从各包 Pages 拉取（异步），拉取失败的包整组隐藏
  async function packGroups() {
    const out = [];
    for (const p of packs) {
      if (cfg[`pack_${p.id}`] !== true) continue; // 关闭的包不进选择器
      let m = null;
      try { m = await packsApi.ensure(p.id); } catch (e) { /* 忽略 */ }
      if (!m || !m.days) continue;
      const items = Object.keys(m.days).sort().map((k) => {
        const e = p.entry(m, k);
        return { value: `pack_${p.id}:${k}`, label: e.label || e.name };
      });
      if (items.length) out.push({ label: p.name, items });
    }
    return out;
  }
  async function buildPickers() {
    const pg = await packGroups();
    themePick.setOptions([...themeGroups(), ...pg]);
    defaultPick.setOptions([{ label: '默认', items: [{ value: '', label: '默认蓝渐变' }] }, ...themeGroups(), ...pg]);
    themePick.refresh(autoLabel());
    defaultPick.refresh('默认蓝渐变');
    updatePackStatuses();
  }

  // 首项说明跟随今天的命中结果（含纪念日开关）；主题包按注册表顺序优先（与 drawShareCard 一致）
  function autoLabel() {
    const today = card.resolveDayTheme(new Date(), { festival: cfg.card_festival_bg !== false, memorial: cfg.card_memorial_bg === true });
    let label = today ? today.name : (cfg.card_default_theme || '默认蓝渐变');
    // 默认风格指向主题包条目时解析成友好名（如「1月1日 · 梅花」）
    const defVal = cfg.card_default_theme || '';
    if (!today && defVal.startsWith('pack_')) {
      const ci = defVal.indexOf(':');
      const p = packs.find((x) => x.id === defVal.slice(5, ci));
      const m = p && packsApi ? packsApi.manifest(p.id) : null;
      const e = p && m ? p.entry(m, defVal.slice(ci + 1)) : null;
      if (e) label = e.label || e.name;
    }
    for (const p of packs) {
      if (cfg[`pack_${p.id}`] !== true) continue;
      const m = packsApi.manifest(p.id);
      const key = p.resolve(m, new Date());
      if (key) {
        const e = p.entry(m, key);
        if (e) { label = `${p.name} · ${e.label || e.name}`; break; }
      }
    }
    return `按今天日期（${label}）`;
  }

  // 主题包：开关行按注册表动态生成（新增包零改动）
  function buildPackRows() {
    const host = $('pack_rows');
    host.innerHTML = packs.map((p) => `
      <div class="row">
        <span class="txt"><b>${p.name}主题包（DLC）</b><span id="pack_status_${p.id}">${p.desc}；从网络按需加载，不影响扩展体积</span></span>
        <label class="ac-switch"><input type="checkbox" id="pack_${p.id}" /><span class="ac-switch-slider"></span></label>
      </div>`).join('');
    for (const p of packs) {
      $(`pack_${p.id}`).addEventListener('change', async (e) => {
        // 关包时：预览选中该包条目回退到按今天日期；默认风格指向该包条目也一并复位（包关=效果全停）
        const prefix = `pack_${p.id}:`;
        const patch = { [`pack_${p.id}`]: e.target.checked };
        if (!e.target.checked && (cfg.card_default_theme || '').startsWith(prefix)) patch.card_default_theme = '';
        save(patch);
        if (!e.target.checked && previewTheme.startsWith(prefix)) {
          previewTheme = '';
          themePick.set('');
        }
        await buildPickers();
        themePick.refresh(autoLabel());
      });
    }
  }
  function updatePackStatuses() {
    for (const p of packs) {
      const el = $(`pack_status_${p.id}`);
      if (!el) continue;
      const m = packsApi ? packsApi.manifest(p.id) : null;
      const count = m && m.days ? Object.keys(m.days).length : 0;
      if (cfg[`pack_${p.id}`] === true && count) {
        el.textContent = `已启用 · 已收录 ${count} 天（版本 v${m.version}），每天自动加载当天内容，仅拉取约 0.2MB`;
      } else if (cfg[`pack_${p.id}`] === true) {
        el.textContent = `已启用，主题清单尚未加载成功，稍后自动重试（断网时回落默认背景）`;
      } else {
        el.textContent = `${p.desc}；从网络按需加载（每天约 0.2MB），不影响扩展体积${count ? `，已收录 ${count} 天` : ''}，断网或未收录日期回落默认背景`;
      }
    }
  }
  buildPackRows(); // 行先建好，存储回调里的 render 才能设置开关状态与回显

  // ========== 实时预览：造一张示例网页图，按当前设置走真实的合成函数 ==========
  let sample = null;

  function makeSample() {
    const c = document.createElement('canvas');
    c.width = 900;
    c.height = 560;
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#f2f4fb';
    x.fillRect(0, 0, c.width, 56);
    x.fillStyle = '#4f6ef7';
    x.beginPath();
    x.arc(34, 28, 9, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = '#c3c9dd';
    [120, 170, 220].forEach((w, i) => x.fillRect(58 + i * 78, 24, w / 6, 9));
    x.font = '600 27px "PingFang SC", "Microsoft YaHei", sans-serif';
    x.fillStyle = '#1f2430';
    x.fillText('示例文章标题：网页截图的排版效果', 34, 116);
    x.fillStyle = '#dcdfeb';
    let y = 150;
    [820, 760, 830, 690, 800, 640, 780, 700].forEach((w, i) => {
      x.fillRect(34, y, w, 13);
      y += 30;
    });
    x.fillStyle = '#eef2ff';
    x.fillRect(34, y + 12, 380, 120);
    x.fillStyle = '#c7d2fe';
    x.fillRect(440, y + 12, 426, 120);
    return c.toDataURL('image/png');
  }

  // 预览渲染分两段：先立即按引擎当前缓存状态画（缓存冷时包背景暂回落默认蓝），
  // 再后台预热默认风格指向的包图，热了重画一次——预热绝不能阻塞出图，
  // 否则 pages.dev 网络慢时两张预览会一直挂空
  let packWarmKey = ''; // 已完成预热的默认风格值
  let drawing = false; // render 可能被高频触发，避免重入
  async function drawPreview() {
    if (drawing) return;
    drawing = true;
    try {
      // 预览选中的包若已被关闭，回退到按今天日期（兜底：开关监听里也会重置）
      if (previewTheme.startsWith('pack_')) {
        const ci = previewTheme.indexOf(':');
        if (cfg[`pack_${previewTheme.slice(5, ci)}`] !== true) {
          previewTheme = '';
          themePick.set('');
          themePick.refresh(autoLabel());
        }
      }
      if (!sample) sample = makeSample();
      const img = await loadImage(sample);
      await drawPreviewCards(img);
      const defVal = cfg.card_default_theme || '';
      if (defVal.startsWith('pack_') && packWarmKey !== defVal && globalThis.__acThemePacks) {
        packWarmKey = defVal;
        const i = defVal.indexOf(':');
        // 后台预热默认风格的包图，不 await——网络挂起时不能卡住 drawing 标志；
        // 热了重画一次（那时 drawShareCard 的 entrySync 才能命中包背景）
        globalThis.__acThemePacks
          .entry(defVal.slice(5, i), defVal.slice(i + 1))
          .then(() => { if (cfg.card_default_theme === defVal) return drawPreviewCards(img); })
          .catch(() => { /* 预热失败保持当前预览 */ });
      }
    } finally {
      drawing = false;
    }
  }

  async function drawPreviewCards(img) {
    try {
      const opts = { ...cfg };
      if (previewTheme) opts.theme_id = previewTheme;
      const url = card.composeScreenshot({ img, dataUrl: sample, url: SAMPLE_URL, time: Date.now(), opts });
      const el = $('previewImg');
      el.src = url;
      el.style.display = '';
    } catch (e) {
      $('previewImg').style.display = 'none';
    }
    // 划线分享金句卡片走真实 drawShareCard，与截图预览共用主题选择与开关（theme_id 同样只在本页临时生效）
    // 主题包预览：选中 pack_<id>:<key> 时显式传 packArt；未指定主题时走自动路径
    //（含 card_default_theme 为主题包条目的情况，card.js 经 entrySync 同步解析）
    try {
      const opts2 = {
        text: '选中网页里的一段文字，点「分享」，就能生成这样一张带二维码的金句卡片。',
        title: '示例文章标题：划线分享的排版效果',
        site: 'anycomment.qimengcheng-47e.workers.dev',
        url: SAMPLE_URL,
        festive: cfg.card_festival_bg !== false,
        memorial: cfg.card_memorial_bg === true,
        themeId: previewTheme.startsWith('pack_') ? '' : previewTheme,
        defaultTheme: cfg.card_default_theme || '',
      };
      if (previewTheme.startsWith('pack_')) {
        const colon = previewTheme.indexOf(':');
        const id = previewTheme.slice(5, colon);
        const key = previewTheme.slice(colon + 1);
        const info = globalThis.__acThemePacks ? await globalThis.__acThemePacks.entry(id, key) : null;
        if (!info) return;
        opts2.packArt = info;
      }
      const url2 = card.drawShareCard(opts2);
      const el2 = $('previewShareImg');
      el2.src = url2;
      el2.style.display = '';
    } catch (e) {
      $('previewShareImg').style.display = 'none';
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = src;
    });
  }
})();
