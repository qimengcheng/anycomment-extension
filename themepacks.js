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
    {
      id: 'monet',
      name: '莫奈画集',
      desc: '每周一幅莫奈名画背景',
      base: 'https://anycomment-monet-pack.pages.dev',
      // manifest.weeks = { 'NN': { n: 画名, f: 文件名 } }；NN = 一年第 N 周（ISO 周序号，53 周年份并入第 52 周）
      resolve(manifest, date) {
        if (!manifest || !manifest.weeks) return null;
        const key = String(Math.min(52, isoWeek(date))).padStart(2, '0');
        return manifest.weeks[key] ? key : null;
      },
      entry(manifest, key) {
        if (!manifest || !manifest.weeks) return null;
        const e = manifest.weeks[key];
        if (!e) return null;
        const n = displayName(e.n);
        return { name: n, file: e.f, label: `第${Number(key)}周 · ${n}` };
      },
      imageUrl(file) {
        return this.base + '/monet/' + file;
      },
    },
    {
      id: 'monet-k3',
      name: '莫奈十二景',
      desc: '每月一幅莫奈名画背景',
      base: 'https://anycomment-monet-pack.pages.dev',
      // 老版月更莫奈包（12 幅），assets 部署在同项目 /monet-k3/ 路径下，manifest 用 months 键
      resolve(manifest, date) {
        if (!manifest || !manifest.months) return null;
        const key = String(date.getMonth() + 1).padStart(2, '0');
        return manifest.months[key] ? key : null;
      },
      entry(manifest, key) {
        if (!manifest || !manifest.months) return null;
        const e = manifest.months[key];
        if (!e) return null;
        const n = displayName(e.n);
        return { name: n, file: e.f, label: `${Number(key)}月 · ${n}` };
      },
      imageUrl(file) {
        return this.base + '/monet-k3/' + file;
      },
    },
    {
      id: 'star',
      name: '星海漫游',
      desc: '每周一个深空天体，从太阳系航行到宇宙尺度',
      base: 'https://anycomment-star-pack.pages.dev',
      // manifest.weeks = { 'NN': { n: 天体名, f: 文件名 } }；NN = ISO 周序号（与莫奈画集同结构）
      resolve(manifest, date) {
        if (!manifest || !manifest.weeks) return null;
        const key = String(Math.min(52, isoWeek(date))).padStart(2, '0');
        return manifest.weeks[key] ? key : null;
      },
      entry(manifest, key) {
        if (!manifest || !manifest.weeks) return null;
        const e = manifest.weeks[key];
        if (!e) return null;
        const n = displayName(e.n);
        return { name: n, file: e.f, label: `第${Number(key)}周 · ${n}` };
      },
      imageUrl(file) {
        return this.base + '/star/' + file;
      },
    },
  ];

  const state = new Map(); // id -> { enabled, manifest, images: Map(key -> HTMLImageElement) }
  for (const p of PACKS) state.set(p.id, { enabled: false, manifest: null, images: new Map() });
  // pack_random_mode：多包同时开启时的择包策略。''=按注册表顺序优先；'day'=每天随机一包（日期播种，全天一致）；
  // 'load'=每次页面加载随机一包。旧版布尔 pack_random_pick=true 迁移为 'day'。
  let randomMode = '';

  function dayKey(d = new Date()) {
    return String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  }

  // ISO 周序号（周一为一周开始，含当年第一个周四的那周是第 1 周）
  function isoWeek(date) {
    const t = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    t.setDate(t.getDate() - ((t.getDay() + 6) % 7) + 3); // 移到所在周的周四
    const firstThu = new Date(t.getFullYear(), 0, 4);
    firstThu.setDate(firstThu.getDate() - ((firstThu.getDay() + 6) % 7) + 3);
    return 1 + Math.round((t - firstThu) / (7 * 24 * 3600 * 1000));
  }

  // 包条目集合的通用取值：days=按日包 / weeks=按周包 / months=按月包
  function packColl(manifest) {
    return (manifest && (manifest.days || manifest.weeks || manifest.months)) || null;
  }

  // 条目显示名（分享卡片右上角、设置页选择器、随机换图共用一个出口）：
  // 文件名里的下划线换成空格；「其他主题_」系列前缀直接去掉只留画名
  function displayName(n) {
    const s = n.startsWith('其他主题_') ? n.slice(5) : n;
    return s.replace(/_/g, ' ');
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
        const rec = { version: m.version, count: m.count, days: m.days, weeks: m.weeks, months: m.months, fetched_at: Date.now() };
        chrome.storage.local.set({ [cacheKey]: rec });
        return rec;
      }
    } catch (e) {
      // 离线等场景回落上次缓存
    }
    return cached;
  }

  // Fisher-Yates 洗牌，rand(i) 返回 0..i 的整数。随机只影响首选项，
  // 拉图失败仍按洗牌后的顺序顺延，兜底链不变。
  function shuffleWith(list, rand) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = rand(i);
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }
  // 按日期（MMDD）播种的确定性随机源：同一天每次调用序列一致，跨天不同
  function dayRand(dk) {
    let seed = 2166136261; // FNV-1a 起点
    for (let i = 0; i < dk.length; i++) {
      seed ^= dk.charCodeAt(i);
      seed = Math.imul(seed, 16777619) >>> 0;
    }
    return (i) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % (i + 1);
    };
  }

  // 就绪的包里取第一个命中的：发布 { packId, key, name, img }；都不命中发布 null。
  // 中途跨天按打开那天的图显示，下次导航自然换新，不为此加定时器。
  async function publish() {
    // 先收集「已开启 + 清单在手 + 今天命中」的所有候选，再按顺序取第一个图片加载成功的（拉图失败自动顺延，兜底链不变）
    const candidates = [];
    for (const pack of PACKS) {
      const st = state.get(pack.id);
      if (!st.enabled || !st.manifest) continue;
      const key = pack.resolve(st.manifest, new Date());
      if (!key) continue;
      const e = pack.entry(st.manifest, key);
      if (!e) continue;
      candidates.push({ pack, key, e });
    }
    if (candidates.length > 1) {
      if (randomMode === 'day') shuffleWith(candidates, dayRand(dayKey()));
      else if (randomMode === 'load') shuffleWith(candidates, (i) => Math.floor(Math.random() * (i + 1)));
    }
    for (const { pack, key, e } of candidates) {
      const st = state.get(pack.id);
      let img = st.images.get(key);
      if (!img) {
        try {
          img = await loadImage(pack.imageUrl(e.file));
          st.images.set(key, img);
        } catch (err) {
          continue; // 拉图失败试下一个候选，最后回落 null
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
        { ...Object.fromEntries(PACKS.map((p) => [`pack_${p.id}`, false])), card_default_theme: '', pack_random_mode: '', pack_random_pick: false },
        (x) => r(x)
      )
    );
    randomMode = v.pack_random_mode || (v.pack_random_pick ? 'day' : ''); // 旧布尔开关迁移
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
    if (changes.pack_random_mode) {
      randomMode = changes.pack_random_mode.newValue || '';
      publish();
    }
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
    // 预览「换一张背景」可用性：任一已开启的包清单在手且有内容
    randomReady() {
      return PACKS.some((p) => {
        const st = state.get(p.id);
        return st.enabled && st.manifest && packColl(st.manifest);
      });
    },
    // 随机取一个包条目（含懒加载图片），供分享预览「换一张背景」重合成。
    // exclude = 'packId:key' 时避开当前这张（只影响首选，被避开项外的图全失败仍会兜底回去）。
    // 返回 { packId, key, name, label, img }；无包可用/全部拉图失败返回 null
    async randomEntry(exclude = '') {
      const pool = [];
      for (const p of PACKS) {
        const st = state.get(p.id);
        if (!st.enabled || !st.manifest) continue;
        const coll = packColl(st.manifest);
        if (!coll) continue;
        for (const key of Object.keys(coll)) {
          if (`${p.id}:${key}` === exclude) continue;
          const e = p.entry(st.manifest, key);
          if (e) pool.push({ pack: p, key, e });
        }
      }
      // Fisher-Yates 全随机洗牌后顺序尝试，拉图失败自动换下一张
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      for (const { pack, key, e } of pool) {
        const st = state.get(pack.id);
        let img = st.images.get(key);
        if (!img) {
          try {
            img = await loadImage(pack.imageUrl(e.file));
            st.images.set(key, img);
          } catch (err) {
            continue;
          }
        }
        return { packId: pack.id, key, name: e.name, label: e.label || e.name, img };
      }
      return null;
    },
  };
})();
