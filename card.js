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

  // 用 Canvas 绘制金句卡片，返回 dataURL(2x)
  function drawShareCard({ text, title, site, url }) {
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

    // 渐变底 + 装饰圆 + 白色圆角卡片
    const cx = 28, cy = 28, cw = W - 56, ch = H - 56, r = 20;
    paintBackdrop(ctx, W, H);
    paintWhiteCard(ctx, cx, cy, cw, ch, r, 24, 8);

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
    if (!qr && !brand && !when) return dataUrl;

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
    paintBackdrop(ctx, plan.outW, plan.outH, plan.s);
    paintWhiteCard(
      ctx, plan.cardX, plan.cardY, plan.cardW, plan.cardH, plan.radius,
      Math.max(6, Math.round(24 * plan.s)), Math.max(2, Math.round(8 * plan.s))
    );

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
    fmtShotTime,
    drawShareCard,
    composeScreenshot,
    planShot,
    showPreview,
    PREVIEW_CSS,
  };
})();
