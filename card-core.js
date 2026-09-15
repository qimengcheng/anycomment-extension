// AnyComment 共享绘制模块（拆分自 card.js）：截图默认值 · 换行 · QR · 圆角/白卡/玻璃/霜冻绘制
// 与 content.js / capture.js 同在 content_scripts 隔离世界（manifest 按序加载），用全局命名空间交换
// 加载顺序：card-core.js → card-art.js → card.js
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
    card_pack_shot_desat: 0, // 主题包截图背景的去色程度：0=保留原色，100=纯黑白（用户可调）
    card_glass_mode: false, // 划线分享卡片磨砂玻璃模式：白底半透明 + 背后画面模糊（backdrop-filter blur 5px 的画布等价）
    card_glass_blur: 5, // 磨砂玻璃的模糊半径（px，0~50）；0 = 只调透明度不模糊
    card_glass_alpha: 55, // 磨砂玻璃面板的白色不透明度（%，0~100）；0=全透明只剩模糊背景，100=实底白卡
    card_marker: true, // 划线分享卡片：给关键词加小红书风荧光笔划线（默认自动识别英文/数字词，预览里可直接点卡片上的词增删）
    card_doodle: true, // 划线分享卡片：手绘装饰元素（箭头/波浪线/粗下划线），随划线一起生效，可单独关闭
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

  // 磨砂玻璃卡片：backdrop-filter: blur(5px) 的画布等价实现。
  // 先把调用时 ctx 上已画好的背景（卡片区域背后那部分）模糊后按圆角裁剪糊进去，
  // 再叠一层半透明白面板 + 玻璃高光描边，模拟「卡片更透明、背景 blur」的磨砂质感。
  // 画布自绘以快照为源，无递归问题；ctx.filter 受当前变换影响，blur 值即 CSS 逻辑像素。
  // 依赖调用方先画完背景再调用本函数（与 paintWhiteCard 的调用位置一致）。
  // alpha 为白色面板不透明度（%，0~100）：越大越接近实底白卡，越小玻璃越通透（文字对比度随之下降）。
  function paintGlassCard(ctx, x, y, w, h, r, blur = 5, alpha = 55) {
    const a = Math.max(0, Math.min(100, typeof alpha === 'number' ? alpha : 55)) / 100;
    if (blur > 0) {
      ctx.save();
      roundRectPath(ctx, x, y, w, h, r);
      ctx.clip();
      ctx.filter = `blur(${blur}px)`;
      const m = ctx.getTransform();
      // 整幅画布按当前变换反算回用户空间铺回去，模糊后只有 clip 内的部分可见
      ctx.drawImage(ctx.canvas, 0, 0, ctx.canvas.width / m.a, ctx.canvas.height / m.d);
      ctx.filter = 'none';
      ctx.restore();
    }
    ctx.save();
    ctx.shadowColor = 'rgba(31,36,48,0.10)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    roundRectPath(ctx, x, y, w, h, r);
    ctx.fill();
    ctx.restore();
    // 玻璃边缘高光：半透明白描边勾出磨砂面板轮廓，浓度随面板不透明度走（全透明时不再留突兀白边）
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${(0.35 + 0.3 * a).toFixed(3)})`;
    ctx.lineWidth = 1.5;
    roundRectPath(ctx, x + 0.75, y + 0.75, w - 1.5, h - 1.5, r);
    ctx.stroke();
    ctx.restore();
  }

  // 磨砂玻璃模式下文字的可读性兜底：面板越通透，文字背后的画面越"花"，给文字加一圈羽化白描边
  // （白色 strokeText 两遍 + 高斯羽化，再叠原色文字）。强度由面板不透明度自动反推，用户无需调节：
  //   不透明度 ≥70% → 完全关闭（接近实底白卡，视觉与原来一致）
  //   不透明度越低  → t 越大，描边越宽越白（v1.88.0 收窄：宽度上限约 2.8px，此前 5px 偏粗）
  function glassTextHalo(alpha) {
    const a = typeof alpha === 'number' ? alpha : 55;
    if (a >= 70) return { halo: 0, s: 0 };
    const t = (70 - a) / 70;
    return { halo: 0.8 + 2 * t, s: Math.min(0.95, 0.35 + 0.6 * t) };
  }

  // 羽化白描边原语：宽描一遍（羽化 halo）+ 窄描一遍（羽化 halo*0.45 收紧边缘），
  // 由调用方在设好 font / textAlign / textBaseline 之后、fillText 之前调用。
  // 与 paintGlassCard 一样，halo 受当前变换影响，传逻辑像素即可。
  function frostText(ctx, text, x, y, halo, strength) {
    if (!(halo > 0) || !(strength > 0)) return;
    ctx.save();
    ctx.shadowColor = `rgba(255,255,255,${(0.95 * strength).toFixed(3)})`;
    ctx.strokeStyle = `rgba(255,255,255,${(0.92 * strength).toFixed(3)})`;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = halo;
    for (const b of [halo, halo * 0.45]) { ctx.shadowBlur = b; ctx.strokeText(text, x, y); }
    ctx.restore();
  }

  globalThis.__acCardCore = {  // 20 个公开 key 里属于 core 的 9 个
    SHOT_DEFAULTS, fontMain, wrapText, cleanUrlForQr, buildQrMatrix,
    roundRectPath, drawQrModules, paintWhiteCard, fmtShotTime,
  };
  globalThis.__acCardCoreInternals = { paintGlassCard, glassTextHalo, frostText }; // 不进公开接口
})();
