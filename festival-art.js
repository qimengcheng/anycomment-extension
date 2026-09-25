// 节日/纪念日/节气海报加载器：内置手绘渐变主题之外的第二套视觉素材。
// 主题命中复用 card-art.js 的 resolveDayTheme（农历/节气推算的唯一事实来源，勿另写一套），
// 海报清单与图片存 anycomment-festival-pack.pages.dev（manifest.themes 的键 = THEME_LIST 主题名）。
// 当天命中且图就绪时优先于主题包（2026-09-25 用户拍板「节日图优先」）；图未就绪/断网/清单
// 不可用时返回 null，card.js 自动回落主题包与手绘渐变（兜底链不变，手绘代码保留作兜底）。
// 图片一律 crossOrigin='anonymous'（Pages 已下发 ACAO:*），保证 canvas 不被污染、toDataURL 可用。
// 加载顺序：card-core.js → card-art.js → 本文件 → card.js（card.js 同步读取，本文件必须先就位）
(() => {
  const BASE = 'https://anycomment-festival-pack.pages.dev';
  const MANIFEST_TTL = 24 * 3600 * 1000; // manifest 每天最多拉一次
  const CACHE_KEY = 'festival_art_manifest';
  const art = globalThis.__acCardArt; // 前置文件提供：resolveDayTheme / THEME_LIST / themeDateInYear

  let manifest = null;
  const images = new Map(); // 主题名 -> HTMLImageElement（仅内存，页面生命周期）
  const failed = new Set(); // 加载失败的主题名：本页不再重试，下次导航重来
  let lastPull = 0; // 自愈重拉节流

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const i = new Image();
      const timer = setTimeout(() => reject(new Error('festival art image timeout')), 15000);
      i.onload = () => { clearTimeout(timer); resolve(i); };
      i.onerror = () => { clearTimeout(timer); reject(new Error('festival art image load fail')); };
      i.crossOrigin = 'anonymous';
      i.src = url;
    });
  }

  async function fetchManifest(force = false) {
    const cached = await new Promise((r) =>
      chrome.storage.local.get({ [CACHE_KEY]: null }, (v) => r(v[CACHE_KEY]))
    );
    // 缓存 24h；今天命中的主题不在缓存里时（包刚扩充/重部署）节流重拉自愈
    const today = todayName();
    const todayCovered = cached && cached.themes && (!today || cached.themes[today]);
    if (!force && cached && Date.now() - cached.fetched_at < MANIFEST_TTL) {
      if (todayCovered) return cached;
      if (Date.now() - cached.fetched_at < 10 * 60 * 1000) return cached;
    }
    try {
      const res = await fetch(BASE + '/manifest.json', { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const m = await res.json();
        const rec = { version: m.version, count: m.count, themes: m.themes, fetched_at: Date.now() };
        chrome.storage.local.set({ [CACHE_KEY]: rec });
        lastPull = Date.now();
        return rec;
      }
    } catch (e) {
      // 离线等场景回落上次缓存
    }
    return cached;
  }

  // 当天命中的主题名。预热用双开（无视开关，多预热一张 ~43KB 图换取开关切换即时生效）；
  // 绘制端 day() 用调用方传入的开关重算
  function todayName() {
    try {
      const t = art.resolveDayTheme(new Date(), { festival: true, memorial: true });
      return t ? t.name : null;
    } catch (e) {
      return null;
    }
  }

  function ensureImage(name) {
    if (!manifest || !manifest.themes[name] || images.has(name) || failed.has(name)) return null;
    const e = manifest.themes[name];
    loadImage(BASE + '/festival/' + e.f)
      .then((img) => images.set(name, img))
      .catch(() => failed.add(name));
    return null;
  }

  // 卡片右上角标签：对齐主题包「日期 · 名目」口径；推算不到日期（表外年份等）时只给名字
  function make(name) {
    const img = images.get(name);
    if (!img) return null;
    let label = name;
    try {
      const t = art.THEME_LIST.find((x) => x.name === name);
      const d = t ? art.themeDateInYear(t, new Date().getFullYear()) : null;
      if (d) label = `${d} · ${name}`;
    } catch (e) { /* 名字兜底 */ }
    return { name, label, img };
  }

  async function preload() {
    manifest = await fetchManifest(false);
    if (!manifest) return;
    ensureImage(todayName());
    // 默认背景风格指向节日主题时也预热（drawShareCard 的 defaultTheme 兜底要同步命中）
    const def = await new Promise((r) =>
      chrome.storage.local.get({ card_default_theme: '' }, (x) => r(x.card_default_theme || ''))
    );
    if (def && manifest.themes[def]) ensureImage(def);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[CACHE_KEY] && changes[CACHE_KEY].newValue) manifest = changes[CACHE_KEY].newValue;
    if (changes.card_default_theme && manifest) {
      const v = changes.card_default_theme.newValue || '';
      if (manifest.themes[v]) ensureImage(v);
    }
  });
  preload();

  globalThis.__acFestivalArt = {
    // 同步取当天命中的海报（festival/memorial 开关由调用方传入，与 drawShareCard 的
    // festive/memorial、composeScreenshot 的 card_festival_bg/card_memorial_bg 同义）。
    // 图未就绪返回 null——绘制链路必须同步返回，绝不 await 网络（预热在 init 已发起）
    day({ festival = true, memorial = false } = {}) {
      if (!manifest) return null;
      let t = null;
      try {
        t = art.resolveDayTheme(new Date(), { festival, memorial });
      } catch (e) {
        return null;
      }
      return t && manifest.themes[t.name] ? make(t.name) : null;
    },
    // 同步按名字取（仅内存缓存命中才有值），供 drawShareCard 的 defaultTheme 兜底
    syncByName(name) {
      return manifest && manifest.themes[name] ? make(name) : null;
    },
    // 异步按名字取（设置页预览用：首次拉清单/图后返回，失败返回 null 由调用方回落手绘）
    async entry(name) {
      if (!manifest) manifest = await fetchManifest(false);
      if (!manifest || !manifest.themes[name]) return null;
      if (!images.has(name)) {
        try {
          const e = manifest.themes[name];
          images.set(name, await loadImage(BASE + '/festival/' + e.f));
        } catch (e) {
          return null;
        }
      }
      return make(name);
    },
  };
})();
