// AnyComment 共享绘制模块：金句卡片、截图合成原语、预览浮层
// 与 content.js / capture.js 同在 content_scripts 隔离世界（manifest 按序加载），用全局 __acCard 交换
(() => {
  // 截图设置的默认值：options 页与 capture.js 共用的唯一来源
  const SHOT_DEFAULTS = {
    shot_qr: true,
    shot_time: true,
    shot_brand: true,
    shot_qr_overlay: false, // 默认放图片下方的边栏；true 则把二维码压在图上
    shot_qr_corner: 'br', // tl | tr | bl | br，仅覆盖模式生效
    shot_default_mode: 'viewport', // selection | viewport | fullpage
    card_festival_bg: true, // 节日/节气主题背景，划线分享卡片与截图共用
    card_memorial_bg: false, // 纪念日主题背景（七七、九一八、国家公祭日等严肃主题），默认关闭
    card_default_theme: '', // 当天无命中时的兜底风格：''=默认蓝渐变，或节日主题名/pack_<id>:<key> 主题包条目（关掉节日开关时它就是常驻风格）
    card_pack_shot_bg: false, // 截图分享合成也使用主题包图案作背景（开启且当天命中时生效）
  };

  const fontMain = (size, weight = 600) => `${weight} ${size}px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;

  // 行头禁则字符：换行后不允许出现在行首的标点（标点跟前一个单元一起挪到下一行）
  const NO_LINE_START = new Set([...'!?,.;:%)]}、，。．：；？！）》〉」』】〕”’…‥·']);
  // 行尾禁则字符：行尾不允许出现的开放标点（随换行带到下一行行首）
  const NO_LINE_END = new Set([...'([{〈《〔（【「『“‘\u2018\u201C']);

  // 按最大宽度对文本做换行拆分。中英混排规则：连续英文字母/数字是一个不可断单元（"SU7"不再被拦腰断开），
  // 中文逐字可断；禁则标点不落行头/行尾；URL 这类超长单元自身占满一行时降级回逐字断
  function wrapText(ctx, text, maxWidth, maxLines) {
    const tokens = String(text || '').match(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*|\s+|\S/gu) || [];
    const lines = [];
    let cur = []; // 当前行的单元数组（空格也作为一个单元，join 后即行文本）
    const curStr = () => cur.join('');
    const fits = (s) => ctx.measureText(s).width <= maxWidth;
    const cut = () => { lines[maxLines - 1] = lines[maxLines - 1].replace(/\s+$/, '') + '…'; };

    // 收束当前行，firstToken 作为下一行的首个单元；超出最大行数时末行加省略号并返回 false
    const pushLine = (firstToken) => {
      // 行尾禁则：开放标点不留在行尾，随 firstToken 一起下去
      let next = firstToken || '';
      while (cur.length && NO_LINE_END.has(curStr().slice(-1))) next = cur.pop() + next;
      lines.push(curStr());
      cur = next ? [next] : [];
      if (lines.length >= maxLines) { cut(); return false; }
      return true;
    };

    for (const t of tokens) {
      if (/^\s+$/.test(t)) {
        // 空白：行首不放；行尾可断（断行时丢弃）；连续空白折叠为单个半角空格
        if (!cur.length) continue;
        if (fits(curStr() + ' ')) cur.push(' ');
        else if (!pushLine('')) return lines;
        continue;
      }
      if (cur.length && !fits(curStr() + t)) {
        // 行头禁则：标点不落行首，把上一行末尾的单元一起挪下来
        if (NO_LINE_START.has(t[0])) {
          if (cur.length && cur[cur.length - 1] === ' ') cur.pop();
          const last = cur.pop();
          if (last && cur.length) { if (!pushLine(last + t)) return lines; continue; }
          if (last) cur.push(last); // 上一行只剩一个单元时无可挪，退回普通断行
        }
        if (!pushLine(t)) return lines;
        continue;
      }
      // 超长单元（URL 等）单独占不下整行：降级为逐字断
      if (!cur.length && !fits(t) && t.length > 1) {
        for (const ch of t) {
          if (cur.length && !fits(curStr() + ch)) { if (!pushLine(ch)) return lines; continue; }
          cur.push(ch);
        }
        continue;
      }
      cur.push(t);
    }
    if (cur.length) lines.push(curStr());
    return lines;
  }

  // 二维码专用网址瘦身：去掉 query 里的投放追踪参数。只影响二维码编码内容，
  // 存储与评论归属仍用原始 page_url。不清洗的话营销长链（千字符级）会让二维码选不出尺寸
  function cleanUrlForQr(url) {
    const raw = String(url || '');
    let u;
    try { u = new URL(raw); } catch { return raw; }
    const PREFIX = /^(utm_|spm|from_|track|creative_|request_id|source_id|resource_id|title_|image_|linked_|share_|refer|scm|pf_|msclk|gclid|fbclid)/;
    const EXACT = new Set(['caid', 'scene', 'vd_source', 'vd_extension', 'uniqid', 'timestamp']);
    for (const k of [...u.searchParams.keys()]) {
      const v = u.searchParams.get(k) || '';
      const kl = k.toLowerCase();
      // 值是 __XX__ 占位符或超长串（加密追踪值）的也视为追踪参数
      if (PREFIX.test(kl) || EXACT.has(kl) || /^__.*__$/.test(v) || v.length > 100) u.searchParams.delete(k);
    }
    if (u.toString().length > 200) { // 仍超长（罕见）：整段 query 丢弃，保 origin+path 可达
      u.search = '';
      u.hash = '';
    }
    return u.toString();
  }

  // 生成网址二维码：库内部读取的是模块级 qrcode.stringToBytes（挂在实例上无效），
  // UTF-8 才能正确编码中文路径；网址过长时降低纠错率以控制二维码尺寸
  function buildQrMatrix(url) {
    if (!url || typeof qrcode !== 'function' || !qrcode.stringToBytesFuncs) return null;
    const clean = cleanUrlForQr(url);
    try {
      qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
      let qr = null;
      for (const ecl of ['M', 'L']) {
        qr = qrcode(0, ecl); // typeNumber 0 = 自动选尺寸
        qr.addData(clean, 'Byte');
        qr.make();
        if (qr.getModuleCount() <= 45) return qr;
      }
      return null; // 仍过大则不画，降级为日期
    } catch (e) {
      return null;
    }
  }

  // 圆角矩形路径（不闭合调用方自行 fill/stroke）
  function roundRectPath(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  // 逐模块画二维码：模块边长必须是整数像素（分数格会糊出灰边、手机识别率骤降），静默区 2 模块
  function drawQrModules(ctx, qr, x, y, cell, quiet = 2) {
    const count = qr.getModuleCount();
    ctx.fillStyle = '#1f2430';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(x + (c + quiet) * cell, y + (r + quiet) * cell, cell, cell);
      }
    }
    return (count + quiet * 2) * cell;
  }

  // 截图时间戳文案：YYYY-MM-DD HH:mm
  function fmtShotTime(ts) {
    const d = ts instanceof Date ? ts : new Date(ts || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // 渐变底 + 两个装饰圆：金句卡片与截图卡片共用同一套背景。
  // s=1 时与金句卡片原画法逐像素一致，截图合成传入整图外接尺寸与版式尺度
  function paintBackdrop(ctx, W, H, s = 1) {
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#eef3ff');
    bg.addColorStop(1, '#f9fbff');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(79,110,247,0.08)';
    ctx.beginPath(); ctx.arc(W - 40 * s, 40 * s, 130 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(47,107,255,0.06)';
    ctx.beginPath(); ctx.arc(30 * s, H - 30 * s, 100 * s, 0, Math.PI * 2); ctx.fill();
  }

  function paintWhiteCard(ctx, x, y, w, h, r, blur, offY, shadow = 'rgba(31,36,48,0.10)') {
    ctx.save();
    ctx.shadowColor = shadow;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetY = offY;
    ctx.fillStyle = '#ffffff';
    roundRectPath(ctx, x, y, w, h, r);
    ctx.fill();
    ctx.restore();
  }

  // ========== 节日 / 节气主题背景 ==========
  // 按当天日期命中，优先级：纪念日（开关开启时）> 公历节日（含母亲节/父亲节/感恩节现算）>
  // 农历节日/除夕 > 二十四节气 > 默认蓝渐变。
  // 主题只换外圈渐变底与角落装饰，白色圆角卡与文字排版不动；卡内另铺一层 7% 透明度
  // 的同款装饰水印（paintCardAccent），正文对比度不受影响。农历表覆盖 1900-2049，
  // 之外的年份只做节气命中（solarToLunar 返回 null 自动跳过农历分支）。

  // 农历压缩表（1900-2049，标准 calendar.js 口径）：低 4 位=闰月月份，0x10000=闰月大月，
  // 0x8000~0x10 依次为正月~腊月是否 30 天
  const LUNAR_INFO = [
    0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
    0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
    0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
    0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
    0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
    0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
    0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
    0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
    0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
    0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0,
    0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
    0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
    0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
    0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
    0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
  ];
  const lunarLeapMonth = (y) => LUNAR_INFO[y - 1900] & 0xf;
  function lunarMonthDays(y, m) { return (LUNAR_INFO[y - 1900] & (0x10000 >> m)) ? 30 : 29; }
  function lunarLeapDays(y) { return lunarLeapMonth(y) ? ((LUNAR_INFO[y - 1900] & 0x10000) ? 30 : 29) : 0; }
  function lunarYearDays(y) {
    let sum = 348;
    for (let i = 0x8000; i > 0x8; i >>= 1) sum += (LUNAR_INFO[y - 1900] & i) ? 1 : 0;
    return sum + lunarLeapDays(y);
  }
  // 公历 → 农历：{ year, month, day, isLeap }；年份不在表范围内返回 null
  function solarToLunar(y, m, d) {
    if (y < 1900 || y > 2049) return null;
    let off = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1900, 0, 31)) / 86400000);
    if (off < 0) return null;
    let year = 1900;
    for (;;) {
      const dys = lunarYearDays(year);
      if (off < dys) break;
      off -= dys; year++;
    }
    const leap = lunarLeapMonth(year);
    let month = 1, isLeap = false;
    for (;;) {
      const md = (leap > 0 && month === leap && isLeap) ? lunarLeapDays(year) : lunarMonthDays(year, month);
      if (off < md) break;
      off -= md;
      if (leap > 0 && month === leap && !isLeap) isLeap = true; // 闰月跟在同名月后，再吃一轮同号月
      else { month++; isLeap = false; }
    }
    return { year, month, day: off + 1, isLeap };
  }

  // 节气推算：太阳视黄经到达 15° 整数倍的时刻（Meeus 低精度太阳黄经，误差 <0.01°≈15 分钟，
  // 牛顿迭代收敛到交节瞬间），交节时刻按北京时间(UTC+8)所在日历日取「几号」。
  // 2025/2026 两年共 31 个抽样交节日已与便民查询网/香港天文台数据逐一核对一致
  const TERM_NAMES = ['小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至'];
  function solarLongitude(jd) { // jd = 儒略日，返回太阳视黄经（度）
    const T = (jd - 2451545.0) / 36525;
    const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
    const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
    const Mr = M * Math.PI / 180;
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mr)
      + (0.019993 - 0.000101 * T) * Math.sin(2 * Mr)
      + 0.000289 * Math.sin(3 * Mr);
    const omega = (125.04 - 1934.136 * T) * Math.PI / 180;
    return L0 + C - 0.00569 - 0.00478 * Math.sin(omega);
  }
  function termDay(y, n) {
    const target = (285 + 15 * n) % 360; // 小寒=285°，此后每节气 +15°
    let jd = Date.UTC(y, Math.floor(n / 2), 1) / 86400000 + 2440587.5 + 14; // 初估月中
    for (let i = 0; i < 40; i++) {
      const diff = ((solarLongitude(jd) - target) % 360 + 540) % 360 - 180;
      if (Math.abs(diff) < 1e-7) break;
      jd -= diff / 0.9856; // 黄经日均速 ≈0.9856°，定点迭代收敛
    }
    const ms = (jd - 2440587.5) * 86400000 + 8 * 3600000; // 交节瞬间 + 北京时区
    return new Date(ms).getUTCDate();
  }

  // 公历节日（'月,日' -> 主题 id）；母亲节/父亲节/感恩节为"第 N 个星期 X"，在 resolveTheme 里现算
  const SOLAR_FEST = { '1,1': 'newyear', '2,14': 'valentine', '3,8': 'women', '3,12': 'arbor', '4,1': 'fools', '5,1': 'labor', '5,4': 'youth', '5,12': 'nurse', '6,1': 'children', '7,1': 'party', '8,1': 'army', '9,10': 'teacher', '10,1': 'national', '10,31': 'halloween', '12,24': 'christmaseve', '12,25': 'christmas' };
  // 农历节日（'月,日' -> 主题 id）；除夕单独判「腊月最后一天」
  const LUNAR_FEST = { '1,1': 'spring', '1,15': 'lantern', '2,2': 'longtaitou', '5,5': 'dragonboat', '7,7': 'qixi', '8,15': 'midautumn', '9,9': 'double9', '12,8': 'laba', '12,23': 'xiaonianN', '12,24': 'xiaonianS' };

  // ----- 装饰原语：全部以传入矩形 (x0,y0,w,h) 为参照、b=min(w,h)*s 为尺度基准；
  // 伪随机用固定种子（同一主题同一尺寸重绘结果逐像素一致，预览不闪烁）-----
  function makeRng(seed) { let t = seed >>> 0; return () => ((t = (t * 9301 + 49297) >>> 0) % 233280) / 233280; }
  // 在矩形两个对角附近散布 n 个元素（i 偶数落右上、奇数落左下），fn(c, x, y, rng)
  function cornerScatter(ctx, x0, y0, w, h, n, seed, fn) {
    const rng = makeRng(seed);
    const b = Math.min(w, h);
    for (let i = 0; i < n; i++) {
      const topRight = i % 2 === 0;
      const x = topRight ? x0 + w - rng() * b * 0.2 : x0 + rng() * b * 0.2;
      const y = topRight ? y0 + rng() * b * 0.2 : y0 + h - rng() * b * 0.2;
      fn(ctx, x, y, rng, i);
    }
  }
  function star4(ctx, x, y, r, color, a = 1) {
    ctx.save(); ctx.globalAlpha *= a; ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.quadraticCurveTo(x, y, x + r, y); ctx.quadraticCurveTo(x, y, x, y + r);
    ctx.quadraticCurveTo(x, y, x - r, y); ctx.quadraticCurveTo(x, y, x, y - r);
    ctx.fill(); ctx.restore();
  }
  function flake(ctx, x, y, r, color, a = 1) {
    ctx.save(); ctx.globalAlpha *= a; ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, r * 0.14); ctx.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      const ang = Math.PI / 3 * i, dx = Math.cos(ang) * r, dy = Math.sin(ang) * r;
      ctx.beginPath(); ctx.moveTo(x - dx, y - dy); ctx.lineTo(x + dx, y + dy); ctx.stroke();
      for (const k of [0.6, -0.6]) {
        ctx.beginPath();
        ctx.moveTo(x + dx * 0.55, y + dy * 0.55);
        ctx.lineTo(x + dx * 0.55 + Math.cos(ang + k) * r * 0.34, y + dy * 0.55 + Math.sin(ang + k) * r * 0.34);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  function petal(ctx, x, y, r, rot, color, a = 1) {
    ctx.save(); ctx.globalAlpha *= a; ctx.fillStyle = color;
    ctx.translate(x, y); ctx.rotate(rot);
    ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.55, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function blossom(ctx, x, y, r, color, core = '#ffffff', a = 1) {
    ctx.save(); ctx.globalAlpha *= a; ctx.fillStyle = color;
    for (let i = 0; i < 5; i++) {
      const ang = -Math.PI / 2 + i * Math.PI * 2 / 5;
      ctx.beginPath();
      ctx.ellipse(x + Math.cos(ang) * r * 0.72, y + Math.sin(ang) * r * 0.72, r * 0.55, r * 0.38, ang, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(x, y, r * 0.26, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function heart(ctx, x, y, r, color, a = 1) {
    ctx.save(); ctx.globalAlpha *= a; ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y + r * 0.9);
    ctx.bezierCurveTo(x - r * 1.3, y - r * 0.1, x - r * 0.55, y - r, x, y - r * 0.35);
    ctx.bezierCurveTo(x + r * 0.55, y - r, x + r * 1.3, y - r * 0.1, x, y + r * 0.9);
    ctx.fill(); ctx.restore();
  }
  // 玫瑰（情人节）：外圈花瓣 + 螺旋花心 + 花萼茎叶
  function rose(ctx, x, y, r, color = 'rgba(214,74,124,0.95)', a = 1) {
    ctx.save(); ctx.globalAlpha *= a;
    ctx.strokeStyle = 'rgba(110,150,100,0.9)'; ctx.lineWidth = Math.max(1.2, r * 0.1); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y + r * 0.5); ctx.lineTo(x, y + r * 1.5); ctx.stroke(); // 茎
    leaf(ctx, x, y + r * 0.95, r * 0.55, -2.4, 'rgba(120,160,105,0.9)');
    leaf(ctx, x, y + r * 1.15, r * 0.5, -0.7, 'rgba(120,160,105,0.9)');
    ctx.fillStyle = 'rgba(150,175,120,0.9)'; // 花萼
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const ang = Math.PI / 2 + (i - 1) * 0.55;
      ctx.moveTo(x, y + r * 0.45);
      ctx.lineTo(x + Math.cos(ang) * r * 0.5, y + r * 0.45 + Math.sin(ang) * r * 0.5);
      ctx.lineTo(x + Math.cos(ang) * r * 0.14, y + r * 0.45 + Math.sin(ang) * r * 0.24);
    }
    ctx.fill();
    // 外圈花瓣：五片圆瓣
    ctx.fillStyle = color;
    for (let i = 0; i < 5; i++) {
      const ang = -Math.PI / 2 + i * Math.PI * 2 / 5 + 0.3;
      ctx.beginPath();
      ctx.ellipse(x + Math.cos(ang) * r * 0.62, y + Math.sin(ang) * r * 0.62, r * 0.48, r * 0.42, ang, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath(); ctx.arc(x, y, r * 0.72, 0, Math.PI * 2); ctx.fill();
    // 螺旋花心：三圈渐细弧线
    ctx.strokeStyle = 'rgba(140,35,80,0.75)'; ctx.lineWidth = Math.max(1, r * 0.075);
    for (let i = 0; i < 3; i++) {
      const rr = r * (0.58 - i * 0.17), a0 = i * 2.4;
      ctx.beginPath(); ctx.arc(x, y, rr, a0, a0 + Math.PI * 1.6); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(140,35,80,0.85)';
    ctx.beginPath(); ctx.arc(x, y, r * 0.12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.28)'; // 高光
    ctx.beginPath(); ctx.ellipse(x - r * 0.34, y - r * 0.34, r * 0.16, r * 0.1, -0.7, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 父亲背影（父亲节）：父亲牵小孩的背影剪影，(x,y) 为父亲脚底中心
  function fatherBack(ctx, x, y, h, color = 'rgba(42,74,140,0.95)', a = 1) {
    ctx.save(); ctx.globalAlpha *= a; ctx.fillStyle = color;
    const hw = h * 0.24; // 父亲半肩宽
    // 头
    ctx.beginPath(); ctx.arc(x - h * 0.1, y - h * 0.88, h * 0.085, 0, Math.PI * 2); ctx.fill();
    // 躯干：肩宽体厚，微收腰
    ctx.beginPath();
    ctx.moveTo(x - h * 0.1 - hw, y - h * 0.76);
    ctx.quadraticCurveTo(x - h * 0.1 - hw * 1.06, y - h * 0.42, x - h * 0.1 - hw * 0.72, y - h * 0.36);
    ctx.lineTo(x - h * 0.1 + hw * 0.72, y - h * 0.36);
    ctx.quadraticCurveTo(x - h * 0.1 + hw * 1.06, y - h * 0.42, x - h * 0.1 + hw, y - h * 0.76);
    ctx.quadraticCurveTo(x - h * 0.1, y - h * 0.83, x - h * 0.1 - hw, y - h * 0.76);
    ctx.closePath(); ctx.fill();
    // 双腿
    ctx.fillRect(x - h * 0.1 - hw * 0.62, y - h * 0.38, hw * 0.5, h * 0.38);
    ctx.fillRect(x - h * 0.1 + hw * 0.12, y - h * 0.38, hw * 0.5, h * 0.38);
    // 左臂自然下垂；右臂斜下牵着小孩
    ctx.strokeStyle = color; ctx.lineWidth = h * 0.075; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - h * 0.1 - hw * 0.92, y - h * 0.72); ctx.lineTo(x - h * 0.1 - hw * 1.02, y - h * 0.4); ctx.stroke();
    const handX = x + h * 0.22, handY = y - h * 0.42;
    ctx.beginPath(); ctx.moveTo(x - h * 0.1 + hw * 0.92, y - h * 0.72); ctx.lineTo(handX, handY); ctx.stroke();
    // 小孩（右手边）：头 + 身 + 腿 + 外摆的手臂
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(handX + h * 0.11, y - h * 0.52, h * 0.055, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath();
    ctx.ellipse(handX + h * 0.11, y - h * 0.4, h * 0.055, h * 0.085, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(handX + h * 0.11 - h * 0.038, y - h * 0.33, h * 0.03, h * 0.2);
    ctx.fillRect(handX + h * 0.11 + h * 0.008, y - h * 0.33, h * 0.03, h * 0.2);
    ctx.strokeStyle = color; ctx.lineWidth = h * 0.03;
    ctx.beginPath(); ctx.moveTo(handX + h * 0.155, y - h * 0.44); ctx.lineTo(handX + h * 0.21, y - h * 0.33); ctx.stroke();
    ctx.restore();
  }
  // 灯笼：扁椭圆灯身（h 传 0.72w 左右）+ 细密经线骨架 + 窄金盖 + 流苏
  function lantern(ctx, x, y, w, h, body = '#e8443a') {
    const gold = '#e7c463';
    const rx = w / 2, ry = h / 2;
    ctx.save();
    ctx.strokeStyle = gold; ctx.lineWidth = Math.max(1, w * 0.04); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y - ry - h * 0.55); ctx.lineTo(x, y - ry - h * 0.06); ctx.stroke(); // 挂绳
    ctx.fillStyle = gold;
    ctx.fillRect(x - w * 0.12, y - ry - h * 0.09, w * 0.24, h * 0.1); // 上盖（窄于灯身）
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    ctx.save(); // 竖条纹：裁进灯身内画经线椭圆（细密骨架，深色压暗条纹，半透明大图标下也清晰）
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.clip();
    ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.lineWidth = Math.max(1, w * 0.028);
    for (const k of [0.22, 0.44, 0.66, 0.88]) {
      ctx.beginPath(); ctx.ellipse(x, y, rx * k, ry, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath(); ctx.ellipse(x - rx * 0.34, y - ry * 0.3, rx * 0.15, ry * 0.28, -0.4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.fillStyle = gold;
    ctx.fillRect(x - w * 0.09, y + ry - h * 0.02, w * 0.18, h * 0.08); // 下盖
    ctx.beginPath(); ctx.moveTo(x, y + ry + h * 0.06); ctx.lineTo(x, y + ry + h * 0.38); ctx.stroke(); // 流苏
    ctx.restore();
  }
  function balloon(ctx, x, y, r, color, withStr = true) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.ellipse(x, y, r * 0.82, r, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.ellipse(x - r * 0.25, y - r * 0.3, r * 0.18, r * 0.28, -0.5, 0, Math.PI * 2); ctx.fill();
    if (withStr) {
      ctx.strokeStyle = 'rgba(31,36,48,0.25)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y + r); ctx.quadraticCurveTo(x + r * 0.3, y + r * 2.1, x, y + r * 3.2); ctx.stroke();
    }
    ctx.restore();
  }
  function fullMoon(ctx, x, y, r, color = '#ffe9a8', halo = 'rgba(255,233,168,0.28)') {
    ctx.save();
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(x, y, r * 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(214,178,94,0.35)';
    ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.15, r * 0.18, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + r * 0.25, y + r * 0.28, r * 0.12, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function cloud(ctx, x, y, w, color, a = 1) {
    ctx.save(); ctx.globalAlpha *= a; ctx.fillStyle = color;
    const h = w * 0.32;
    ctx.beginPath();
    ctx.arc(x - w * 0.28, y, h * 0.62, 0, Math.PI * 2);
    ctx.arc(x, y - h * 0.35, h * 0.85, 0, Math.PI * 2);
    ctx.arc(x + w * 0.3, y, h * 0.66, 0, Math.PI * 2);
    ctx.fill(); ctx.restore();
  }
  function leaf(ctx, x, y, len, rot, color, a = 1, veins = false) {
    ctx.save(); ctx.globalAlpha *= a; ctx.fillStyle = color;
    ctx.translate(x, y); ctx.rotate(rot);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(len * 0.5, -len * 0.32, len, 0);
    ctx.quadraticCurveTo(len * 0.5, len * 0.32, 0, 0);
    ctx.fill();
    if (veins) { // 叶脉：主脉 + 三对侧脉
      ctx.strokeStyle = 'rgba(60,40,20,0.4)'; ctx.lineWidth = Math.max(0.8, len * 0.028); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(len * 0.06, 0); ctx.lineTo(len * 0.92, 0); ctx.stroke();
      ctx.lineWidth = Math.max(0.6, len * 0.02);
      for (const t of [0.3, 0.52, 0.74]) {
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(len * t, 0);
          ctx.lineTo(len * (t + 0.14), s * len * 0.17);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }
  function sprout(ctx, x, y, h, color, a = 1) {
    ctx.save(); ctx.globalAlpha *= a; ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.4, h * 0.09); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x, y - h * 0.6, x, y - h); ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.ellipse(x - h * 0.24, y - h * 0.68, h * 0.26, h * 0.13, -0.6, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x + h * 0.24, y - h * 0.88, h * 0.26, h * 0.13, 0.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function raindrop(ctx, x, y, len, color, a = 1) {
    ctx.save(); ctx.globalAlpha *= a; ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, len * 0.12); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - len * 0.25, y + len); ctx.stroke();
    ctx.restore();
  }
  function confetti(ctx, x, y, size, rot, color, a = 1) {
    ctx.save(); ctx.globalAlpha *= a; ctx.fillStyle = color;
    ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillRect(-size / 2, -size / 4, size, size / 2);
    ctx.restore();
  }
  function firework(ctx, x, y, r, color, a = 1) {
    ctx.save(); ctx.globalAlpha *= a;
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, r * 0.06); ctx.lineCap = 'round';
    for (let i = 0; i < 12; i++) {
      const ang = Math.PI * 2 * i / 12;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(ang) * r * 0.3, y + Math.sin(ang) * r * 0.3);
      ctx.lineTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r);
      ctx.stroke();
    }
    ctx.fillStyle = color;
    for (let i = 0; i < 12; i++) {
      const ang = Math.PI * 2 * i / 12 + Math.PI / 12;
      ctx.beginPath(); ctx.arc(x + Math.cos(ang) * r * 0.65, y + Math.sin(ang) * r * 0.65, r * 0.05, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  function wheat(ctx, x, y, len, rot, color, a = 1) {
    ctx.save(); ctx.globalAlpha *= a; ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.2, len * 0.06); ctx.lineCap = 'round';
    ctx.translate(x, y); ctx.rotate(rot);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -len); ctx.stroke();
    ctx.fillStyle = color;
    for (let i = 0; i < 5; i++) {
      const t = i / 5, yy = -len * (0.35 + t * 0.6), ww = len * (0.17 - t * 0.06);
      ctx.beginPath(); ctx.ellipse(-ww, yy, ww * 0.5, ww, -0.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(ww, yy, ww * 0.5, ww, 0.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  // 大太阳贴角落（只露四分之一圆也成立），配 8 道光线
  function sunDeco(ctx, cx, cy, r, color) {
    ctx.save();
    ctx.fillStyle = 'rgba(247,196,107,0.3)';
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(247,196,107,0.6)';
    ctx.lineWidth = Math.max(1.5, r * 0.06); ctx.lineCap = 'round';
    for (let i = 0; i < 8; i++) {
      const ang = Math.PI * 2 * i / 8 + 0.3;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r * 1.35, cy + Math.sin(ang) * r * 1.35);
      ctx.lineTo(cx + Math.cos(ang) * r * 1.75, cy + Math.sin(ang) * r * 1.75);
      ctx.stroke();
    }
    ctx.restore();
  }
  // 圣诞帽：(x,y) 为帽底中心，w 宽 h 高，rot 旋转；红帽身 + 帽边绒毛 + 右垂帽尖绒球。
  // tone 控制白色部分颜色：半透明大图标层压白卡时传浅灰（纯白 ×0.25 会隐身）
  function santaHat(ctx, x, y, w, h, rot = 0, tone = '#ffffff') {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(rot);
    const bandH = Math.max(2, w * 0.22);
    ctx.fillStyle = '#d84a45';
    ctx.beginPath();
    ctx.moveTo(-w * 0.4, -bandH);
    ctx.quadraticCurveTo(-w * 0.48, -h * 0.72, w * 0.08, -h);
    ctx.quadraticCurveTo(w * 0.3, -h * 0.86, w * 0.38, -h * 0.55);
    ctx.quadraticCurveTo(w * 0.46, -h * 0.3, w * 0.42, -bandH);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = tone;
    ctx.strokeStyle = 'rgba(120,135,160,0.6)'; ctx.lineWidth = Math.max(1, w * 0.025);
    roundRectPath(ctx, -w * 0.55, -bandH / 2, w * 1.05, bandH, bandH / 2);
    ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(w * 0.4, -h * 0.55, w * 0.14, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  // 苹果（平安果）：经典果形轮廓（顶凹 + 双瓣底）+ 高光 + 果柄绿叶
  function apple(ctx, x, y, r, body = '#d64545') {
    ctx.save();
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(x, y - r * 0.45);
    ctx.bezierCurveTo(x - r * 0.3, y - r * 0.9, x - r * 1.05, y - r * 0.5, x - r * 0.95, y + r * 0.2);
    ctx.bezierCurveTo(x - r * 0.88, y + r * 0.85, x - r * 0.35, y + r * 0.95, x, y + r * 0.6);
    ctx.bezierCurveTo(x + r * 0.35, y + r * 0.95, x + r * 0.88, y + r * 0.85, x + r * 0.95, y + r * 0.2);
    ctx.bezierCurveTo(x + r * 1.05, y - r * 0.5, x + r * 0.3, y - r * 0.9, x, y - r * 0.45);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.beginPath(); ctx.ellipse(x - r * 0.38, y - r * 0.2, r * 0.14, r * 0.3, -0.55, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.beginPath(); ctx.ellipse(x + r * 0.4, y + r * 0.35, r * 0.3, r * 0.2, 0.6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#7a4a2d'; ctx.lineWidth = Math.max(1, r * 0.14); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y - r * 0.42); ctx.quadraticCurveTo(x + r * 0.04, y - r * 0.85, x + r * 0.24, y - r * 1.05); ctx.stroke();
    leaf(ctx, x + r * 0.42, y - r * 0.88, r * 0.7, -0.55, '#4a9e5a');
    ctx.restore();
  }
  // 五角星：r 为外接圆半径，一角朝上
  function star5(ctx, x, y, r, color, a = 1) {
    ctx.save(); ctx.globalAlpha *= a; ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const ang = -Math.PI / 2 + i * Math.PI * 2 / 5;
      const vx = x + Math.cos(ang) * r, vy = y + Math.sin(ang) * r;
      const ang2 = ang + Math.PI / 5;
      if (i === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
      ctx.lineTo(x + Math.cos(ang2) * r * 0.42, y + Math.sin(ang2) * r * 0.42);
    }
    ctx.closePath(); ctx.fill(); ctx.restore();
  }
  // 蜡烛：(x,y) 为烛身底边中心，暖光火苗 + 柔光晕（纪念日主题的悼念烛光）
  function candle(ctx, x, y, w, h, a = 1) {
    ctx.save(); ctx.globalAlpha *= a;
    const glow = ctx.createRadialGradient(x, y - h * 0.72, 0, x, y - h * 0.72, w * 1.6);
    glow.addColorStop(0, 'rgba(255,214,140,0.45)'); glow.addColorStop(1, 'rgba(255,214,140,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(x, y - h * 0.72, w * 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f0e6d4';
    roundRectPath(ctx, x - w / 2, y - h * 0.62, w, h * 0.62, Math.min(w * 0.18, w / 2)); ctx.fill();
    ctx.strokeStyle = 'rgba(31,36,48,0.55)'; ctx.lineWidth = Math.max(1, w * 0.09); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y - h * 0.62); ctx.lineTo(x, y - h * 0.7); ctx.stroke();
    ctx.fillStyle = '#f7a23c';
    ctx.beginPath();
    ctx.moveTo(x, y - h * 0.98);
    ctx.quadraticCurveTo(x + w * 0.24, y - h * 0.76, x, y - h * 0.66);
    ctx.quadraticCurveTo(x - w * 0.24, y - h * 0.76, x, y - h * 0.98);
    ctx.fill();
    ctx.fillStyle = '#ffe9a8';
    ctx.beginPath(); ctx.ellipse(x, y - h * 0.78, w * 0.09, h * 0.07, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 树（植树节）：树干 + 云朵状层叠树冠（三圆深度重叠，无尖顶）+ 高光
  function tree(ctx, x, y, h, color = '#3c8c50', trunkColor = 'rgba(140,100,70,0.85)') {
    ctx.save();
    ctx.fillStyle = trunkColor;
    ctx.fillRect(x - h * 0.055, y - h * 0.4, h * 0.11, h * 0.4);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y - h * 0.56, h * 0.27, 0, Math.PI * 2);
    ctx.arc(x - h * 0.21, y - h * 0.4, h * 0.2, 0, Math.PI * 2);
    ctx.arc(x + h * 0.21, y - h * 0.4, h * 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath(); ctx.arc(x - h * 0.09, y - h * 0.63, h * 0.12, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + h * 0.14, y - h * 0.5, h * 0.08, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    ctx.beginPath(); ctx.arc(x + h * 0.13, y - h * 0.34, h * 0.1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 笑脸（愚人节）
  function smiley(ctx, x, y, r, color = '#ffd93d') {
    ctx.save(); ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(31,36,48,0.65)'; ctx.lineWidth = Math.max(1, r * 0.1); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(x, y + r * 0.1, r * 0.5, 0.3, Math.PI - 0.3); ctx.stroke();
    ctx.fillStyle = 'rgba(31,36,48,0.65)';
    ctx.beginPath(); ctx.arc(x - r * 0.32, y - r * 0.24, r * 0.1, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + r * 0.32, y - r * 0.24, r * 0.1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 医疗十字（护士节）：圆角实心十字
  function medCross(ctx, x, y, size, color = '#e8708f') {
    const a = size * 0.34, b = size * 0.5, r = a * 0.3;
    ctx.save(); ctx.fillStyle = color;
    roundRectPath(ctx, x - a, y - b, a * 2, b * 2, r); ctx.fill();
    roundRectPath(ctx, x - b, y - a, b * 2, a * 2, r); ctx.fill();
    ctx.restore();
  }
  // 南瓜（万圣夜）：扁圆橙身 + 竖棱 + 弯瓜蒂 + 高光；face=true 画南瓜灯脸（三角眼 + 锯齿嘴）
  function pumpkin(ctx, x, y, r, body = '#ef8a2f', face = false) {
    ctx.save();
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.66, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(140,70,20,0.4)'; ctx.lineWidth = Math.max(1, r * 0.07);
    for (const k of [0.45, 0.8]) {
      ctx.beginPath(); ctx.ellipse(x, y, r * k, r * 0.66, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.strokeStyle = '#5a7a3a'; ctx.lineWidth = Math.max(1.2, r * 0.13); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y - r * 0.62); ctx.quadraticCurveTo(x + r * 0.1, y - r * 0.95, x + r * 0.24, y - r * 1.0); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath(); ctx.ellipse(x - r * 0.34, y - r * 0.2, r * 0.15, r * 0.2, -0.5, 0, Math.PI * 2); ctx.fill();
    if (face) {
      ctx.fillStyle = 'rgba(96,44,10,0.9)';
      for (const s of [-1, 1]) { // 三角眼
        ctx.beginPath();
        ctx.moveTo(x + s * r * 0.16, y - r * 0.28);
        ctx.lineTo(x + s * r * 0.48, y - r * 0.14);
        ctx.lineTo(x + s * r * 0.2, y - r * 0.02);
        ctx.closePath(); ctx.fill();
      }
      ctx.beginPath(); // 鼻
      ctx.moveTo(x, y - r * 0.12); ctx.lineTo(x + r * 0.09, y + r * 0.02); ctx.lineTo(x - r * 0.09, y + r * 0.02);
      ctx.closePath(); ctx.fill();
      ctx.beginPath(); // 锯齿咧嘴
      ctx.moveTo(x - r * 0.52, y + r * 0.16);
      for (let i = 0; i < 4; i++) {
        const t0 = i / 4, t1 = (i + 0.5) / 4, t2 = (i + 1) / 4;
        ctx.lineTo(x - r * 0.52 + r * 1.04 * t1, y + r * 0.3);
        ctx.lineTo(x - r * 0.52 + r * 1.04 * t2, y + r * 0.16);
      }
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  // 蝙蝠（万圣夜）：双翼剪影 + 小耳
  function bat(ctx, x, y, r, a = 1) {
    ctx.save(); ctx.globalAlpha *= a; ctx.fillStyle = 'rgba(56,44,80,0.85)';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x - r * 0.3, y - r * 0.45, x - r, y - r * 0.2);
    ctx.quadraticCurveTo(x - r * 0.55, y + r * 0.05, x - r * 0.62, y + r * 0.38);
    ctx.quadraticCurveTo(x - r * 0.3, y + r * 0.18, x, y + r * 0.3);
    ctx.quadraticCurveTo(x + r * 0.3, y + r * 0.18, x + r * 0.62, y + r * 0.38);
    ctx.quadraticCurveTo(x + r * 0.55, y + r * 0.05, x + r, y - r * 0.2);
    ctx.quadraticCurveTo(x + r * 0.3, y - r * 0.45, x, y);
    ctx.moveTo(x - r * 0.16, y - r * 0.08);
    ctx.lineTo(x - r * 0.2, y - r * 0.42);
    ctx.lineTo(x - r * 0.02, y - r * 0.16);
    ctx.moveTo(x + r * 0.16, y - r * 0.08);
    ctx.lineTo(x + r * 0.2, y - r * 0.42);
    ctx.lineTo(x + r * 0.02, y - r * 0.16);
    ctx.fill();
    ctx.restore();
  }
  // 领带（父亲节）：(x,y) 为领结顶边中心，结 + 箭头形带身向下延伸 h
  function necktie(ctx, x, y, w, h, color = '#3d5aa8') {
    ctx.save(); ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x - w * 0.32, y);
    ctx.lineTo(x + w * 0.32, y);
    ctx.lineTo(x + w * 0.18, y + h * 0.2);
    ctx.lineTo(x - w * 0.18, y + h * 0.2);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - w * 0.18, y + h * 0.23);
    ctx.lineTo(x + w * 0.18, y + h * 0.23);
    ctx.lineTo(x + w * 0.3, y + h * 0.86);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x - w * 0.3, y + h * 0.86);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(x - w * 0.08, y + h * 0.23);
    ctx.lineTo(x + w * 0.02, y + h * 0.23);
    ctx.lineTo(x - w * 0.06, y + h * 0.9);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  // 糖瓜（小年）：白胖糖球 + 高光 + 淡影
  function sugarBall(ctx, x, y, r, a = 1) {
    ctx.save(); ctx.globalAlpha *= a;
    ctx.fillStyle = 'rgba(31,36,48,0.1)';
    ctx.beginPath(); ctx.ellipse(x, y + r * 0.92, r * 0.8, r * 0.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fdf6e8';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(210,180,130,0.5)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath(); ctx.ellipse(x - r * 0.3, y - r * 0.3, r * 0.22, r * 0.13, -0.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 龙（龙抬头）：锥形蛇身（尾细头粗）+ 背鳍 + 四爪 + 带角张嘴龙头，(x,y) 为尾部起点，龙头朝右上
  function dragon(ctx, x, y, len, rot = 0, color = '#d6a94a', a = 1) {
    ctx.save(); ctx.globalAlpha *= a;
    ctx.translate(x, y); ctx.rotate(rot);
    const P = [[0, 0], [len * 0.32, len * 0.26], [len * 0.38, -len * 0.3], [len * 0.74, -len * 0.26]];
    const bez = (t) => {
      const u = 1 - t;
      return [
        u * u * u * P[0][0] + 3 * u * u * t * P[1][0] + 3 * u * t * t * P[2][0] + t * t * t * P[3][0],
        u * u * u * P[0][1] + 3 * u * u * t * P[1][1] + 3 * u * t * t * P[2][1] + t * t * t * P[3][1],
      ];
    };
    const tan = (t) => {
      const e = 0.02, [ax, ay] = bez(Math.max(0, t - e)), [bx, by] = bez(Math.min(1, t + e));
      const d = Math.hypot(bx - ax, by - ay) || 1;
      return [(bx - ax) / d, (by - ay) / d];
    };
    // 身体：沿曲线铺渐缩圆段，尾细颈粗
    ctx.fillStyle = color;
    for (let i = 0; i <= 30; i++) {
      const t = i / 30;
      const [px, py] = bez(t);
      const r = len * (0.022 + t * 0.055);
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    }
    // 尾鳍：尾端三角小扇
    {
      const [px, py] = bez(0.02);
      const [tx, ty] = tan(0.02);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px - tx * len * 0.1 - ty * len * 0.07, py - ty * len * 0.1 + tx * len * 0.07);
      ctx.lineTo(px - tx * len * 0.13, py - ty * len * 0.13);
      ctx.lineTo(px - tx * len * 0.1 + ty * len * 0.07, py - ty * len * 0.1 - tx * len * 0.07);
      ctx.closePath(); ctx.fill();
    }
    // 背鳍：沿背脊外侧一排小三角（统一朝曲线一侧的"上方"）
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    for (let i = 1; i <= 8; i++) {
      const t = 0.06 + (i / 9) * 0.8;
      const [px, py] = bez(t), [tx, ty] = tan(t);
      let nx = -ty, ny = tx;
      if (ny > 0) { nx = -nx; ny = -ny; } // 背鳍统一朝上
      const r = len * (0.03 + t * 0.045);
      ctx.beginPath();
      ctx.moveTo(px + tx * len * 0.035 + nx * r * 0.8, py + ty * len * 0.035 + ny * r * 0.8);
      ctx.lineTo(px + nx * (r + len * 0.075), py + ny * (r + len * 0.075));
      ctx.lineTo(px - tx * len * 0.035 + nx * r * 0.8, py - ty * len * 0.035 + ny * r * 0.8);
      ctx.closePath(); ctx.fill();
    }
    // 爪：前后两对，贴身向斜下后方的短折线 + 三尖爪
    ctx.strokeStyle = color; ctx.lineCap = 'round';
    const claw = (t, side) => {
      const [px, py] = bez(t), [tx, ty] = tan(t);
      // 前肢朝运动方向斜前下，后肢斜后下，均为小角度不外戳
      const sweep = side > 0 ? 0.9 : 2.3;
      const dx = tx * Math.cos(sweep) - ty * Math.sin(sweep);
      const dy = tx * Math.sin(sweep) + ty * Math.cos(sweep);
      const bx2 = px + dx * len * 0.09, by2 = py + dy * len * 0.09;
      ctx.lineWidth = Math.max(1.4, len * 0.032);
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(bx2, by2); ctx.stroke();
      const ex = bx2 + dx * len * 0.06, ey = by2 + dy * len * 0.06;
      ctx.beginPath(); ctx.moveTo(bx2, by2); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.lineWidth = Math.max(1, len * 0.018);
      for (const s2 of [-0.5, 0, 0.5]) {
        const cx2 = dx * Math.cos(s2) - dy * Math.sin(s2), cy2 = dx * Math.sin(s2) + dy * Math.cos(s2);
        ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex + cx2 * len * 0.045, ey + cy2 * len * 0.045); ctx.stroke();
      }
    };
    claw(0.3, 1); claw(0.66, 1);
    // 龙头：鹿角 + 张嘴上下颚 + 眼 + 卷须
    const hx = P[3][0], hy = P[3][1];
    const [tx, ty] = tan(0.96);
    ctx.save();
    ctx.translate(hx, hy); ctx.rotate(Math.atan2(ty, tx));
    ctx.fillStyle = color;
    // 头颅（放大，占显眼比例）
    ctx.beginPath(); ctx.ellipse(-len * 0.02, 0, len * 0.15, len * 0.11, 0, 0, Math.PI * 2); ctx.fill();
    // 上颚（前伸，微微张开）
    ctx.beginPath();
    ctx.moveTo(len * 0.04, -len * 0.07);
    ctx.quadraticCurveTo(len * 0.18, -len * 0.08, len * 0.27, -len * 0.005);
    ctx.quadraticCurveTo(len * 0.16, len * 0.02, len * 0.03, len * 0.025);
    ctx.closePath(); ctx.fill();
    // 下颚（张开）
    ctx.beginPath();
    ctx.moveTo(len * 0.03, len * 0.03);
    ctx.quadraticCurveTo(len * 0.13, len * 0.04, len * 0.2, len * 0.1);
    ctx.quadraticCurveTo(len * 0.09, len * 0.11, len * 0.0, len * 0.08);
    ctx.closePath(); ctx.fill();
    // 鹿角：两根后掠分叉
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.6, len * 0.035);
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(-len * 0.07, -len * 0.09 * s);
      ctx.quadraticCurveTo(-len * 0.19, -len * 0.26 * s, -len * 0.27, -len * 0.31 * s);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-len * 0.15, -len * 0.19 * s);
      ctx.lineTo(-len * 0.07, -len * 0.28 * s);
      ctx.stroke();
    }
    // 眼
    ctx.fillStyle = 'rgba(31,36,48,0.75)';
    ctx.beginPath(); ctx.arc(len * 0.03, -len * 0.05, len * 0.022, 0, Math.PI * 2); ctx.fill();
    // 双龙须：从吻侧向前卷
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, len * 0.022);
    for (const s of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(len * 0.25, len * 0.01);
      ctx.quadraticCurveTo(len * 0.4, -len * 0.03 * s, len * 0.44, len * 0.09 * s);
      ctx.stroke();
    }
    ctx.restore();
    ctx.restore();
  }

  // ---------- 主题专属图形原语（每主题一个独有主图案；25% 半透明压白卡上，勿用纯白/近白填色）----------
  // 五星红旗（国庆）：旗杆 + 波浪红旗 + 一大四小黄星
  function flag(ctx, x, y, w, h) {
    ctx.save();
    ctx.strokeStyle = 'rgba(130,100,70,0.9)'; ctx.lineWidth = Math.max(1.5, w * 0.035); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x, y); ctx.stroke();
    ctx.fillStyle = 'rgba(220,70,55,0.95)';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + w * 0.45, y + h * 0.18, x + w, y + h * 0.06);
    ctx.lineTo(x + w, y + h * 0.56);
    ctx.quadraticCurveTo(x + w * 0.45, y + h * 0.68, x, y + h * 0.5);
    ctx.closePath(); ctx.fill();
    star5(ctx, x + w * 0.2, y + h * 0.22, w * 0.09, '#f0c050');
    for (const [sx, sy] of [[0.38, 0.12], [0.46, 0.26], [0.46, 0.42], [0.38, 0.55]]) {
      star5(ctx, x + w * sx, y + h * sy, w * 0.038, '#f0c050');
    }
    ctx.restore();
  }
  // 党旗（建党节）：红旗（比例 3:2）+ 左上角黄色锤子镰刀
  function partyFlag(ctx, x, y, w) {
    const h = w * 2 / 3;
    ctx.save();
    ctx.strokeStyle = 'rgba(130,100,70,0.9)'; ctx.lineWidth = Math.max(1.5, w * 0.035); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x, y); ctx.stroke();
    ctx.fillStyle = 'rgba(220,70,55,0.95)';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + w * 0.45, y + h * 0.18, x + w, y + h * 0.06);
    ctx.lineTo(x + w, y + h * 0.56);
    ctx.quadraticCurveTo(x + w * 0.45, y + h * 0.68, x, y + h * 0.5);
    ctx.closePath(); ctx.fill();
    // 锤镰：位于旗面左上四分之一处
    ctx.save();
    ctx.translate(x + w * 0.27, y + h * 0.32);
    const e = w * 0.17;
    ctx.strokeStyle = '#f0c050'; ctx.fillStyle = '#f0c050'; ctx.lineCap = 'round';
    // 镰刀：C 形刃 + 短柄（刃口朝右下）
    ctx.lineWidth = Math.max(1.4, e * 0.22);
    ctx.beginPath(); ctx.arc(0, 0, e * 0.62, Math.PI * 0.55, Math.PI * 1.55); ctx.stroke();
    ctx.lineWidth = Math.max(1.4, e * 0.2);
    ctx.beginPath(); ctx.moveTo(-e * 0.1, e * 0.58); ctx.lineTo(e * 0.3, e * 0.88); ctx.stroke();
    // 锤子：斜柄 + 矩形锤头（与镰刀斜向交叉）
    ctx.save();
    ctx.rotate(-Math.PI / 4);
    ctx.lineWidth = Math.max(1.4, e * 0.18);
    ctx.beginPath(); ctx.moveTo(-e * 0.75, 0); ctx.lineTo(e * 0.35, 0); ctx.stroke();
    ctx.beginPath();
    roundRectPath(ctx, e * 0.3, -e * 0.3, e * 0.42, e * 0.6, e * 0.1);
    ctx.fill();
    ctx.restore();
    ctx.restore();
    ctx.restore();
  }
  // 礼花筒（元旦）：锥筒尖朝左下，彩带彩点沿筒口朝右上（45°）喷出
  function popper(ctx, x, y, size, rot = 0) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = 'rgba(226,120,80,0.95)';
    ctx.beginPath();
    ctx.moveTo(-size * 0.5, size * 0.5);
    ctx.lineTo(-size * 0.08, size * 0.34);
    ctx.lineTo(-size * 0.34, size * 0.08);
    ctx.closePath(); ctx.fill();
    const cols = ['rgba(240,200,70,0.95)', 'rgba(110,175,230,0.95)', 'rgba(235,130,160,0.95)', 'rgba(150,125,215,0.95)'];
    const aim = -Math.PI / 4; // 筒口方向：锥尖(-0.5,0.5)指向筒口中点(-0.21,0.21) 即右上 45°
    for (let i = 0; i < 7; i++) {
      const ang = aim + (i - 3) * 0.3;
      const r1 = size * 0.42, r2 = r1 + size * (0.2 + (i % 3) * 0.1);
      const mx = -size * 0.21, my = size * 0.21;
      ctx.strokeStyle = cols[i % cols.length]; ctx.lineWidth = Math.max(1.2, size * 0.05); ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(mx + Math.cos(ang) * r1, my + Math.sin(ang) * r1);
      ctx.lineTo(mx + Math.cos(ang) * r2, my + Math.sin(ang) * r2);
      ctx.stroke();
      ctx.fillStyle = cols[(i + 1) % cols.length];
      ctx.beginPath(); ctx.arc(mx + Math.cos(ang) * (r2 + size * 0.07), my + Math.sin(ang) * (r2 + size * 0.07), size * 0.035, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  // 碗（元宵汤圆 / 腊八粥共用器型，内容与颜色由调用方区分）
  function bowl(ctx, x, y, w, color) {
    const h = w * 0.55;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x - w / 2, y);
    ctx.quadraticCurveTo(x - w * 0.42, y + h, x, y + h);
    ctx.quadraticCurveTo(x + w * 0.42, y + h, x + w / 2, y);
    ctx.closePath(); ctx.fill();
    ctx.fillRect(x - w * 0.14, y + h - 1, w * 0.28, h * 0.14);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath(); ctx.ellipse(x, y, w / 2, w * 0.085, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 热气：两缕上升波纹
  function steam(ctx, x, y, h, color = 'rgba(150,160,180,0.8)', a = 1) {
    ctx.save(); ctx.globalAlpha *= a; ctx.strokeStyle = color; ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.2, h * 0.09);
    for (const dx of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x + dx * h * 0.22, y);
      ctx.bezierCurveTo(x + dx * h * 0.02, y - h * 0.35, x + dx * h * 0.42, y - h * 0.6, x + dx * h * 0.16, y - h);
      ctx.stroke();
    }
    ctx.restore();
  }
  // 饺子（冬至）：月牙身 + 上弧褶边（25% 透明度下用较深奶黄 + 描边保证可见）
  function dumpling(ctx, x, y, w, rot = 0) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = 'rgba(230,205,150,0.98)';
    ctx.strokeStyle = 'rgba(170,140,90,0.9)';
    ctx.lineWidth = Math.max(1.2, w * 0.035);
    ctx.beginPath();
    ctx.moveTo(-w / 2, 0);
    ctx.quadraticCurveTo(0, -w * 0.62, w / 2, 0);
    ctx.quadraticCurveTo(0, w * 0.3, -w / 2, 0);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(170,140,95,0.8)'; ctx.lineWidth = Math.max(1, w * 0.03); ctx.lineCap = 'round';
    for (let i = 1; i < 6; i++) {
      const t = i / 6, px = -w / 2 + w * t;
      const py = -Math.sin(t * Math.PI) * w * 0.31 * 0.8; // 二次曲线顶点是控制点偏移的一半
      ctx.beginPath(); ctx.moveTo(px, py + w * 0.015); ctx.lineTo(px, py + w * 0.1); ctx.stroke();
    }
    ctx.restore();
  }
  // 雪人（大雪）：蓝灰描边双球 + 红围巾 + 桶帽 + 树枝手
  function snowman(ctx, x, y, h) {
    ctx.save();
    const r1 = h * 0.2, r2 = h * 0.3;
    const cy2 = y - r2, cy1 = cy2 - r2 - r1 * 0.85;
    ctx.fillStyle = 'rgba(205,224,242,0.95)';
    ctx.strokeStyle = 'rgba(110,150,195,0.95)'; ctx.lineWidth = Math.max(1.6, h * 0.022);
    for (const [cy, r] of [[cy2, r2], [cy1, r1]]) {
      ctx.beginPath(); ctx.arc(x, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(110,80,55,0.9)'; ctx.lineWidth = Math.max(1.4, h * 0.018); ctx.lineCap = 'round';
    for (const dx of [-1, 1]) { // 树枝手
      ctx.beginPath();
      ctx.moveTo(x + dx * r2 * 0.9, cy2 - r2 * 0.15);
      ctx.lineTo(x + dx * r2 * 1.6, cy2 - r2 * 0.55);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(200,80,60,0.95)'; // 围巾
    roundRectPath(ctx, x - r1 * 1.1, cy1 + r1 * 0.72, r1 * 2.2, r1 * 0.42, r1 * 0.2); ctx.fill();
    ctx.fillRect(x + r1 * 0.2, cy1 + r1 * 0.95, r1 * 0.4, r1 * 0.7);
    ctx.fillStyle = 'rgba(90,110,140,0.95)'; // 桶帽
    ctx.fillRect(x - r1 * 0.85, cy1 - r1 * 1.5, r1 * 1.7, r1 * 0.22);
    ctx.fillRect(x - r1 * 0.58, cy1 - r1 * 2.05, r1 * 1.16, r1 * 0.62);
    ctx.fillStyle = '#e0884a'; // 胡萝卜鼻
    ctx.beginPath();
    ctx.moveTo(x, cy1); ctx.lineTo(x + r1 * 0.75, cy1 + r1 * 0.12); ctx.lineTo(x, cy1 + r1 * 0.18);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(60,55,60,0.95)';
    for (const dx of [-0.42, 0.42]) {
      ctx.beginPath(); ctx.arc(x + dx * r1, cy1 - r1 * 0.25, r1 * 0.1, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  // 手套（立冬）：连指毛线手套 + 罗纹袖口 + 雪花纹
  function mitten(ctx, x, y, h, rot = 0) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    const w = h * 0.62;
    ctx.fillStyle = 'rgba(205,115,90,0.95)';
    roundRectPath(ctx, -w / 2, -h * 0.5, w, h * 0.82, w * 0.42); ctx.fill();
    ctx.beginPath(); ctx.ellipse(w * 0.42, h * 0.06, w * 0.26, h * 0.2, 0.7, 0, Math.PI * 2); ctx.fill(); // 拇指
    ctx.fillStyle = 'rgba(170,90,70,0.95)'; // 袖口
    roundRectPath(ctx, -w * 0.55, h * 0.28, w * 1.1, h * 0.22, h * 0.05); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = Math.max(1.2, h * 0.02);
    for (const yy of [h * 0.32, h * 0.4]) {
      ctx.beginPath(); ctx.moveTo(-w * 0.55, yy); ctx.lineTo(w * 0.55, yy); ctx.stroke();
    }
    flake(ctx, 0, -h * 0.12, h * 0.14, 'rgba(255,255,255,0.85)');
    ctx.restore();
  }
  // 火炬（青年节）：双层火苗 + 外张火盆托 + 环形握把长柄（不像蜡烛）
  function torch(ctx, x, y, h) {
    ctx.save();
    // 外层火苗（带歪尖，火焰形）
    ctx.fillStyle = 'rgba(235,140,50,0.95)';
    ctx.beginPath();
    ctx.moveTo(x - h * 0.06, y - h * 0.62);
    ctx.quadraticCurveTo(x - h * 0.3, y - h * 0.34, x - h * 0.16, y - h * 0.14);
    ctx.quadraticCurveTo(x, y - h * 0.04, x + h * 0.16, y - h * 0.14);
    ctx.quadraticCurveTo(x + h * 0.3, y - h * 0.34, x + h * 0.09, y - h * 0.6);
    ctx.quadraticCurveTo(x + h * 0.03, y - h * 0.48, x - h * 0.06, y - h * 0.62);
    ctx.closePath(); ctx.fill();
    // 内焰
    ctx.fillStyle = 'rgba(250,210,100,0.95)';
    ctx.beginPath();
    ctx.moveTo(x, y - h * 0.42);
    ctx.quadraticCurveTo(x - h * 0.11, y - h * 0.26, x, y - h * 0.12);
    ctx.quadraticCurveTo(x + h * 0.11, y - h * 0.26, x, y - h * 0.42);
    ctx.closePath(); ctx.fill();
    // 火盆托：上宽下窄的弧碗
    ctx.fillStyle = 'rgba(190,125,60,0.95)';
    ctx.beginPath();
    ctx.moveTo(x - h * 0.15, y - h * 0.12);
    ctx.quadraticCurveTo(x, y - h * 0.02, x + h * 0.15, y - h * 0.12);
    ctx.quadraticCurveTo(x + h * 0.1, y, x + h * 0.055, y);
    ctx.lineTo(x - h * 0.055, y);
    ctx.quadraticCurveTo(x - h * 0.1, y, x - h * 0.15, y - h * 0.12);
    ctx.closePath(); ctx.fill();
    // 长柄 + 环形握把
    ctx.fillStyle = 'rgba(160,100,55,0.95)';
    roundRectPath(ctx, x - h * 0.045, y, h * 0.09, h * 0.4, h * 0.04); ctx.fill();
    ctx.strokeStyle = 'rgba(160,100,55,0.95)'; ctx.lineWidth = Math.max(1.6, h * 0.045);
    ctx.beginPath(); ctx.arc(x, y + h * 0.28, h * 0.085, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  // 扳手（劳动节）：实心柄 + 双爪开口扳手头（开口用 evenodd 挖出）
  function wrench(ctx, x, y, len, rot, color) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = color;
    roundRectPath(ctx, -len * 0.44, -len * 0.06, len * 0.8, len * 0.12, len * 0.06); ctx.fill();
    ctx.beginPath();
    ctx.arc(len * 0.38, -len * 0.38, len * 0.17, 0, Math.PI * 2);
    ctx.moveTo(len * 0.3, -len * 0.62);
    ctx.lineTo(len * 0.52, -len * 0.38);
    ctx.lineTo(len * 0.3, -len * 0.16);
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.restore();
  }
  // 锤子（劳动节）：实心柄 + 圆角锤头
  function hammer(ctx, x, y, len, rot, color) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = color;
    roundRectPath(ctx, -len * 0.4, -len * 0.05, len * 0.72, len * 0.1, len * 0.05); ctx.fill();
    roundRectPath(ctx, len * 0.08, -len * 0.5, len * 0.5, len * 0.2, len * 0.06); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    roundRectPath(ctx, len * 0.12, -len * 0.47, len * 0.14, len * 0.14, len * 0.04); ctx.fill();
    ctx.restore();
  }
  // 齿轮（劳动节配图）：8 齿 + 中孔
  function gear(ctx, x, y, r, color, a = 1) {
    ctx.save(); ctx.globalAlpha *= a; ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const ang = i * Math.PI / 4;
      const a0 = ang - 0.16, a1 = ang + 0.16;
      const w0 = ang - 0.26, w1 = ang + 0.26;
      if (i === 0) ctx.moveTo(x + Math.cos(w0) * r * 0.72, y + Math.sin(w0) * r * 0.72);
      ctx.lineTo(x + Math.cos(a0) * r * 0.72, y + Math.sin(a0) * r * 0.72);
      ctx.lineTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r);
      ctx.lineTo(x + Math.cos(a1) * r, y + Math.sin(a1) * r);
      ctx.lineTo(x + Math.cos(a1) * r * 0.72, y + Math.sin(a1) * r * 0.72);
      ctx.lineTo(x + Math.cos(w1) * r * 0.72, y + Math.sin(w1) * r * 0.72);
    }
    ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, r * 0.32, 0, Math.PI * 2);
    ctx.moveTo(x + r * 0.2, y);
    ctx.arc(x, y, r * 0.2, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.restore();
  }
  // 铅笔（教师节配笔）：笔杆 + 笔尖 + 橡皮头
  function pencil(ctx, x, y, len, rot) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = 'rgba(225,160,80,0.95)';
    ctx.fillRect(-len * 0.4, -len * 0.055, len * 0.62, len * 0.11);
    ctx.fillStyle = 'rgba(215,185,145,0.95)';
    ctx.beginPath();
    ctx.moveTo(len * 0.22, -len * 0.055); ctx.lineTo(len * 0.36, 0); ctx.lineTo(len * 0.22, len * 0.055);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(140,145,160,0.95)';
    ctx.fillRect(-len * 0.47, -len * 0.055, len * 0.07, len * 0.11);
    ctx.restore();
  }
  // 花束（妇女节）：锥形包装 + 三枝花
  function bouquet(ctx, x, y, size) {
    ctx.save();
    ctx.fillStyle = 'rgba(195,145,200,0.6)';
    ctx.beginPath();
    ctx.moveTo(x, y + size * 0.5);
    ctx.lineTo(x - size * 0.3, y - size * 0.08);
    ctx.lineTo(x + size * 0.3, y - size * 0.08);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(95,140,95,0.9)'; ctx.lineWidth = Math.max(1.4, size * 0.03); ctx.lineCap = 'round';
    for (const dx of [-0.16, 0, 0.16]) {
      ctx.beginPath(); ctx.moveTo(x + dx * size * 0.5, y - size * 0.06);
      ctx.quadraticCurveTo(x + dx * size, y - size * 0.28, x + dx * size * 1.3, y - size * 0.42);
      ctx.stroke();
    }
    blossom(ctx, x - size * 0.2, y - size * 0.46, size * 0.13, '#e88ab0', '#fff');
    blossom(ctx, x + size * 0.2, y - size * 0.43, size * 0.13, '#f0b0c8', '#fff');
    blossom(ctx, x, y - size * 0.56, size * 0.15, '#d86a98', '#fff');
    ctx.restore();
  }
  // 康乃馨（母亲节）：皱边花球（外圈锯齿瓣 + 内圈碎瓣 + 白色褶纹）+ 花萼花茎
  function carnation(ctx, x, y, r, color = 'rgba(222,118,150,0.95)', a = 1) {
    ctx.save(); ctx.globalAlpha *= a;
    ctx.strokeStyle = 'rgba(110,150,100,0.9)'; ctx.lineWidth = Math.max(1.2, r * 0.09); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y + r * 0.55); ctx.lineTo(x, y + r * 1.5); ctx.stroke(); // 茎
    ctx.fillStyle = 'rgba(120,160,105,0.9)';
    leaf(ctx, x, y + r * 1.0, r * 0.5, -2.5);
    leaf(ctx, x, y + r * 1.2, r * 0.45, -0.6);
    ctx.fillStyle = 'rgba(130,160,110,0.9)'; // 花萼
    ctx.beginPath();
    ctx.moveTo(x - r * 0.2, y + r * 0.62);
    ctx.quadraticCurveTo(x, y + r * 0.95, x + r * 0.2, y + r * 0.62);
    ctx.quadraticCurveTo(x, y + r * 0.42, x - r * 0.2, y + r * 0.62);
    ctx.closePath(); ctx.fill();
    // 花球：三层皱边
    const ruffle = (cx, cy, rr, n, tint, seedOff) => {
      ctx.fillStyle = tint;
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
        const jag = 1 + 0.18 * Math.sin(i * 2.3 + seedOff);
        const px = cx + Math.cos(ang) * rr * jag, py = cy + Math.sin(ang) * rr * jag * 0.92;
        if (i === 0) ctx.moveTo(px, py);
        else {
          const ang0 = -Math.PI / 2 + ((i - 0.5) / n) * Math.PI * 2;
          ctx.quadraticCurveTo(cx + Math.cos(ang0) * rr * 1.16, cy + Math.sin(ang0) * rr * 1.16, px, py);
        }
      }
      ctx.closePath(); ctx.fill();
    };
    ruffle(x, y, r, 12, color, 1);
    ruffle(x - r * 0.08, y - r * 0.06, r * 0.68, 9, 'rgba(240,170,195,0.95)', 4);
    ruffle(x + r * 0.05, y - r * 0.1, r * 0.4, 7, 'rgba(248,200,215,0.95)', 7);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = Math.max(0.8, r * 0.05); // 褶纹
    for (const s of [-1, 0, 1]) {
      ctx.beginPath();
      ctx.moveTo(x + s * r * 0.4, y + r * 0.5);
      ctx.quadraticCurveTo(x + s * r * 0.5, y - r * 0.1, x + s * r * 0.12, y - r * 0.55);
      ctx.stroke();
    }
    ctx.restore();
  }
  // 菊花（重阳）：16 条细长放射瓣
  function chrysanth(ctx, x, y, r, a = 1) {
    ctx.save(); ctx.globalAlpha *= a;
    ctx.fillStyle = 'rgba(226,155,70,0.95)';
    for (let i = 0; i < 16; i++) {
      const ang = (i / 16) * Math.PI * 2;
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      ctx.beginPath(); ctx.ellipse(r * 0.55, 0, r * 0.48, r * 0.085, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = 'rgba(180,110,40,0.95)';
    ctx.beginPath(); ctx.arc(x, y, r * 0.22, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 紫荆花（香港回归）：5 片尖端开缺的长瓣
  function bauhinia(ctx, x, y, r, a = 1) {
    ctx.save(); ctx.globalAlpha *= a;
    ctx.fillStyle = 'rgba(198,105,205,0.95)';
    for (let i = 0; i < 5; i++) {
      const ang = -Math.PI / 2 + (i / 5) * Math.PI * 2;
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(r * 0.34, -r * 0.5, r * 0.13, -r);
      ctx.lineTo(r * 0.03, -r * 0.8);
      ctx.lineTo(0, -r * 0.97);
      ctx.lineTo(-r * 0.03, -r * 0.8);
      ctx.lineTo(-r * 0.13, -r);
      ctx.quadraticCurveTo(-r * 0.34, -r * 0.5, 0, 0);
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    for (let i = 0; i < 5; i++) {
      const ang = -Math.PI / 2 + (i / 5) * Math.PI * 2 + Math.PI / 5;
      ctx.beginPath(); ctx.arc(x + Math.cos(ang) * r * 0.16, y + Math.sin(ang) * r * 0.16, r * 0.045, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  // 莲花（澳门回归）：三主瓣直立居中 + 两侧对称副瓣（区旗莲花开式，不歪斜）
  function lotusFlower(ctx, x, y, r, a = 1) {
    ctx.save(); ctx.globalAlpha *= a;
    const petal = (ang, pr, tint) => {
      ctx.fillStyle = tint;
      ctx.save();
      ctx.translate(x, y + pr * 0.3); ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(pr * 0.26, -pr * 0.5, 0, -pr);
      ctx.quadraticCurveTo(-pr * 0.26, -pr * 0.5, 0, 0);
      ctx.fill();
      ctx.restore();
    };
    // 后层副瓣（浅）
    petal(-1.05, r * 0.62, 'rgba(242,190,205,0.95)');
    petal(1.05, r * 0.62, 'rgba(242,190,205,0.95)');
    // 中层副瓣
    petal(-0.55, r * 0.85, 'rgba(236,165,188,0.95)');
    petal(0.55, r * 0.85, 'rgba(236,165,188,0.95)');
    // 中央主瓣
    petal(0, r, 'rgba(230,140,172,0.95)');
    // 花蕊
    ctx.fillStyle = 'rgba(225,190,120,0.95)';
    ctx.beginPath(); ctx.ellipse(x, y + r * 0.18, r * 0.13, r * 0.055, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (const dx of [-0.07, 0, 0.07]) {
      ctx.beginPath(); ctx.arc(x + r * dx, y + r * 0.16, r * 0.02, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  // 粽子（端午）：三角身 + 亮叶尖 + 两道绑绳
  function zongzi(ctx, x, y, size, rot = 0) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = 'rgba(115,168,90,0.95)';
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.55);
    ctx.lineTo(size * 0.5, size * 0.32);
    ctx.lineTo(-size * 0.5, size * 0.32);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(150,195,115,0.95)';
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.55);
    ctx.lineTo(size * 0.17, -size * 0.12);
    ctx.lineTo(-size * 0.17, -size * 0.12);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(232,200,120,0.95)'; ctx.lineWidth = Math.max(1.4, size * 0.045); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-size * 0.35, size * 0.04); ctx.lineTo(size * 0.35, size * 0.04); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-size * 0.2, size * 0.23); ctx.lineTo(size * 0.2, size * 0.23); ctx.stroke();
    ctx.restore();
  }
  // 火鸡（感恩节）：扇形尾羽 + 圆身 + 弯颈头 + 喙肉垂 + 细腿
  function turkey(ctx, x, y, h, a = 1) {
    ctx.save(); ctx.globalAlpha *= a;
    // 尾羽：身后五瓣扇形，深浅交替
    const feather = (ang, len, wid, tint) => {
      ctx.save(); ctx.translate(x, y - h * 0.18); ctx.rotate(ang);
      ctx.fillStyle = tint;
      ctx.beginPath(); ctx.ellipse(0, -len, wid, len, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    };
    const fcols = ['rgba(160,90,45,0.9)', 'rgba(200,140,70,0.9)', 'rgba(130,70,38,0.9)'];
    for (const [ang, ci] of [[-0.9, 0], [-0.45, 1], [0, 2], [0.45, 1], [0.9, 0]]) {
      feather(ang, h * 0.34, h * 0.085, fcols[ci]);
    }
    // 腿
    ctx.strokeStyle = 'rgba(200,140,60,0.95)'; ctx.lineWidth = Math.max(1.2, h * 0.03); ctx.lineCap = 'round';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x + s * h * 0.06, y - h * 0.04); ctx.lineTo(x + s * h * 0.08, y + h * 0.06); ctx.stroke();
    }
    // 身体
    ctx.fillStyle = 'rgba(140,80,45,0.95)';
    ctx.beginPath(); ctx.ellipse(x, y - h * 0.14, h * 0.19, h * 0.15, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(180,110,60,0.9)'; // 翅膀
    ctx.beginPath(); ctx.ellipse(x + h * 0.02, y - h * 0.13, h * 0.11, h * 0.08, 0.3, 0, Math.PI * 2); ctx.fill();
    // 弯颈 + 头（加大，火鸡特征更明显）
    ctx.strokeStyle = 'rgba(140,80,45,0.95)'; ctx.lineWidth = Math.max(2, h * 0.085);
    ctx.beginPath();
    ctx.moveTo(x - h * 0.12, y - h * 0.2);
    ctx.quadraticCurveTo(x - h * 0.28, y - h * 0.24, x - h * 0.27, y - h * 0.42);
    ctx.stroke();
    ctx.fillStyle = 'rgba(140,80,45,0.95)';
    ctx.beginPath(); ctx.arc(x - h * 0.27, y - h * 0.47, h * 0.078, 0, Math.PI * 2); ctx.fill();
    // 喙 + 肉垂 + 眼
    ctx.fillStyle = 'rgba(230,160,70,0.95)';
    ctx.beginPath();
    ctx.moveTo(x - h * 0.34, y - h * 0.49); ctx.lineTo(x - h * 0.44, y - h * 0.46); ctx.lineTo(x - h * 0.34, y - h * 0.43);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(200,70,55,0.95)';
    ctx.beginPath(); ctx.ellipse(x - h * 0.32, y - h * 0.39, h * 0.022, h * 0.045, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(60,40,30,0.9)';
    ctx.beginPath(); ctx.arc(x - h * 0.26, y - h * 0.5, h * 0.016, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 月饼（中秋）：波浪边圆饼 + 顶部放射花纹
  function mooncake(ctx, x, y, r, color = 'rgba(198,138,66,0.95)', a = 1) {
    ctx.save(); ctx.globalAlpha *= a;
    ctx.fillStyle = color;
    ctx.beginPath(); // 10 瓣波浪边
    for (let i = 0; i <= 10; i++) {
      const ang = -Math.PI / 2 + (i / 10) * Math.PI * 2;
      const px = x + Math.cos(ang) * r, py = y + Math.sin(ang) * r;
      if (i === 0) ctx.moveTo(px, py);
      else {
        const ang0 = -Math.PI / 2 + ((i - 0.5) / 10) * Math.PI * 2;
        ctx.quadraticCurveTo(x + Math.cos(ang0) * r * 1.22, y + Math.sin(ang0) * r * 1.22, px, py);
      }
    }
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(140,88,36,0.7)'; ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.beginPath(); ctx.arc(x, y, r * 0.74, 0, Math.PI * 2); ctx.stroke(); // 顶圈
    // 中心放射花纹：六弧抱圆
    ctx.strokeStyle = 'rgba(140,88,36,0.75)'; ctx.lineWidth = Math.max(1, r * 0.09);
    for (let i = 0; i < 6; i++) {
      const ang = -Math.PI / 2 + i * Math.PI / 3;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(ang) * r * 0.16, y + Math.sin(ang) * r * 0.16);
      ctx.quadraticCurveTo(
        x + Math.cos(ang + 0.5) * r * 0.55, y + Math.sin(ang + 0.5) * r * 0.55,
        x + Math.cos(ang + 1.05) * r * 0.5, y + Math.sin(ang + 1.05) * r * 0.5
      );
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(140,88,36,0.8)';
    ctx.beginPath(); ctx.arc(x, y, r * 0.12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.2)'; // 高光
    ctx.beginPath(); ctx.ellipse(x - r * 0.35, y - r * 0.4, r * 0.22, r * 0.1, -0.7, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 糖葫芦（小年北）：竹签串五颗山楂 + 糖衣高光；竹签只画山楂上下两段，串内不露杆
  function hawthorn(ctx, x, y, h, rot = 0) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.strokeStyle = 'rgba(150,110,70,0.9)'; ctx.lineWidth = Math.max(1.4, h * 0.025); ctx.lineCap = 'round';
    const topBerry = -h * 0.38 - h * 0.095, botBerry = h * 0.38 + h * 0.095;
    ctx.beginPath(); ctx.moveTo(0, h * 0.55); ctx.lineTo(0, botBerry); ctx.stroke(); // 底段签
    ctx.beginPath(); ctx.moveTo(0, topBerry); ctx.lineTo(0, -h * 0.52); ctx.stroke(); // 顶段签
    for (let i = 0; i < 5; i++) {
      const yy = h * 0.38 - i * h * 0.19;
      ctx.fillStyle = i === 0 ? 'rgba(226,92,72,0.95)' : 'rgba(208,68,58,0.95)';
      ctx.beginPath(); ctx.arc(0, yy, h * 0.095, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath(); ctx.ellipse(-h * 0.028, yy - h * 0.032, h * 0.028, h * 0.015, -0.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  // 螺丝钉（学雷锋）：钉头 + 螺纹杆 + 钉尖
  function screw(ctx, x, y, h, rot = 0) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = 'rgba(158,172,188,0.95)';
    ctx.beginPath(); ctx.ellipse(0, -h * 0.42, h * 0.17, h * 0.075, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(-h * 0.13, -h * 0.42, h * 0.26, h * 0.1);
    ctx.fillRect(-h * 0.07, -h * 0.34, h * 0.14, h * 0.7);
    ctx.strokeStyle = 'rgba(80,95,112,0.85)'; ctx.lineWidth = Math.max(1.2, h * 0.028);
    for (let i = 0; i < 5; i++) {
      const yy = -h * 0.25 + i * h * 0.125;
      ctx.beginPath(); ctx.moveTo(-h * 0.07, yy); ctx.lineTo(h * 0.07, yy + h * 0.035); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(158,172,188,0.95)';
    ctx.beginPath();
    ctx.moveTo(-h * 0.07, h * 0.36); ctx.lineTo(h * 0.07, h * 0.36); ctx.lineTo(0, h * 0.5);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  // 雨伞（防灾减灾）：三段波浪伞缘 + 弯柄
  function umbrella(ctx, x, y, w, a = 1) {
    ctx.save(); ctx.globalAlpha *= a;
    ctx.fillStyle = 'rgba(100,132,170,0.95)';
    ctx.beginPath();
    ctx.moveTo(x - w / 2, y);
    ctx.quadraticCurveTo(x - w * 0.25, y - w * 0.56, x, y - w * 0.56);
    ctx.quadraticCurveTo(x + w * 0.25, y - w * 0.56, x + w / 2, y);
    ctx.arc(x + w / 3, y, w / 6, 0, Math.PI);
    ctx.arc(x, y, w / 6, 0, Math.PI);
    ctx.arc(x - w / 3, y, w / 6, 0, Math.PI);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(75,90,110,0.9)'; ctx.lineWidth = Math.max(1.4, w * 0.032); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y + w * 0.04); ctx.lineTo(x, y + w * 0.4);
    ctx.arc(x - w * 0.075, y + w * 0.4, w * 0.075, 0, Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y - w * 0.56); ctx.lineTo(x, y - w * 0.63); ctx.stroke();
    ctx.restore();
  }
  // 警钟（七七事变）：钟身 + 钟口沿 + 钟舌
  function bell(ctx, x, y, h, a = 1) {
    ctx.save(); ctx.globalAlpha *= a;
    ctx.fillStyle = 'rgba(172,136,74,0.95)';
    ctx.beginPath();
    ctx.moveTo(x - h * 0.3, y + h * 0.18);
    ctx.quadraticCurveTo(x - h * 0.3, y - h * 0.25, x - h * 0.08, y - h * 0.32);
    ctx.quadraticCurveTo(x - h * 0.08, y - h * 0.44, x, y - h * 0.44);
    ctx.quadraticCurveTo(x + h * 0.08, y - h * 0.44, x + h * 0.08, y - h * 0.32);
    ctx.quadraticCurveTo(x + h * 0.3, y - h * 0.25, x + h * 0.3, y + h * 0.18);
    ctx.closePath(); ctx.fill();
    ctx.fillRect(x - h * 0.35, y + h * 0.16, h * 0.7, h * 0.08);
    ctx.beginPath(); ctx.arc(x, y + h * 0.32, h * 0.06, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath(); ctx.ellipse(x - h * 0.1, y - h * 0.02, h * 0.05, h * 0.14, 0.1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 日历页（九一八）：挂环 + 红色顶栏（月份）+ 大号日期
  function calendar(ctx, x, y, w, mon = '9', day = '18') {
    ctx.save();
    const h = w * 0.98;
    ctx.fillStyle = 'rgba(238,228,212,0.98)';
    roundRectPath(ctx, x - w / 2, y - h / 2, w, h, w * 0.09); ctx.fill();
    ctx.strokeStyle = 'rgba(150,125,100,0.8)'; ctx.lineWidth = Math.max(1.2, w * 0.025); ctx.stroke();
    ctx.fillStyle = 'rgba(178,60,50,0.95)';
    roundRectPath(ctx, x - w / 2, y - h / 2, w, h * 0.26, w * 0.09); ctx.fill();
    ctx.fillRect(x - w / 2, y - h * 0.37, w, h * 0.025);
    ctx.strokeStyle = 'rgba(100,105,115,0.9)'; ctx.lineWidth = Math.max(1.4, w * 0.045); ctx.lineCap = 'round';
    for (const dx of [-w * 0.24, w * 0.24]) {
      ctx.beginPath(); ctx.arc(x + dx, y - h * 0.5, w * 0.06, Math.PI, 0); ctx.stroke();
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(250,240,230,0.95)';
    ctx.font = `700 ${Math.round(w * 0.19)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.fillText(mon, x, y - h * 0.37);
    ctx.fillStyle = 'rgba(160,55,45,0.95)';
    ctx.font = `700 ${Math.round(w * 0.42)}px Georgia, "Times New Roman", serif`;
    ctx.fillText(day, x, y + h * 0.16);
    ctx.restore();
  }
  // 纪念碑（烈士纪念日）：方尖碑 + 两层基座
  function obelisk(ctx, x, y, h, a = 1) {
    ctx.save(); ctx.globalAlpha *= a;
    ctx.fillStyle = 'rgba(150,158,168,0.95)';
    ctx.beginPath();
    ctx.moveTo(x - h * 0.09, y);
    ctx.lineTo(x - h * 0.055, y - h * 0.78);
    ctx.lineTo(x, y - h * 0.92);
    ctx.lineTo(x + h * 0.055, y - h * 0.78);
    ctx.lineTo(x + h * 0.09, y);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.moveTo(x - h * 0.028, y); ctx.lineTo(x - h * 0.018, y - h * 0.72);
    ctx.lineTo(x, y - h * 0.72); ctx.lineTo(x - h * 0.008, y);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(122,130,140,0.95)';
    ctx.fillRect(x - h * 0.14, y, h * 0.28, h * 0.07);
    ctx.fillRect(x - h * 0.2, y + h * 0.07, h * 0.4, h * 0.06);
    ctx.restore();
  }
  // 和平鸽（国家公祭日）：展翅剪影
  function dove(ctx, x, y, size, rot = 0, a = 1) {
    ctx.save(); ctx.globalAlpha *= a; ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = 'rgba(160,175,195,0.95)';
    ctx.beginPath();
    ctx.moveTo(-size * 0.5, size * 0.1);
    ctx.quadraticCurveTo(-size * 0.1, -size * 0.05, size * 0.1, -size * 0.02);
    ctx.quadraticCurveTo(size * 0.05, -size * 0.44, size * 0.3, -size * 0.52);
    ctx.quadraticCurveTo(size * 0.2, -size * 0.2, size * 0.42, -size * 0.1);
    ctx.quadraticCurveTo(size * 0.52, -size * 0.06, size * 0.5, size * 0.02);
    ctx.lineTo(size * 0.56, -size * 0.05);
    ctx.quadraticCurveTo(size * 0.45, size * 0.12, size * 0.1, size * 0.2);
    ctx.quadraticCurveTo(-size * 0.2, size * 0.24, -size * 0.5, size * 0.1);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(110,125,145,0.9)';
    ctx.beginPath(); ctx.arc(size * 0.36, -size * 0.08, size * 0.025, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 勋章（抗战胜利）：双色绶带 + 金圆牌 + 五角星
  function medal(ctx, x, y, r, a = 1) {
    ctx.save(); ctx.globalAlpha *= a;
    ctx.fillStyle = 'rgba(200,70,60,0.9)';
    ctx.beginPath();
    ctx.moveTo(x - r * 0.5, y - r * 1.5);
    ctx.lineTo(x - r * 0.1, y - r * 1.5);
    ctx.lineTo(x + r * 0.15, y - r * 0.55);
    ctx.lineTo(x - r * 0.3, y - r * 0.45);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(226,158,70,0.9)';
    ctx.beginPath();
    ctx.moveTo(x + r * 0.1, y - r * 1.5);
    ctx.lineTo(x + r * 0.5, y - r * 1.5);
    ctx.lineTo(x + r * 0.3, y - r * 0.45);
    ctx.lineTo(x - r * 0.05, y - r * 0.55);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(222,172,82,0.95)';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(185,128,52,0.95)';
    ctx.beginPath(); ctx.arc(x, y, r * 0.78, 0, Math.PI * 2); ctx.fill();
    star5(ctx, x, y + r * 0.04, r * 0.55, '#f0d090');
    ctx.restore();
  }
  // 盾牌 + 军星（建军节）
  function shieldStar(ctx, x, y, w, h) {
    ctx.save();
    ctx.fillStyle = 'rgba(88,116,92,0.95)';
    ctx.beginPath();
    ctx.moveTo(x - w / 2, y - h / 2);
    ctx.lineTo(x + w / 2, y - h / 2);
    ctx.lineTo(x + w / 2, y + h * 0.1);
    ctx.quadraticCurveTo(x + w / 2, y + h * 0.38, x, y + h / 2);
    ctx.quadraticCurveTo(x - w / 2, y + h * 0.38, x - w / 2, y + h * 0.1);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(228,218,190,0.85)'; ctx.lineWidth = Math.max(1.5, w * 0.035);
    ctx.stroke();
    star5(ctx, x, y - h * 0.06, w * 0.3, '#e04a3a');
    ctx.restore();
  }
  // 柿子（霜降）：扁圆果 + 四片柿蒂
  function persimmon(ctx, x, y, r) {
    ctx.save();
    ctx.fillStyle = 'rgba(222,118,58,0.95)';
    ctx.beginPath(); ctx.ellipse(x, y + r * 0.12, r, r * 0.8, 0, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 4; i++) {
      const ang = -Math.PI / 2 + (i - 1.5) * 0.55;
      leaf(ctx, x + Math.cos(ang) * r * 0.26, y - r * 0.58 + Math.sin(ang) * r * 0.1, r * 0.42, ang + Math.PI / 2, 'rgba(95,132,72,0.95)');
    }
    ctx.strokeStyle = 'rgba(95,115,62,0.9)'; ctx.lineWidth = Math.max(1.2, r * 0.08); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y - r * 0.66); ctx.lineTo(x + r * 0.07, y - r * 0.95); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath(); ctx.ellipse(x - r * 0.35, y - r * 0.12, r * 0.16, r * 0.22, -0.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 处暑鸭：浮水鸭身 + 翘尾 + 嘴眼 + 水波
  function duck(ctx, x, y, size) {
    ctx.save();
    ctx.fillStyle = 'rgba(238,200,115,0.95)';
    ctx.beginPath(); ctx.ellipse(x, y, size * 0.46, size * 0.3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - size * 0.38, y - size * 0.06);
    ctx.quadraticCurveTo(x - size * 0.62, y - size * 0.28, x - size * 0.5, y - size * 0.34);
    ctx.quadraticCurveTo(x - size * 0.46, y - size * 0.14, x - size * 0.34, y - size * 0.02);
    ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(x + size * 0.3, y - size * 0.32, size * 0.19, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(222,132,72,0.95)';
    ctx.beginPath();
    ctx.moveTo(x + size * 0.46, y - size * 0.36);
    ctx.quadraticCurveTo(x + size * 0.64, y - size * 0.3, x + size * 0.46, y - size * 0.24);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(60,52,44,0.9)';
    ctx.beginPath(); ctx.arc(x + size * 0.35, y - size * 0.38, size * 0.03, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(128,168,190,0.75)'; ctx.lineWidth = Math.max(1.2, size * 0.03); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - size * 0.5, y + size * 0.4);
    ctx.quadraticCurveTo(x - size * 0.15, y + size * 0.3, x + size * 0.1, y + size * 0.4); ctx.stroke();
    ctx.restore();
  }
  // 瓢虫（惊蛰）：红鞘翅中线斑点 + 黑头触角
  function ladybug(ctx, x, y, r, rot = 0) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = 'rgba(214,78,58,0.95)';
    ctx.beginPath(); ctx.ellipse(0, 0, r * 0.78, r, 0, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.beginPath(); ctx.ellipse(0, 0, r * 0.78, r, 0, 0, Math.PI * 2); ctx.clip();
    ctx.strokeStyle = 'rgba(62,44,42,0.88)'; ctx.lineWidth = Math.max(1.2, r * 0.09);
    ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(0, r); ctx.stroke();
    ctx.fillStyle = 'rgba(62,44,42,0.88)';
    for (const [px, py, pr] of [[-0.35, -0.25, 0.11], [0.32, -0.4, 0.09], [-0.3, 0.32, 0.1], [0.35, 0.24, 0.09]]) {
      ctx.beginPath(); ctx.arc(px * r, py * r, pr * r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = 'rgba(58,46,44,0.95)';
    ctx.beginPath(); ctx.arc(0, -r * 0.92, r * 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(58,46,44,0.9)'; ctx.lineWidth = Math.max(1, r * 0.05); ctx.lineCap = 'round';
    for (const dx of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(dx * r * 0.1, -r * 1.12);
      ctx.quadraticCurveTo(dx * r * 0.3, -r * 1.34, dx * r * 0.46, -r * 1.28);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath(); ctx.ellipse(-r * 0.26, -r * 0.35, r * 0.12, r * 0.2, -0.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 茶芽（谷雨）：一芽两叶
  function teaShoot(ctx, x, y, size, rot = 0) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.strokeStyle = 'rgba(92,132,88,0.9)'; ctx.lineWidth = Math.max(1.2, size * 0.055); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, size * 0.5); ctx.lineTo(0, -size * 0.28); ctx.stroke();
    leaf(ctx, 0, size * 0.16, size * 0.42, -Math.PI / 2 - 0.55, 'rgba(112,156,106,0.92)');
    leaf(ctx, 0, size * 0.02, size * 0.42, -Math.PI / 2 + 0.55, 'rgba(132,176,122,0.92)');
    ctx.fillStyle = 'rgba(152,192,140,0.95)';
    ctx.beginPath(); ctx.ellipse(0, -size * 0.38, size * 0.09, size * 0.17, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 樱桃（立夏）：双果 + 双梗 + 叶
  function cherry(ctx, x, y, r) {
    ctx.save();
    ctx.strokeStyle = 'rgba(92,130,80,0.9)'; ctx.lineWidth = Math.max(1.4, r * 0.11); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - r * 0.5, y - r * 0.4); ctx.quadraticCurveTo(x - r * 0.2, y - r * 1.1, x + r * 0.1, y - r * 1.25); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + r * 0.66, y - r * 0.3); ctx.quadraticCurveTo(x + r * 0.4, y - r * 1.0, x + r * 0.1, y - r * 1.25); ctx.stroke();
    leaf(ctx, x + r * 0.1, y - r * 1.25, r * 0.62, -0.5, 'rgba(95,142,88,0.92)');
    ctx.fillStyle = 'rgba(208,58,70,0.95)';
    ctx.beginPath(); ctx.arc(x - r * 0.5, y + r * 0.1, r * 0.55, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(224,80,88,0.95)';
    ctx.beginPath(); ctx.arc(x + r * 0.66, y + r * 0.22, r * 0.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath(); ctx.ellipse(x - r * 0.68, y - r * 0.05, r * 0.12, r * 0.18, -0.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 梅枝（小寒）：S 形老枝 + 分枝 + 三朵梅
  function plumBranch(ctx, x, y, size, rot = 0) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.strokeStyle = 'rgba(122,92,70,0.95)'; ctx.lineWidth = Math.max(2, size * 0.055); ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, size * 0.4);
    ctx.quadraticCurveTo(size * 0.3, size * 0.12, size * 0.55, -size * 0.05);
    ctx.quadraticCurveTo(size * 0.8, -size * 0.2, size * 0.95, -size * 0.42);
    ctx.stroke();
    ctx.lineWidth = Math.max(1.4, size * 0.032);
    ctx.beginPath(); ctx.moveTo(size * 0.5, -size * 0.03);
    ctx.quadraticCurveTo(size * 0.46, -size * 0.24, size * 0.3, -size * 0.38);
    ctx.stroke();
    blossom(ctx, size * 0.95, -size * 0.48, size * 0.14, '#e891a5', '#c86a80');
    blossom(ctx, size * 0.3, -size * 0.44, size * 0.11, '#eeb0bd', '#c86a80');
    blossom(ctx, size * 0.62, -size * 0.1, size * 0.1, '#e891a5', '#c86a80');
    ctx.restore();
  }
  // 冰凌（大寒）：冰檐 + 五根垂挂冰柱
  function icicles(ctx, x, y, w) {
    ctx.save();
    ctx.fillStyle = 'rgba(165,198,226,0.95)';
    roundRectPath(ctx, x - w / 2, y - w * 0.08, w, w * 0.1, w * 0.045); ctx.fill();
    const lens = [0.5, 0.28, 0.42, 0.22, 0.36];
    for (let i = 0; i < 5; i++) {
      const px = x - w * 0.38 + i * w * 0.19;
      const len = w * lens[i];
      ctx.fillStyle = 'rgba(185,212,238,0.95)';
      ctx.beginPath();
      ctx.moveTo(px - w * 0.05, y);
      ctx.lineTo(px + w * 0.05, y);
      ctx.lineTo(px, y + len);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath(); ctx.ellipse(px - w * 0.014, y + len * 0.35, w * 0.011, len * 0.22, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  // 稻穗（秋分）：弯垂穗轴 + 交替谷粒
  function riceEar(ctx, x, y, len, rot = 0) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.strokeStyle = 'rgba(178,148,70,0.9)'; ctx.lineWidth = Math.max(1.4, len * 0.04); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(len * 0.12, -len * 0.55, len * 0.5, -len * 0.78);
    ctx.stroke();
    const q = (t) => {
      const u = 1 - t;
      return [2 * u * t * (len * 0.12) + t * t * (len * 0.5), 2 * u * t * (-len * 0.55) + t * t * (-len * 0.78)];
    };
    ctx.fillStyle = 'rgba(214,176,86,0.95)';
    for (let i = 0; i < 8; i++) {
      const t = 0.3 + (i / 7) * 0.7;
      const [px, py] = q(t);
      const side = i % 2 ? 1 : -1;
      ctx.beginPath(); ctx.ellipse(px + side * len * 0.05, py, len * 0.042, len * 0.072, side * 0.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  // 雁阵（寒露）：人字形五雁
  function geese(ctx, x, y, size) {
    ctx.save();
    ctx.strokeStyle = 'rgba(118,128,150,0.92)'; ctx.lineWidth = Math.max(1.6, size * 0.045); ctx.lineCap = 'round';
    for (const [bx, by, sc] of [[0, 0, 1], [-0.42, 0.26, 0.85], [0.42, 0.26, 0.85], [-0.8, 0.52, 0.68], [0.8, 0.52, 0.68]]) {
      const r = size * 0.2 * sc;
      const cx2 = x + bx * size, cy2 = y + by * size;
      ctx.beginPath();
      ctx.moveTo(cx2 - r, cy2 + r * 0.45);
      ctx.quadraticCurveTo(cx2 - r * 0.25, cy2 - r * 0.55, cx2, cy2);
      ctx.quadraticCurveTo(cx2 + r * 0.25, cy2 - r * 0.55, cx2 + r, cy2 + r * 0.45);
      ctx.stroke();
    }
    ctx.restore();
  }
  // 荷塘（小暑）：带深 V 缺口的椭圆荷叶 + 叶脉 + 直立层瓣荷花
  function lotusPond(ctx, x, y, r) {
    ctx.save();
    // 荷叶：横向椭圆（scale 压扁）+ 右侧深 V 缺口
    ctx.fillStyle = 'rgba(92,158,110,0.9)';
    ctx.save();
    ctx.translate(x, y); ctx.scale(1.18, 0.86);
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.12, -0.08, Math.PI * 2 - 0.22);
    ctx.lineTo(r * 0.16, r * 0.12);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(62,120,82,0.75)'; ctx.lineWidth = Math.max(1, r * 0.04); ctx.lineCap = 'round';
    for (let i = 0; i < 7; i++) { // 叶脉：从圆心放射，避开缺口
      const ang = 0.5 + i * (Math.PI * 2 - 0.95) / 6;
      ctx.beginPath(); ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(ang) * r * 0.94, y + Math.sin(ang) * r * 0.94 * 0.82);
      ctx.stroke();
    }
    // 荷花：直立层瓣 + 花苞侧芽
    const fx = x + r * 1.05, fy = y - r * 0.9;
    ctx.strokeStyle = 'rgba(92,148,100,0.9)'; ctx.lineWidth = Math.max(1.4, r * 0.07);
    ctx.beginPath(); ctx.moveTo(fx, fy + r * 0.5); ctx.quadraticCurveTo(fx + r * 0.18, fy + r * 0.1, fx, fy - r * 0.1); ctx.stroke();
    const petal = (ang, pr, tint) => {
      ctx.fillStyle = tint;
      ctx.save();
      ctx.translate(fx, fy + pr * 0.28); ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(pr * 0.26, -pr * 0.5, 0, -pr);
      ctx.quadraticCurveTo(-pr * 0.26, -pr * 0.5, 0, 0);
      ctx.fill();
      ctx.restore();
    };
    petal(-0.95, r * 0.34, 'rgba(242,190,205,0.95)');
    petal(0.95, r * 0.34, 'rgba(242,190,205,0.95)');
    petal(-0.5, r * 0.46, 'rgba(236,160,185,0.95)');
    petal(0.5, r * 0.46, 'rgba(236,160,185,0.95)');
    petal(0, r * 0.55, 'rgba(230,140,172,0.98)');
    ctx.fillStyle = 'rgba(225,190,120,0.95)';
    ctx.beginPath(); ctx.ellipse(fx, fy + r * 0.12, r * 0.06, r * 0.028, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 西瓜瓣（大暑）：平底朝上半圆三层 + 籽
  function watermelon(ctx, x, y, r, rot = 0) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = 'rgba(72,140,82,0.95)';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(238,238,222,0.95)';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.84, 0, Math.PI); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(232,92,82,0.95)';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.7, 0, Math.PI); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(66,50,44,0.9)';
    for (const [sx, sy] of [[-0.36, 0.3], [0, 0.45], [0.36, 0.3], [-0.16, 0.14], [0.18, 0.14]]) {
      ctx.beginPath(); ctx.ellipse(sx * r, sy * r, r * 0.045, r * 0.07, 0.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  // 麦镰（芒种）：金麦穗 + 实心月牙刃镰刀（银刃 + 木柄），刃形一眼可辨
  function sickleWheat(ctx, x, y, size) {
    ctx.save();
    wheat(ctx, x - size * 0.22, y + size * 0.4, size * 0.58, 0.12, 'rgba(196,164,80,0.95)');
    ctx.save(); // 镰刀：柄朝右下，刃口月牙朝上弯
    ctx.translate(x + size * 0.3, y + size * 0.1); ctx.rotate(0.35);
    ctx.fillStyle = 'rgba(150,160,178,0.95)'; // 月牙刃：外弧 + 内弧回抱
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.4, Math.PI * 1.05, Math.PI * 1.95);
    ctx.arc(Math.cos(Math.PI * 1.95) * size * 0.26, Math.sin(Math.PI * 1.95) * size * 0.26, size * 0.27, Math.PI * 1.87, Math.PI * 1.13, true);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(162,120,80,0.95)'; // 木柄：从刃根伸出
    ctx.save();
    ctx.translate(Math.cos(Math.PI * 1.5) * size * 0.4, Math.sin(Math.PI * 1.5) * size * 0.4);
    ctx.rotate(Math.PI / 4);
    roundRectPath(ctx, -size * 0.05, 0, size * 0.1, size * 0.34, size * 0.05);
    ctx.fill();
    ctx.restore();
    ctx.restore();
    ctx.restore();
  }
  // 燕子（清明）：剪式双翼 + 分叉尾
  function swallow(ctx, x, y, size, rot = 0) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = 'rgba(72,88,112,0.92)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(-size * 0.2, -size * 0.35, -size * 0.55, -size * 0.4);
    ctx.quadraticCurveTo(-size * 0.25, -size * 0.05, -size * 0.3, size * 0.16);
    ctx.quadraticCurveTo(0, size * 0.06, size * 0.3, size * 0.16);
    ctx.quadraticCurveTo(size * 0.25, -size * 0.05, size * 0.55, -size * 0.4);
    ctx.quadraticCurveTo(size * 0.2, -size * 0.35, 0, 0);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, size * 0.02);
    ctx.lineTo(-size * 0.18, size * 0.5);
    ctx.lineTo(-size * 0.02, size * 0.28);
    ctx.lineTo(size * 0.02, size * 0.28);
    ctx.lineTo(size * 0.18, size * 0.5);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // ----- 二十四节气主题：每个节气独立渐变配色 + 独有主图案（种子取节气下标，重绘稳定）-----
  // kind 即各节气专属图案：小寒梅枝 | 大寒冰凌 | 立春嫩芽 | 雨水云雨 | 惊蛰瓢虫 | 春分花瓣
  // 清明燕风筝 | 谷雨茶芽 | 立夏樱桃 | 小满青麦 | 芒种麦镰 | 夏至烈日 | 小暑荷塘 | 大暑西瓜
  // 立秋落叶 | 处暑鸭 | 白露露珠 | 秋分稻穗 | 寒露雁阵 | 霜降柿子 | 立冬手套 | 小雪雪花
  // 大雪雪人 | 冬至饺子 —— 每个节气 big 独一无二，不再共用
  const TERM_STYLE = [
    ['#dbe7f2', '#f5f9fc', 'plumbranch'], ['#d8e6f0', '#f4f8fb', 'ice'],
    ['#dff0e2', '#f6fbf6', 'sprout'],     ['#d5e9f2', '#f3f9fc', 'rain'],
    ['#e0f0dd', '#f7fcf4', 'ladybug'],    ['#fde9ef', '#fff8fa', 'petal'],
    ['#e2ead9', '#f8faf4', 'kite'],       ['#dcefe0', '#f7fcf8', 'tea'],
    ['#dcf0d9', '#f7fdf5', 'cherry'],     ['#f4ecc9', '#fdfaf0', 'wheat'],
    ['#f0e6bd', '#fcf9ef', 'harvest'],    ['#fdeebe', '#fffbf0', 'sun'],
    ['#fbe3c0', '#fef9f2', 'lotus'],      ['#fbdcb4', '#fef8f0', 'melon'],
    ['#f6e8c8', '#fdf9f0', 'leaf'],       ['#f5dfb6', '#fdf7ec', 'duck'],
    ['#e3eef0', '#f8fcfd', 'dew'],        ['#f6e3c0', '#fdf8ee', 'rice'],
    ['#f0dcc8', '#fbf4ee', 'geese'],      ['#f2e0d0', '#fcf6f1', 'persimmon'],
    ['#e0e8ee', '#f7fafc', 'mitten'],     ['#dfe8ef', '#f6fafc', 'snow'],
    ['#d7e3ee', '#f4f8fb', 'snowman'],    ['#dde7f0', '#f6f9fc', 'dumpling'],
  ];
  const SEASON_DECO = {
    plumbranch(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      blossom(ctx, x0 + w - b * 0.08, y0 + b * 0.09, b * 0.042, '#f2a7b3');
      blossom(ctx, x0 + b * 0.07, y0 + h - b * 0.08, b * 0.036, '#f2a7b3', '#fff', 0.9);
      cornerScatter(ctx, x0, y0, w, h, 6, seed, (c, x, y, rng) => petal(c, x, y, b * 0.011, rng() * Math.PI, 'rgba(242,167,179,0.55)'));
    },
    ice(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      icicles(ctx, x0 + w - b * 0.14, y0 + b * 0.045, b * 0.14);
      cornerScatter(ctx, x0, y0, w, h, 6, seed, (c, x, y, rng) => flake(c, x, y, b * (0.012 + rng() * 0.012), 'rgba(127,168,217,0.6)'));
    },
    sprout(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      sprout(ctx, x0 + w - b * 0.08, y0 + b * 0.08, b * 0.08, '#7cb87c');
      sprout(ctx, x0 + w - b * 0.15, y0 + b * 0.06, b * 0.05, '#8fc98f', 0.8);
      sprout(ctx, x0 + b * 0.07, y0 + h - b * 0.07, b * 0.06, '#7cb87c', 0.9);
      cornerScatter(ctx, x0, y0, w, h, 6, seed, (c, x, y, rng) => petal(c, x, y, b * 0.011, rng() * Math.PI, 'rgba(160,205,160,0.5)'));
    },
    rain(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      cloud(ctx, x0 + w - b * 0.1, y0 + b * 0.08, b * 0.13, 'rgba(151,180,203,0.5)');
      cloud(ctx, x0 + b * 0.09, y0 + h - b * 0.06, b * 0.1, 'rgba(151,180,203,0.35)');
      cornerScatter(ctx, x0, y0, w, h, 10, seed, (c, x, y, rng) => raindrop(c, x, y, b * (0.02 + rng() * 0.02), 'rgba(111,168,201,0.6)'));
    },
    ladybug(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      ladybug(ctx, x0 + w - b * 0.08, y0 + b * 0.09, b * 0.026, 0.4);
      sprout(ctx, x0 + b * 0.07, y0 + h - b * 0.07, b * 0.055, 'rgba(124,184,124,0.85)');
      cornerScatter(ctx, x0, y0, w, h, 5, seed, (c, x, y, rng) => petal(c, x, y, b * 0.01, rng() * Math.PI, 'rgba(160,205,160,0.5)'));
    },
    petal(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      cornerScatter(ctx, x0, y0, w, h, 12, seed, (c, x, y, rng) => petal(c, x, y, b * (0.012 + rng() * 0.012), rng() * Math.PI, rng() > 0.4 ? 'rgba(244,167,191,0.7)' : 'rgba(250,205,220,0.6)'));
      blossom(ctx, x0 + w - b * 0.07, y0 + b * 0.07, b * 0.035, '#f4a7bf', '#fff', 0.85);
    },
    kite(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      swallow(ctx, x0 + w - b * 0.1, y0 + b * 0.09, b * 0.06, 0.15);
      cloud(ctx, x0 + b * 0.09, y0 + h - b * 0.07, b * 0.1, 'rgba(150,168,150,0.4)');
      cornerScatter(ctx, x0, y0, w, h, 7, seed, (c, x, y, rng) => raindrop(c, x, y, b * (0.014 + rng() * 0.014), 'rgba(122,160,145,0.5)'));
    },
    tea(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      teaShoot(ctx, x0 + w - b * 0.08, y0 + b * 0.1, b * 0.09);
      cornerScatter(ctx, x0, y0, w, h, 7, seed, (c, x, y, rng) => raindrop(c, x, y, b * (0.014 + rng() * 0.016), 'rgba(111,168,201,0.55)'));
    },
    cherry(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      cherry(ctx, x0 + w - b * 0.09, y0 + b * 0.11, b * 0.032);
      cornerScatter(ctx, x0, y0, w, h, 6, seed, (c, x, y, rng) => petal(c, x, y, b * 0.01, rng() * Math.PI, 'rgba(240,170,180,0.5)'));
    },
    wheat(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      wheat(ctx, x0 + w - b * 0.07, y0 + b * 0.1, b * 0.11, 0.5, 'rgba(150,185,110,0.75)');
      wheat(ctx, x0 + b * 0.08, y0 + h - b * 0.08, b * 0.09, -2.4, 'rgba(150,185,110,0.6)');
      cornerScatter(ctx, x0, y0, w, h, 6, seed, (c, x, y, rng) => petal(c, x, y, b * 0.01, rng() * Math.PI, 'rgba(180,200,130,0.5)'));
    },
    harvest(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      wheat(ctx, x0 + w - b * 0.07, y0 + b * 0.1, b * 0.11, 0.5, 'rgba(196,164,80,0.75)');
      wheat(ctx, x0 + b * 0.08, y0 + h - b * 0.08, b * 0.09, -2.4, 'rgba(196,164,80,0.6)');
      cornerScatter(ctx, x0, y0, w, h, 6, seed, (c, x, y, rng) => petal(c, x, y, b * 0.01, rng() * Math.PI, 'rgba(214,188,110,0.5)'));
    },
    sun(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      sunDeco(ctx, x0 + w - b * 0.07, y0 + b * 0.08, b * 0.06, '#f7c46b');
      cornerScatter(ctx, x0, y0, w, h, 5, seed, (c, x, y, rng) => star4(c, x, y, b * 0.008, 'rgba(247,196,107,0.7)'));
    },
    lotus(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      leaf(ctx, x0 + w - b * 0.09, y0 + b * 0.09, b * 0.09, 0.7, 'rgba(110,165,120,0.7)');
      blossom(ctx, x0 + b * 0.07, y0 + h - b * 0.08, b * 0.032, 'rgba(235,150,175,0.85)');
      cornerScatter(ctx, x0, y0, w, h, 5, seed, (c, x, y, rng) => petal(c, x, y, b * 0.01, rng() * Math.PI, 'rgba(150,190,160,0.45)'));
    },
    melon(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      watermelon(ctx, x0 + w - b * 0.09, y0 + b * 0.085, b * 0.035);
      cornerScatter(ctx, x0, y0, w, h, 5, seed, (c, x, y, rng) => star4(c, x, y, b * 0.007, 'rgba(247,196,107,0.7)'));
    },
    leaf(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      const cols = ['rgba(224,146,73,0.7)', 'rgba(206,178,88,0.7)', 'rgba(196,110,60,0.6)'];
      cornerScatter(ctx, x0, y0, w, h, 10, seed, (c, x, y, rng) => leaf(c, x, y, b * (0.035 + rng() * 0.03), rng() * Math.PI * 2, cols[Math.floor(rng() * cols.length)]));
      leaf(ctx, x0 + w - b * 0.09, y0 + b * 0.08, b * 0.06, 0.8, 'rgba(224,146,73,0.8)', 1, true);
    },
    duck(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      duck(ctx, x0 + b * 0.1, y0 + h - b * 0.1, b * 0.07);
      cornerScatter(ctx, x0, y0, w, h, 5, seed, (c, x, y, rng) => petal(c, x, y, b * 0.01, rng() * Math.PI, 'rgba(240,205,120,0.5)'));
    },
    dew(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      cornerScatter(ctx, x0, y0, w, h, 12, seed, (c, x, y, rng) => {
        c.save(); c.fillStyle = 'rgba(160,205,215,0.5)';
        c.beginPath(); c.arc(x, y, b * (0.005 + rng() * 0.008), 0, Math.PI * 2); c.fill();
        c.fillStyle = 'rgba(255,255,255,0.8)';
        c.beginPath(); c.arc(x - b * 0.002, y - b * 0.002, b * 0.0018, 0, Math.PI * 2); c.fill();
        c.restore();
      });
      leaf(ctx, x0 + w - b * 0.09, y0 + b * 0.08, b * 0.08, 0.7, 'rgba(150,185,160,0.6)');
    },
    rice(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      riceEar(ctx, x0 + w - b * 0.08, y0 + b * 0.22, b * 0.11, 0.35);
      cornerScatter(ctx, x0, y0, w, h, 6, seed, (c, x, y, rng) => petal(c, x, y, b * 0.01, rng() * Math.PI, 'rgba(214,188,110,0.5)'));
    },
    geese(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      geese(ctx, x0 + w - b * 0.18, y0 + b * 0.08, b * 0.14);
      cornerScatter(ctx, x0, y0, w, h, 5, seed, (c, x, y, rng) => star4(c, x, y, b * 0.006, 'rgba(150,160,180,0.6)'));
    },
    persimmon(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      persimmon(ctx, x0 + w - b * 0.09, y0 + b * 0.11, b * 0.032);
      leaf(ctx, x0 + b * 0.07, y0 + h - b * 0.08, b * 0.06, -0.8, 'rgba(200,120,70,0.6)');
      cornerScatter(ctx, x0, y0, w, h, 5, seed, (c, x, y, rng) => leaf(c, x, y, b * 0.025, rng() * Math.PI * 2, 'rgba(200,120,70,0.5)'));
    },
    mitten(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      mitten(ctx, x0 + w - b * 0.09, y0 + b * 0.09, b * 0.07, 0.3);
      cornerScatter(ctx, x0, y0, w, h, 6, seed, (c, x, y, rng) => flake(c, x, y, b * (0.012 + rng() * 0.012), 'rgba(127,168,217,0.55)'));
    },
    snow(ctx, x0, y0, w, h, s, seed, dens = 1) {
      const b = Math.min(w, h) * s;
      const n = Math.round(8 * dens);
      cornerScatter(ctx, x0, y0, w, h, n, seed, (c, x, y, rng) => flake(c, x, y, b * (0.012 + rng() * 0.014), 'rgba(127,168,217,0.65)'));
      cornerScatter(ctx, x0, y0, w, h, n * 2, seed + 1, (c, x, y, rng) => {
        c.save(); c.fillStyle = 'rgba(127,168,217,0.4)';
        c.beginPath(); c.arc(x, y, b * (0.003 + rng() * 0.004), 0, Math.PI * 2); c.fill(); c.restore();
      });
    },
    snowman(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      snowman(ctx, x0 + w - b * 0.09, y0 + b * 0.12, b * 0.09);
      cornerScatter(ctx, x0, y0, w, h, 6, seed, (c, x, y, rng) => flake(c, x, y, b * (0.012 + rng() * 0.012), 'rgba(127,168,217,0.6)'));
    },
    dumpling(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      dumpling(ctx, x0 + w - b * 0.09, y0 + b * 0.08, b * 0.06, -0.15);
      dumpling(ctx, x0 + b * 0.08, y0 + h - b * 0.08, b * 0.05, 0.2);
      cornerScatter(ctx, x0, y0, w, h, 5, seed, (c, x, y, rng) => star4(c, x, y, b * 0.006, 'rgba(210,180,120,0.6)'));
    },
  };
  // 大图标（≥画面宽度 1/4，压白卡半透明展示）：24 节气逐一独有图案
  const TERM_BIG = {
    plumbranch(ctx, x0, y0, w) {
      const u = w;
      plumBranch(ctx, x0 + u * 0.36, y0 + u * 0.56, u * 0.55);
    },
    ice(ctx, x0, y0, w) {
      const u = w;
      icicles(ctx, x0 + u * 0.83, y0 + u * 0.03, u * 0.3);
      flake(ctx, x0 + u * 0.65, y0 + u * 0.16, u * 0.07, 'rgba(127,168,217,0.85)');
    },
    sprout(ctx, x0, y0, w) {
      const u = w;
      sprout(ctx, x0 + u * 0.85, y0 + u * 0.24, u * 0.26, '#5da65d');
      sprout(ctx, x0 + u * 0.69, y0 + u * 0.13, u * 0.15, '#7cb87c');
    },
    rain(ctx, x0, y0, w) {
      const u = w;
      cloud(ctx, x0 + u * 0.83, y0 + u * 0.15, u * 0.3, 'rgba(120,155,190,0.95)');
      raindrop(ctx, x0 + u * 0.75, y0 + u * 0.26, u * 0.08, 'rgba(110,150,190,0.9)');
      raindrop(ctx, x0 + u * 0.86, y0 + u * 0.28, u * 0.06, 'rgba(110,150,190,0.75)');
    },
    ladybug(ctx, x0, y0, w) {
      const u = w;
      ladybug(ctx, x0 + u * 0.84, y0 + u * 0.19, u * 0.11, 0.4);
      sprout(ctx, x0 + u * 0.64, y0 + u * 0.33, u * 0.15, '#7cb87c');
    },
    petal(ctx, x0, y0, w) {
      const u = w;
      blossom(ctx, x0 + u * 0.84, y0 + u * 0.16, u * 0.115, '#ec8fae', '#e06a92');
      blossom(ctx, x0 + u * 0.7, y0 + u * 0.3, u * 0.07, '#f5b8cb', '#e06a92');
    },
    kite(ctx, x0, y0, w) {
      const u = w;
      swallow(ctx, x0 + u * 0.84, y0 + u * 0.15, u * 0.26, 0.15);
      ctx.save();
      ctx.strokeStyle = 'rgba(110,125,150,0.7)'; ctx.lineWidth = Math.max(1.2, u * 0.004); ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x0 + u * 0.81, y0 + u * 0.28);
      ctx.quadraticCurveTo(x0 + u * 0.73, y0 + u * 0.4, x0 + u * 0.78, y0 + u * 0.55);
      ctx.stroke();
      ctx.restore();
      cloud(ctx, x0 + u * 0.6, y0 + u * 0.42, u * 0.16, 'rgba(150,168,150,0.6)');
    },
    tea(ctx, x0, y0, w) {
      const u = w;
      teaShoot(ctx, x0 + u * 0.84, y0 + u * 0.2, u * 0.3);
      raindrop(ctx, x0 + u * 0.64, y0 + u * 0.12, u * 0.05, 'rgba(110,160,200,0.7)');
    },
    cherry(ctx, x0, y0, w) {
      const u = w;
      cherry(ctx, x0 + u * 0.82, y0 + u * 0.24, u * 0.16);
    },
    wheat(ctx, x0, y0, w) {
      const u = w;
      wheat(ctx, x0 + u * 0.85, y0 + u * 0.24, u * 0.28, 0.35, 'rgba(115,155,80,0.95)');
      wheat(ctx, x0 + u * 0.69, y0 + u * 0.12, u * 0.18, -0.4, 'rgba(135,172,95,0.8)');
    },
    harvest(ctx, x0, y0, w) {
      const u = w;
      sickleWheat(ctx, x0 + u * 0.66, y0 + u * 0.28, u * 0.4);
    },
    sun(ctx, x0, y0, w) {
      const u = w;
      sunDeco(ctx, x0 + u * 0.85, y0 + u * 0.15, u * 0.125, '#f0b050');
    },
    lotus(ctx, x0, y0, w) {
      const u = w;
      lotusPond(ctx, x0 + u * 0.74, y0 + u * 0.4, u * 0.17);
    },
    melon(ctx, x0, y0, w) {
      const u = w;
      watermelon(ctx, x0 + u * 0.84, y0 + u * 0.08, u * 0.17);
    },
    leaf(ctx, x0, y0, w) {
      const u = w;
      leaf(ctx, x0 + u * 0.86, y0 + u * 0.12, u * 0.26, -0.5, 'rgba(217,122,53,0.95)', 1, true);
      leaf(ctx, x0 + u * 0.71, y0 + u * 0.22, u * 0.16, -1.2, 'rgba(196,150,60,0.8)', 1, true);
    },
    duck(ctx, x0, y0, w) {
      const u = w;
      duck(ctx, x0 + u * 0.74, y0 + u * 0.22, u * 0.36);
    },
    dew(ctx, x0, y0, w) {
      const u = w;
      leaf(ctx, x0 + u * 0.86, y0 + u * 0.16, u * 0.26, -0.6, 'rgba(120,160,135,0.95)');
      ctx.save();
      ctx.fillStyle = 'rgba(150,200,212,0.95)';
      ctx.beginPath(); ctx.ellipse(x0 + u * 0.78, y0 + u * 0.09, u * 0.045, u * 0.055, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath(); ctx.arc(x0 + u * 0.768, y0 + u * 0.075, u * 0.014, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    },
    rice(ctx, x0, y0, w) {
      const u = w;
      riceEar(ctx, x0 + u * 0.72, y0 + u * 0.48, u * 0.44, -0.2);
    },
    geese(ctx, x0, y0, w) {
      const u = w;
      geese(ctx, x0 + u * 0.7, y0 + u * 0.15, u * 0.42);
    },
    persimmon(ctx, x0, y0, w) {
      const u = w;
      persimmon(ctx, x0 + u * 0.84, y0 + u * 0.24, u * 0.16);
      leaf(ctx, x0 + u * 0.62, y0 + u * 0.3, u * 0.12, -1.4, 'rgba(200,120,70,0.8)');
    },
    mitten(ctx, x0, y0, w) {
      const u = w;
      mitten(ctx, x0 + u * 0.84, y0 + u * 0.2, u * 0.3, 0.3);
      flake(ctx, x0 + u * 0.63, y0 + u * 0.32, u * 0.06, 'rgba(127,168,217,0.8)');
    },
    snow(ctx, x0, y0, w) {
      const u = w;
      flake(ctx, x0 + u * 0.84, y0 + u * 0.17, u * 0.13, 'rgba(127,168,217,0.95)');
      flake(ctx, x0 + u * 0.65, y0 + u * 0.09, u * 0.07, 'rgba(127,168,217,0.7)');
    },
    snowman(ctx, x0, y0, w) {
      const u = w;
      snowman(ctx, x0 + u * 0.84, y0 + u * 0.44, u * 0.4);
      flake(ctx, x0 + u * 0.63, y0 + u * 0.1, u * 0.06, 'rgba(127,168,217,0.85)');
    },
    dumpling(ctx, x0, y0, w) {
      const u = w;
      dumpling(ctx, x0 + u * 0.8, y0 + u * 0.16, u * 0.28, -0.12);
      dumpling(ctx, x0 + u * 0.6, y0 + u * 0.32, u * 0.19, 0.22);
    },
  };
  const TERM_THEMES = TERM_NAMES.map((name, i) => ({
    name, isTerm: true, when: { term: i },
    grad: [TERM_STYLE[i][0], TERM_STYLE[i][1]],
    big: TERM_BIG[TERM_STYLE[i][2]],
    deco: (ctx, x0, y0, w, h, s) => SEASON_DECO[TERM_STYLE[i][2]](ctx, x0, y0, w, h, s, i),
  }));

  // ----- 节日主题：name 用于设置页预览选择器，isTerm 标记节气分组 -----
  const THEMES = {
    newyear: {
      name: '元旦', when: { solar: [1, 1] }, grad: ['#3d4f94', '#7b8fd6'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        const cols = ['#ff8a8a', '#ffd93d', '#7ecbff', '#c9b6f0', '#ffffff'];
        cornerScatter(ctx, x0, y0, w, h, 14, 1, (c, x, y, rng) => confetti(c, x, y, b * (0.014 + rng() * 0.012), rng() * Math.PI, cols[Math.floor(rng() * cols.length)], 0.85));
        cornerScatter(ctx, x0, y0, w, h, 6, 2, (c, x, y, rng) => star4(c, x, y, b * (0.006 + rng() * 0.008), '#ffe9a8', 0.9));
        firework(ctx, x0 + w - b * 0.13, y0 + b * 0.12, b * 0.05, 'rgba(255,233,168,0.85)');
      },
      big(ctx, x0, y0, w) {
        const u = w;
        popper(ctx, x0 + u * 0.8, y0 + u * 0.24, u * 0.42, -0.15);
        star4(ctx, x0 + u * 0.94, y0 + u * 0.04, u * 0.03, '#f7c445');
        star4(ctx, x0 + u * 0.72, y0 + u * 0.03, u * 0.025, '#7ecbff');
      },
    },
    spring: {
      name: '春节', when: { lunar: [1, 1] }, grad: ['#a61b1b', '#d95436'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        lantern(ctx, x0 + w - b * 0.1, y0 + b * 0.14, b * 0.085, b * 0.062);
        lantern(ctx, x0 + w - b * 0.03, y0 + b * 0.055, b * 0.055, b * 0.04);
        lantern(ctx, x0 + b * 0.09, y0 + h - b * 0.11, b * 0.07, b * 0.05);
        cornerScatter(ctx, x0, y0, w, h, 10, 7, (c, x, y, rng) => star4(c, x, y, b * (0.005 + rng() * 0.007), 'rgba(255,217,138,0.9)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        lantern(ctx, x0 + u * 0.85, y0 + u * 0.175, u * 0.26, u * 0.19);
        lantern(ctx, x0 + u * 0.685, y0 + u * 0.09, u * 0.12, u * 0.088, '#f0605a');
      },
    },
    chuxi: {
      name: '除夕', when: { chuxi: true }, grad: ['#8f1414', '#c9432c'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        // 守岁烟花为主，配一只灯笼，与春节的灯笼阵区分
        firework(ctx, x0 + w - b * 0.11, y0 + b * 0.12, b * 0.055, 'rgba(255,217,138,0.95)');
        firework(ctx, x0 + b * 0.1, y0 + h - b * 0.1, b * 0.042, 'rgba(255,217,138,0.7)');
        firework(ctx, x0 + w - b * 0.05, y0 + b * 0.24, b * 0.03, 'rgba(255,180,120,0.6)');
        lantern(ctx, x0 + b * 0.08, y0 + h - b * 0.14, b * 0.065, b * 0.047);
        cornerScatter(ctx, x0, y0, w, h, 8, 8, (c, x, y, rng) => star4(c, x, y, b * (0.005 + rng() * 0.007), 'rgba(255,217,138,0.9)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        firework(ctx, x0 + u * 0.82, y0 + u * 0.17, u * 0.13, '#f7c445');
        firework(ctx, x0 + u * 0.63, y0 + u * 0.08, u * 0.07, '#f09a5a');
        lantern(ctx, x0 + u * 0.86, y0 + u * 0.45, u * 0.17, u * 0.125);
      },
    },
    lantern: {
      name: '元宵', when: { lunar: [1, 15] }, grad: ['#8a2f52', '#d96c6c'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        lantern(ctx, x0 + w - b * 0.09, y0 + b * 0.12, b * 0.075, b * 0.054, '#f0605a');
        lantern(ctx, x0 + b * 0.08, y0 + h - b * 0.1, b * 0.065, b * 0.047, '#f08a5a');
        // 汤圆：白胖小圆 + 淡影
        cornerScatter(ctx, x0, y0, w, h, 4, 9, (c, x, y) => {
          c.save(); c.fillStyle = 'rgba(31,36,48,0.12)';
          c.beginPath(); c.ellipse(x, y + b * 0.017, b * 0.017, b * 0.005, 0, 0, Math.PI * 2); c.fill();
          c.fillStyle = '#fffaf2';
          c.beginPath(); c.arc(x, y, b * 0.016, 0, Math.PI * 2); c.fill(); c.restore();
        });
        cornerScatter(ctx, x0, y0, w, h, 8, 10, (c, x, y, rng) => star4(c, x, y, b * (0.005 + rng() * 0.006), 'rgba(255,225,170,0.85)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        // 45° 俯视：碗口椭圆 + 汤面 + 三只白胖汤圆，配热气与小灯笼
        const bx = x0 + u * 0.82, by = y0 + u * 0.27, rx = u * 0.18, ry = u * 0.095;
        const srx = rx * 0.8, sry = ry * 0.8;
        ctx.save();
        ctx.fillStyle = '#7aa8d0'; // 碗沿
        ctx.beginPath(); ctx.ellipse(bx, by, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.6)'; // 碗沿高光弧
        ctx.beginPath(); ctx.ellipse(bx, by, rx * 0.94, ry * 0.94, 0, Math.PI * 1.15, Math.PI * 1.85); ctx.lineWidth = Math.max(1.4, u * 0.012); ctx.stroke();
        ctx.fillStyle = '#628cb0'; // 碗身（往下收的下半椭圆）
        ctx.beginPath();
        ctx.ellipse(bx, by + ry * 0.4, rx * 0.9, ry * 0.85, 0, 0, Math.PI);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#f5f0e6'; // 汤面
        ctx.beginPath(); ctx.ellipse(bx, by, srx, sry, 0, 0, Math.PI * 2); ctx.fill();
        // 汤圆：三只，带底影与高光（都在汤面椭圆内）
        for (const [dx, dy, rr] of [[-0.45, 0.3, 0.046], [0.48, 0.22, 0.042], [-0.05, -0.42, 0.04]]) {
          const cx2 = bx + srx * dx, cy2 = by + sry * dy;
          ctx.fillStyle = 'rgba(180,165,135,0.5)';
          ctx.beginPath(); ctx.ellipse(cx2, cy2 + rr * u * 0.4, rr * u, rr * u * 0.35, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#fffdf8';
          ctx.strokeStyle = 'rgba(200,185,150,0.9)'; ctx.lineWidth = Math.max(1, u * 0.005);
          ctx.beginPath(); ctx.arc(cx2, cy2, rr * u, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,1)';
          ctx.beginPath(); ctx.ellipse(cx2 - rr * u * 0.3, cy2 - rr * u * 0.35, rr * u * 0.22, rr * u * 0.13, -0.6, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
        steam(ctx, x0 + u * 0.94, y0 + u * 0.13, u * 0.09);
        lantern(ctx, x0 + u * 0.58, y0 + u * 0.09, u * 0.09, u * 0.066, '#f0605a');
      },
    },
    longtaitou: {
      name: '龙抬头', when: { lunar: [2, 2] }, grad: ['#9a6a35', '#e0c284'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        dragon(ctx, x0 + w - b * 0.26, y0 + b * 0.2, b * 0.15, 0, 'rgba(214,169,74,0.85)');
        cloud(ctx, x0 + b * 0.1, y0 + h - b * 0.09, b * 0.12, 'rgba(255,255,255,0.35)');
        cornerScatter(ctx, x0, y0, w, h, 7, 31, (c, x, y, rng) => star4(c, x, y, b * (0.005 + rng() * 0.006), 'rgba(255,235,190,0.8)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        dragon(ctx, x0 + u * 0.6, y0 + u * 0.28, u * 0.3, 0, '#d6a94a');
      },
    },
    valentine: {
      name: '情人节', when: { solar: [2, 14] }, grad: ['#d9648f', '#f3b3c8'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        heart(ctx, x0 + w - b * 0.09, y0 + b * 0.09, b * 0.045, 'rgba(255,255,255,0.9)');
        heart(ctx, x0 + w - b * 0.17, y0 + b * 0.16, b * 0.028, 'rgba(214,74,124,0.75)');
        heart(ctx, x0 + b * 0.08, y0 + h - b * 0.08, b * 0.038, 'rgba(255,255,255,0.8)');
        cornerScatter(ctx, x0, y0, w, h, 8, 12, (c, x, y, rng) => heart(c, x, y, b * (0.012 + rng() * 0.016), rng() > 0.5 ? 'rgba(255,255,255,0.55)' : 'rgba(214,74,124,0.45)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        rose(ctx, x0 + u * 0.82, y0 + u * 0.15, u * 0.14);
        heart(ctx, x0 + u * 0.66, y0 + u * 0.08, u * 0.055, '#f3a0bc');
        heart(ctx, x0 + u * 0.95, y0 + u * 0.36, u * 0.04, 'rgba(232,96,138,0.85)');
      },
    },
    women: {
      name: '妇女节', when: { solar: [3, 8] }, grad: ['#a86ed6', '#e3c1ef'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        blossom(ctx, x0 + w - b * 0.08, y0 + b * 0.09, b * 0.05, '#f0e0f7', '#d6a2e8');
        blossom(ctx, x0 + b * 0.08, y0 + h - b * 0.08, b * 0.042, '#f7e6fb', '#d6a2e8', 0.9);
        cornerScatter(ctx, x0, y0, w, h, 8, 14, (c, x, y, rng) => petal(c, x, y, b * (0.012 + rng() * 0.01), rng() * Math.PI, 'rgba(255,255,255,0.6)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        bouquet(ctx, x0 + u * 0.82, y0 + u * 0.28, u * 0.34);
      },
    },
    arbor: {
      name: '植树节', when: { solar: [3, 12] }, grad: ['#4a9e5a', '#a8d8a0'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        tree(ctx, x0 + w - b * 0.11, y0 + b * 0.15, b * 0.11, 'rgba(50,130,75,0.85)');
        sprout(ctx, x0 + b * 0.08, y0 + h - b * 0.08, b * 0.06, 'rgba(60,140,80,0.7)');
        cornerScatter(ctx, x0, y0, w, h, 6, 32, (c, x, y, rng) => petal(c, x, y, b * 0.011, rng() * Math.PI, 'rgba(255,255,255,0.55)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        tree(ctx, x0 + u * 0.81, y0 + u * 0.34, u * 0.34, 'rgba(45,125,70,0.95)');
      },
    },
    fools: {
      name: '愚人节', when: { solar: [4, 1] }, grad: ['#8a6ad0', '#d4c1f2'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        smiley(ctx, x0 + w - b * 0.09, y0 + b * 0.1, b * 0.038, 'rgba(255,225,120,0.95)');
        smiley(ctx, x0 + b * 0.08, y0 + h - b * 0.09, b * 0.03, 'rgba(255,225,120,0.8)');
        const cols = ['#ffd93d', '#ffffff', '#c9b6f0'];
        cornerScatter(ctx, x0, y0, w, h, 9, 33, (c, x, y, rng) => confetti(c, x, y, b * (0.012 + rng() * 0.01), rng() * Math.PI, cols[Math.floor(rng() * cols.length)], 0.8));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        smiley(ctx, x0 + u * 0.84, y0 + u * 0.17, u * 0.12, '#ffd93d');
      },
    },
    labor: {
      name: '劳动节', when: { solar: [5, 1] }, grad: ['#e09b3d', '#f3ce8a'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        wrench(ctx, x0 + w - b * 0.07, y0 + b * 0.07, b * 0.045, Math.PI / 4, 'rgba(255,255,255,0.9)');
        const cols = ['#ffffff', '#f7e6b0', '#e88a5a'];
        cornerScatter(ctx, x0, y0, w, h, 8, 15, (c, x, y, rng) => confetti(c, x, y, b * (0.013 + rng() * 0.01), rng() * Math.PI, cols[Math.floor(rng() * cols.length)], 0.8));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        // 劳动节：齿轮 + 精修扳手 × 锤子交叉
        gear(ctx, x0 + u * 0.64, y0 + u * 0.12, u * 0.09, 'rgba(150,160,175,0.85)');
        wrench(ctx, x0 + u * 0.84, y0 + u * 0.22, u * 0.36, 0, 'rgba(150,160,175,0.95)');
        hammer(ctx, x0 + u * 0.84, y0 + u * 0.22, u * 0.36, Math.PI / 2, 'rgba(200,120,80,0.95)');
      },
    },
    youth: {
      name: '青年节', when: { solar: [5, 4] }, grad: ['#3f7fbf', '#8fc4e8'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        const cols = ['#ffd93d', '#ffffff', '#ffb05a'];
        cornerScatter(ctx, x0, y0, w, h, 10, 16, (c, x, y, rng) => confetti(c, x, y, b * (0.013 + rng() * 0.011), rng() * Math.PI, cols[Math.floor(rng() * cols.length)], 0.85));
        cornerScatter(ctx, x0, y0, w, h, 6, 17, (c, x, y, rng) => star4(c, x, y, b * (0.006 + rng() * 0.007), 'rgba(255,255,255,0.9)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        torch(ctx, x0 + u * 0.84, y0 + u * 0.2, u * 0.36);
        star4(ctx, x0 + u * 0.66, y0 + u * 0.12, u * 0.03, '#f7c948');
      },
    },
    nurse: {
      name: '护士节', when: { solar: [5, 12] }, grad: ['#6fa8cc', '#c2e2f2'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        medCross(ctx, x0 + w - b * 0.09, y0 + b * 0.1, b * 0.075, 'rgba(255,255,255,0.9)');
        medCross(ctx, x0 + b * 0.08, y0 + h - b * 0.09, b * 0.055, 'rgba(232,106,138,0.75)');
        cornerScatter(ctx, x0, y0, w, h, 7, 34, (c, x, y, rng) => heart(c, x, y, b * (0.012 + rng() * 0.014), 'rgba(255,255,255,0.5)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        medCross(ctx, x0 + u * 0.84, y0 + u * 0.17, u * 0.22, '#e8708f');
      },
    },
    children: {
      name: '儿童节', when: { solar: [6, 1] }, grad: ['#5cc9e8', '#aee89a'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        balloon(ctx, x0 + w - b * 0.09, y0 + b * 0.1, b * 0.045, '#ff8a8a');
        balloon(ctx, x0 + w - b * 0.04, y0 + b * 0.16, b * 0.038, '#ffd93d');
        balloon(ctx, x0 + b * 0.08, y0 + h - b * 0.1, b * 0.042, '#7ecbff');
        const cols = ['#ff8a8a', '#ffd93d', '#7ecbff', '#ffffff'];
        cornerScatter(ctx, x0, y0, w, h, 8, 18, (c, x, y, rng) => confetti(c, x, y, b * (0.012 + rng() * 0.01), rng() * Math.PI, cols[Math.floor(rng() * cols.length)], 0.85));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        // 一束气球：六只多彩 + 缆绳收拢
        const bals = [
          [0.84, 0.14, 0.115, '#ff8a8a'], [0.68, 0.07, 0.09, '#ffd93d'], [0.95, 0.3, 0.085, '#7ecbff'],
          [0.63, 0.24, 0.075, '#c9b6f0'], [0.79, 0.33, 0.08, '#9ae6a0'], [0.52, 0.13, 0.065, '#ffa0d0'],
        ];
        ctx.save();
        ctx.strokeStyle = 'rgba(31,36,48,0.22)'; ctx.lineWidth = Math.max(1, u * 0.004); ctx.lineCap = 'round';
        for (const [bx, by, br] of bals) { // 缆绳：从各气球底收到下方一点
          ctx.beginPath();
          ctx.moveTo(x0 + u * bx, y0 + u * (by + br * 2.6));
          ctx.quadraticCurveTo(x0 + u * (bx - 0.03), y0 + u * (by + br * 3.4), x0 + u * 0.78, y0 + u * 0.48);
          ctx.stroke();
        }
        ctx.restore();
        for (const [bx, by, br, col] of bals) balloon(ctx, x0 + u * bx, y0 + u * by, u * br, col, false);
      },
    },
    mother: {
      name: '母亲节', when: { mother: true }, grad: ['#e88a9a', '#f7c9c1'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        blossom(ctx, x0 + w - b * 0.08, y0 + b * 0.09, b * 0.05, '#f7b3c1', '#e86a8a');
        blossom(ctx, x0 + b * 0.08, y0 + h - b * 0.08, b * 0.042, '#f7b3c1', '#e86a8a', 0.9);
        cornerScatter(ctx, x0, y0, w, h, 8, 19, (c, x, y, rng) => petal(c, x, y, b * (0.012 + rng() * 0.01), rng() * Math.PI, 'rgba(255,255,255,0.65)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        carnation(ctx, x0 + u * 0.84, y0 + u * 0.16, u * 0.13);
        carnation(ctx, x0 + u * 0.66, y0 + u * 0.3, u * 0.085, 'rgba(238,150,175,0.9)');
      },
    },
    father: {
      name: '父亲节', when: { father: true }, grad: ['#3d6ab8', '#8fb4e4'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        necktie(ctx, x0 + w - b * 0.1, y0 + b * 0.07, b * 0.052, b * 0.13, 'rgba(255,255,255,0.85)');
        necktie(ctx, x0 + b * 0.09, y0 + h - b * 0.2, b * 0.04, b * 0.1, 'rgba(255,217,138,0.8)');
        cornerScatter(ctx, x0, y0, w, h, 7, 35, (c, x, y, rng) => star4(c, x, y, b * (0.006 + rng() * 0.007), 'rgba(255,255,255,0.8)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        // 父亲的背影：父亲牵小孩
        fatherBack(ctx, x0 + u * 0.76, y0 + u * 0.42, u * 0.44, 'rgba(42,74,140,0.95)');
        star4(ctx, x0 + u * 0.63, y0 + u * 0.09, u * 0.025, 'rgba(255,255,255,0.9)');
      },
    },
    dragonboat: {
      name: '端午节', when: { lunar: [5, 5] }, grad: ['#3f8f5f', '#8fd0a0'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        leaf(ctx, x0 + w - b * 0.08, y0 + b * 0.09, b * 0.11, -0.5, 'rgba(46,120,74,0.75)');
        leaf(ctx, x0 + w - b * 0.05, y0 + b * 0.14, b * 0.08, -1, 'rgba(46,120,74,0.55)');
        leaf(ctx, x0 + b * 0.08, y0 + h - b * 0.08, b * 0.1, Math.PI - 0.6, 'rgba(46,120,74,0.7)');
        // 底部水波
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = Math.max(1.2, b * 0.004); ctx.lineCap = 'round';
        for (const [dy, ww] of [[0.035, 0.09], [0.06, 0.06]]) {
          ctx.beginPath();
          ctx.moveTo(x0 + b * 0.02, y0 + h - b * dy);
          ctx.quadraticCurveTo(x0 + b * (0.02 + ww), y0 + h - b * (dy + 0.018), x0 + b * (0.02 + ww * 2), y0 + h - b * dy);
          ctx.stroke();
        }
        ctx.restore();
      },
      big(ctx, x0, y0, w) {
        const u = w;
        zongzi(ctx, x0 + u * 0.82, y0 + u * 0.2, u * 0.34, -0.1);
        leaf(ctx, x0 + u * 0.64, y0 + u * 0.32, u * 0.14, -1.1, 'rgba(46,120,74,0.8)');
      },
    },
    qixi: {
      name: '七夕', when: { lunar: [7, 7] }, grad: ['#2f3d7a', '#7a6fd6'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        // 斜向银河淡带
        ctx.save();
        ctx.translate(x0 + w / 2, y0 + h / 2); ctx.rotate(-0.5);
        const g = ctx.createLinearGradient(0, -b * 0.3, 0, b * 0.3);
        g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,0.13)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.fillRect(-w, -b * 0.3, w * 2, b * 0.6);
        ctx.restore();
        cornerScatter(ctx, x0, y0, w, h, 22, 21, (c, x, y, rng) => star4(c, x, y, b * (0.004 + rng() * 0.006), '#ffffff', 0.4 + rng() * 0.6));
        heart(ctx, x0 + w - b * 0.09, y0 + b * 0.09, b * 0.03, 'rgba(255,182,203,0.85)');
        heart(ctx, x0 + b * 0.07, y0 + h - b * 0.07, b * 0.022, 'rgba(255,182,203,0.65)');
      },
      big(ctx, x0, y0, w) {
        const u = w;
        // 鹊桥：拱形桥身 + 桥面栏杆 + 两端双星（牛郎织女）+ 桥上小鹊
        const bx = x0 + u * 0.75, by = y0 + u * 0.36, br = u * 0.25;
        ctx.save();
        ctx.fillStyle = 'rgba(200,160,110,0.95)'; // 桥身：外拱弧 + 内拱弧回抱
        ctx.beginPath();
        ctx.arc(bx, by, br, Math.PI * 1.05, Math.PI * 1.95);
        ctx.arc(bx, by, br * 0.72, Math.PI * 1.95, Math.PI * 1.05, true);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(200,160,110,0.95)'; ctx.lineWidth = Math.max(1.4, u * 0.014); ctx.lineCap = 'round';
        for (let i = 0; i <= 5; i++) { // 栏柱
          const ang = Math.PI * 1.1 + (i / 5) * Math.PI * 0.8;
          ctx.beginPath();
          ctx.moveTo(bx + Math.cos(ang) * br * 1.02, by + Math.sin(ang) * br * 1.02);
          ctx.lineTo(bx + Math.cos(ang) * br * 1.12, by + Math.sin(ang) * br * 1.12);
          ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(200,160,110,0.95)';
        ctx.beginPath(); // 栏杆横梁
        ctx.arc(bx, by, br * 1.12, Math.PI * 1.08, Math.PI * 1.92);
        ctx.stroke();
        ctx.restore();
        // 桥上三只小鹊（v 形剪影）
        ctx.strokeStyle = 'rgba(90,80,110,0.9)'; ctx.lineWidth = Math.max(1.2, u * 0.012);
        for (const t of [0.3, 0.5, 0.7]) {
          const ang = Math.PI + t * Math.PI;
          const px = bx + Math.cos(ang) * br * 1.18, py = by + Math.sin(ang) * br * 1.18;
          ctx.beginPath();
          ctx.moveTo(px - u * 0.022, py - u * 0.004);
          ctx.quadraticCurveTo(px - u * 0.008, py - u * 0.02, px, py - u * 0.006);
          ctx.quadraticCurveTo(px + u * 0.008, py - u * 0.02, px + u * 0.022, py - u * 0.004);
          ctx.stroke();
        }
        // 两端双星
        star5(ctx, x0 + u * 0.93, y0 + u * 0.1, u * 0.07, '#f7d774');
        star5(ctx, x0 + u * 0.56, y0 + u * 0.32, u * 0.05, '#f7d774');
        star4(ctx, x0 + u * 0.72, y0 + u * 0.05, u * 0.025, '#ffffff');
      },
    },
    party: {
      name: '建党节', when: { solar: [7, 1] }, grad: ['#a01818', '#d86a3a'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        star5(ctx, x0 + w - b * 0.09, y0 + b * 0.1, b * 0.045, 'rgba(255,217,138,0.95)');
        star5(ctx, x0 + b * 0.08, y0 + h - b * 0.1, b * 0.035, 'rgba(255,217,138,0.8)');
        const cols = ['#ffd98a', '#ffffff', '#ff9a6a'];
        cornerScatter(ctx, x0, y0, w, h, 8, 36, (c, x, y, rng) => confetti(c, x, y, b * (0.012 + rng() * 0.01), rng() * Math.PI, cols[Math.floor(rng() * cols.length)], 0.8));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        // 党旗：红旗 + 锤子镰刀
        partyFlag(ctx, x0 + u * 0.7, y0 + u * 0.06, u * 0.3);
        star4(ctx, x0 + u * 0.63, y0 + u * 0.42, u * 0.02, 'rgba(255,217,138,0.9)');
      },
    },
    teacher: {
      name: '教师节', when: { solar: [9, 10] }, grad: ['#d99a3d', '#f3d9a0'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        blossom(ctx, x0 + w - b * 0.08, y0 + b * 0.09, b * 0.048, '#f7d9a0', '#e8a84a');
        blossom(ctx, x0 + b * 0.08, y0 + h - b * 0.08, b * 0.04, '#f7d9a0', '#e8a84a', 0.9);
        cornerScatter(ctx, x0, y0, w, h, 7, 22, (c, x, y, rng) => star4(c, x, y, b * (0.005 + rng() * 0.006), 'rgba(255,255,255,0.85)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        // 三册叠放的书（封面 + 书脊 + 书页）+ 斜放铅笔（互不穿模）
        const bx = x0 + u * 0.84, by = y0 + u * 0.34;
        const books = [
          [u * 0.4, u * 0.085, 'rgba(105,135,185,0.95)', -0.02],
          [u * 0.34, u * 0.075, 'rgba(200,120,80,0.95)', 0.03],
          [u * 0.3, u * 0.07, 'rgba(120,165,120,0.95)', -0.03],
        ];
        let yy = by;
        ctx.save();
        for (const [bw, bh, col, tilt] of books) {
          ctx.save();
          ctx.translate(bx, yy); ctx.rotate(tilt);
          ctx.fillStyle = col; // 封面
          roundRectPath(ctx, -bw / 2, -bh, bw, bh, Math.min(bh * 0.22, bh / 2)); ctx.fill();
          ctx.fillStyle = 'rgba(0,0,0,0.18)'; // 书脊（左端深色带）
          roundRectPath(ctx, -bw / 2, -bh, bh * 0.42, bh, Math.min(bh * 0.22, bh / 2)); ctx.fill();
          ctx.fillRect(-bw / 2 + bh * 0.2, -bh, bh * 0.22, bh);
          ctx.fillStyle = 'rgba(255,255,255,0.65)'; // 书页（右端留口）
          ctx.fillRect(bw / 2 - bh * 0.55, -bh * 0.72, bh * 0.32, bh * 0.44);
          ctx.restore();
          yy -= bh * 1.04;
        }
        ctx.restore();
        pencil(ctx, x0 + u * 0.66, y0 + u * 0.45, u * 0.2, -0.35);
        star4(ctx, x0 + u * 0.6, y0 + u * 0.12, u * 0.025, 'rgba(255,255,255,0.9)');
      },
    },
    army: {
      name: '建军节', when: { solar: [8, 1] }, grad: ['#4a6a50', '#9ab88a'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        star5(ctx, x0 + w - b * 0.09, y0 + b * 0.1, b * 0.042, 'rgba(230,70,60,0.9)');
        star5(ctx, x0 + b * 0.08, y0 + h - b * 0.1, b * 0.032, 'rgba(230,70,60,0.75)');
        cornerScatter(ctx, x0, y0, w, h, 7, 37, (c, x, y, rng) => star4(c, x, y, b * (0.005 + rng() * 0.006), 'rgba(255,255,255,0.7)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        shieldStar(ctx, x0 + u * 0.83, y0 + u * 0.2, u * 0.26, u * 0.32);
      },
    },
    national: {
      name: '国庆节', when: { solar: [10, 1] }, grad: ['#b01f1f', '#e0663c'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        flag(ctx, x0 + w - b * 0.13, y0 + b * 0.04, b * 0.09, b * 0.06);
        cornerScatter(ctx, x0, y0, w, h, 8, 23, (c, x, y, rng) => star4(c, x, y, b * (0.006 + rng() * 0.008), '#ffd98a', 0.9));
        star5(ctx, x0 + b * 0.09, y0 + h - b * 0.09, b * 0.02, 'rgba(255,217,138,0.85)');
      },
      big(ctx, x0, y0, w) {
        const u = w;
        flag(ctx, x0 + u * 0.72, y0 + u * 0.06, u * 0.26, u * 0.26 / 1.5); // 国旗比例 3:2
        star5(ctx, x0 + u * 0.65, y0 + u * 0.3, u * 0.05, '#f0c060');
      },
    },
    midautumn: {
      name: '中秋节', when: { lunar: [8, 15] }, grad: ['#2f4470', '#5a7fb8'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        fullMoon(ctx, x0 + w - b * 0.11, y0 + b * 0.1, b * 0.062);
        cloud(ctx, x0 + w - b * 0.2, y0 + b * 0.15, b * 0.15, 'rgba(255,255,255,0.3)');
        cloud(ctx, x0 + b * 0.1, y0 + h - b * 0.07, b * 0.12, 'rgba(255,255,255,0.2)');
        cornerScatter(ctx, x0, y0, w, h, 12, 24, (c, x, y, rng) => star4(c, x, y, b * (0.004 + rng() * 0.005), 'rgba(255,240,200,0.85)', 0.4 + rng() * 0.6));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        fullMoon(ctx, x0 + u * 0.86, y0 + u * 0.14, u * 0.11, '#f7d774', 'rgba(247,215,116,0.3)');
        mooncake(ctx, x0 + u * 0.68, y0 + u * 0.33, u * 0.11);
        star4(ctx, x0 + u * 0.62, y0 + u * 0.08, u * 0.025, 'rgba(255,240,200,0.9)');
      },
    },
    double9: {
      name: '重阳节', when: { lunar: [9, 9] }, grad: ['#c97b3d', '#f0b97a'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        blossom(ctx, x0 + w - b * 0.08, y0 + b * 0.09, b * 0.05, '#f7c9a0', '#e8934a'); // 菊
        blossom(ctx, x0 + b * 0.08, y0 + h - b * 0.08, b * 0.042, '#f7c9a0', '#e8934a', 0.9);
        cornerScatter(ctx, x0, y0, w, h, 7, 25, (c, x, y, rng) => leaf(c, x, y, b * (0.03 + rng() * 0.025), rng() * Math.PI * 2, 'rgba(196,110,60,0.55)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        chrysanth(ctx, x0 + u * 0.83, y0 + u * 0.19, u * 0.15);
        leaf(ctx, x0 + u * 0.64, y0 + u * 0.32, u * 0.12, -1.5, 'rgba(150,160,90,0.9)');
      },
    },
    halloween: {
      name: '万圣夜', when: { solar: [10, 31] }, grad: ['#3d2a5a', '#8a66ae'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        pumpkin(ctx, x0 + w - b * 0.1, y0 + b * 0.12, b * 0.045);
        bat(ctx, x0 + w - b * 0.24, y0 + b * 0.07, b * 0.026, 0.85);
        bat(ctx, x0 + b * 0.1, y0 + h - b * 0.1, b * 0.024, 0.7);
        cornerScatter(ctx, x0, y0, w, h, 8, 38, (c, x, y, rng) => star4(c, x, y, b * (0.005 + rng() * 0.006), 'rgba(255,235,170,0.75)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        pumpkin(ctx, x0 + u * 0.84, y0 + u * 0.24, u * 0.14, '#ef8a2f', true); // 南瓜灯脸
        bat(ctx, x0 + u * 0.62, y0 + u * 0.09, u * 0.06, 0.9);
      },
    },
    thanksgiving: {
      name: '感恩节', when: { thanksgiving: true }, grad: ['#b06a3d', '#eab88a'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        const cols = ['rgba(200,110,50,0.7)', 'rgba(180,130,50,0.7)', 'rgba(160,90,40,0.6)'];
        cornerScatter(ctx, x0, y0, w, h, 10, 39, (c, x, y, rng) => leaf(c, x, y, b * (0.03 + rng() * 0.028), rng() * Math.PI * 2, cols[Math.floor(rng() * cols.length)]));
        heart(ctx, x0 + w - b * 0.08, y0 + b * 0.09, b * 0.032, 'rgba(255,255,255,0.7)');
      },
      big(ctx, x0, y0, w) {
        const u = w;
        turkey(ctx, x0 + u * 0.8, y0 + u * 0.34, u * 0.44);
      },
    },
    laba: {
      name: '腊八', when: { lunar: [12, 8] }, grad: ['#8a5a3d', '#d0a37a'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        cornerScatter(ctx, x0, y0, w, h, 6, 26, (c, x, y, rng) => flake(c, x, y, b * (0.012 + rng() * 0.012), 'rgba(255,255,255,0.75)'));
        cornerScatter(ctx, x0, y0, w, h, 6, 27, (c, x, y, rng) => { // 红豆/枣点
          c.save(); c.fillStyle = 'rgba(200,80,60,0.85)';
          c.beginPath(); c.arc(x, y, b * (0.006 + rng() * 0.004), 0, Math.PI * 2); c.fill(); c.restore();
        });
        star4(ctx, x0 + w - b * 0.08, y0 + b * 0.08, b * 0.008, 'rgba(255,235,200,0.9)');
      },
      big(ctx, x0, y0, w) {
        const u = w;
        bowl(ctx, x0 + u * 0.83, y0 + u * 0.26, u * 0.3, '#6a4a34');
        ctx.save();
        ctx.fillStyle = 'rgba(148,96,58,0.95)';
        ctx.beginPath(); ctx.ellipse(x0 + u * 0.83, y0 + u * 0.26, u * 0.13, u * 0.038, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(190,70,55,0.95)';
        for (const [dx, dy] of [[-0.06, 0.002], [0.04, 0.014], [0.1, -0.006]]) {
          ctx.beginPath(); ctx.arc(x0 + u * (0.83 + dx), y0 + u * (0.258 + dy), u * 0.014, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
        steam(ctx, x0 + u * 0.82, y0 + u * 0.2, u * 0.1);
        flake(ctx, x0 + u * 0.6, y0 + u * 0.12, u * 0.055, 'rgba(159,180,204,0.85)');
      },
    },
    xiaonianN: {
      name: '小年（北方）', when: { lunar: [12, 23] }, grad: ['#b04a2f', '#e8a06a'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        lantern(ctx, x0 + w - b * 0.09, y0 + b * 0.12, b * 0.07, b * 0.051);
        hawthorn(ctx, x0 + b * 0.09, y0 + h - b * 0.16, b * 0.09, 0.1);
        cornerScatter(ctx, x0, y0, w, h, 6, 41, (c, x, y, rng) => star4(c, x, y, b * (0.005 + rng() * 0.006), 'rgba(255,235,190,0.8)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        hawthorn(ctx, x0 + u * 0.84, y0 + u * 0.27, u * 0.46, 0.1);
        lantern(ctx, x0 + u * 0.62, y0 + u * 0.12, u * 0.1, u * 0.073, '#f0605a');
      },
    },
    xiaonianS: {
      name: '小年（南方）', when: { lunar: [12, 24] }, grad: ['#c05a3a', '#f0b884'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        cornerScatter(ctx, x0, y0, w, h, 6, 42, (c, x, y, rng) => sugarBall(c, x, y, b * (0.013 + rng() * 0.009)));
        star4(ctx, x0 + w - b * 0.08, y0 + b * 0.09, b * 0.008, 'rgba(255,235,190,0.9)');
        lantern(ctx, x0 + b * 0.09, y0 + h - b * 0.12, b * 0.06, b * 0.044, '#f0605a');
      },
      big(ctx, x0, y0, w) {
        const u = w;
        sugarBall(ctx, x0 + u * 0.8, y0 + u * 0.2, u * 0.11);
        sugarBall(ctx, x0 + u * 0.63, y0 + u * 0.32, u * 0.06);
        lantern(ctx, x0 + u * 0.89, y0 + u * 0.08, u * 0.1, u * 0.073, '#f0605a');
      },
    },
    christmaseve: {
      name: '平安夜', when: { solar: [12, 24] }, grad: ['#2b4a7a', '#7a9fd0'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        // 平安果（苹果）为主，配雪花与星光
        apple(ctx, x0 + w - b * 0.09, y0 + b * 0.1, b * 0.034);
        apple(ctx, x0 + b * 0.08, y0 + h - b * 0.09, b * 0.028, '#e05a50');
        cornerScatter(ctx, x0, y0, w, h, 7, 29, (c, x, y, rng) => flake(c, x, y, b * (0.012 + rng() * 0.013), 'rgba(255,255,255,0.8)'));
        cornerScatter(ctx, x0, y0, w, h, 5, 30, (c, x, y, rng) => star4(c, x, y, b * (0.005 + rng() * 0.006), 'rgba(255,235,190,0.9)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        apple(ctx, x0 + u * 0.84, y0 + u * 0.18, u * 0.125);
        apple(ctx, x0 + u * 0.67, y0 + u * 0.09, u * 0.07, '#e05a50');
      },
    },
    christmas: {
      name: '圣诞节', when: { solar: [12, 25] }, grad: ['#2f6e5a', '#8fc9b0'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        santaHat(ctx, x0 + w - b * 0.065, y0 + b * 0.065, b * 0.12, b * 0.12, -0.85); // 右上角挂一顶圣诞帽
        cornerScatter(ctx, x0, y0, w, h, 8, 28, (c, x, y, rng) => flake(c, x, y, b * (0.012 + rng() * 0.014), 'rgba(255,255,255,0.85)'));
        // 冬青果：两颗红果 + 小叶（左下）
        leaf(ctx, x0 + b * 0.08, y0 + h - b * 0.08, b * 0.035, -1.8, 'rgba(30,90,60,0.8)');
        leaf(ctx, x0 + b * 0.08, y0 + h - b * 0.08, b * 0.035, 1.2, 'rgba(30,90,60,0.8)');
        ctx.save(); ctx.fillStyle = '#d64545';
        ctx.beginPath(); ctx.arc(x0 + b * 0.072, y0 + h - b * 0.072, b * 0.01, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(x0 + b * 0.088, y0 + h - b * 0.076, b * 0.01, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      },
      big(ctx, x0, y0, w) {
        const u = w;
        // 大图标层白卡上纯白会隐身，帽边绒球改浅灰
        santaHat(ctx, x0 + u * 0.82, y0 + u * 0.22, u * 0.26, u * 0.26, -0.6, '#c9d3e2');
      },
    },
  };

  // ----- 纪念日主题：风格严肃（深色低饱和 + 悼念烛光/五角星），isMemorial 标记，
  // 默认关闭，由设置 card_memorial_bg 单独控制；开启时优先于同日节日主题
  // （如 7/1 建党节让位香港回归纪念日、5/12 护士节让位防灾减灾日） -----
  const MEMORIALS = {
    leifeng: {
      name: '学雷锋纪念日', isMemorial: true, when: { solar: [3, 5] }, grad: ['#8a4a3a', '#c98a7a'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        heart(ctx, x0 + w - b * 0.09, y0 + b * 0.1, b * 0.036, 'rgba(255,255,255,0.75)');
        heart(ctx, x0 + b * 0.08, y0 + h - b * 0.09, b * 0.028, 'rgba(255,255,255,0.55)');
        cornerScatter(ctx, x0, y0, w, h, 6, 50, (c, x, y, rng) => star4(c, x, y, b * (0.005 + rng() * 0.006), 'rgba(255,240,220,0.7)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        screw(ctx, x0 + u * 0.84, y0 + u * 0.2, u * 0.34, 0.6);
        star4(ctx, x0 + u * 0.65, y0 + u * 0.12, u * 0.025, 'rgba(255,240,220,0.9)');
      },
    },
    disaster: {
      name: '防灾减灾日', isMemorial: true, when: { solar: [5, 12] }, grad: ['#4a5a6a', '#93a5b5'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        umbrella(ctx, x0 + w - b * 0.09, y0 + b * 0.08, b * 0.075, 0.9);
        cornerScatter(ctx, x0, y0, w, h, 8, 51, (c, x, y, rng) => raindrop(c, x, y, b * (0.016 + rng() * 0.016), 'rgba(255,255,255,0.4)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        umbrella(ctx, x0 + u * 0.83, y0 + u * 0.16, u * 0.34, 1);
        raindrop(ctx, x0 + u * 0.66, y0 + u * 0.1, u * 0.05, 'rgba(220,232,245,0.8)');
      },
    },
    qiqi: {
      name: '七七事变纪念日', isMemorial: true, when: { solar: [7, 7] }, grad: ['#26262e', '#5c5c66'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        bell(ctx, x0 + b * 0.09, y0 + h - b * 0.13, b * 0.06, 0.9);
        cornerScatter(ctx, x0, y0, w, h, 6, 52, (c, x, y, rng) => star4(c, x, y, b * (0.004 + rng() * 0.005), 'rgba(255,240,210,0.5)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        bell(ctx, x0 + u * 0.84, y0 + u * 0.26, u * 0.4);
        star4(ctx, x0 + u * 0.65, y0 + u * 0.12, u * 0.02, 'rgba(255,240,210,0.6)');
      },
    },
    hkreturn: {
      name: '香港回归纪念日', isMemorial: true, when: { solar: [7, 1] }, grad: ['#5a2f6a', '#a878c0'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        blossom(ctx, x0 + w - b * 0.08, y0 + b * 0.09, b * 0.05, '#e8c8f0', '#b06ac8'); // 紫荆
        blossom(ctx, x0 + b * 0.08, y0 + h - b * 0.08, b * 0.04, '#e8c8f0', '#b06ac8', 0.85);
        cornerScatter(ctx, x0, y0, w, h, 6, 53, (c, x, y, rng) => petal(c, x, y, b * 0.011, rng() * Math.PI, 'rgba(255,255,255,0.5)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        bauhinia(ctx, x0 + u * 0.83, y0 + u * 0.2, u * 0.17);
      },
    },
    victory: {
      name: '抗战胜利纪念日', isMemorial: true, when: { solar: [9, 3] }, grad: ['#6a1616', '#b85a42'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        star5(ctx, x0 + w - b * 0.09, y0 + b * 0.1, b * 0.04, 'rgba(255,217,138,0.85)');
        cornerScatter(ctx, x0, y0, w, h, 6, 54, (c, x, y, rng) => star4(c, x, y, b * (0.004 + rng() * 0.006), 'rgba(255,235,190,0.6)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        medal(ctx, x0 + u * 0.84, y0 + u * 0.28, u * 0.13);
      },
    },
    jiuyiba: {
      name: '九一八纪念日', isMemorial: true, when: { solar: [9, 18] }, grad: ['#22262e', '#55606e'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        calendar(ctx, x0 + b * 0.09, y0 + h - b * 0.11, b * 0.05);
        cornerScatter(ctx, x0, y0, w, h, 6, 55, (c, x, y, rng) => star4(c, x, y, b * (0.004 + rng() * 0.005), 'rgba(255,240,210,0.5)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        calendar(ctx, x0 + u * 0.83, y0 + u * 0.22, u * 0.28);
        candle(ctx, x0 + u * 0.62, y0 + u * 0.36, u * 0.055, u * 0.16);
      },
    },
    martyrs: {
      name: '烈士纪念日', isMemorial: true, when: { solar: [9, 30] }, grad: ['#26292b', '#5f6668'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        obelisk(ctx, x0 + b * 0.09, y0 + h - b * 0.09, b * 0.07, 0.9);
        star5(ctx, x0 + w - b * 0.09, y0 + b * 0.1, b * 0.03, 'rgba(240,192,96,0.6)');
      },
      big(ctx, x0, y0, w) {
        const u = w;
        obelisk(ctx, x0 + u * 0.84, y0 + u * 0.4, u * 0.42);
        star5(ctx, x0 + u * 0.63, y0 + u * 0.14, u * 0.05, 'rgba(240,192,96,0.85)');
      },
    },
    gongji: {
      name: '国家公祭日', isMemorial: true, when: { solar: [12, 13] }, grad: ['#1d1e22', '#484a50'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        candle(ctx, x0 + w - b * 0.1, y0 + h - b * 0.13, b * 0.03, b * 0.08, 0.9);
        candle(ctx, x0 + b * 0.08, y0 + h - b * 0.1, b * 0.024, b * 0.066, 0.75);
        cornerScatter(ctx, x0, y0, w, h, 5, 56, (c, x, y, rng) => star4(c, x, y, b * (0.004 + rng() * 0.004), 'rgba(255,240,210,0.4)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        candle(ctx, x0 + u * 0.85, y0 + u * 0.36, u * 0.095, u * 0.27);
        candle(ctx, x0 + u * 0.71, y0 + u * 0.34, u * 0.06, u * 0.17);
        dove(ctx, x0 + u * 0.72, y0 + u * 0.14, u * 0.22, 0.1);
      },
    },
    macau: {
      name: '澳门回归纪念日', isMemorial: true, when: { solar: [12, 20] }, grad: ['#2f5244', '#7aa890'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        blossom(ctx, x0 + w - b * 0.08, y0 + b * 0.09, b * 0.05, '#f2f7ee', '#8ab89a'); // 莲花
        blossom(ctx, x0 + b * 0.08, y0 + h - b * 0.08, b * 0.04, '#f2f7ee', '#8ab89a', 0.85);
        cornerScatter(ctx, x0, y0, w, h, 6, 57, (c, x, y, rng) => petal(c, x, y, b * 0.011, rng() * Math.PI, 'rgba(255,255,255,0.45)'));
      },
      big(ctx, x0, y0, w) {
        const u = w;
        lotusFlower(ctx, x0 + u * 0.84, y0 + u * 0.2, u * 0.16);
        leaf(ctx, x0 + u * 0.68, y0 + u * 0.34, u * 0.1, -1.6, 'rgba(110,160,120,0.85)');
      },
    },
  };
  const MEMORIAL_FEST = { '3,5': 'leifeng', '5,12': 'disaster', '7,1': 'hkreturn', '7,7': 'qiqi', '9,3': 'victory', '9,18': 'jiuyiba', '9,30': 'martyrs', '12,13': 'gongji', '12,20': 'macau' };

  // 当天命中的主题；无命中返回 null（用默认蓝渐变）。
  // memorial=true 时纪念日主题优先于同日节日主题（如 7/1 香港回归纪念日优先于建党节）
  function resolveTheme(date, memorial = false) {
    const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
    if (m === 5 && d === 1 + ((0 - new Date(y, 4, 1).getDay() + 7) % 7) + 7) return THEMES.mother; // 5月第二个周日
    if (m === 6 && d === 1 + ((0 - new Date(y, 5, 1).getDay() + 7) % 7) + 14) return THEMES.father; // 6月第三个周日
    if (m === 11 && d === 1 + ((4 - new Date(y, 10, 1).getDay() + 7) % 7) + 21) return THEMES.thanksgiving; // 11月第四个周四
    if (memorial) {
      const mem = MEMORIAL_FEST[`${m},${d}`];
      if (mem) return MEMORIALS[mem];
    }
    const fest = SOLAR_FEST[`${m},${d}`];
    if (fest) return THEMES[fest];
    const lun = solarToLunar(y, m, d);
    if (lun) {
      if (!lun.isLeap && lun.month === 12 && lun.day === lunarMonthDays(lun.year, 12)) return THEMES.chuxi; // 除夕
      if (!lun.isLeap) {
        const lf = LUNAR_FEST[`${lun.month},${lun.day}`];
        if (lf) return THEMES[lf];
      }
    }
    const n = m * 2 - 2; // 当月两个节气的下标
    if (termDay(y, n) === d) return TERM_THEMES[n];
    if (termDay(y, n + 1) === d) return TERM_THEMES[n + 1];
    return null;
  }

  // 统一按"两个开关"解析当天主题：memorial 开启时纪念日优先，festival 关闭则只看纪念日。
  // 划线分享卡片、截图合成与设置页自动标签共用，避免各调用点重复纪念日分支
  function resolveDayTheme(date, { festival = true, memorial = false } = {}) {
    const m = date.getMonth() + 1, d = date.getDate();
    if (memorial) {
      const mem = MEMORIAL_FEST[`${m},${d}`];
      if (mem) return MEMORIALS[mem];
    }
    return festival ? resolveTheme(date) : null;
  }

  // 带主题的渐变底 + 角落装饰；无主题时与旧版逐像素一致
  function paintBackdrop(ctx, W, H, s = 1, theme = null) {
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, theme ? theme.grad[0] : '#eef3ff');
    bg.addColorStop(1, theme ? theme.grad[1] : '#f9fbff');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    if (theme && theme.deco) { theme.deco(ctx, 0, 0, W, H, s); return; }
    ctx.fillStyle = 'rgba(79,110,247,0.08)';
    ctx.beginPath(); ctx.arc(W - 40 * s, 40 * s, 130 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(47,107,255,0.06)';
    ctx.beginPath(); ctx.arc(30 * s, H - 30 * s, 100 * s, 0, Math.PI * 2); ctx.fill();
  }

  // 白卡内铺一层 7% 透明度的同款装饰水印：必须在 paintWhiteCard 之后、内容绘制之前调用
  function paintCardAccent(ctx, theme, x, y, w, h, r, s = 1) {
    if (!theme || !theme.deco) return;
    ctx.save();
    roundRectPath(ctx, x, y, w, h, r);
    ctx.clip();
    ctx.globalAlpha = 0.07;
    theme.deco(ctx, x, y, w, h, s);
    ctx.restore();
  }

  // 大图标：≥画面宽度 1/4 的主题主图标，25% 不透明度压在白卡上、正文之下。
  // 白卡不透明，装饰只画在卡下的话最多露出边缘几十像素，所以主图标必须叠在卡上；
  // 正文文字在其后绘制，永远压在图标上方，可读性不受影响。必须在 paintWhiteCard
  // 之后、正文文字之前调用；截图合成里截图图片会盖住卡内部分，图标只在页眉/页脚
  // 留白与外圈边缘露出，属预期。
  function paintThemeIcon(ctx, theme, W, H, s = 1) {
    if (!theme || !theme.big) return;
    ctx.save();
    ctx.globalAlpha = 0.25;
    theme.big(ctx, 0, 0, W, H, s);
    ctx.restore();
  }

  // 设置页预览选择器的候选：节日在前、节气在后、纪念日居中
  const THEME_LIST = [...Object.values(THEMES), ...Object.values(MEMORIALS), ...TERM_THEMES];

  // 主题在指定公历年份的实际日期文案（'M月D日'，设置页选择器展示用）；无法计算返回 ''。
  // 农历节日的「当年日期」按公历年逐日扫描命中（腊八这类农历年末节日会落在次年初，
  // 用户口径是"今年过的那次"），结果按年缓存
  const _lunarDatesCache = new Map(); // year -> Map('农历m,d' 或 'chuxi' -> 'M月D日')
  function lunarDatesInYear(year) {
    let map = _lunarDatesCache.get(year);
    if (map) return map;
    map = new Map();
    for (let day = 1; day <= 366; day++) {
      const dt = new Date(year, 0, day);
      if (dt.getFullYear() !== year) break;
      const lun = solarToLunar(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
      if (lun && !lun.isLeap) {
        if (lun.month === 12 && lun.day === lunarMonthDays(lun.year, 12) && !map.has('chuxi')) map.set('chuxi', `${dt.getMonth() + 1}月${dt.getDate()}日`);
        const key = `${lun.month},${lun.day}`;
        if (!map.has(key)) map.set(key, `${dt.getMonth() + 1}月${dt.getDate()}日`);
      }
    }
    _lunarDatesCache.set(year, map);
    return map;
  }
  function themeDateInYear(theme, year = new Date().getFullYear()) {
    const w = theme && theme.when;
    if (!w) return '';
    if (w.term != null) return `${Math.floor(w.term / 2) + 1}月${termDay(year, w.term)}日`;
    if (w.solar) return `${w.solar[0]}月${w.solar[1]}日`;
    if (w.mother) return `5月${1 + ((0 - new Date(year, 4, 1).getDay() + 7) % 7) + 7}日`; // 5月第二个周日
    if (w.father) return `6月${1 + ((0 - new Date(year, 5, 1).getDay() + 7) % 7) + 14}日`; // 6月第三个周日
    if (w.thanksgiving) return `11月${1 + ((4 - new Date(year, 10, 1).getDay() + 7) % 7) + 21}日`; // 11月第四个周四
    if (w.lunar || w.chuxi) return lunarDatesInYear(year).get(w.chuxi ? 'chuxi' : `${w.lunar[0]},${w.lunar[1]}`) || '';
    return '';
  }

  // 主题包图片整体平均色（按 1x1 缩绘取样），用于海报外留白的底色延伸
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

  // 用 Canvas 绘制金句卡片，返回 dataURL(2x)。
  // festive=false 关掉节日/节气背景；memorial 开启纪念日主题（优先于节日）；
  // themeId 指定主题名（设置页预览用，优先级最高）；
  // defaultTheme 是无命中时的兜底风格名（card_default_theme 设置）；
  // packArt 为主题包（DLC）背景：显式传 { name, label, img }（设置页预览）或不传走自动路径
  // 读 themepacks.js 发布的 __acThemePack；优先级：显式 themeId > 主题包 > 节日/节气 > 默认。
  function drawShareCard({ text, title, site, url, festive = true, memorial = false, themeId = '', defaultTheme = '', packArt }) {
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
      ctx.fillStyle = 'rgba(255,255,255,0.93)';
      ctx.shadowColor = 'rgba(31,36,48,0.12)';
      ctx.shadowBlur = 24;
      ctx.shadowOffsetY = 8;
      // 面板底部锚定（贴卡片底边 28px），高度贴合内容
      roundRectPath(ctx, cx, panelTop, cw, H - 28 - panelTop, r);
      ctx.fill();
      ctx.restore();
    } else {
      paintBackdrop(ctx, W, H, 1, theme);
      paintWhiteCard(ctx, cx, cy, cw, ch, r, 24, 8);
      paintCardAccent(ctx, theme, cx, cy, cw, ch, r, 1);
      paintThemeIcon(ctx, theme, W, H, 1);
    }

    // 顶部品牌条：蓝点 + AnyComment 划线分享（主题包版式落在面板顶部，右侧加日期·条目名）
    const brandY = usePack ? panelTop + 44 : cy + 44;
    ctx.fillStyle = '#2f6bff';
    ctx.beginPath(); ctx.arc(cx + 30, brandY, 7, 0, Math.PI * 2); ctx.fill();
    ctx.font = fontMain(15, 500);
    ctx.fillStyle = '#8a90a5';
    ctx.textBaseline = 'middle';
    ctx.fillText('AnyComment · 划线分享', cx + 46, brandY + 1);
    if (usePack) {
      ctx.textAlign = 'right';
      ctx.fillText(pack.label || pack.name, W - PAD, brandY + 1);
      ctx.textAlign = 'left';
    }

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
  function composeScreenshot({ img, dataUrl, url, time = Date.now(), opts = {} }) {
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
    // 优先级与金句卡片一致：显式 theme_id > 主题包 > 节日/节气 > 默认风格
    let packArt = null;
    if (o.card_pack_shot_bg === true && !o.theme_id) {
      const dayPack = globalThis.__acThemePack || null;
      if (dayPack && dayPack.img) {
        packArt = dayPack;
      } else if (o.card_default_theme && o.card_default_theme.startsWith('pack_') && globalThis.__acThemePacks) {
        // 默认风格指向包条目时作为兜底（entrySync 带开关守卫，包关闭即 null）
        const ci = o.card_default_theme.indexOf(':');
        const d = globalThis.__acThemePacks.entrySync(o.card_default_theme.slice(5, ci), o.card_default_theme.slice(ci + 1));
        if (d && d.img) packArt = d;
      }
    }
    if (!qr && !brand && !when && !theme && !packArt) return dataUrl;

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
    if (packArt) {
      // 背景去色 90%（saturate 0.1）满铺，截图以正片叠底（multiply）贴上：
      // 截图浅色区域透出去色花纹，深色内容保持——不透明、无空洞
      ctx.save();
      ctx.filter = 'saturate(0.1)';
      const bs = Math.max(plan.outW / packArt.img.naturalWidth, plan.outH / packArt.img.naturalHeight);
      const biw = packArt.img.naturalWidth * bs, bih = packArt.img.naturalHeight * bs;
      ctx.drawImage(packArt.img, (plan.outW - biw) / 2, (plan.outH - bih) / 2, biw, bih);
      ctx.restore();
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
    if (packArt) {
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
      if (packArt) {
        ctx.font = fontMain(plan.fs1, 600);
        const bw = ctx.measureText(wrapText(ctx, brand, plan.maxBrand, 1)[0] || '').width;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
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
      if (packArt) {
        const tw = ctx.measureText(t).width;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
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
      } else if (packArt) {
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
    .ac-share-actions { display: flex; gap: 10px; }
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
    root.querySelector('.ac-share-mask')?.remove();
    const mask = document.createElement('div');
    mask.className = 'ac-share-mask';
    const box = document.createElement('div');
    box.className = 'ac-share-card-box';
    const img = document.createElement('img');
    img.className = 'ac-share-img';
    img.src = dataUrl;
    img.alt = opts.alt || '分享卡片预览';
    // 图片可被扩展操作替换（如截图主题包背景快捷开关重合成），复制/下载始终取当前图
    let curUrl = dataUrl;
    const updateImg = (u) => { curUrl = u; img.src = u; };
    const acts = document.createElement('div');
    acts.className = 'ac-share-actions';
    const btnDl = document.createElement('button');
    btnDl.className = 'ac-share-btn ac-share-primary';
    btnDl.textContent = '下载图片';
    btnDl.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = curUrl;
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
        await copyImageToClipboard(curUrl);
        btnCopy.textContent = '已复制 ✓';
      } catch {
        btnCopy.textContent = '复制失败，请下载';
      }
    });
    const btnClose = document.createElement('button');
    btnClose.className = 'ac-share-btn ac-share-close';
    btnClose.textContent = '关闭';
    // 关闭统一走 close()：顺带移除 Esc 监听，避免浮层关了监听还在
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey, true);
    function close() {
      mask.remove();
      window.removeEventListener('keydown', onKey, true);
    }
    btnClose.addEventListener('click', close);
    // 扩展操作按钮（如截图的主题包背景快捷开关）：onClick(updateImg) 返回字符串则更新按钮文案
    for (const act of opts.actions || []) {
      const b = document.createElement('button');
      b.className = 'ac-share-btn ac-share-ghost';
      b.textContent = act.label;
      b.addEventListener('click', async () => {
        try {
          const nl = await act.onClick(updateImg);
          if (typeof nl === 'string') b.textContent = nl;
        } catch (e) { /* 失败保持原文案 */ }
      });
      acts.append(b);
    }
    acts.append(btnDl, btnCopy, btnClose);
    box.append(img, acts);
    mask.append(box);
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    root.appendChild(mask);
  }

  globalThis.__acCard = {
    SHOT_DEFAULTS,
    fontMain,
    wrapText,
    cleanUrlForQr,
    buildQrMatrix,
    roundRectPath,
    drawQrModules,
    paintBackdrop,
    paintWhiteCard,
    paintCardAccent,
    resolveTheme,
    resolveDayTheme,
    themeDateInYear,
    THEME_LIST,
    fmtShotTime,
    drawShareCard,
    composeScreenshot,
    planShot,
    showPreview,
    PREVIEW_CSS,
  };
})();
