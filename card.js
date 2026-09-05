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
    card_default_theme: '', // 当天无命中时的兜底风格：''=默认蓝渐变，或节日主题名（关掉节日开关时它就是常驻风格）
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
  // 按当天日期命中，优先级：公历节日 > 农历节日/除夕 > 二十四节气 > 默认蓝渐变。
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

  // 公历节日（'月,日' -> 主题 id）；母亲节=5月第二个周日，在 resolveTheme 里现算
  const SOLAR_FEST = { '1,1': 'newyear', '2,14': 'valentine', '3,8': 'women', '5,1': 'labor', '5,4': 'youth', '6,1': 'children', '9,10': 'teacher', '10,1': 'national', '12,24': 'christmaseve', '12,25': 'christmas' };
  // 农历节日（'月,日' -> 主题 id）；除夕单独判「腊月最后一天」
  const LUNAR_FEST = { '1,1': 'spring', '1,15': 'lantern', '5,5': 'dragonboat', '7,7': 'qixi', '8,15': 'midautumn', '9,9': 'double9', '12,8': 'laba' };

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
  function lantern(ctx, x, y, w, h, body = '#e8443a') {
    const gold = '#e7c463';
    ctx.save();
    ctx.strokeStyle = gold; ctx.lineWidth = Math.max(1, w * 0.05); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y - h * 1.05); ctx.lineTo(x, y - h * 0.5); ctx.stroke(); // 挂绳
    ctx.fillStyle = gold;
    ctx.fillRect(x - w * 0.18, y - h * 0.58, w * 0.36, h * 0.1); // 上盖
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.ellipse(x, y, w * 0.5, h * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath(); ctx.ellipse(x - w * 0.16, y - h * 0.12, w * 0.14, h * 0.2, -0.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = gold;
    ctx.fillRect(x - w * 0.14, y + h * 0.48, w * 0.28, h * 0.07); // 下盖
    ctx.beginPath(); ctx.moveTo(x, y + h * 0.55); ctx.lineTo(x, y + h * 0.82); ctx.stroke(); // 流苏
    ctx.restore();
  }
  function balloon(ctx, x, y, r, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.ellipse(x, y, r * 0.82, r, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.ellipse(x - r * 0.25, y - r * 0.3, r * 0.18, r * 0.28, -0.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(31,36,48,0.25)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y + r); ctx.quadraticCurveTo(x + r * 0.3, y + r * 2.1, x, y + r * 3.2); ctx.stroke();
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
  function leaf(ctx, x, y, len, rot, color, a = 1) {
    ctx.save(); ctx.globalAlpha *= a; ctx.fillStyle = color;
    ctx.translate(x, y); ctx.rotate(rot);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(len * 0.5, -len * 0.32, len, 0);
    ctx.quadraticCurveTo(len * 0.5, len * 0.32, 0, 0);
    ctx.fill(); ctx.restore();
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
  // 圣诞帽：(x,y) 为帽底中心，w 宽 h 高，rot 旋转；红帽身 + 白绒帽边 + 右垂帽尖绒球
  function santaHat(ctx, x, y, w, h, rot = 0) {
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
    ctx.fillStyle = '#ffffff';
    roundRectPath(ctx, -w * 0.55, -bandH / 2, w * 1.05, bandH, bandH / 2);
    ctx.fill();
    ctx.beginPath(); ctx.arc(w * 0.4, -h * 0.55, w * 0.14, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 苹果（平安果）：双圆果身带顶凹 + 高光 + 果柄绿叶
  function apple(ctx, x, y, r, body = '#d64545') {
    ctx.save();
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(x - r * 0.36, y + r * 0.08, r * 0.76, 0, Math.PI * 2);
    ctx.arc(x + r * 0.36, y + r * 0.08, r * 0.76, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.ellipse(x - r * 0.3, y - r * 0.12, r * 0.16, r * 0.26, -0.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#8a5a3d'; ctx.lineWidth = Math.max(1, r * 0.13); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y - r * 0.55); ctx.quadraticCurveTo(x + r * 0.1, y - r * 0.95, x + r * 0.3, y - r * 1.1); ctx.stroke();
    leaf(ctx, x + r * 0.5, y - r * 0.9, r * 0.62, -0.7, '#4a9e5a');
    ctx.restore();
  }

  // ----- 二十四节气主题：每个节气独立渐变配色 + 当季装饰（种子取节气下标，重绘稳定）-----
  // kind: plum 小寒大寒梅花 | sprout 嫩芽 | rain 雨丝 | petal 春花瓣 | qingming 清明雨柳
  //       leaf 秋叶 | wheat 麦穗 | sun 盛夏烈日 | dew 白露寒露露珠 | frost 霜 | snow 冬雪
  const TERM_STYLE = [
    ['#dbe7f2', '#f5f9fc', 'plum'],  ['#d8e6f0', '#f4f8fb', 'plum'],
    ['#dff0e2', '#f6fbf6', 'sprout'], ['#d5e9f2', '#f3f9fc', 'rain'],
    ['#e0f0dd', '#f7fcf4', 'sprout'], ['#fde9ef', '#fff8fa', 'petal'],
    ['#e2ead9', '#f8faf4', 'qingming'], ['#dcefe0', '#f7fcf8', 'rain'],
    ['#dcf0d9', '#f7fdf5', 'leaf'],  ['#f4ecc9', '#fdfaf0', 'wheat'],
    ['#f0e6bd', '#fcf9ef', 'wheat'], ['#fdeebe', '#fffbf0', 'sun'],
    ['#fbe3c0', '#fef9f2', 'sun'],   ['#fbdcb4', '#fef8f0', 'sun'],
    ['#f6e8c8', '#fdf9f0', 'leaf'],  ['#f5dfb6', '#fdf7ec', 'leaf'],
    ['#e3eef0', '#f8fcfd', 'dew'],   ['#f6e3c0', '#fdf8ee', 'leaf'],
    ['#f0dcc8', '#fbf4ee', 'dew'],   ['#f2e0d0', '#fcf6f1', 'frost'],
    ['#e0e8ee', '#f7fafc', 'snow'],  ['#dfe8ef', '#f6fafc', 'snow'],
    ['#d7e3ee', '#f4f8fb', 'snow'],  ['#dde7f0', '#f6f9fc', 'snow'],
  ];
  const SEASON_DECO = {
    plum(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      blossom(ctx, x0 + w - b * 0.08, y0 + b * 0.09, b * 0.045, '#f2a7b3');
      blossom(ctx, x0 + w - b * 0.16, y0 + b * 0.15, b * 0.03, '#ee97a5', '#fff', 0.8);
      blossom(ctx, x0 + b * 0.07, y0 + h - b * 0.08, b * 0.038, '#f2a7b3', '#fff', 0.9);
      cornerScatter(ctx, x0, y0, w, h, 6, seed, (c, x, y, rng) => petal(c, x, y, b * 0.012, rng() * Math.PI, 'rgba(242,167,179,0.6)'));
      cornerScatter(ctx, x0, y0, w, h, 5, seed + 1, (c, x, y, rng) => flake(c, x, y, b * 0.02, 'rgba(122,160,199,0.55)'));
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
    petal(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      cornerScatter(ctx, x0, y0, w, h, 12, seed, (c, x, y, rng) => petal(c, x, y, b * (0.012 + rng() * 0.012), rng() * Math.PI, rng() > 0.4 ? 'rgba(244,167,191,0.7)' : 'rgba(250,205,220,0.6)'));
      blossom(ctx, x0 + w - b * 0.07, y0 + b * 0.07, b * 0.035, '#f4a7bf', '#fff', 0.85);
    },
    qingming(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      cloud(ctx, x0 + w - b * 0.1, y0 + b * 0.07, b * 0.12, 'rgba(150,168,150,0.45)');
      cornerScatter(ctx, x0, y0, w, h, 8, seed, (c, x, y, rng) => raindrop(c, x, y, b * (0.018 + rng() * 0.018), 'rgba(122,160,145,0.55)'));
      leaf(ctx, x0 + b * 0.06, y0 + h - b * 0.07, b * 0.09, -0.7, 'rgba(139,170,120,0.7)');
      leaf(ctx, x0 + b * 0.12, y0 + h - b * 0.05, b * 0.07, -1.2, 'rgba(139,170,120,0.5)');
    },
    leaf(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      const cols = ['rgba(224,146,73,0.7)', 'rgba(206,178,88,0.7)', 'rgba(196,110,60,0.6)'];
      cornerScatter(ctx, x0, y0, w, h, 10, seed, (c, x, y, rng) => leaf(c, x, y, b * (0.035 + rng() * 0.03), rng() * Math.PI * 2, cols[Math.floor(rng() * cols.length)]));
      leaf(ctx, x0 + w - b * 0.09, y0 + b * 0.08, b * 0.06, 0.8, 'rgba(224,146,73,0.8)');
    },
    wheat(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      wheat(ctx, x0 + w - b * 0.07, y0 + b * 0.1, b * 0.11, 0.5, 'rgba(196,164,80,0.75)');
      wheat(ctx, x0 + b * 0.08, y0 + h - b * 0.08, b * 0.09, -2.4, 'rgba(196,164,80,0.6)');
      cornerScatter(ctx, x0, y0, w, h, 6, seed, (c, x, y, rng) => petal(c, x, y, b * 0.01, rng() * Math.PI, 'rgba(214,188,110,0.55)'));
    },
    sun(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      sunDeco(ctx, x0 + w - b * 0.07, y0 + b * 0.08, b * 0.06, '#f7c46b');
      cornerScatter(ctx, x0, y0, w, h, 5, seed, (c, x, y, rng) => star4(c, x, y, b * 0.008, 'rgba(247,196,107,0.7)'));
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
    frost(ctx, x0, y0, w, h, s, seed) {
      const b = Math.min(w, h) * s;
      cornerScatter(ctx, x0, y0, w, h, 14, seed, (c, x, y, rng) => star4(c, x, y, b * (0.004 + rng() * 0.006), 'rgba(255,255,255,0.9)', 0.9));
      leaf(ctx, x0 + w - b * 0.09, y0 + b * 0.08, b * 0.07, 0.9, 'rgba(205,140,90,0.65)');
      flake(ctx, x0 + b * 0.07, y0 + h - b * 0.07, b * 0.02, 'rgba(255,255,255,0.8)');
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
  };
  const TERM_THEMES = TERM_NAMES.map((name, i) => ({
    name, isTerm: true, when: { term: i },
    grad: [TERM_STYLE[i][0], TERM_STYLE[i][1]],
    deco: TERM_STYLE[i][2] === 'snow' && i === 22
      ? (ctx, x0, y0, w, h, s) => SEASON_DECO.snow(ctx, x0, y0, w, h, s, i, 1.8) // 大雪最密
      : (ctx, x0, y0, w, h, s) => SEASON_DECO[TERM_STYLE[i][2]](ctx, x0, y0, w, h, s, i),
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
    },
    spring: {
      name: '春节', when: { lunar: [1, 1] }, grad: ['#a61b1b', '#d95436'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        lantern(ctx, x0 + w - b * 0.1, y0 + b * 0.14, b * 0.085, b * 0.1);
        lantern(ctx, x0 + w - b * 0.03, y0 + b * 0.055, b * 0.055, b * 0.066);
        lantern(ctx, x0 + b * 0.09, y0 + h - b * 0.11, b * 0.07, b * 0.084);
        cornerScatter(ctx, x0, y0, w, h, 10, 7, (c, x, y, rng) => star4(c, x, y, b * (0.005 + rng() * 0.007), 'rgba(255,217,138,0.9)'));
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
        lantern(ctx, x0 + b * 0.08, y0 + h - b * 0.14, b * 0.065, b * 0.078);
        cornerScatter(ctx, x0, y0, w, h, 8, 8, (c, x, y, rng) => star4(c, x, y, b * (0.005 + rng() * 0.007), 'rgba(255,217,138,0.9)'));
      },
    },
    lantern: {
      name: '元宵', when: { lunar: [1, 15] }, grad: ['#8a2f52', '#d96c6c'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        lantern(ctx, x0 + w - b * 0.09, y0 + b * 0.12, b * 0.075, b * 0.09, '#f0605a');
        lantern(ctx, x0 + b * 0.08, y0 + h - b * 0.1, b * 0.065, b * 0.078, '#f08a5a');
        // 汤圆：白胖小圆 + 淡影
        cornerScatter(ctx, x0, y0, w, h, 4, 9, (c, x, y) => {
          c.save(); c.fillStyle = 'rgba(31,36,48,0.12)';
          c.beginPath(); c.ellipse(x, y + b * 0.017, b * 0.017, b * 0.005, 0, 0, Math.PI * 2); c.fill();
          c.fillStyle = '#fffaf2';
          c.beginPath(); c.arc(x, y, b * 0.016, 0, Math.PI * 2); c.fill(); c.restore();
        });
        cornerScatter(ctx, x0, y0, w, h, 8, 10, (c, x, y, rng) => star4(c, x, y, b * (0.005 + rng() * 0.006), 'rgba(255,225,170,0.85)'));
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
    },
    women: {
      name: '妇女节', when: { solar: [3, 8] }, grad: ['#a86ed6', '#e3c1ef'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        blossom(ctx, x0 + w - b * 0.08, y0 + b * 0.09, b * 0.05, '#f0e0f7', '#d6a2e8');
        blossom(ctx, x0 + b * 0.08, y0 + h - b * 0.08, b * 0.042, '#f7e6fb', '#d6a2e8', 0.9);
        cornerScatter(ctx, x0, y0, w, h, 8, 14, (c, x, y, rng) => petal(c, x, y, b * (0.012 + rng() * 0.01), rng() * Math.PI, 'rgba(255,255,255,0.6)'));
      },
    },
    labor: {
      name: '劳动节', when: { solar: [5, 1] }, grad: ['#e09b3d', '#f3ce8a'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        sunDeco(ctx, x0 + w - b * 0.08, y0 + b * 0.09, b * 0.055, '#f7c46b');
        const cols = ['#ffffff', '#f7e6b0', '#e88a5a'];
        cornerScatter(ctx, x0, y0, w, h, 8, 15, (c, x, y, rng) => confetti(c, x, y, b * (0.013 + rng() * 0.01), rng() * Math.PI, cols[Math.floor(rng() * cols.length)], 0.8));
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
    },
    mother: {
      name: '母亲节', when: { mother: true }, grad: ['#e88a9a', '#f7c9c1'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        blossom(ctx, x0 + w - b * 0.08, y0 + b * 0.09, b * 0.05, '#f7b3c1', '#e86a8a');
        blossom(ctx, x0 + b * 0.08, y0 + h - b * 0.08, b * 0.042, '#f7b3c1', '#e86a8a', 0.9);
        cornerScatter(ctx, x0, y0, w, h, 8, 19, (c, x, y, rng) => petal(c, x, y, b * (0.012 + rng() * 0.01), rng() * Math.PI, 'rgba(255,255,255,0.65)'));
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
    },
    teacher: {
      name: '教师节', when: { solar: [9, 10] }, grad: ['#d99a3d', '#f3d9a0'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        blossom(ctx, x0 + w - b * 0.08, y0 + b * 0.09, b * 0.048, '#f7d9a0', '#e8a84a');
        blossom(ctx, x0 + b * 0.08, y0 + h - b * 0.08, b * 0.04, '#f7d9a0', '#e8a84a', 0.9);
        cornerScatter(ctx, x0, y0, w, h, 7, 22, (c, x, y, rng) => star4(c, x, y, b * (0.005 + rng() * 0.006), 'rgba(255,255,255,0.85)'));
      },
    },
    national: {
      name: '国庆节', when: { solar: [10, 1] }, grad: ['#b01f1f', '#e0663c'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        firework(ctx, x0 + w - b * 0.12, y0 + b * 0.11, b * 0.055, 'rgba(255,217,138,0.9)');
        firework(ctx, x0 + b * 0.1, y0 + h - b * 0.1, b * 0.042, 'rgba(255,217,138,0.7)');
        cornerScatter(ctx, x0, y0, w, h, 8, 23, (c, x, y, rng) => star4(c, x, y, b * (0.006 + rng() * 0.008), '#ffd98a', 0.9));
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
    },
    double9: {
      name: '重阳节', when: { lunar: [9, 9] }, grad: ['#c97b3d', '#f0b97a'],
      deco(ctx, x0, y0, w, h, s) {
        const b = Math.min(w, h) * s;
        blossom(ctx, x0 + w - b * 0.08, y0 + b * 0.09, b * 0.05, '#f7c9a0', '#e8934a'); // 菊
        blossom(ctx, x0 + b * 0.08, y0 + h - b * 0.08, b * 0.042, '#f7c9a0', '#e8934a', 0.9);
        cornerScatter(ctx, x0, y0, w, h, 7, 25, (c, x, y, rng) => leaf(c, x, y, b * (0.03 + rng() * 0.025), rng() * Math.PI * 2, 'rgba(196,110,60,0.55)'));
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
    },
  };

  // 当天命中的主题；无命中返回 null（用默认蓝渐变）
  function resolveTheme(date) {
    const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
    if (m === 5 && d === 1 + ((0 - new Date(y, 4, 1).getDay() + 7) % 7) + 7) return THEMES.mother; // 5月第二个周日
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

  // 设置页预览选择器的候选：节日在前、节气在后
  const THEME_LIST = [...Object.values(THEMES), ...TERM_THEMES];

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
    if (w.lunar || w.chuxi) return lunarDatesInYear(year).get(w.chuxi ? 'chuxi' : `${w.lunar[0]},${w.lunar[1]}`) || '';
    return '';
  }

  // 用 Canvas 绘制金句卡片，返回 dataURL(2x)。
  // festive=false 关掉节日/节气背景；themeId 指定主题名（设置页预览用，优先级最高）；
  // defaultTheme 是无命中时的兜底风格名（card_default_theme 设置）
  function drawShareCard({ text, title, site, url, festive = true, themeId = '', defaultTheme = '' }) {
    const theme = themeId ? (THEME_LIST.find((t) => t.name === themeId) || null)
      : ((festive === false ? null : resolveTheme(new Date()))
        || (defaultTheme ? THEME_LIST.find((t) => t.name === defaultTheme) || null : null));
    const W = 720, PAD = 56, DPR = 2;
    // 先用离屏 canvas 测量文字行数
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = fontMain(30);
    const lines = wrapText(meas, text, W - PAD * 2, 10);
    const lineH = 48;
    const quoteTop = 150;
    const dividerY = quoteTop + lines.length * lineH + 4; // 出处区上方的分隔线

    // 二维码模块边长取整像素（半格会糊出灰边，手机识别率骤降），静默区 2 模块
    const qr = buildQrMatrix(url);
    const QR_QUIET = 2;
    const qrCount = qr ? qr.getModuleCount() : 0;
    const qrTotal = qrCount + QR_QUIET * 2;
    const qrCell = qr ? Math.max(3, Math.min(4, Math.floor(104 / qrTotal))) : 0;
    const qrPx = qrCell * qrTotal;
    const qrTop = dividerY + 14;
    const qrLeft = W - PAD - qrPx;
    const hintY = qrTop + qrPx + 17;
    const srcTitleY = dividerY + 18;
    const srcDomainY = dividerY + 44;
    const H = dividerY + (qr ? Math.max(64, hintY - dividerY + 9) : 64) + 34; // 卡片底边 = H - 28

    const canvas = document.createElement('canvas');
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    const ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);

    // 渐变底 + 装饰 + 白色圆角卡片（卡内再铺同款装饰的淡水印）
    const cx = 28, cy = 28, cw = W - 56, ch = H - 56, r = 20;
    paintBackdrop(ctx, W, H, 1, theme);
    paintWhiteCard(ctx, cx, cy, cw, ch, r, 24, 8);
    paintCardAccent(ctx, theme, cx, cy, cw, ch, r, 1);

    // 顶部品牌条：蓝点 + AnyComment 划线分享
    ctx.fillStyle = '#2f6bff';
    ctx.beginPath(); ctx.arc(cx + 30, cy + 44, 7, 0, Math.PI * 2); ctx.fill();
    ctx.font = fontMain(15, 500);
    ctx.fillStyle = '#8a90a5';
    ctx.textBaseline = 'middle';
    ctx.fillText('AnyComment · 划线分享', cx + 46, cy + 45);

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
      : ((o.card_festival_bg === false ? null : resolveTheme(new Date(time)))
        || (o.card_default_theme ? THEME_LIST.find((t) => t.name === o.card_default_theme) || null : null));
    if (!qr && !brand && !when && !theme) return dataUrl;

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
    paintBackdrop(ctx, plan.outW, plan.outH, plan.s, theme);
    paintWhiteCard(
      ctx, plan.cardX, plan.cardY, plan.cardW, plan.cardH, plan.radius,
      Math.max(6, Math.round(24 * plan.s)), Math.max(2, Math.round(8 * plan.s))
    );
    paintCardAccent(ctx, theme, plan.cardX, plan.cardY, plan.cardW, plan.cardH, plan.radius, plan.s);

    // 截图裁成圆角贴在白卡上，再描一圈淡边，免得浅色画面与白卡糊成一片
    ctx.save();
    roundRectPath(ctx, plan.imgX, plan.imgY, W, H, plan.imgRadius);
    ctx.clip();
    ctx.drawImage(img, plan.imgX, plan.imgY, W, H);
    ctx.restore();
    ctx.strokeStyle = '#e6e9f2';
    ctx.lineWidth = Math.max(1, Math.round(plan.s));
    roundRectPath(ctx, plan.imgX, plan.imgY, W, H, plan.imgRadius);
    ctx.stroke();

    // 顶部留白：蓝点 + 品牌靠左，拍摄时间靠右，同一行两端对齐
    ctx.textBaseline = 'middle';
    if (brand) {
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
      ctx.fillStyle = '#8a90a5';
      const t = wrapText(ctx, when, plan.maxWhen, 1)[0] || '';
      ctx.fillText(t, plan.textRight - ctx.measureText(t).width, plan.rowY);
    }

    // 二维码：整像素模块 + 下方提示文字。底就是白卡/白底板，不必再垫白底
    if (qr && plan.cell > 0) {
      if (plan.mode === 'overlay') {
        paintWhiteCard(
          ctx, plan.bx, plan.by, plan.bw, plan.bh, plan.radius,
          Math.max(3, Math.round(12 * plan.s)), Math.max(1, Math.round(2 * plan.s)), 'rgba(31,36,48,0.18)'
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
    const acts = document.createElement('div');
    acts.className = 'ac-share-actions';
    const btnDl = document.createElement('button');
    btnDl.className = 'ac-share-btn ac-share-primary';
    btnDl.textContent = '下载图片';
    btnDl.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = dataUrl;
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
        await copyImageToClipboard(dataUrl);
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
