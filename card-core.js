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
    card_glass_mode: false, // 划线分享卡片玻璃模式总开关：关=实底白卡，开=按 card_glass_style 呈现
    card_glass_style: '', // 玻璃样式三选一：translucent 半透明 / frost 磨砂玻璃 / liquid 液态玻璃；'' = 未设置，由 resolveGlassStyle 按旧数据推导
    card_glass_blur: 5, // 磨砂玻璃的模糊半径（px，0~50）；只在 frost 样式生效（半透明恒为 0，液态玻璃自带固定轻模糊）
    card_glass_alpha: 55, // 玻璃面板的白色不透明度（%，0~100）；三种样式通用。0=全透明只剩背景，100=实底白卡
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

  // 玻璃样式的唯一推导口径（content.js / options.js 共用，勿各写一份）：
  // 新键 card_glass_style 未设置（'' 或非法值）时按旧数据迁移——老用户把「模糊强度」拖到 0
  // 得到的就是纯半透明效果，所以 blur === 0 → translucent，否则维持磨砂（与升级前逐像素一致）。
  const GLASS_STYLES = ['translucent', 'frost', 'liquid'];
  function resolveGlassStyle(cfg) {
    const s = cfg && cfg.card_glass_style;
    return GLASS_STYLES.includes(s) ? s : ((cfg && cfg.card_glass_blur === 0) ? 'translucent' : 'frost');
  }

  // 磨砂玻璃卡片：backdrop-filter: blur(5px) 的画布等价实现。
  // 先把调用时 ctx 上已画好的背景（卡片区域背后那部分）模糊后按圆角裁剪糊进去，
  // 再叠一层半透明白面板 + 玻璃高光描边，模拟「卡片更透明、背景 blur」的磨砂质感。
  // 画布自绘以快照为源，无递归问题；ctx.filter 受当前变换影响，blur 值即 CSS 逻辑像素。
  // 依赖调用方先画完背景再调用本函数（与 paintWhiteCard 的调用位置一致）。
  // alpha 为白色面板不透明度（%，0~100）：越大越接近实底白卡，越小玻璃越通透（文字对比度随之下降）。
  // blur = 0 时即「半透明」档（只调透明度、背景不模糊）。
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

  // 圆角矩形 Path2D（与 roundRectPath 同几何，只是返回对象）：供 ctx.clip(path, 'evenodd') 挖环带用
  function roundRectPath2(x, y, w, h, r) {
    const p = new Path2D();
    const rr = Math.min(r, w / 2, h / 2);
    p.moveTo(x + rr, y);
    p.arcTo(x + w, y, x + w, y + h, rr);
    p.arcTo(x + w, y + h, x, y + h, rr);
    p.arcTo(x, y + h, x, y, rr);
    p.arcTo(x, y, x + w, y, rr);
    p.closePath();
    return p;
  }

  // 液态玻璃（对齐 iOS 实拍的 Liquid Glass，26 引入、27 继续优化）。两条已被实拍否掉的错误路线，别再走回去：
  //   ✕「把背后内容放大」——iOS 图里穿过玻璃边界的直线（衣服印字、黑胶排）一格都不该错开；
  //   ✕「内部明显起雾」——那是**磨砂**档的特征。iOS 实拍同图并排：液态那半边印字锐利，磨砂那半边糊成一片。
  // 液态玻璃的本职是**透得清楚**（scatter 恒低于磨砂的 blur 5），差异全压在轮廓上，靠三件事：
  //   ① 贴内缘一道**暗化收边**（iOS 27 官方口径「引入暗化边缘以增强视觉分离度」），把玻璃从背景里切出来；
  //   ② 轮廓**高亮反光**（fresnel 亮边 + 上缘入光/下缘聚光），iOS 27 明确「提高高光反射亮度」；
  //   ③ 折射只压在**轮廓那几像素**：玻璃体中间是平的，只有贴边一圈表面倾斜，所以中心完全不失真，
  //      位移从折射带内缘的 0 连续升到贴边处的最大值（很小，L=0.012 → 664 宽面板上约 8px）。
  // ③ 的逐像素做法（对齐 iOS 逆向出的 shader：法线取自 SDF 梯度，凸面 → 采样点向内侧收）：
  //   sd   = 圆角矩形有向距离（内部为负）；din = -sd 即「离表面多深」
  //   t    = 1 - smoothstep(0, band, din)          // 表面 1 → 带内缘 0，带外恒为 0（中心不偏移）
  //   n    = -∇sd 归一化                            // 内法线：直边处垂直于边、圆角处沿半径朝内
  //   采样 = 像素 + n × t × maxDisp                 // 凸面把光往光轴折 → 边缘从更靠内侧取色
  //   R/B 各用略不同的 t·maxDisp → 边缘极细色散（chromatic aberration）
  // 另叠自适应 tint：按透射内容平均亮度调白 veil，暗背景多铺保文字可读、亮背景少铺保通透。
  // 画布被跨域图污染时 getImageData 会抛，自动回落 paintLiquidLite（同心环带分步近似的边缘折射）。
  // alpha 与磨砂共用同一语义（0~100%，越大越接近实底白卡）；几何与 blur 值都是 CSS 逻辑像素。
  // 参数（调参器 .workbuddy/glass_styles_preview.html?g=6 直接改这里的同名字段做对比）
  const LIQ = {
    warp: 0.5,        // 透镜工作分辨率（设备像素倍率）：0.5 = 四分之一像素量，肉眼无损（内容本就轻模糊）
    lens: 0.012,      // 边缘折射强度 L：贴边处最大内移 = L × 长边。Apple 的折射只压在轮廓那几像素，
                      // 不是把画面整片推移；调大就变成放大镜（用户 2026-09-24 拿 iOS 实拍图否掉）
    bandRatio: 0.035, // 折射带宽度 = bandRatio × 长边（按长边归一，避免竖长卡片整片糊进带里）
    chroma: 0.1,      // 色散：R/B 通道位移相对 L 的偏差（只在折射带内可见）
    scatter: 0.8,     // 透射后的扩散模糊（px）：液态玻璃的本职是**透得清楚**，必须明显低于磨砂档（默认 blur 5）。
                      // 调大就退化成磨砂——iOS 实拍里液态那半边衣服印字、黑胶都是锐的，磨砂那半边才糊成一片
    sat: 1.18,        // 透射内容提饱和（配合暗化收边一起读「更高对比度」）
    edgeDark: 0.16,   // 暗化收边（iOS 27 官方口径「引入暗化边缘以增强视觉分离度」）：贴内缘一道暗线
    padRatio: 0.05,   // 源图外扩比例：折射只往内采样，留这点边距供扩散模糊不吃边
  };
  const sstep = (e0, e1, v) => {
    const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0 || 1e-6)));
    return t * t * (3 - 2 * t);
  };
  // 圆角矩形 SDF（Inigo Quilez 版式）：内部为负、外部为正、0 即表面
  function sdRoundRect(mx, my, hx, hy, rr) {
    const qx = Math.abs(mx) - hx + rr;
    const qy = Math.abs(my) - hy + rr;
    return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - rr;
  }
  // 双线性采样（越界钳边）：单通道
  function sampleCh(data, sw, sh, fx, fy, ch) {
    let x = fx, y = fy;
    if (x < 0) x = 0; else if (x > sw - 1.001) x = sw - 1.001;
    if (y < 0) y = 0; else if (y > sh - 1.001) y = sh - 1.001;
    const x0 = x | 0, y0 = y | 0, tx = x - x0, ty = y - y0;
    const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
    const i00 = (y0 * sw + x0) * 4 + ch, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
    return data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
  }
  // 逐像素透镜：返回面板尺寸的 warp 画布 + 透射内容平均亮度（供自适应 tint）
  function liquidLens(ctx, x, y, w, h, r, m) {
    const dpr = m.a, dprY = m.d;
    const ws = LIQ.warp;
    const pad = Math.max(w, h) * LIQ.padRatio;
    const sw = Math.max(2, Math.round((w + pad * 2) * dpr * ws));
    const sh = Math.max(2, Math.round((h + pad * 2) * dprY * ws));
    const src = document.createElement('canvas');
    src.width = sw; src.height = sh;
    const sc = src.getContext('2d', { willReadFrequently: true });
    // 源矩形是「面板 + 四周外扩」这块区域在**整卡设备像素**下的尺寸，目标才是 warp 分辨率。
    // 曾把 sw/sh 同时当源和目标 → 降采样根本没发生，源区被按 1:1 设备像素读进来却当成半分辨率用，
    // 结果玻璃里的内容放大 1/ws 倍（2×）且整体错位，与背后背景完全脱节。
    const rw = Math.max(1, Math.round((w + pad * 2) * dpr));
    const rh = Math.max(1, Math.round((h + pad * 2) * dprY));
    sc.drawImage(ctx.canvas, Math.round(x * dpr + m.e - pad * dpr), Math.round(y * dprY + m.f - pad * dprY), rw, rh, 0, 0, sw, sh);
    const sdata = sc.getImageData(0, 0, sw, sh).data; // 画布被污染时在此抛 SecurityError
    const pw = Math.max(2, Math.round(w * dpr * ws));
    const ph = Math.max(2, Math.round(h * dprY * ws));
    const out = document.createElement('canvas');
    out.width = pw; out.height = ph;
    const oc = out.getContext('2d');
    const img = oc.createImageData(pw, ph);
    const d = img.data;
    const hx = pw / 2, hy = ph / 2, rr = Math.min(r * dpr * ws, hx, hy);
    const off = pad * dpr * ws; // 面板左上角在源图里的偏移
    const longSide = 2 * Math.max(hx, hy);            // warp 像素下的长边（按长边归一，防竖长卡片畸变）
    const band = Math.max(2, longSide * LIQ.bandRatio); // 折射带：带外完全不偏移
    const maxDisp = longSide * LIQ.lens;               // 贴边处最大内移
    const CA = LIQ.chroma;
    let lum = 0, n = 0;
    for (let oy = 0; oy < ph; oy++) {
      const my = oy + 0.5 - hy;
      let row = (oy * pw) << 2;
      for (let ox = 0; ox < pw; ox++) {
        const i = row + (ox << 2);
        const mx = ox + 0.5 - hx;
        const sd = sdRoundRect(mx, my, hx, hy, rr);
        if (sd > 0.5) { d[i + 3] = 0; continue; } // 圆角外留透明，边缘由 clip 兜底
        const t = 1 - sstep(0, band, Math.min(-sd, band)); // 表面 1 → 带内缘 0；带外恒 0
        let nx = 0, ny = 0;
        if (t > 0) { // 内法线 = -∇sd（中心区不进这条分支 → 中心逐像素零位移）
          const gx = sdRoundRect(mx + 1, my, hx, hy, rr) - sdRoundRect(mx - 1, my, hx, hy, rr);
          const gy = sdRoundRect(mx, my + 1, hx, hy, rr) - sdRoundRect(mx, my - 1, hx, hy, rr);
          const gl = Math.hypot(gx, gy) || 1;
          const disp = t * maxDisp;
          nx = (-gx / gl) * disp; ny = (-gy / gl) * disp;
        }
        const bx = off + hx + mx, by = off + hy + my;
        const e = 1 + CA * t; // R 多折、B 少折 → 边缘细色散
        d[i] = sampleCh(sdata, sw, sh, bx + nx * e, by + ny * e, 0);
        d[i + 1] = sampleCh(sdata, sw, sh, bx + nx, by + ny, 1);
        d[i + 2] = sampleCh(sdata, sw, sh, bx + nx / e, by + ny / e, 2);
        d[i + 3] = 255;
        if (((ox ^ oy) & 7) === 0) { lum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
      }
    }
    oc.putImageData(img, 0, 0);
    return { canvas: out, lum: n ? lum / n / 255 : 0.5 };
  }
  function paintLiquidCard(ctx, x, y, w, h, r, alpha = 55) {
    const a = Math.max(0, Math.min(100, typeof alpha === 'number' ? alpha : 55)) / 100;
    const m = ctx.getTransform();
    if (!(m.a > 0 && m.d > 0) || !(w > 0) || !(h > 0)) return;
    let lens = null;
    try {
      lens = liquidLens(ctx, x, y, w, h, r, m);
    } catch (e) {
      lens = null; // 跨域图污染画布：回落近似透镜
    }
    if (!lens) return paintLiquidLite(ctx, x, y, w, h, r, a, m);
    const outer = roundRectPath2(x, y, w, h, r);
    // 高光浓度：面板越接近实底越该收（白带压在白卡上只会脏）
    const spec = 0.34 + 0.66 * (1 - a);
    // 自适应 tint：透射内容越暗，白veil 越多（保住深色文字对比度）；越亮越通透
    const veil = Math.max(0, Math.min(1, a * (1.3 - 0.55 * lens.lum)));

    // ① 透镜层：放大鼓起的背景 + 轻散射 + 提饱和
    ctx.save();
    ctx.clip(outer);
    ctx.filter = `blur(${LIQ.scatter}px) saturate(${LIQ.sat})`;
    ctx.drawImage(lens.canvas, 0, 0, lens.canvas.width, lens.canvas.height, x, y, w, h);
    ctx.filter = 'none';
    // ② 玻璃体：自适应半透明白（落影与磨砂同规格，换档时卡片不"跳位"）
    ctx.shadowColor = 'rgba(31,36,48,0.10)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = `rgba(255,255,255,${veil.toFixed(3)})`;
    ctx.fill(outer);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    // ③ 镜面高光：上缘入光最宽、下缘聚光成一条亮带（玻璃边缘的水光）
    const gTop = ctx.createLinearGradient(0, y, 0, y + h * 0.34);
    gTop.addColorStop(0, `rgba(255,255,255,${(0.5 * spec).toFixed(3)})`);
    gTop.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gTop;
    ctx.fill(outer);
    const gBot = ctx.createLinearGradient(0, y + h * 0.62, 0, y + h);
    gBot.addColorStop(0, 'rgba(255,255,255,0)');
    gBot.addColorStop(0.82, `rgba(255,255,255,${(0.16 * spec).toFixed(3)})`);
    gBot.addColorStop(1, `rgba(255,255,255,${(0.5 * spec).toFixed(3)})`);
    ctx.fillStyle = gBot;
    ctx.fill(outer);
    // 斜向水光：光源在左上（lightDir ≈ (.5, 1)），左上角最亮
    const gSheen = ctx.createLinearGradient(x, y, x + w, y + h);
    gSheen.addColorStop(0, `rgba(255,255,255,${(0.18 * spec).toFixed(3)})`);
    gSheen.addColorStop(0.4, 'rgba(255,255,255,0)');
    ctx.fillStyle = gSheen;
    ctx.fill(outer);
    ctx.restore();

    // ④ 暗化收边（iOS 27「引入暗化边缘以增强视觉分离度」）：贴内缘一道 3px 暗线，把玻璃从背景里
    // 「切」出来。clip 到面板内，描边外半不会溢出轮廓；面板越接近实底白卡，暗边越该收。
    ctx.save();
    ctx.clip(outer);
    ctx.strokeStyle = `rgba(31,36,48,${(LIQ.edgeDark * (1 - a * 0.6)).toFixed(3)})`;
    ctx.lineWidth = 3;
    ctx.stroke(roundRectPath2(x + 1.5, y + 1.5, w - 3, h - 3, Math.max(1, r - 1.5)));
    ctx.restore();
    // ⑤ fresnel 亮边：极细（1.2px），上缘与下缘亮、两侧收；内侧再压一道淡暗线读厚度
    ctx.save();
    const gRim = ctx.createLinearGradient(0, y, 0, y + h);
    gRim.addColorStop(0, `rgba(255,255,255,${Math.min(1, 0.55 + 0.45 * spec)})`);
    gRim.addColorStop(0.5, `rgba(255,255,255,${(0.16 * spec + 0.14).toFixed(3)})`);
    gRim.addColorStop(1, `rgba(255,255,255,${Math.min(1, 0.4 + 0.5 * spec)})`);
    ctx.strokeStyle = gRim;
    ctx.lineWidth = 1.2;
    ctx.stroke(roundRectPath2(x + 0.6, y + 0.6, w - 1.2, h - 1.2, Math.max(1, r - 0.6)));
    ctx.strokeStyle = `rgba(31,36,48,${(0.09 * (1 - a * 0.5)).toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.stroke(roundRectPath2(x + 2.2, y + 2.2, w - 4.4, h - 4.4, Math.max(1, r - 2.2)));
    ctx.restore();
  }
  // 回落路径（画布被跨域图污染、读不到像素时）：与主路径同向的**窄边折射**近似 + 同样的 tint 与高光。
  // 中心区 1:1 原样透出，只在折射带内按同心环带分步把内容放大（放大 = 采样点往中心收）。
  // 没有连续位移场，所以用 STEPS 段阶梯代替 smoothstep，避免带内缘出现硬缝。
  function paintLiquidLite(ctx, x, y, w, h, r, a, m) {
    const pad = Math.max(w, h) * LIQ.padRatio;
    const toDevice = (v, axis) => v * (axis === 'x' ? m.a : m.d);
    const src = document.createElement('canvas');
    src.width = Math.max(1, Math.round(toDevice(w + pad * 2, 'x')));
    src.height = Math.max(1, Math.round(toDevice(h + pad * 2, 'y')));
    src.getContext('2d').drawImage(
      ctx.canvas,
      Math.round(toDevice(x - pad, 'x') + m.e), Math.round(toDevice(y - pad, 'y') + m.f), src.width, src.height,
      0, 0, src.width, src.height,
    );
    const outer = roundRectPath2(x, y, w, h, r);
    const spec = 0.34 + 0.66 * (1 - a);
    // 与主路径同向的边缘折射近似：中心区 1:1 透出，只在折射带内按同心环带分步把内容放大
    // （放大 = 采样点往中心收）。没有连续位移场，所以用 STEPS 段阶梯代替 smoothstep，避免带内缘硬缝。
    const longSide = Math.max(w, h);
    const band = Math.max(2, longSide * LIQ.bandRatio);
    const D = Math.max(1, longSide / 2);                       // 折算半径取长边一半 → 左右缘位移与主路径等值（上下缘偏小，回落路径可接受）
    const cux = (pad + w / 2) * m.a, cuv = (pad + h / 2) * m.d; // 面板中心在 src 像素里的位置
    const STEPS = 4;
    ctx.save();
    ctx.clip(outer);
    ctx.filter = `blur(${LIQ.scatter}px) saturate(${LIQ.sat})`;
    // 底：面板那块区域 1:1 透出（中心区就该长这样）。src 覆盖的是 [面板 - pad, 面板 + pad]，
    // 必须按源矩形取用，整块 src 直接画进面板会把内容缩小 pad 那么多。
    ctx.drawImage(src, pad * m.a, pad * m.d, w * m.a, h * m.d, x, y, w, h);
    for (let s = 0; s < STEPS; s++) {
      const d0 = (band * s) / STEPS, d1 = (band * (s + 1)) / STEPS;
      const t = 1 - sstep(0, band, (d0 + d1) / 2);             // 该环带中点的折射强度（与主路径同一条 smoothstep）
      const kk = Math.max(0.2, 1 - (t * longSide * LIQ.lens) / D);
      const sw2 = w * kk * m.a, sh2 = h * kk * m.d;
      const ring = roundRectPath2(x + d0, y + d0, Math.max(0, w - 2 * d0), Math.max(0, h - 2 * d0), Math.max(0, r - d0));
      ring.addPath(roundRectPath2(x + d1, y + d1, Math.max(0, w - 2 * d1), Math.max(0, h - 2 * d1), Math.max(0, r - d1)));
      ctx.save();
      ctx.clip(ring, 'evenodd');
      ctx.drawImage(src, cux - sw2 / 2, cuv - sh2 / 2, sw2, sh2, x, y, w, h);
      ctx.restore();
    }
    ctx.filter = 'none';
    ctx.shadowColor = 'rgba(31,36,48,0.10)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.fill(outer);
    const gTop = ctx.createLinearGradient(0, y, 0, y + h * 0.34);
    gTop.addColorStop(0, `rgba(255,255,255,${(0.5 * spec).toFixed(3)})`);
    gTop.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gTop;
    ctx.fill(outer);
    const gBot = ctx.createLinearGradient(0, y + h * 0.62, 0, y + h);
    gBot.addColorStop(0, 'rgba(255,255,255,0)');
    gBot.addColorStop(1, `rgba(255,255,255,${(0.5 * spec).toFixed(3)})`);
    ctx.fillStyle = gBot;
    ctx.fill(outer);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${Math.min(1, 0.55 + 0.45 * spec)})`;
    ctx.lineWidth = 1.2;
    ctx.stroke(roundRectPath2(x + 0.6, y + 0.6, w - 1.2, h - 1.2, Math.max(1, r - 0.6)));
    ctx.restore();
  }

  // 三种玻璃样式的统一入口（card.js 两个版式分支共用，别在调用点各写一份 if）
  // style: translucent 半透明 / frost 磨砂玻璃 / liquid 液态玻璃；blur 只对 frost 有意义
  function paintGlassPanel(ctx, style, x, y, w, h, r, blur, alpha) {
    if (style === 'liquid') paintLiquidCard(ctx, x, y, w, h, r, alpha);
    else if (style === 'translucent') paintGlassCard(ctx, x, y, w, h, r, 0, alpha);
    else paintGlassCard(ctx, x, y, w, h, r, blur, alpha);
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
  globalThis.__acCardCoreInternals = { paintGlassCard, paintGlassPanel, glassTextHalo, frostText, resolveGlassStyle, GLASS_STYLES, LIQ }; // 不进公开接口；LIQ 暴露只为本地调参器可改
})();
