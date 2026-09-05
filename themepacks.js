// 主题包（DLC）通用引擎：未来所有可下载主题包都走这套规则
// 每个包在 PACKS 注册表里声明：{ id, name, desc, base, resolve, entry, imageUrl }，
// 引擎统一负责：开关存储（pack_<id>）、manifest 缓存（pack_<id>_manifest，24h）、
// 按 key 懒加载图片（内存 Map）、胜出包发布到 globalThis.__acThemePack 供 card.js 同步读取。
// 优先级：注册表顺序（前面的包先命中）；未收录日期/断网/拉图失败 → 发布 null 回落默认背景。
// 图片一律 crossOrigin='anonymous'（Pages 已下发 ACAO:*），保证 canvas 不被污染、toDataURL 可用。
(() => {
  const MANIFEST_TTL = 24 * 3600 * 1000; // manifest 每天最多拉一次（version 变化靠下次刷新生效）

  // ---- 主题包注册表（新增包 = 加一个对象，引擎零改动）----
  const PACKS = [
    {
      id: 'flower',
      name: '花开有时',
      desc: '每天一种花的国风水彩背景',
      base: 'https://anycomment-flower-pack.pages.dev',
      // manifest.days = { 'MMDD': { n: 花名, f: 文件名 } }；当天有收录返回 key，否则 null
      resolve(manifest, date) {
        if (!manifest || !manifest.days) return null;
        const key = String(date.getMonth() + 1).padStart(2, '0') + String(date.getDate()).padStart(2, '0');
        return manifest.days[key] ? key : null;
      },
      entry(manifest, key) {
        if (!manifest || !manifest.days) return null;
        const e = manifest.days[key];
        return e ? { name: e.n, file: e.f, label: `${Number(key.slice(0, 2))}月${Number(key.slice(2))}日 · ${e.n}` } : null;
      },
      imageUrl(file) {
        return this.base + '/flowers/' + file;
      },
    },
  ];

  const state = new Map(); // id -> { enabled, manifest, images: Map(key -> HTMLImageElement) }
  for (const p of PACKS) state.set(p.id, { enabled: false, manifest: null, images: new Map() });

  function dayKey(d = new Date()) {
    return String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const i = new Image();
      const timer = setTimeout(() => reject(new Error('theme pack image timeout')), 15000);
      i.onload = () => { clearTimeout(timer); resolve(i); };
      i.onerror = () => { clearTimeout(timer); reject(new Error('theme pack image load fail')); };
      i.crossOrigin = 'anonymous';
      i.src = url;
    });
  }

  async function fetchManifest(pack, force = false) {
    const st = state.get(pack.id);
    const cacheKey = `pack_${pack.id}_manifest`;
    const cached = await new Promise((r) =>
      chrome.storage.local.get({ [cacheKey]: null }, (v) => r(v[cacheKey]))
    );
    // 缓存 24h；但缓存里查不到今天时（包刚扩充/新部署）要尽快重拉自愈，
    // 否则要等整整一天才能看到新增日期——重拉节流 10 分钟防网络差时反复打
    const todayCovered = cached && pack.resolve(cached, new Date());
    if (!force && cached && Date.now() - cached.fetched_at < MANIFEST_TTL) {
      if (todayCovered) return cached;
      if (Date.now() - cached.fetched_at < 10 * 60 * 1000) return cached;
    }
    try {
      // 8 秒超时：pages.dev 不可达时不能让 await 链挂死（预览/发布都依赖它返回）
      const res = await fetch(pack.base + '/manifest.json', { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const m = await res.json();
        const rec = { version: m.version, count: m.count, days: m.days, fetched_at: Date.now() };
        chrome.storage.local.set({ [cacheKey]: rec });
        return rec;
      }
    } catch (e) {
      // 离线等场景回落上次缓存
    }
    return cached;
  }

  // 就绪的包按注册表顺序取第一个命中的：发布 { packId, key, name, img }；都不命中发布 null。
  // 中途跨天按打开那天的图显示，下次导航自然换新，不为此加定时器。
  async function publish() {
    for (const pack of PACKS) {
      const st = state.get(pack.id);
      if (!st.enabled || !st.manifest) continue;
      const key = pack.resolve(st.manifest, new Date());
      if (!key) continue;
      const e = pack.entry(st.manifest, key);
      if (!e) continue;
      let img = st.images.get(key);
      if (!img) {
        try {
          img = await loadImage(pack.imageUrl(e.file));
          st.images.set(key, img);
        } catch (err) {
          continue; // 拉图失败试下一个包，最后回落 null
        }
      }
      globalThis.__acThemePack = { packId: pack.id, key, name: e.name, label: e.label || e.name, img };
      return;
    }
    globalThis.__acThemePack = null;
  }

  async function refreshPack(pack, force = false) {
    const st = state.get(pack.id);
    if (!st.enabled) return;
    st.manifest = await fetchManifest(pack, force);
    await publish();
  }

  // 开关读取与变更监听：关掉立即重新发布（可能回落到后面的包或 null）。
  // 所有包的 manifest 都常拉（默认风格兜底 card_default_theme 指向包条目时需要同步解析），
  // 但只为开启的包预取当天图
  async function init() {
    const v = await new Promise((r) =>
      chrome.storage.local.get(
        { ...Object.fromEntries(PACKS.map((p) => [`pack_${p.id}`, false])), card_default_theme: '' },
        (x) => r(x)
      )
    );
    for (const p of PACKS) {
      const st = state.get(p.id);
      st.enabled = v[`pack_${p.id}`] === true;
      st.manifest = await fetchManifest(p);
    }
    await publish();
    await warmDefaultPack();
  }
  // card_default_theme 指向包条目（pack_<id>:<key>）时预热图片缓存，
  // 供 card.js 的 defaultTheme 同步解析（entrySync）命中
  async function warmDefaultPack() {
    const v = await new Promise((r) => chrome.storage.local.get({ card_default_theme: '' }, (x) => r(x.card_default_theme)));
    const val = v || '';
    if (!val.startsWith('pack_')) return;
    const ci = val.indexOf(':');
    const id = val.slice(5, ci);
    const key = val.slice(ci + 1);
    const pack = PACKS.find((p) => p.id === id);
    const st = state.get(id);
    if (!pack || !st || !st.manifest || st.images.has(key)) return;
    const e = pack.entry(st.manifest, key);
    if (!e) return;
    try {
      st.images.set(key, await loadImage(pack.imageUrl(e.file)));
    } catch (err) {
      // 加载失败保持无兜底
    }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const p of PACKS) {
      const k = `pack_${p.id}`;
      if (!changes[k]) continue;
      state.get(p.id).enabled = changes[k].newValue === true;
      // 手动开启 = 明确要最新清单，强制重拉（也是用户遇到清单过旧时的自救手段）
      if (state.get(p.id).enabled) refreshPack(p, true);
      else publish();
    }
    if (changes.card_default_theme) warmDefaultPack();
  });
  init();

  // 设置页预览用接口
  globalThis.__acThemePacks = {
    packs: PACKS,
    manifest: (id) => (state.get(id) || {}).manifest || null,
    async ensure(id, force = false) {
      const pack = PACKS.find((p) => p.id === id);
      if (!pack) return null;
      const st = state.get(id);
      st.manifest = await fetchManifest(pack, force);
      await publish();
      return st.manifest;
    },
    // 按 key 取 { name, label, img }（含懒加载），供预览显式绘制
    async entry(id, key) {
      const pack = PACKS.find((p) => p.id === id);
      const st = state.get(id);
      if (!pack || !st) return null;
      if (!st.manifest) await this.ensure(id);
      if (!st.manifest) return null; // 清单不可用（断网等）
      const e = pack.entry(st.manifest, key);
      if (!e) return null;
      let img = st.images.get(key);
      if (!img) {
        try {
          img = await loadImage(pack.imageUrl(e.file));
          st.images.set(key, img);
        } catch (err) {
          return null;
        }
      }
      return { name: e.name, label: e.label || e.name, img };
    },
    // 同步版本：只读内存缓存（图片须已预热），供 card.js 解析 defaultTheme 兜底。
    // 包被关闭时返回 null——开关控制该包的一切效果
    entrySync(id, key) {
      const pack = PACKS.find((p) => p.id === id);
      const st = state.get(id);
      if (!pack || !st || !st.enabled || !st.manifest) return null;
      const e = pack.entry(st.manifest, key);
      const img = st.images.get(key);
      if (!e || !img) return null;
      return { name: e.name, label: e.label || e.name, img };
    },
  };
})();
