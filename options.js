// AnyComment 截图设置页：读写 chrome.storage.local 的 shot_* 配置 + 展示 commands 绑定 + 实时预览
(() => {
  const card = globalThis.__acCard;
  const $ = (id) => document.getElementById(id);
  const KEYS = Object.keys(card.SHOT_DEFAULTS);
  const SAMPLE_URL = 'https://anycomment.qimengcheng-47e.workers.dev/产品笔记/2026-09-网页截图';
  let cfg = { ...card.SHOT_DEFAULTS };

  chrome.storage.local.get(card.SHOT_DEFAULTS, (v) => {
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

  // 预览选择器：节日在前、节气在后分组，每项带当年实际日期（腊八这类农历年末节日算"今年过的那次"）
  const themeSel = $('theme_pick');
  function buildThemeOptions() {
    const withDate = (t) => `${t.name}（${card.themeDateInYear(t)}）`;
    themeSel.innerHTML = `<option value=""></option>`
      + `<optgroup label="节日">${card.THEME_LIST.filter((t) => !t.isTerm).map((t) => `<option value="${t.name}">${withDate(t)}</option>`).join('')}</optgroup>`
      + `<optgroup label="二十四节气">${card.THEME_LIST.filter((t) => t.isTerm).map((t) => `<option value="${t.name}">${withDate(t)}</option>`).join('')}</optgroup>`;
    themeSel.addEventListener('change', () => { previewTheme = themeSel.value; drawPreview(); });
  }
  // 首项说明跟随今天的命中结果；无命中时提示将使用的兜底默认风格
  function updateAutoLabel() {
    const today = card.resolveTheme(new Date());
    themeSel.querySelector('option').textContent = `按今天日期（${today ? today.name : cfg.card_default_theme || '默认蓝渐变'}）`;
  }
  buildThemeOptions();

  // 默认背景风格：默认蓝渐变 + 全部节日风格（当天无命中时生效；关掉节日开关时它就是常驻风格）
  $('card_default_theme').innerHTML = `<option value="">默认蓝渐变</option>`
    + card.THEME_LIST.filter((t) => !t.isTerm).map((t) => `<option value="${t.name}">${t.name}</option>`).join('');

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
