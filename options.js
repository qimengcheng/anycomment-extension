// AnyComment 截图设置页：读写 chrome.storage.local 的 shot_* 配置 + 展示 commands 绑定 + 实时预览
(() => {
  const card = globalThis.__acCard;
  const $ = (id) => document.getElementById(id);
  const KEYS = Object.keys(card.SHOT_DEFAULTS);
  const SAMPLE_URL = 'https://anycomment.qimengcheng-47e.workers.dev/产品笔记/2026-09-网页截图';
  let cfg = { ...card.SHOT_DEFAULTS };

  // 主题包（DLC）开关：按注册表动态生成（新增包零改动），键名 pack_<id>，默认关
  const packs = (globalThis.__acThemePacks && globalThis.__acThemePacks.packs) || [];
  const packDefaults = Object.fromEntries(packs.map((p) => [`pack_${p.id}`, false]));
  chrome.storage.local.get({ ...card.SHOT_DEFAULTS, ...packDefaults }, (v) => {
    cfg = { ...card.SHOT_DEFAULTS, ...v };
    render();
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
    $('card_default_theme').value = cfg.card_default_theme || '';
    $(cfg.shot_qr_overlay ? 'pos_overlay' : 'pos_strip').checked = true;
    $('cornerBox').classList.toggle('off', !cfg.shot_qr_overlay || !cfg.shot_qr);
    const corner = document.querySelector(`input[name="corner"][value="${cfg.shot_qr_corner}"]`);
    if (corner) corner.checked = true;
    $('shot_default_mode').value = cfg.shot_default_mode;
    updateAutoLabel();
    drawPreview();
  }

  $('shot_qr').addEventListener('change', (e) => save({ shot_qr: e.target.checked }));
  $('shot_time').addEventListener('change', (e) => save({ shot_time: e.target.checked }));
  $('shot_brand').addEventListener('change', (e) => save({ shot_brand: e.target.checked }));
  $('card_festival_bg').addEventListener('change', (e) => save({ card_festival_bg: e.target.checked }));
  $('card_memorial_bg').addEventListener('change', (e) => save({ card_memorial_bg: e.target.checked }));
  $('card_default_theme').addEventListener('change', (e) => save({ card_default_theme: e.target.value }));
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
    'capture-fullpage': '截取完整页面',
  };
  chrome.commands.getAll((cmds) => {
    const rows = cmds
      .filter((c) => LABELS[c.name])
      .map((c) => `<tr><td class="k">${LABELS[c.name]}</td><td class="v">${c.shortcut || '未生效'}</td></tr>`)
      .join('');
    $('keys').tBodies[0].innerHTML = rows || '<tr><td class="k">未读到命令</td><td class="v">-</td></tr>';
  });

  // ========== 实时预览：造一张示例网页图，按当前设置走真实的合成函数 ==========
  let sample = null;
  // 主题预览选择：仅本页临时生效，不写入 storage
  let previewTheme = '';

  // 预览选择器：节日在前、节气居中、纪念日在后分组，每项带当年实际日期（腊八这类农历年末节日算"今年过的那次"）
  const themeSel = $('theme_pick');
  function buildThemeOptions() {
    const withDate = (t) => `${t.name}（${card.themeDateInYear(t)}）`;
    themeSel.innerHTML = `<option value=""></option>`
      + `<optgroup label="节日">${card.THEME_LIST.filter((t) => !t.isTerm && !t.isMemorial).map((t) => `<option value="${t.name}">${withDate(t)}</option>`).join('')}</optgroup>`
      + `<optgroup label="二十四节气">${card.THEME_LIST.filter((t) => t.isTerm).map((t) => `<option value="${t.name}">${withDate(t)}</option>`).join('')}</optgroup>`
      + `<optgroup label="纪念日">${card.THEME_LIST.filter((t) => t.isMemorial).map((t) => `<option value="${t.name}">${withDate(t)}</option>`).join('')}</optgroup>`
      + packs.map((p) => `<optgroup label="${p.name}" id="pack_opt_${p.id}"></optgroup>`).join('');
    themeSel.addEventListener('change', () => { previewTheme = themeSel.value; drawPreview(); });
  }
  // 主题包：开关行 + 预览分组都按注册表动态生成；清单从各包 Pages 拉取（异步），失败则该组隐藏
  function buildPackRows() {
    const host = $('pack_rows');
    host.innerHTML = packs.map((p) => `
      <div class="row">
        <span class="txt"><b>${p.name}主题包（DLC）</b><span id="pack_status_${p.id}">${p.desc}；从网络按需加载，不影响扩展体积</span></span>
        <label class="ac-switch"><input type="checkbox" id="pack_${p.id}" /><span class="ac-switch-slider"></span></label>
      </div>`).join('');
    for (const p of packs) {
      $(`pack_${p.id}`).addEventListener('change', (e) => save({ [`pack_${p.id}`]: e.target.checked }));
    }
  }
  async function buildPackOptions() {
    for (const p of packs) {
      const og = document.getElementById(`pack_opt_${p.id}`);
      if (!og) continue;
      let m = null;
      try { m = await globalThis.__acThemePacks.ensure(p.id); } catch (e) { /* 忽略，分组隐藏 */ }
      const og2 = document.getElementById(`pack_opt_${p.id}`); // await 之后可能已被重排
      if (!og2) continue;
      const days = m && m.days ? Object.keys(m.days).sort() : [];
      if (!days.length) { og2.remove(); updatePackStatuses(); continue; }
      og2.innerHTML = days.map((k) => {
        const e = p.entry(m, k);
        return `<option value="pack_${p.id}:${k}">${e.label || e.name}</option>`;
      }).join('');
    }
    updatePackStatuses();
  }
  function updatePackStatuses() {
    for (const p of packs) {
      const el = $(`pack_status_${p.id}`);
      if (!el) continue;
      const m = globalThis.__acThemePacks.manifest(p.id);
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
  // 首项说明跟随今天的命中结果（含纪念日开关）；无命中时提示将使用的兜底默认风格。
  // 主题包按注册表顺序优先：开启且当天有收录时展示包内条目名（与 drawShareCard 优先级一致）
  function updateAutoLabel() {
    const today = card.resolveDayTheme(new Date(), { festival: cfg.card_festival_bg !== false, memorial: cfg.card_memorial_bg === true });
    let label = today ? today.name : (cfg.card_default_theme || '默认蓝渐变');
    for (const p of packs) {
      if (cfg[`pack_${p.id}`] !== true) continue;
      const m = globalThis.__acThemePacks.manifest(p.id);
      const key = p.resolve(m, new Date());
      if (key) {
        const e = p.entry(m, key);
        if (e) { label = `${p.name} · ${e.name}`; break; }
      }
    }
    themeSel.querySelector('option').textContent = `按今天日期（${label}）`;
  }
  buildPackRows();
  buildThemeOptions();
  buildPackOptions();

  // 默认背景风格：默认蓝渐变 + 全部节日与节气风格（当天无命中时生效；关掉节日开关时它就是常驻风格）。
  // 纪念日风格不进此列表——严肃主题不做常驻默认，只由纪念日开关控制
  $('card_default_theme').innerHTML = `<option value="">默认蓝渐变</option>`
    + `<optgroup label="节日">${card.THEME_LIST.filter((t) => !t.isTerm && !t.isMemorial).map((t) => `<option value="${t.name}">${t.name}</option>`).join('')}</optgroup>`
    + `<optgroup label="二十四节气">${card.THEME_LIST.filter((t) => t.isTerm).map((t) => `<option value="${t.name}">${t.name}</option>`).join('')}</optgroup>`;

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

  async function drawPreview() {
    if (!sample) sample = makeSample();
    const img = await loadImage(sample);
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
    // 主题包预览：theme_pick 选了 pack_<id>:<key> 时显式传 packArt；未指定主题且包开启时走
    // 自动路径（card.js 读 __acThemePack）
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
