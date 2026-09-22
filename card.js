// AnyComment 共享绘制模块（拆分自 card.js）：主题包背景工具 · 金句卡片 · 截图合成 · 预览浮层
// 与 content.js / capture.js 同在 content_scripts 隔离世界（manifest 按序加载），用全局命名空间交换
// 加载顺序：card-core.js → card-art.js → card.js
(() => {
  // 解构放 IIFE 顶部（而非末尾导出块旁）：消灭 TDZ 风险，中段新增加载期调用也安全
  const C = globalThis.__acCardCore, CI = globalThis.__acCardCoreInternals;
  const A = globalThis.__acCardArt, AI = globalThis.__acCardArtInternals;
  const { fontMain, wrapText, roundRectPath, buildQrMatrix, drawQrModules, paintWhiteCard, SHOT_DEFAULTS, fmtShotTime, cleanUrlForQr } = C;
  const { paintGlassPanel, glassTextHalo, frostText, GLASS_STYLES } = CI;
  const { paintBackdrop, paintCardAccent, resolveTheme, resolveDayTheme, themeDateInYear, THEME_LIST, paintMarker, paintDoodle, MARKER_PALETTE } = A;
  const { paintThemeIcon, makeRng } = AI;

  // 主题包图片整体平均色（按 1x1 缩绘取样），用于海报外留白的底色延伸
  // 主题包截图背景呈现参数（v1.57 用户调参器定稿）：曲线 LUT 控制点、提亮、截图垫白、白底浓度
  const PACK_SHOT = {
    curve: [[0, 1], [0.08, 0.12], [1, 1]],
    lighten: 0.8,
    underlay: 0.7,
    chip: 0.7,
  };
  let packCurveLUT = null;
  function packCurveBuild() {
    const pts = PACK_SHOT.curve.slice().sort((a, b) => a[0] - b[0]);
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      const x = i / 255;
      let j = 0;
      while (j < pts.length - 2 && x > pts[j + 1][0]) j++;
      const x0 = pts[j][0], y0 = pts[j][1], x1 = pts[j + 1][0], y1 = pts[j + 1][1];
      const t = x1 > x0 ? Math.min(1, Math.max(0, (x - x0) / (x1 - x0))) : 0;
      const sm = t * t * (3 - 2 * t); // 段内 smoothstep，过渡平滑
      lut[i] = Math.round(255 * (y0 + (y1 - y0) * sm));
    }
    packCurveLUT = lut;
  }
  // 曲线效果：暗部（墨色笔触）压向白色，海报变成浅色纹理纸
  function packCurveApply(ctx, w, h) {
    if (!packCurveLUT) packCurveBuild();
    const d = ctx.getImageData(0, 0, w, h);
    const px = d.data;
    for (let i = 0; i < px.length; i += 4) {
      px[i] = packCurveLUT[px[i]];
      px[i + 1] = packCurveLUT[px[i + 1]];
      px[i + 2] = packCurveLUT[px[i + 2]];
    }
    ctx.putImageData(d, 0, 0);
  }

  function imageAvgColor(img) {
    if (img.__acAvg) return img.__acAvg;
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, 1, 1);
    const d = x.getImageData(0, 0, 1, 1).data;
    img.__acAvg = `rgb(${d[0]},${d[1]},${d[2]})`;
    return img.__acAvg;
  }

  // ===== 划线强调（小红书风）：把已换行的引用文字拆成带坐标的词块 =====
  // 与 wrapText 同一 token 正则，逐块累加 measureText 得到行内 x 偏移；drawShareCard 逐块绘制、
  // 预览层按同一坐标命中「点词切换高亮」，绘制与命中共用一套数字，绝不跑偏。
  const QUOTE_FONT = 30, QUOTE_W = 720, QUOTE_PAD = 56, QUOTE_LINEH = 48, QUOTE_TOP = 150;
  const QUOTE_TOKEN_RE = /[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*|\s+|\S/gu;
  function quoteMeasurer() {
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = fontMain(QUOTE_FONT, 600);
    return meas;
  }
  function tokenizeLine(ctx, line) {
    const toks = String(line).match(QUOTE_TOKEN_RE) || [];
    let x = 0;
    const out = [];
    for (const t of toks) {
      const w = ctx.measureText(t).width;
      out.push({ t, x, w });
      x += w;
    }
    return out;
  }
  // 引用文字的词块布局：{ lines: [字符串], tokens: [[{t,x,w}]] }，绘制与命中测试共用
  function buildQuoteLayout(text) {
    const meas = quoteMeasurer();
    const lines = wrapText(meas, text, QUOTE_W - QUOTE_PAD * 2, 10);
    return { lines, tokens: lines.map((ln) => tokenizeLine(meas, ln)) };
  }
  // 自动识别关键词：命中「英文/数字词（去符号后长度≥2）」，中文等其余词留给用户点选。
  // 返回 key 列表 "行:块"，与 buildQuoteLayout 坐标口径一致。
  function autoHighlightKeys(text) {
    const { tokens } = buildQuoteLayout(text);
    const keys = [];
    tokens.forEach((line, li) => line.forEach((tok, ti) => {
      if (/^[A-Za-z0-9]/.test(tok.t) && tok.t.replace(/[^A-Za-z0-9]/g, '').length >= 2) keys.push(`${li}:${ti}`);
    }));
    return keys;
  }
  let LAST_QUOTE = null; // 最近一次带划线的 drawShareCard 布局，供预览层命中测试

  // ===== 预览层「按住拖动划线」的命中（点词与拖动共用，勿各写一套坐标口径）=====
  const isQuoteSpace = (t) => /^\s+$/.test(t);
  // 一行的可命中词块下标：空白只当词间胶水，不作为选词端点
  function quoteWordIdxs(line) {
    const out = [];
    for (let i = 0; i < line.length; i++) if (!isQuoteSpace(line[i].t)) out.push(i);
    return out;
  }
  // 分数坐标 → 最近的词块 { li, ti }。纵向优先取所在行，落在行距/文字区外时钳到最近一行；
  // 横向按「到词块区间的距离」取最近词：落在词内距离 0（词的左右半部都算这个词，勿改成中点二分，
  // 那样点在词右半边会误命中下一个词），落在词间空隙则取较近的一边、并列偏左
  function quoteNearest(L, fx, fy) {
    const cx = fx * L.W, cy = fy * L.H;
    let li = 0, best = Infinity;
    for (let i = 0; i < L.tokens.length; i++) {
      const yTop = L.quoteTop + i * L.lineH - 20;
      if (cy >= yTop - 8 && cy <= yTop + L.fs + 8) { li = i; break; }
      const d = Math.abs(cy - (yTop + L.fs / 2));
      if (d < best) { best = d; li = i; }
    }
    const words = quoteWordIdxs(L.tokens[li]);
    if (!words.length) return null;
    let ti = words[0];
    best = Infinity;
    for (const k of words) {
      const tok = L.tokens[li][k];
      const x0 = L.PAD + tok.x, x1 = x0 + tok.w;
      const d = cx < x0 ? x0 - cx : (cx > x1 ? cx - x1 : 0);
      if (d < best) { best = d; ti = k; }
    }
    return { li, ti };
  }
  // 两点（相对图片的分数坐标 0~1）→ 按阅读顺序整段选中：{ anchor, keys, rects }，无布局时 null。
  // anchor = 起点词块 key（调用方据此决定整段是划上还是擦掉）；keys = 起点到终点之间所有词块
  // （中间整行全选，与网页里选一段文字一致）；rects = 逐行合并后的长条，仍是分数坐标，
  // 竖直位置对齐 paintMarker 的笔带（top = yTop + fs*0.48、厚 = max(13, fs*0.52)），
  // 拖动预览按百分比贴上去就是松手后荧光笔真正出现的地方。
  function quoteRangeAt(fx0, fy0, fx1, fy1) {
    const L = LAST_QUOTE;
    if (!L || !L.tokens.length) return null;
    const a = quoteNearest(L, fx0, fy0), b = quoteNearest(L, fx1, fy1);
    if (!a || !b) return null;
    let s = a, e = b;
    if (s.li > e.li || (s.li === e.li && s.ti > e.ti)) { s = b; e = a; } // 反向拖动归一
    const keys = [], rects = [], thick = Math.max(13, L.fs * 0.52);
    for (let i = s.li; i <= e.li; i++) {
      const line = L.tokens[i];
      if (!line) continue;
      const lo = i === s.li ? s.ti : -Infinity;
      const hi = i === e.li ? e.ti : Infinity;
      let x0 = 0, x1 = 0, has = false;
      for (const k of quoteWordIdxs(line)) {
        if (k < lo || k > hi) continue;
        keys.push(`${i}:${k}`);
        if (!has) { x0 = line[k].x; has = true; }
        x1 = line[k].x + line[k].w;
      }
      if (!has) continue;
      const yTop = L.quoteTop + i * L.lineH - 20;
      rects.push({
        li: i, // 行号带着，便于调用方/测试核对
        x: (L.PAD + x0) / L.W, y: (yTop + L.fs * 0.48) / L.H,
        w: (x1 - x0) / L.W, h: thick / L.H,
      });
    }
    return { anchor: `${a.li}:${a.ti}`, keys, rects };
  }

  // 用 Canvas 绘制金句卡片，返回 dataURL(2x)。
  // festive=false 关掉节日/节气背景；memorial 开启纪念日主题（优先于节日）；
  // themeId 指定主题名（设置页预览用，优先级最高）；
  // defaultTheme 是无命中时的兜底风格名（card_default_theme 设置）；
  // packArt 为主题包（DLC）背景：显式传 { name, label, img }（设置页预览）或不传走自动路径
  // 读 themepacks.js 发布的 __acThemePack；优先级：显式 themeId > 主题包 > 节日/节气 > 默认。
  // glass=true 时走玻璃模式：白卡变半透明、背后画面按样式处理（card_glass_mode 总开关）；
  // glassStyle 三选一（card_glass_style）：translucent 半透明 / frost 磨砂玻璃 / liquid 液态玻璃；
  // glassBlur 为模糊半径 px（card_glass_blur 设置，只对 frost 生效；translucent 恒为 0，liquid 自带轻模糊）；
  // glassAlpha 为白色面板不透明度 %（card_glass_alpha 设置，0~100，三种样式通用）
  function drawShareCard({ text, title, site, url, festive = true, memorial = false, themeId = '', defaultTheme = '', packArt, glass = false, glassStyle = 'frost', glassBlur = 5, glassAlpha = 55, marker = false, doodle = false, highlight = null }) {
    // packArt 显式传值（设置页预览）> 自动路径 __acThemePack（当日命中）> 显式 themeId >
    // 当天节日/节气/纪念日 > defaultTheme 兜底（主题名或 pack_<id>:<key> 主题包条目，经
    // entrySync 同步解析——图片须已在引擎缓存，themepacks.js 会按 card_default_theme 预热）
    let pack = null, usePack = false, theme = null;
    if (packArt && packArt.img && !themeId) {
      pack = packArt;
      usePack = true;
    } else {
      const dayPack = !themeId && packArt === undefined ? (globalThis.__acThemePack || null) : null;
      const dayTheme = resolveDayTheme(new Date(), { festival: festive !== false, memorial: memorial === true });
      if (dayPack && dayPack.img) {
        pack = dayPack;
        usePack = true;
      } else if (themeId) {
        theme = THEME_LIST.find((t) => t.name === themeId) || null;
      } else if (dayTheme) {
        theme = dayTheme;
      } else if (defaultTheme && defaultTheme.startsWith('pack_')) {
        const ci = defaultTheme.indexOf(':');
        const d = globalThis.__acThemePacks
          ? globalThis.__acThemePacks.entrySync(defaultTheme.slice(5, ci), defaultTheme.slice(ci + 1))
          : null;
        if (d && d.img) { pack = d; usePack = true; }
      } else if (defaultTheme) {
        theme = THEME_LIST.find((t) => t.name === defaultTheme) || null;
      }
    }
    const W = 720, PAD = 56, DPR = 2;
    // 玻璃样式兜底：缺省/非法值一律按磨砂玻璃（与升级前的唯一样式一致）
    const gStyle = GLASS_STYLES.includes(glassStyle) ? glassStyle : 'frost';
    // 先用离屏 canvas 测量文字行数
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = fontMain(30);
    const lines = wrapText(meas, text, W - PAD * 2, 10);
    const lineH = 48;

    // 二维码模块边长取整像素（半格会糊出灰边，手机识别率骤降），静默区 2 模块
    const qr = buildQrMatrix(url);
    const QR_QUIET = 2;
    const qrCount = qr ? qr.getModuleCount() : 0;
    const qrTotal = qrCount + QR_QUIET * 2;
    const qrCell = qr ? Math.max(3, Math.min(4, Math.floor(104 / qrTotal))) : 0;
    const qrPx = qrCell * qrTotal;

    // 主题包版式（A）：面板底部锚定（贴卡片底边 28px），高度贴合内容；
    // 海报在面板上方完整显示（卡片高度保底 960，3:4 海报满幅零裁切；
    // 内容超长时面板跟随上移，海报顶部仍保留至少 260px）
    let quoteTop = 150, panelTop = 0, H = 0;
    if (usePack) {
      const dividerRel = 120 + lines.length * lineH + 4; // 面板顶→分隔线
      const qrTopRel = dividerRel + 14;
      const qrBlockH = qr ? Math.max(64, qrTopRel + qrPx + 17 - dividerRel + 9) : 64;
      const panelH = dividerRel + qrBlockH + 26; // + 底部内边距
      H = Math.max(960, panelH + 28 + 260);
      panelTop = H - 28 - panelH;
      quoteTop = panelTop + 120;
    }
    const dividerY = quoteTop + lines.length * lineH + 4; // 出处区上方的分隔线
    const qrTop = dividerY + 14;
    const qrLeft = W - PAD - qrPx;
    const hintY = qrTop + qrPx + 17;
    const srcTitleY = dividerY + 18;
    const srcDomainY = dividerY + 44;
    if (!usePack) H = dividerY + (qr ? Math.max(64, hintY - dividerY + 9) : 64) + 34; // 卡片底边 = H - 28

    const canvas = document.createElement('canvas');
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    const ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);

    // 渐变底 + 装饰 + 白色圆角卡片（卡内再铺同款装饰的淡水印）；
    // 主题包版式（A）：海报按 720x960 满幅完整显示（不裁切，上下烙字都在），
    // 下部叠半透明白面板，无卡内水印/大图标
    const cx = 28, cy = 28, cw = W - 56, ch = H - 56, r = 20;
    if (usePack) {
      // 背景铺海报整体平均色，承接留白；海报等比、顶端对齐完整显示（任何长宽比都不裁切不变形）
      ctx.fillStyle = imageAvgColor(pack.img);
      ctx.fillRect(0, 0, W, H);
      const s = Math.min(W / pack.img.naturalWidth, H / pack.img.naturalHeight);
      const iw = pack.img.naturalWidth * s, ih = pack.img.naturalHeight * s;
      ctx.drawImage(pack.img, (W - iw) / 2, 0, iw, ih);
      ctx.save();
      if (glass) {
        // 玻璃面板：面板背后的海报区域按样式处理（半透明不模糊 / 磨砂整片起雾 / 液态玻璃边缘折射+镜面高光）
        paintGlassPanel(ctx, gStyle, cx, panelTop, cw, H - 28 - panelTop, r, glassBlur, glassAlpha);
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.93)';
        ctx.shadowColor = 'rgba(31,36,48,0.12)';
        ctx.shadowBlur = 24;
        ctx.shadowOffsetY = 8;
        // 面板底部锚定（贴卡片底边 28px），高度贴合内容
        roundRectPath(ctx, cx, panelTop, cw, H - 28 - panelTop, r);
        ctx.fill();
      }
      ctx.restore();
    } else {
      paintBackdrop(ctx, W, H, 1, theme);
      if (glass) paintGlassPanel(ctx, gStyle, cx, cy, cw, ch, r, glassBlur, glassAlpha);
      else paintWhiteCard(ctx, cx, cy, cw, ch, r, 24, 8);
      paintCardAccent(ctx, theme, cx, cy, cw, ch, r, 1);
      paintThemeIcon(ctx, theme, W, H, 1);
    }

    // 手绘装饰：主题包版式与普通版式都画（此前只在 else 分支，导致主题包下"装饰"开关毫无变化）。
    // 落在卡片顶部留白带、文字之前，品牌行与引文压在其上
    if (doodle) paintDoodle(ctx, W, H, makeRng(((text ? text.length : 0) + 7) >>> 0));

    // 磨砂玻璃模式下所有文字统一走 put（羽化白描边 + 原色填充），强度由面板不透明度自动反推；
    // 装饰性大引号是淡色水印，不需要可读性，保持原样不描边
    const G = glass ? glassTextHalo(glassAlpha) : { halo: 0, s: 0 };
    // 描边的「线宽」与「白描边不透明度」必须随字号同步等比收窄（30px 引文为基准）：
    // v1.95.0 只收窄了线宽、没收窄不透明度——13~17px 小字仍套用引文那档白描边浓度（约 0.44 的白色），
    // 白边把笔画整根糊成白影、字看不清。这里把 lineWidth 与 strength 一起按 fs/30 收窄，
    // 引文（fs≥30）比例=1 口径完全不变，小字两侧白边明显变薄变淡。上限=1 保证引文不被二次收窄。
    const HALO_REF_FS = 30;
    const put = (t, x, y, fs) => {
      if (G.halo <= 0) { ctx.fillText(t, x, y); return; }
      const r = Math.min(1, fs / HALO_REF_FS);
      frostText(ctx, t, x, y, Math.max(0.35, G.halo * r), Math.max(0.16, G.s * r));
      ctx.fillText(t, x, y);
    };

    // 顶部品牌条：蓝点 + AnyComment 划线分享（主题包版式落在面板顶部，右侧加日期·条目名）
    const brandY = usePack ? panelTop + 44 : cy + 44;
    ctx.fillStyle = '#2f6bff';
    ctx.beginPath(); ctx.arc(cx + 30, brandY, 7, 0, Math.PI * 2); ctx.fill();
    ctx.font = fontMain(15, 500);
    ctx.fillStyle = '#8a90a5';
    ctx.textBaseline = 'middle';
    put('AnyComment · 划线分享', cx + 46, brandY + 1, 15);
    if (usePack) {
      ctx.textAlign = 'right';
      put(pack.label || pack.name, W - PAD, brandY + 1, 15);
      ctx.textAlign = 'left';
    }

    // 大引号
    ctx.font = `700 64px Georgia, "Times New Roman", serif`;
    ctx.fillStyle = 'rgba(47,107,255,0.18)';
    ctx.fillText('“', PAD - 8, quoteTop - 22);

    // 引用文字：marker 开启时逐词块绘制（先画荧光笔带、再压文字），并记录布局供预览点词命中；
    // 关闭时走原来的整行绘制，逐像素不变、零回归
    ctx.font = fontMain(30, 600);
    ctx.fillStyle = '#1f2430';
    ctx.textBaseline = 'top';
    if (marker) {
      const { tokens } = buildQuoteLayout(text);
      // highlight 三种入参：{ "行:块": colorId } 映射（分色）/ ["行:块", ...] 数组（统一黄）/ undefined（自动识别，统一黄）
      let hlMap;
      if (Array.isArray(highlight)) hlMap = Object.fromEntries(highlight.map((k) => [k, 'yellow']));
      else if (highlight && typeof highlight === 'object') hlMap = highlight;
      else hlMap = Object.fromEntries(autoHighlightKeys(text).map((k) => [k, 'yellow']));
      // 词间"胶水"（空白 / 纯标点，如小数点、顿号、连字符）把相邻同色命中词连成一条：
      // 否则 "16.68" 会被 "." 切成两段各画一头，露出断口和端点接缝，很难看
      const isGlue = (t) => /^\s+$/.test(t) || /^[^\p{L}\p{N}]+$/u.test(t);
      // 先画文字，再把荧光笔带压在文字之上（真马克笔"划在字上"；multiply 混色下深色字仍透出）
      tokens.forEach((line, i) => {
        const yTop = quoteTop + i * lineH - 20;
        line.forEach((tok) => put(tok.t, PAD + tok.x, yTop, 30));
      });
      tokens.forEach((line, i) => {
        const yTop = quoteTop + i * lineH - 20;
        const idxs = [];
        line.forEach((tok, ti) => { if (hlMap[`${i}:${ti}`]) idxs.push(ti); });
        if (!idxs.length) return;
        const drawRun = (a, b, colorId) => {
          const x0 = line[a].x, x1 = line[b].x + line[b].w;
          const seed = (i * 100003 + Math.round(x0) * 31 + Math.round(x1)) >>> 0;
          paintMarker(ctx, PAD + x0, yTop, x1 - x0, 30, makeRng(seed), colorId);
        };
        let a = idxs[0], b = idxs[0], runColor = hlMap[`${i}:${a}`];
        for (let n = 1; n < idxs.length; n++) {
          const prev = idxs[n - 1], cur = idxs[n];
          const curColor = hlMap[`${i}:${cur}`];
          let gapGlue = true;
          for (let k = prev + 1; k < cur; k++) if (!isGlue(line[k].t)) { gapGlue = false; break; }
          if (gapGlue && curColor === runColor) b = cur;
          else { drawRun(a, b, runColor); a = cur; b = cur; runColor = curColor; }
        }
        drawRun(a, b, runColor);
      });
      LAST_QUOTE = { W, H, PAD, quoteTop, lineH, fs: 30, tokens };
    } else {
      LAST_QUOTE = null;
      lines.forEach((ln, i) => put(ln, PAD, quoteTop + i * lineH - 20, 30));
    }

    // 出处：页面标题 + 站点（右侧留给二维码）
    // 磨砂玻璃下分隔线也换成白色——深色画面里浅灰线会比文字先消失
    ctx.strokeStyle = G.halo > 0 ? 'rgba(255,255,255,0.85)' : '#eceef4';
    ctx.beginPath(); ctx.moveTo(PAD, dividerY); ctx.lineTo(W - PAD, dividerY); ctx.stroke();
    ctx.font = fontMain(17, 500);
    ctx.fillStyle = '#4b5563';
    // 前缀也要计入测量，否则长标题会钻到二维码底下
    const srcText = `—— ${title || site || ''}`;
    put(wrapText(ctx, srcText, (qr ? qrLeft - PAD : W - PAD * 2) - 20, 1)[0] || '', PAD, srcTitleY, 17);
    ctx.font = fontMain(14, 400);
    ctx.fillStyle = '#a5abc0';
    const domain = (site || '').replace(/^www\./, '');
    put(wrapText(ctx, domain, (qr ? qrLeft - PAD : W - PAD * 2) - 20, 1)[0] || '', PAD, srcDomainY, 14);

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
      put(hint, qrLeft + (qrPx - ctx.measureText(hint).width) / 2, hintY, 13);
    } else {
      const d = new Date();
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      ctx.font = fontMain(13, 400);
      ctx.fillStyle = '#a5abc0';
      put(ds, W - PAD - ctx.measureText(ds).width, srcDomainY, 13);
    }

    return canvas.toDataURL('image/png');
  }

  // ========== 网页截图合成 ==========
  // 坐标一律在"图像自然像素空间"计算（不做 ctx.scale(DPR)，输出倍率由 CDP 的 dpr×clip.scale 决定）。
  // 版式：截图外面整圈套上金句卡片同款的渐变底 + 白色圆角卡，品牌与拍摄时间同行两端对齐走在图片
  // 上方的白色留白里，二维码默认走在图片下方的白色留白里（可选压在图上四角），所以输出必然比原图大。
  // 小尺寸框选放不下时，候选尺度从基准逐级 ×0.75 试到放得下二维码为止，仍放不下就只留文字。
  const SHOT_BRAND = 'AnyComment · 网页截图';
  const SHOT_QR_HINT = '扫码阅读原文';
  const QR_QUIET = 2;

  function planShot({ s, W, H, brand, when, qr, overlay, corner }) {
    const meas = measureCtx();
    const fs1 = Math.max(13, Math.round(22 * s)); // 品牌
    const fs2 = Math.max(11, Math.round(18 * s)); // 拍摄时间
    const fs3 = Math.max(10, Math.round(15 * s)); // 二维码提示文字
    const M = Math.max(6, Math.round(22 * s)); // 渐变底外圈
    const P = Math.max(5, Math.round(14 * s)); // 白卡内边距
    const gap = Math.max(4, Math.round(8 * s));
    const hintGap = Math.max(6, Math.round(12 * s));
    const radius = Math.max(6, Math.round(16 * s));
    const imgRadius = Math.max(3, Math.round(9 * s));
    const lh1 = Math.round(fs1 * 1.35);
    const lh3 = Math.round(fs3 * 1.45);
    const dotR = Math.max(3, Math.round(fs1 * 0.34));
    const dotGap = Math.max(4, Math.round(8 * s));
    const dotW = dotR * 2 + dotGap;

    // 二维码模块边长仍取整像素（同金句卡片规则），目标边长约 180 号字高
    const qrTotal = qr ? qr.getModuleCount() + QR_QUIET * 2 : 0;
    const cell = qrTotal ? Math.max(1, Math.min(8, Math.round((180 * s) / qrTotal))) : 0;
    const qrPx = cell * qrTotal;

    const headH = brand || when ? lh1 + P : 0;
    const outW = W + (M + P) * 2;
    const cardX = M, cardY = M, cardW = outW - M * 2;
    const imgX = M + P, imgY = M + P + headH;
    const textCx = cardX + P, textRight = cardX + cardW - P;
    const rowY = cardY + P + lh1 / 2;

    meas.font = fontMain(fs1, 600);
    const wBrand = brand ? meas.measureText(brand).width : 0;
    meas.font = fontMain(fs2, 400);
    const wWhen = when ? meas.measureText(when).width : 0;
    // 两端对齐：装得下各走各的贴边；装不下先牺牲时间（标识是主体），品牌仍超宽才在自身行内截断
    const sep = brand && when ? gap * 2 : 0;
    const dotRoom = brand ? dotW : 0;
    const keepWhen = !(brand && when) || dotRoom + wBrand + sep + wWhen <= W;
    const maxBrand = brand ? Math.max(0, W - dotRoom - (keepWhen ? sep + wWhen : 0)) : 0;
    const maxWhen = when ? (keepWhen ? Math.max(0, W - dotRoom - maxBrand - sep) : 0) : 0;

    const base = {
      s, fs1, fs2, fs3, M, P, gap, hintGap, radius, imgRadius, lh1, lh3, dotR, dotGap, dotW,
      outW, cardX, cardY, cardW, imgX, imgY, textCx, textRight, rowY, headH, cell, qrPx, maxBrand, maxWhen,
    };
    const bodyH = headH + H + P * 2;
    if (!qr) {
      return { ...base, mode: 'none', footH: 0, cardH: bodyH, outH: bodyH + M * 2, fits: true, qx: 0, qy: 0 };
    }
    if (overlay) {
      // 压在图上：白底板装二维码 + 提示文字，整块按所选角内缩在截图范围内
      const bp = Math.max(4, Math.round(12 * s));
      meas.font = fontMain(fs3, 400);
      // 极小框选时二维码会比提示文字还窄，底板按更宽的那一项算，免得文字戳出板外
      const blockW = Math.max(qrPx, meas.measureText(SHOT_QR_HINT).width);
      const bw = bp * 2 + blockW;
      const bh = bp * 2 + qrPx + hintGap + lh3;
      const inset = Math.max(6, Math.round(16 * s));
      const bx = imgX + (corner === 'tl' || corner === 'bl' ? inset : Math.max(inset, W - inset - bw));
      const by = imgY + (corner === 'tl' || corner === 'tr' ? inset : Math.max(inset, H - inset - bh));
      return {
        ...base, mode: 'overlay', footH: 0, cardH: bodyH, outH: bodyH + M * 2,
        bp, bw, bh, inset, bx, by, qx: bx + bp + Math.round((blockW - qrPx) / 2), qy: by + bp,
        fits: bw + inset * 2 <= W * 0.94 && bh + inset * 2 <= Math.max(40, H * 0.6),
      };
    }
    // 不覆盖：白卡往下再扩一段，二维码整块走在截图下方，一点画面都不遮
    const footH = P + qrPx + hintGap + lh3;
    const cardH = bodyH + footH;
    return {
      ...base, mode: 'footer', footH, cardH, outH: cardH + M * 2,
      qx: Math.round(textCx + (W - qrPx) / 2), qy: imgY + H + P,
      fits: qrPx <= W,
    };
  }

  let _meas;
  function measureCtx() {
    if (!_meas) _meas = document.createElement('canvas').getContext('2d');
    return _meas;
  }

  // 把捕获图与二维码/时间/品牌合成一张可下载的图，返回 dataURL
  function composeScreenshot({ img, dataUrl, url, time = Date.now(), opts = {}, packArt }) {
    const o = { ...SHOT_DEFAULTS, ...opts };
    const W = img.naturalWidth || img.width;
    const H = img.naturalHeight || img.height;
    if (!W || !H) throw new Error('empty-image');
    const qr = o.shot_qr ? buildQrMatrix(url) : null;
    const brand = o.shot_brand ? SHOT_BRAND : '';
    const when = o.shot_time ? fmtShotTime(time) : '';
    // theme_id 是设置页预览的临时指定（不落 storage），优先于开关与默认风格
    const theme = o.theme_id ? (THEME_LIST.find((t) => t.name === o.theme_id) || null)
      : (resolveDayTheme(new Date(time), { festival: o.card_festival_bg !== false, memorial: o.card_memorial_bg === true })
        || (o.card_default_theme ? THEME_LIST.find((t) => t.name === o.card_default_theme) || null : null));
    // 主题包图案背景（card_pack_shot_bg 开启时生效）：当日命中的包图替代渐变外框，
    // 优先级与金句卡片一致：显式 packArt（设置页预览）/theme_id > 主题包 > 节日/节气 > 默认风格
    let shotPack = (packArt && packArt.img && !o.theme_id) ? packArt : null;
    if (!shotPack && o.card_pack_shot_bg === true && !o.theme_id) {
      const dayPack = globalThis.__acThemePack || null;
      if (dayPack && dayPack.img) {
        shotPack = dayPack;
      } else if (o.card_default_theme && o.card_default_theme.startsWith('pack_') && globalThis.__acThemePacks) {
        // 默认风格指向包条目时作为兜底（entrySync 带开关守卫，包关闭即 null）
        const ci = o.card_default_theme.indexOf(':');
        const d = globalThis.__acThemePacks.entrySync(o.card_default_theme.slice(5, ci), o.card_default_theme.slice(ci + 1));
        if (d && d.img) shotPack = d;
      }
    }
    const packBg = shotPack;
    if (!qr && !brand && !when && !theme && !packBg) return dataUrl;

    const overlay = o.shot_qr_overlay === true;
    const corner = ['tl', 'tr', 'bl', 'br'].includes(o.shot_qr_corner) ? o.shot_qr_corner : 'br';

    let plan = null;
    for (let s = Math.max(0.55, W / 1920); s >= 0.18; s *= 0.75) {
      plan = planShot({ s, W, H, brand, when, qr, overlay, corner });
      if (plan.fits) break;
    }
    if (!plan || !plan.fits) {
      // 最小尺度仍放不下二维码：放弃二维码，只保留顶部品牌与时间
      plan = planShot({ s: 0.18, W, H, brand, when, qr: null, overlay, corner });
    }

    const canvas = document.createElement('canvas');
    canvas.width = plan.outW;
    canvas.height = plan.outH;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (packBg) {
      // 背景去色程度来自设置项 card_pack_shot_desat（0=原色，100=黑白）
      const desat = Math.min(100, Math.max(0, typeof o.card_pack_shot_desat === 'number' ? o.card_pack_shot_desat : 0)) / 100;
      if (!packCurveLUT) packCurveBuild();
      // 海报按宽适配、贴顶呈现（截图形状任意：横向与顶部都绝不裁切，花名带永远完整，
      // 经正片叠底透过截图可见；方形截图露出的背景即花名区域，长条截图花名也完整）。
      // 海报不足画布高时（极端长竖条）下缘以海报整体平均色延伸（与金句卡片 v1.45 同口径）；
      // 旧 cover 居中裁剪会把海报顶部烙的花名切成一半
      ctx.save();
      ctx.filter = `saturate(${1 - desat})`;
      const bs = plan.outW / packBg.img.naturalWidth;
      const bih = packBg.img.naturalHeight * bs;
      const dh = Math.min(bih, plan.outH);
      ctx.fillStyle = imageAvgColor(packBg.img);
      ctx.fillRect(0, 0, plan.outW, plan.outH);
      ctx.drawImage(packBg.img, 0, 0, packBg.img.naturalWidth, dh / bs, 0, 0, plan.outW, dh);
      ctx.restore();
      // 色调曲线：暗部墨色笔触压向白色，海报变成浅色纹理纸（此时画布上只有背景，可整幅处理）
      packCurveApply(ctx, plan.outW, plan.outH);
      // 提亮 80%（调参器 lighten=80）
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillRect(0, 0, plan.outW, plan.outH);
    } else {
      paintBackdrop(ctx, plan.outW, plan.outH, plan.s, theme);
      paintWhiteCard(
        ctx, plan.cardX, plan.cardY, plan.cardW, plan.cardH, plan.radius,
        Math.max(6, Math.round(24 * plan.s)), Math.max(2, Math.round(8 * plan.s))
      );
    }
    paintCardAccent(ctx, theme, plan.cardX, plan.cardY, plan.cardW, plan.cardH, plan.radius, plan.s);
    paintThemeIcon(ctx, theme, plan.outW, plan.outH, plan.s);

    // 截图裁成圆角贴上，再描一圈淡边；主题包模式下先垫白 70% 再正片叠底（调参器 underlay=70）
    ctx.save();
    if (packBg) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      roundRectPath(ctx, plan.imgX, plan.imgY, W, H, plan.imgRadius);
      ctx.fill();
      ctx.globalCompositeOperation = 'multiply';
    }
    roundRectPath(ctx, plan.imgX, plan.imgY, W, H, plan.imgRadius);
    ctx.clip();
    ctx.drawImage(img, plan.imgX, plan.imgY, W, H);
    ctx.restore();
    ctx.strokeStyle = '#e6e9f2';
    ctx.lineWidth = Math.max(1, Math.round(plan.s));
    roundRectPath(ctx, plan.imgX, plan.imgY, W, H, plan.imgRadius);
    ctx.stroke();

    // 顶部留白：蓝点 + 品牌靠左，拍摄时间靠右，同一行两端对齐；
    // 主题包模式背景是去色花纹，文字下垫白色圆角小底保证可读
    ctx.textBaseline = 'middle';
    if (brand) {
      if (packBg) {
        ctx.font = fontMain(plan.fs1, 600);
        const bw = ctx.measureText(wrapText(ctx, brand, plan.maxBrand, 1)[0] || '').width;
        ctx.fillStyle = `rgba(255,255,255,${PACK_SHOT.chip})`;
        roundRectPath(ctx, plan.textCx - 8 * plan.s, plan.rowY - plan.lh1 / 2, plan.dotW + bw + 16 * plan.s, plan.lh1, 6 * plan.s);
        ctx.fill();
      }
      ctx.fillStyle = '#2f6bff';
      ctx.beginPath();
      ctx.arc(plan.textCx + plan.dotR, plan.rowY, plan.dotR, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = fontMain(plan.fs1, 600);
      ctx.fillStyle = '#1f2430';
      ctx.fillText(wrapText(ctx, brand, plan.maxBrand, 1)[0] || '', plan.textCx + plan.dotW, plan.rowY);
    }
    if (when && plan.maxWhen > 0) {
      ctx.font = fontMain(plan.fs2, 400);
      const t = wrapText(ctx, when, plan.maxWhen, 1)[0] || '';
      if (packBg) {
        const tw = ctx.measureText(t).width;
        ctx.fillStyle = `rgba(255,255,255,${PACK_SHOT.chip})`;
        roundRectPath(ctx, plan.textRight - tw - 8 * plan.s, plan.rowY - plan.fs2 * 0.7, tw + 16 * plan.s, plan.fs2 * 1.4, 6 * plan.s);
        ctx.fill();
      }
      ctx.fillStyle = '#8a90a5';
      ctx.fillText(t, plan.textRight - ctx.measureText(t).width, plan.rowY);
    }

    // 二维码：整像素模块 + 下方提示文字。普通模式底就是白卡；主题包模式垫白色圆角底保证扫码
    if (qr && plan.cell > 0) {
      if (plan.mode === 'overlay') {
        paintWhiteCard(
          ctx, plan.bx, plan.by, plan.bw, plan.bh, plan.radius,
          Math.max(3, Math.round(12 * plan.s)), Math.max(1, Math.round(2 * plan.s)), 'rgba(31,36,48,0.18)'
        );
      } else if (packBg) {
        paintWhiteCard(
          ctx, plan.qx - 12 * plan.s, plan.qy - 12 * plan.s,
          plan.qrPx + 24 * plan.s, plan.qrPx + plan.hintGap + plan.lh3 + 20 * plan.s,
          Math.max(4, Math.round(10 * plan.s)),
          Math.max(3, Math.round(10 * plan.s)), Math.max(1, Math.round(3 * plan.s))
        );
      }
      drawQrModules(ctx, qr, plan.qx, plan.qy, plan.cell, QR_QUIET);
      ctx.font = fontMain(plan.fs3, 400);
      ctx.fillStyle = '#a5abc0';
      const hintW = ctx.measureText(SHOT_QR_HINT).width;
      ctx.fillText(SHOT_QR_HINT, plan.qx + (plan.qrPx - hintW) / 2, plan.qy + plan.qrPx + plan.hintGap + plan.lh3 / 2);
    }

    return canvas.toDataURL('image/png');
  }

  // ========== 预览浮层（金句卡片与截图共用） ==========

  const PREVIEW_CSS = `
    .ac-share-mask {
      position: fixed; inset: 0; z-index: 2147483647;
      /* capture.js 的宿主是 pointer-events:none（平时不挡页面鼠标），继承会让整个浮层收不到
         任何点击、三个按钮全部失效且永远关不掉（表现为页面"卡死"），这里必须显式恢复 */
      pointer-events: auto;
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
    .ac-share-actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; }
    /* 划线调色板浮条：贴图片下缘悬浮，不占额外高度（卡片底部中间本就是留白，遮挡最小）。
       壳用 inline-block（同 annotate 的 .ac-anno-wrap），让浮条的 50% 居中贴合图片实际宽度 */
    .ac-share-view { position: relative; display: inline-block; line-height: 0; max-width: 100%; }
    /* 划线卡现在也走 annotate（贴纸层），画布自带 58vh 上限；这里对齐图片的 62vh，
       否则同一张卡片会平白缩水一档（实测 799x470 vs 原文 854x502） */
    .ac-share-view .ac-anno-base { max-height: 62vh; }
    .ac-share-float {
      position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%);
      /* annotate 模式下 view 是 .ac-anno-stage，里面的 .ac-anno-wrap 带 z-index:1，
         浮条不抬 z-index 会被标注画布整条盖住（调色板/贴纸按钮全看不见） */
      z-index: 6;
      display: flex; align-items: center; gap: 7px; padding: 5px 11px; border-radius: 999px;
      background: rgba(255,255,255,.93); border: 1px solid rgba(31,36,48,.14);
      box-shadow: 0 4px 16px rgba(15,18,28,.18); backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
    }
    .ac-share-dot {
      width: 20px; height: 20px; padding: 0; border-radius: 50%; cursor: pointer;
      border: 1px solid rgba(31,36,48,.18); transition: transform .12s;
    }
    .ac-share-dot:hover { transform: scale(1.12); }
    .ac-share-dot.on { outline: 2px solid #4f6ef7; outline-offset: 1px; }
    .ac-share-icn {
      width: 26px; height: 26px; padding: 0; border: none; border-radius: 50%; background: transparent;
      color: #5b6172; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
    }
    .ac-share-icn:hover { background: #eef1fb; }
    .ac-share-icn.on { background: #4f6ef7; color: #fff; }
    .ac-share-vsep { width: 1px; height: 18px; background: rgba(31,36,48,.14); }
    /* 拖动划线的实时预览层：DOM 色块按分数坐标（百分比）贴在图片上，pointer-events:none
       保证指针事件仍落到图片容器。整张 canvas 一次重绘在玻璃/主题包版式下要几十毫秒，
       逐帧重绘会卡，所以拖动途中只画这层，松手才落一次真笔 */
    .ac-drag-bands { position: absolute; inset: 0; pointer-events: none; z-index: 2; }
    .ac-drag-bands > i { position: absolute; display: block; border-radius: 2px; opacity: .55; }
    /* 擦除预览：不铺色，改画虚线框，读作"松手后这几条会消失" */
    .ac-drag-bands.erase > i { opacity: 1; box-shadow: inset 0 0 0 1.5px rgba(31,36,48,.5); }
    .ac-share-btn {
      padding: 8px 18px; border-radius: 8px; border: none; cursor: pointer;
      font: 600 13px/1 system-ui, sans-serif;
    }
    .ac-share-primary { background: #4f6ef7; color: #fff; }
    .ac-share-ghost { background: #eef1fb; color: #4f6ef7; }
    .ac-share-close { background: #f3f4f6; color: #6b7280; }
  `;

  // 预览样式跟着调用方的 shadow root 走：capture.js 有自己的 root，不依赖 content.js 的 CSS_TEXT
  function ensurePreviewStyle(root) {
    if (root.querySelector('style[data-ac-card]')) return;
    const style = document.createElement('style');
    style.setAttribute('data-ac-card', '');
    style.textContent = PREVIEW_CSS;
    root.appendChild(style);
  }

  // 把 dataURL 写入剪贴板：自动复制与手动按钮共用同一个写流程，失败时按钮文字保持原样以便手动重试
  function copyImageToClipboard(dataUrl) {
    const b64 = dataUrl.split(',')[1];
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
  }

  // 预览浮层：下载 / 复制到剪贴板 / 关闭；弹出即尝试自动复制，HTTP 站点/权限拒绝时静默降级到手动按钮
  function showPreview(root, dataUrl, opts = {}) {
    ensurePreviewStyle(root);
    // 换图重开前先把上一个浮层的标注编辑器销毁（它身上有 window 级监听，直接 remove 会泄漏）
    const prev = root.querySelector('.ac-share-mask');
    if (prev) {
      try { prev.__acAnnoDestroy?.(); } catch { /* 已销毁 */ }
      prev.remove();
    }
    const mask = document.createElement('div');
    mask.className = 'ac-share-mask';
    const box = document.createElement('div');
    box.className = 'ac-share-card-box';
    // 标注编辑器（箭头 / 矩形 / 马赛克 / 贴纸等）：截图与划线分享共用
    // 当 onImageClick 存在时（荧光笔划线模式），也启用 annotate 但默认隐藏工具栏，
    // 贴纸模式通过外部按钮切换，底图更新走 setImage，贴纸作为标注层独立保存
    let anno = null;
    let view;
    let stickerMode = false; // 荧光笔模式下是否处于贴纸编辑态
    if (opts.annotate !== false && globalThis.__acAnnotate) {
      const annoOpts = {};
      // 有 onImageClick 说明是荧光笔模式，初始隐藏工具栏
      if (typeof opts.onImageClick === 'function') {
        annoOpts.hideToolbar = true;
        annoOpts.tool = 'sticker';
      }
      anno = globalThis.__acAnnotate.create(root, dataUrl, annoOpts);
      view = anno.el;
    } else {
      const img = document.createElement('img');
      img.className = 'ac-share-img';
      img.src = dataUrl;
      img.alt = opts.alt || '分享卡片预览';
      view = img;
    }
    // 悬浮工具条（划线调色板）需要一层 relative 壳把浮条锚在图片下缘；没有浮条时不包壳，
    // 免得干扰标注编辑器（自带 vh 布局）的尺寸测量
    const fActs = opts.floatActions || [];
    let host = box;
    if (fActs.length) {
      host = document.createElement('div');
      host.className = 'ac-share-view';
      host.append(view);
    }
    // 图片可被扩展操作替换（如截图主题包背景快捷开关重合成），复制/下载始终取当前图
    let curUrl = dataUrl;
    // 有标注就取「底图 + 标注层」的合成图；没标注直接返回原图，省一次大图编码
    const currentUrl = () => (anno ? anno.exportUrl() || curUrl : curUrl);
    const acts = document.createElement('div');
    acts.className = 'ac-share-actions';
    const btnDl = document.createElement('button');
    btnDl.className = 'ac-share-btn ac-share-primary';
    btnDl.textContent = '下载图片';
    btnDl.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = currentUrl();
      a.download = opts.fileName || `anycomment-quote-${Date.now()}.png`;
      a.click();
    });
    const btnCopy = document.createElement('button');
    btnCopy.className = 'ac-share-btn ac-share-ghost';
    btnCopy.textContent = '复制图片';
    // 弹出即尝试自动复制：选区/视口截图与划线分享共用同一流程，用户不再需要手动点击
    // 注意：必须在 user gesture 同帧内调用（这里是同步链路里启动，Chrome 把它视作 transient）
    copyImageToClipboard(dataUrl).then(
      () => { if (btnCopy.isConnected) btnCopy.textContent = '已复制 ✓'; },
      () => { /* 静默失败：按钮保持「复制图片」由用户主动重试，HTTP/无权限场景仍可用 */ },
    );
    btnCopy.addEventListener('click', async () => {
      try {
        await copyImageToClipboard(currentUrl());
        btnCopy.textContent = '已复制 ✓';
      } catch {
        btnCopy.textContent = '复制失败，请下载';
      }
    });
    // 自动复制：截图界面里的任何改动（画一笔 / 撤销 / 清空 / 换底图）都重新写一次剪贴板，
    // 用户始终可以随手 Ctrl+V。防抖 260ms 合并连续操作，且仍落在用户手势的手里
    // （Chrome 要求 clipboard.write 在 transient activation 窗口内，约 5s）
    let copyTimer = 0;
    function autoCopy() {
      if (copyTimer) clearTimeout(copyTimer);
      if (btnCopy.isConnected) btnCopy.textContent = '复制中…';
      copyTimer = setTimeout(() => {
        copyTimer = 0;
        copyImageToClipboard(currentUrl()).then(
          () => { if (btnCopy.isConnected) btnCopy.textContent = '已复制 ✓'; },
          // 失败（无权限 / 非安全上下文 / 手势过期）就把文案拨回「复制图片」，交给用户手动点
          () => { if (btnCopy.isConnected) btnCopy.textContent = '复制图片'; },
        );
      }, 260);
    }
    // 换底图后要等新图解码完再复制，否则复制到的还是上一张
    const updateImg = (u) => {
      curUrl = u;
      if (anno) anno.setImage(u, autoCopy);
      else {
        view.src = u;
        autoCopy();
      }
    };
    if (anno) anno.onChange(autoCopy);
    // 悬浮工具条：色点 / 图标按钮（act.icon 给 SVG 原文）+ 分隔符（act.kind === 'sep'）。
    // act.selected 可以是函数，每次点击后就地重算选中态——这样调色板换色不用重建整个浮层
    // 荧光笔模式下的点击目标（wrap 容器），贴纸切换时要用
    let clickTarget = null;
    if (typeof opts.onImageClick === 'function' && anno) {
      clickTarget = view.querySelector('.ac-anno-wrap') || view;
      // 初始：canvas 不拦截点击，穿透到 wrap（荧光笔模式）
      const layers = view.querySelectorAll('.ac-anno-layer, .ac-anno-sel');
      layers.forEach((l) => { l.style.pointerEvents = 'none'; });
    }
    if (fActs.length) {
      const fb = document.createElement('div');
      fb.className = 'ac-share-float';
      const items = [];
      for (const act of fActs) {
        if (act.kind === 'sep') {
          const s = document.createElement('span');
          s.className = 'ac-share-vsep';
          fb.append(s);
          continue;
        }
        const b = document.createElement('button');
        b.type = 'button';
        b.title = act.label || '';
        if (act.icon) {
          b.className = 'ac-share-icn';
          b.innerHTML = act.icon;
        } else {
          b.className = 'ac-share-dot';
          b.style.background = act.bg || '#fff';
        }
        items.push([b, act]);
        fb.append(b);
      }
      const isOn = (act) => !!(typeof act.selected === 'function' ? act.selected() : act.selected);
      const sync = () => { for (const [b, act] of items) b.classList.toggle('on', isOn(act)); };
      for (const [b, act] of items) {
        b.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            if (act.kind === 'sticker') {
              // 贴纸模式切换：荧光笔模式下进入/退出贴纸编辑
              stickerMode = !stickerMode;
              if (stickerMode) {
                anno?.showToolbar?.();
                anno?.setTool?.('sticker');
                // 恢复 canvas 交互
                const layers = view.querySelectorAll('.ac-anno-layer, .ac-anno-sel');
                layers.forEach((l) => { l.style.pointerEvents = ''; });
                if (clickTarget) clickTarget.style.cursor = '';
              } else {
                anno?.hideToolbar?.();
                // 禁用 canvas 交互，让点击穿透
                const layers = view.querySelectorAll('.ac-anno-layer, .ac-anno-sel');
                layers.forEach((l) => { l.style.pointerEvents = 'none'; });
                if (clickTarget) clickTarget.style.cursor = 'crosshair';
              }
              if (act.onClick) await act.onClick(updateImg, stickerMode);
            } else {
              await act.onClick(updateImg);
            }
          } catch { /* 失败保持原状 */ }
          sync();
        });
      }
      sync();
      host.append(fb);
    }
    // 卡片上的划线交互。card.js 只管指针机制，选词语义全在调用方：
    //   onImageClick(fx, fy, api)                 —— 按下后没怎么移动就抬起（=原 click），逐词微调
    //   onImageDrag(fx0, fy0, fx1, fy1, api)      —— 按住拖动：移动中每次调用（api.commit=false，
    //                                                请只用 api.setPreview 画预览），松手调一次
    //                                                （api.commit=true，此时才 api.updateImg 落笔）
    // 坐标都是相对图片的分数值（0~1）；贴纸模式下两者都不触发，留给标注编辑器
    if (typeof opts.onImageClick === 'function') {
      const target = clickTarget || view;
      target.style.cursor = 'crosshair';
      // 色块宿主：annotate 的 .ac-anno-wrap / 无标注时包图片的 .ac-share-view 壳。
      // 直接命中 <img> 时它挂不了子节点，退到父级并补 position:relative
      const bandsHost = document.createElement('div');
      bandsHost.className = 'ac-drag-bands';
      const shell = target.tagName === 'IMG' ? (target.parentElement || target) : target;
      if (getComputedStyle(shell).position === 'static') shell.style.position = 'relative';
      shell.append(bandsHost);
      // 预览色块：rect 是相对图片的分数坐标，这里换算成宿主内的像素（图片若在宿主里有偏移/
      // 缩放也照样贴准），erase 时只描虚线不铺色
      const setPreview = (rects, css, erase) => {
        bandsHost.replaceChildren();
        if (!rects || !rects.length) return;
        const imgR = target.getBoundingClientRect(), hostR = shell.getBoundingClientRect();
        if (!imgR.width || !imgR.height) return;
        bandsHost.classList.toggle('erase', !!erase);
        const frag = document.createDocumentFragment();
        for (const b of rects) {
          const d = document.createElement('i');
          d.style.left = `${imgR.left - hostR.left + b.x * imgR.width}px`;
          d.style.top = `${imgR.top - hostR.top + b.y * imgR.height}px`;
          d.style.width = `${b.w * imgR.width}px`;
          d.style.height = `${b.h * imgR.height}px`;
          if (!erase) d.style.background = css || '#fff2a8';
          frag.append(d);
        }
        bandsHost.append(frag);
      };
      const api = { updateImg, setPreview, commit: false };
      const DRAG_MIN = 5; // 位移阈值（px）：没超过它算单击，手抖不会误划一整段
      let st = null;
      const fracAt = (e) => {
        const rect = target.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height];
      };
      target.addEventListener('pointerdown', (e) => {
        if (stickerMode || e.button !== 0) return;
        const p = fracAt(e);
        if (!p) return;
        st = { x0: p[0], y0: p[1], sx: e.clientX, sy: e.clientY, dragging: false };
        e.preventDefault(); // 别让拖动过程选中图片或宿主页文字
        try { target.setPointerCapture(e.pointerId); } catch { /* 忽略：拿不到捕获照常按抬起判定 */ }
      });
      target.addEventListener('pointermove', (e) => {
        if (!st || typeof opts.onImageDrag !== 'function') return;
        if (!st.dragging) {
          if (Math.abs(e.clientX - st.sx) + Math.abs(e.clientY - st.sy) < DRAG_MIN) return;
          st.dragging = true;
        }
        const p = fracAt(e);
        if (p) opts.onImageDrag(st.x0, st.y0, p[0], p[1], Object.assign(api, { commit: false }));
      });
      target.addEventListener('pointerup', (e) => {
        if (!st) return;
        const s = st;
        st = null;
        setPreview(null);
        const p = fracAt(e) || [s.x0, s.y0];
        if (s.dragging && typeof opts.onImageDrag === 'function') {
          opts.onImageDrag(s.x0, s.y0, p[0], p[1], Object.assign(api, { commit: true }));
        } else {
          opts.onImageClick(s.x0, s.y0, api);
        }
      });
      target.addEventListener('pointercancel', () => { st = null; setPreview(null); });
    }
    const btnClose = document.createElement('button');
    btnClose.className = 'ac-share-btn ac-share-close';
    btnClose.textContent = '关闭';
    // 关闭统一走 close()：顺带移除 Esc 监听，避免浮层关了监听还在
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey, true);
    // 标注编辑器跟着浮层一起销毁，别的入口（截图重开）也要能拿到
    mask.__acAnnoDestroy = () => { if (anno) anno.destroy(); };
    function close() {
      mask.remove();
      if (anno) anno.destroy();
      window.removeEventListener('keydown', onKey, true);
    }
    btnClose.addEventListener('click', close);
    // 扩展操作按钮（如截图的主题包背景快捷开关、划线卡片的调色板）：
    // onClick(updateImg) 返回字符串则更新按钮文案；act.bg 给按钮上色（调色板色块）；act.selected 描选中态
    for (const act of opts.actions || []) {
      const b = document.createElement('button');
      b.className = 'ac-share-btn ac-share-ghost';
      b.textContent = act.label;
      if (act.bg) { b.style.background = act.bg; b.style.color = '#3a3f4a'; }
      if (act.selected) { b.style.outline = '2px solid #4f6ef7'; b.style.outlineOffset = '1px'; }
      b.addEventListener('click', async () => {
        try {
          const nl = await act.onClick(updateImg);
          if (typeof nl === 'string') b.textContent = nl;
        } catch (e) { /* 失败保持原文案 */ }
      });
      acts.append(b);
    }
    acts.append(btnDl, btnCopy, btnClose);
    // 无浮条时 host 就是 box 本身，视图仍要直挂 box，别漏挂
    if (host === box) box.append(view);
    else box.append(host);
    box.append(acts);
    mask.append(box);
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    root.appendChild(mask);
  }

  globalThis.__acCard = {
    SHOT_DEFAULTS, fontMain, wrapText, cleanUrlForQr, buildQrMatrix, roundRectPath,
    drawQrModules, paintBackdrop, paintWhiteCard, paintCardAccent, resolveTheme,
    resolveDayTheme, themeDateInYear, THEME_LIST, fmtShotTime, drawShareCard,
    composeScreenshot, planShot, showPreview, PREVIEW_CSS,
    autoHighlight: autoHighlightKeys, lastQuoteLayout: () => LAST_QUOTE, quoteRangeAt, MARKER_PALETTE,
  };
})();
