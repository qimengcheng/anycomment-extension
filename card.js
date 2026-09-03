// AnyComment 共享绘制模块：金句卡片、截图合成原语、预览浮层
// 与 content.js / capture.js 同在 content_scripts 隔离世界（manifest 按序加载），用全局 __acCard 交换
(() => {
  // 截图设置的默认值：options 页与 capture.js 共用的唯一来源
  const SHOT_DEFAULTS = {
    shot_qr: true,
    shot_time: true,
    shot_brand: true,
    shot_qr_overlay: true,
    shot_qr_corner: 'br', // tl | tr | bl | br，仅覆盖模式生效
    shot_default_mode: 'viewport', // selection | viewport | fullpage
  };

  const fontMain = (size, weight = 600) => `${weight} ${size}px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;

  // 按最大宽度对文本做换行拆分（逐字测量，兼容中英文混排）
  function wrapText(ctx, text, maxWidth, maxLines) {
    const lines = [];
    let line = '';
    for (const ch of text) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = ch;
        if (lines.length >= maxLines) { lines[maxLines - 1] = lines[maxLines - 1].replace(/\s+$/, '') + '…'; return lines; }
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  // 生成网址二维码：库内部读取的是模块级 qrcode.stringToBytes（挂在实例上无效），
  // UTF-8 才能正确编码中文路径；网址过长时降低纠错率以控制二维码尺寸
  function buildQrMatrix(url) {
    if (!url || typeof qrcode !== 'function' || !qrcode.stringToBytesFuncs) return null;
    try {
      qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
      let qr = null;
      for (const ecl of ['M', 'L']) {
        qr = qrcode(0, ecl); // typeNumber 0 = 自动选尺寸
        qr.addData(String(url), 'Byte');
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

    // 渐变底 + 装饰圆
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#eef3ff');
    bg.addColorStop(1, '#f9fbff');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(79,110,247,0.08)';
    ctx.beginPath(); ctx.arc(W - 40, 40, 130, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(47,107,255,0.06)';
    ctx.beginPath(); ctx.arc(30, H - 30, 100, 0, Math.PI * 2); ctx.fill();

    // 白色圆角卡片
    const cx = 28, cy = 28, cw = W - 56, ch = H - 56, r = 20;
    ctx.save();
    ctx.shadowColor = 'rgba(31,36,48,0.10)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(cx + r, cy);
    ctx.arcTo(cx + cw, cy, cx + cw, cy + ch, r);
    ctx.arcTo(cx + cw, cy + ch, cx, cy + ch, r);
    ctx.arcTo(cx, cy + ch, cx, cy, r);
    ctx.arcTo(cx, cy, cx + cw, cy, r);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

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
  // 尺度基准 u：以 1920 宽为 1 号，字号/留白都乘 u，二维码模块边长仍取整像素（同金句卡片规则）。
  // 小尺寸框选时底板会吃掉画面主体，所以候选尺度从基准逐级 ×0.75 试到"不越界"为止。
  const SHOT_BRAND = 'AnyComment · 网页截图';
  const QR_QUIET = 2;

  function planShot({ s, W, H, brand, when, qrTotal, overlay, corner }) {
    const meas = measureCtx();
    const fs1 = Math.max(8, Math.round(15 * s));
    const fs2 = Math.max(7, Math.round(13 * s));
    const pad = Math.max(4, Math.round(14 * s));
    const inset = Math.max(6, Math.round(16 * s));
    const radius = Math.max(4, Math.round(8 * s));
    const gap = Math.max(4, Math.round(10 * s));
    const lh1 = Math.round(fs1 * 1.3);
    const lh2 = Math.round(fs2 * 1.3);
    const dotR = Math.max(2, Math.round(fs1 * 0.36));
    const dotGap = Math.max(3, Math.round(6 * s));
    meas.font = fontMain(fs1, 600);
    const wBrand = brand ? dotR * 2 + dotGap + meas.measureText(brand).width : 0;
    meas.font = fontMain(fs2, 400);
    const wWhen = when ? meas.measureText(when).width : 0;
    const textW = Math.max(wBrand, wWhen);
    const textH = (brand ? lh1 : 0) + (when ? lh2 : 0);
    const base = { s, fs1, fs2, pad, inset, radius, gap, lh1, lh2, dotR, dotGap, textW, textH };

    if (overlay) {
      const cell = qrTotal ? Math.max(1, Math.round(4 * s)) : 0;
      const qrPx = cell * qrTotal;
      const w = pad * 2 + textW + (qrPx ? gap + qrPx : 0);
      const h = pad * 2 + Math.max(textH, qrPx);
      const fits = w + inset * 2 <= W * 0.94 && h + inset * 2 <= Math.max(40, H * 0.55);
      const x = corner === 'tl' || corner === 'bl' ? inset : W - inset - w;
      const y = corner === 'tl' || corner === 'tr' ? inset : H - inset - h;
      const qx = x + w - pad - qrPx;
      const qy = y + (h - qrPx) / 2;
      return { ...base, mode: 'overlay', fits, x, y, w, h, cell, qrPx, qx, qy, textMax: w - pad * 2 - (qrPx ? gap + qrPx : 0) };
    }
    const stripH = Math.max(18, Math.round(64 * s));
    const room = stripH - Math.max(2, Math.round(5 * s)) * 2;
    const cell = qrTotal ? Math.max(0, Math.floor(room / qrTotal)) : 0; // 放不下二维码就只留文字
    const qrPx = cell * qrTotal;
    const fits = stripH <= Math.max(40, H * 0.5);
    return {
      ...base, mode: 'strip', fits, stripH, cell, qrPx,
      // 白底静默区会比二维码本身外扩 gap，右边界要按外扩后的尺寸留白
      qx: W - pad - qrPx - (qrPx ? gap : 0), qy: H + (stripH - qrPx) / 2,
      textMax: W - pad * 2 - (qrPx ? gap + qrPx : 0),
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

    const overlay = o.shot_qr_overlay !== false;
    const corner = ['tl', 'tr', 'bl', 'br'].includes(o.shot_qr_corner) ? o.shot_qr_corner : 'br';
    const qrTotal = qr ? qr.getModuleCount() + QR_QUIET * 2 : 0;

    let plan = null;
    for (let s = Math.max(0.55, W / 1920); s >= 0.18; s *= 0.75) {
      plan = planShot({ s, W, H, brand, when, qrTotal, overlay, corner });
      if (plan.fits) break;
    }
    if (!plan || !plan.fits) {
      // 最小尺度仍放不下二维码：放弃二维码，只保留文字
      plan = planShot({ s: 0.18, W, H, brand, when, qrTotal: 0, overlay, corner });
      if (!plan.fits) return dataUrl;
    }

    const outW = W;
    const outH = plan.mode === 'strip' ? H + plan.stripH : H;
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(img, 0, 0, W, H);

    if (plan.mode === 'strip') {
      ctx.fillStyle = '#f7f8fc';
      ctx.fillRect(0, H, outW, plan.stripH);
      ctx.fillStyle = '#eceef4';
      ctx.fillRect(0, H, outW, 1); // 顶边线，分隔原图与底栏
    } else {
      ctx.save();
      ctx.shadowColor = 'rgba(31,36,48,0.18)';
      ctx.shadowBlur = Math.max(3, Math.round(12 * plan.s));
      ctx.shadowOffsetY = Math.max(1, Math.round(2 * plan.s));
      ctx.fillStyle = '#ffffff';
      roundRectPath(ctx, plan.x, plan.y, plan.w, plan.h, plan.radius);
      ctx.fill();
      ctx.restore();
    }

    // 二维码：整像素模块 + 纯白静默区（底栏是浅灰，必须垫白底，否则对比度不足扫不出）
    if (qr && plan.cell > 0) {
      // 底栏里二维码几乎占满栏高，白底外扩会糊到原图首行，必须夹在底栏内
      const hy = plan.mode === 'strip' ? Math.max(H, plan.qy - plan.gap) : plan.qy - plan.gap;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(plan.qx - plan.gap, hy, plan.qrPx + plan.gap * 2, plan.qy + plan.qrPx + plan.gap - hy);
      drawQrModules(ctx, qr, plan.qx, plan.qy, plan.cell, QR_QUIET);
    }

    // 品牌行 + 时间行：左列顶部起排，整体在可用高度里垂直居中，超宽只在自身行内截断
    const textX = plan.mode === 'strip' ? plan.pad : plan.x + plan.pad;
    const textTop = plan.mode === 'strip' ? H + (plan.stripH - plan.textH) / 2 : plan.y + (plan.h - plan.textH) / 2;
    ctx.textBaseline = 'middle';
    let ty = textTop;
    if (brand) {
      ctx.fillStyle = '#2f6bff';
      ctx.beginPath();
      ctx.arc(textX + plan.dotR, ty + plan.lh1 / 2, plan.dotR, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = fontMain(plan.fs1, 600);
      ctx.fillStyle = '#1f2430';
      const t = wrapText(ctx, brand, plan.textMax - plan.dotR * 2 - plan.dotGap, 1)[0] || '';
      ctx.fillText(t, textX + plan.dotR * 2 + plan.dotGap, ty + plan.lh1 / 2);
      ty += plan.lh1;
    }
    if (when) {
      ctx.font = fontMain(plan.fs2, 400);
      ctx.fillStyle = '#8a90a5';
      ctx.fillText(wrapText(ctx, when, plan.textMax, 1)[0] || '', textX, ty + plan.lh2 / 2);
    }

    return canvas.toDataURL('image/png');
  }

  // ========== 预览浮层（金句卡片与截图共用） ==========

  const PREVIEW_CSS = `
    .ac-share-mask {
      position: fixed; inset: 0; z-index: 2147483647;
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

  // 预览浮层：下载 / 复制到剪贴板 / 关闭
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
    btnCopy.addEventListener('click', async () => {
      try {
        // dataURL → Blob（content script 里 fetch(data:) 在部分环境被禁，手动解码更稳）
        const b64 = dataUrl.split(',')[1];
        const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
        btnCopy.textContent = '已复制 ✓';
      } catch {
        btnCopy.textContent = '复制失败，请下载';
      }
    });
    const btnClose = document.createElement('button');
    btnClose.className = 'ac-share-btn ac-share-close';
    btnClose.textContent = '关闭';
    btnClose.addEventListener('click', () => mask.remove());
    acts.append(btnDl, btnCopy, btnClose);
    box.append(img, acts);
    mask.append(box);
    mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
    root.appendChild(mask);
  }

  globalThis.__acCard = {
    SHOT_DEFAULTS,
    fontMain,
    wrapText,
    buildQrMatrix,
    roundRectPath,
    drawQrModules,
    fmtShotTime,
    drawShareCard,
    composeScreenshot,
    planShot,
    showPreview,
    PREVIEW_CSS,
  };
})();
