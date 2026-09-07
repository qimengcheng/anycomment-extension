// AnyComment 分享图标注（微信截图同款）：箭头 / 直线 / 矩形 / 椭圆 / 画笔 / 马赛克 / 文字 / 序号
// 与 card.js 的 showPreview 协作：底层 canvas 画原图，上层 canvas 画标注，导出时两层合成。
// 所有形状坐标存「原图像素」，线宽/字号存「屏幕像素」，绘制时乘 uiScale() 换算，
// 这样长图（整页截图）被缩到视口高度预览时，笔触粗细与最终导出一致。
(() => {
  const FONT = '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
  const COLORS = ['#e5342c', '#ff8c1a', '#ffc60a', '#22c55e', '#2f6bff', '#8b5cf6', '#1f2430', '#ffffff'];
  const SIZES = [
    { v: 2, label: '细', d: 4 },
    { v: 4, label: '中', d: 8 },
    { v: 7, label: '粗', d: 12 },
  ];
  // 序号工具：点击处画一个带数字的圆点，数字自动递增
  const TOOLS = [
    { id: 'arrow', label: '箭头', svg: '<path d="M2.6 13.4 L13.2 2.8"/><path d="M7.6 2.8 H13.2 V8.4"/>' },
    { id: 'line', label: '直线', svg: '<path d="M2.6 13.4 L13.4 2.6"/>' },
    { id: 'rect', label: '矩形', svg: '<rect x="2.6" y="3.4" width="10.8" height="9.2" rx="1.4"/>' },
    { id: 'ellipse', label: '椭圆', svg: '<ellipse cx="8" cy="8" rx="6.2" ry="5.2"/>' },
    { id: 'pen', label: '画笔', svg: '<path d="M3 13l1.2-3.6L10.6 3l2.6 2.6L6.8 12.9z"/>' },
    { id: 'mosaic', label: '马赛克', fill: true, svg: '<path d="M2.6 2.6h4.8v4.8H2.6zM8.6 2.6h4.8v4.8H8.6zM2.6 8.6h4.8v4.8H2.6zM8.6 8.6h4.8v4.8H8.6z"/>' },
    { id: 'text', label: '文字', svg: '<path d="M3 3.6h10"/><path d="M8 3.6v8.8"/>' },
    { id: 'number', label: '序号', svg: '<circle cx="8" cy="8" r="6"/><text x="8" y="11.4" font-size="9" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">1</text>' },
  ];

  const CSS = `
    .ac-anno-stage { display: flex; flex-direction: column; gap: 10px; align-items: center; max-width: 100%; }
    .ac-anno-bar {
      display: flex; align-items: center; gap: 5px; flex-wrap: wrap; justify-content: center;
      padding: 7px 9px; border-radius: 10px; background: #f6f7fb; border: 1px solid #eceef4;
      font: 500 12px/1 ${FONT}; user-select: none;
    }
    .ac-anno-tool {
      width: 30px; height: 30px; padding: 0; border: none; border-radius: 7px;
      background: #fff; color: #5b6172; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .ac-anno-tool:hover { background: #eceffb; }
    .ac-anno-tool.on { background: #4f6ef7; color: #fff; }
    .ac-anno-text-btn {
      width: auto; height: 30px; padding: 0 10px; border-radius: 7px; border: none;
      background: #fff; color: #5b6172; cursor: pointer; font: 600 12px/1 ${FONT};
    }
    .ac-anno-text-btn:hover { background: #eceffb; }
    .ac-anno-sep { width: 1px; height: 20px; background: #e2e5ef; margin: 0 3px; }
    .ac-anno-sw {
      width: 18px; height: 18px; padding: 0; border-radius: 50%; cursor: pointer;
      border: 2px solid transparent; box-shadow: 0 0 0 1px rgba(31,36,48,.14) inset;
    }
    .ac-anno-sw.on { border-color: #1f2430; }
    .ac-anno-sz {
      width: 30px; height: 26px; padding: 0; border: none; border-radius: 6px; background: #fff;
      color: #5b6172; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
    }
    .ac-anno-sz.on { background: #4f6ef7; color: #fff; }
    .ac-anno-sz i { display: block; border-radius: 99px; background: currentColor; }
    .ac-anno-wrap { position: relative; display: inline-block; line-height: 0; max-width: 100%; }
    /* 宽度上限直接用 vw：wrap 是 shrink-to-fit，canvas 再用 100% 会与父级宽度互相依赖算不准 */
    .ac-anno-base { display: block; max-height: 58vh; max-width: 88vw; border-radius: 8px; border: 1px solid #eceef4; }
    .ac-anno-layer { position: absolute; left: 0; top: 0; width: 100%; height: 100%; cursor: crosshair; touch-action: none; }
    .ac-anno-input {
      position: fixed; z-index: 2147483647; min-width: 140px; max-width: 420px;
      padding: 4px 8px; border-radius: 6px; border: 2px solid #4f6ef7; outline: none;
      background: #fff; color: #1f2430; box-shadow: 0 6px 18px rgba(15,18,28,.22);
    }
    .ac-anno-tip { color: #8a90a5; font: 400 11px/1 ${FONT}; }
  `;

  function ensureStyle(root) {
    if (root.querySelector('style[data-ac-anno]')) return;
    const s = document.createElement('style');
    s.setAttribute('data-ac-anno', '');
    s.textContent = CSS;
    root.appendChild(s);
  }

  function svgIcon(tool, cls) {
    const el = document.createElement('span');
    el.className = cls || '';
    el.innerHTML =
      `<svg width="17" height="17" viewBox="0 0 16 16" fill="${tool.fill ? 'currentColor' : 'none'}" ` +
      `stroke="${tool.fill ? 'none' : 'currentColor'}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${tool.svg}</svg>`;
    return el;
  }

  function create(root, dataUrl, opts = {}) {
    ensureStyle(root);
    const stage = document.createElement('div');
    stage.className = 'ac-anno-stage';

    const bar = document.createElement('div');
    bar.className = 'ac-anno-bar';
    const wrap = document.createElement('div');
    wrap.className = 'ac-anno-wrap';
    const cvBase = document.createElement('canvas');
    cvBase.className = 'ac-anno-base';
    const cv = document.createElement('canvas');
    cv.className = 'ac-anno-layer';
    wrap.append(cvBase, cv);
    stage.append(bar, wrap);

    let img = null;
    let shapes = [];
    let draft = null;
    let tool = opts.tool || 'arrow';
    let color = opts.color || COLORS[0];
    let size = opts.size || SIZES[1].v;
    let seq = 0;
    let onChange = null;
    let raf = 0;

    const ctx = cv.getContext('2d');
    const bctx = cvBase.getContext('2d');

    // 显示宽度 → 原图像素的换算比（原图被缩到 62vh 预览时，这个比值会很大）
    const uiScale = () => {
      const r = cv.getBoundingClientRect();
      return r.width ? cv.width / r.width : 1;
    };
    const toImg = (e) => {
      const r = cv.getBoundingClientRect();
      const k = r.width ? cv.width / r.width : 1;
      return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
    };

    // ---------- 工具栏 ----------
    const toolBtns = new Map();
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.className = 'ac-anno-tool' + (t.id === tool ? ' on' : '');
      b.type = 'button';
      b.title = t.label;
      b.setAttribute('aria-label', t.label);
      b.append(svgIcon(t));
      b.addEventListener('click', () => setTool(t.id));
      toolBtns.set(t.id, b);
      bar.append(b);
    }
    bar.append(sep());
    const swBtns = [];
    for (const c of COLORS) {
      const b = document.createElement('button');
      b.className = 'ac-anno-sw' + (c === color ? ' on' : '');
      b.type = 'button';
      b.style.background = c;
      b.title = c;
      b.addEventListener('click', () => {
        color = c;
        swBtns.forEach((x) => x.classList.toggle('on', x.dataset.c === c));
      });
      b.dataset.c = c;
      swBtns.push(b);
      bar.append(b);
    }
    bar.append(sep());
    const szBtns = [];
    for (const s of SIZES) {
      const b = document.createElement('button');
      b.className = 'ac-anno-sz' + (s.v === size ? ' on' : '');
      b.type = 'button';
      b.title = '笔触' + s.label;
      const i = document.createElement('i');
      i.style.width = '16px';
      i.style.height = s.d + 'px';
      b.append(i);
      b.addEventListener('click', () => {
        size = s.v;
        szBtns.forEach((x) => x.classList.toggle('on', Number(x.dataset.v) === s.v));
      });
      b.dataset.v = String(s.v);
      szBtns.push(b);
      bar.append(b);
    }
    bar.append(sep());
    const btnUndo = document.createElement('button');
    btnUndo.className = 'ac-anno-text-btn';
    btnUndo.type = 'button';
    btnUndo.textContent = '撤销';
    btnUndo.title = '撤销上一步（Ctrl+Z）';
    btnUndo.addEventListener('click', undo);
    const btnClear = document.createElement('button');
    btnClear.className = 'ac-anno-text-btn';
    btnClear.type = 'button';
    btnClear.textContent = '清空';
    btnClear.addEventListener('click', clear);
    bar.append(btnUndo, btnClear);
    const tip = document.createElement('span');
    tip.className = 'ac-anno-tip';
    bar.append(tip);

    function sep() {
      const d = document.createElement('span');
      d.className = 'ac-anno-sep';
      return d;
    }
    function setTool(id) {
      tool = id;
      toolBtns.forEach((b, k) => b.classList.toggle('on', k === id));
      tip.textContent = id === 'text' ? '点击图片输入文字，Enter 完成' : id === 'number' ? '点击图片添加序号' : '';
    }
    setTool(tool);

    // ---------- 绘制 ----------
    // 拖拽过程用 rAF 节流；提交/撤销/换图必须同步画完（flush），
    // 否则紧接着导出会拿到还没落笔的图层（页面在后台时 rAF 甚至不会触发）
    function redraw() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        render();
      });
    }
    function flush() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      render();
    }
    function render() {
      if (!cv.width || !cv.height) return;
      ctx.clearRect(0, 0, cv.width, cv.height);
      const k = uiScale();
      for (const sh of shapes) paint(sh, k);
      if (draft) paint(draft, k);
    }

    function paint(sh, k) {
      const w = Math.max(1, sh.size * k);
      ctx.save();
      ctx.strokeStyle = sh.color;
      ctx.fillStyle = sh.color;
      ctx.lineWidth = w;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      switch (sh.type) {
        case 'arrow':
        case 'line': {
          ctx.beginPath();
          ctx.moveTo(sh.x0, sh.y0);
          ctx.lineTo(sh.x1, sh.y1);
          ctx.stroke();
          if (sh.type === 'arrow') {
            const a = Math.atan2(sh.y1 - sh.y0, sh.x1 - sh.x0);
            const len = Math.max(12 * k, w * 3.4);
            const spread = 0.42;
            ctx.beginPath();
            ctx.moveTo(sh.x1, sh.y1);
            ctx.lineTo(sh.x1 - len * Math.cos(a - spread), sh.y1 - len * Math.sin(a - spread));
            ctx.lineTo(sh.x1 - len * Math.cos(a + spread), sh.y1 - len * Math.sin(a + spread));
            ctx.closePath();
            ctx.fill();
          }
          break;
        }
        case 'rect': {
          const x = Math.min(sh.x0, sh.x1);
          const y = Math.min(sh.y0, sh.y1);
          ctx.beginPath();
          ctx.rect(x, y, Math.abs(sh.x1 - sh.x0), Math.abs(sh.y1 - sh.y0));
          ctx.stroke();
          break;
        }
        case 'ellipse': {
          const cx = (sh.x0 + sh.x1) / 2;
          const cy = (sh.y0 + sh.y1) / 2;
          ctx.beginPath();
          ctx.ellipse(cx, cy, Math.abs(sh.x1 - sh.x0) / 2, Math.abs(sh.y1 - sh.y0) / 2, 0, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case 'pen': {
          if (sh.pts.length === 1) {
            ctx.beginPath();
            ctx.arc(sh.pts[0].x, sh.pts[0].y, w / 2, 0, Math.PI * 2);
            ctx.fill();
            break;
          }
          ctx.beginPath();
          sh.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          ctx.stroke();
          break;
        }
        case 'mosaic':
          paintMosaic(sh, k);
          break;
        case 'text': {
          const fs = sh.fs * k;
          ctx.font = `600 ${fs}px ${FONT}`;
          ctx.textBaseline = 'top';
          ctx.lineWidth = Math.max(2, fs * 0.16);
          ctx.strokeStyle = 'rgba(255,255,255,.92)';
          ctx.strokeText(sh.text, sh.x, sh.y);
          ctx.lineWidth = w; // 还原，避免影响后续
          ctx.fillStyle = sh.color;
          ctx.fillText(sh.text, sh.x, sh.y);
          break;
        }
        case 'number': {
          const r = Math.max(10 * k, w * 1.7);
          ctx.beginPath();
          ctx.arc(sh.x, sh.y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = `700 ${Math.round(r * 1.15)}px ${FONT}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(sh.n), sh.x, sh.y + r * 0.04);
          break;
        }
      }
      ctx.restore();
    }

    // 马赛克：把原图对应区域缩到极小再放大回来（关闭插值 → 色块）
    function paintMosaic(sh, k) {
      const x = Math.min(sh.x0, sh.x1);
      const y = Math.min(sh.y0, sh.y1);
      const w = Math.abs(sh.x1 - sh.x0);
      const h = Math.abs(sh.y1 - sh.y0);
      if (!img || w < 2 || h < 2) return;
      const block = Math.max(6, sh.size * k * 2.2);
      const small = document.createElement('canvas');
      small.width = Math.max(1, Math.round(w / block));
      small.height = Math.max(1, Math.round(h / block));
      const sctx = small.getContext('2d');
      sctx.drawImage(img, x, y, w, h, 0, 0, small.width, small.height);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.drawImage(small, x, y, w, h);
      ctx.restore();
    }

    // ---------- 交互 ----------
    let drawing = false;
    let startPt = null;

    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !img) return;
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch { /* 老版本不支持 */ }
      const p = toImg(e);
      if (tool === 'text') {
        openInput(p);
        return;
      }
      if (tool === 'number') {
        seq += 1;
        commit({ type: 'number', x: p.x, y: p.y, n: seq, color, size: 4 });
        return;
      }
      drawing = true;
      startPt = p;
      draft = tool === 'pen'
        ? { type: 'pen', pts: [p], color, size }
        : { type: tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y, color, size };
      redraw();
    });

    cv.addEventListener('pointermove', (e) => {
      if (!drawing || !draft) return;
      const p = toImg(e);
      if (draft.type === 'pen') {
        const last = draft.pts[draft.pts.length - 1];
        // 采样节流：屏幕上移动不足 1px 的点丢掉，长图上能少掉一大半数据
        const k = uiScale();
        if (Math.hypot(p.x - last.x, p.y - last.y) < k) return;
        draft.pts.push(p);
      } else {
        draft.x1 = p.x;
        draft.y1 = p.y;
      }
      redraw();
    });

    const endDraw = (e) => {
      if (!drawing || !draft) return;
      drawing = false;
      try { cv.releasePointerCapture(e.pointerId); } catch { /* 未捕获到 */ }
      const sh = draft;
      draft = null;
      const moved = sh.type === 'pen'
        ? sh.pts.length > 1
        : Math.hypot(sh.x1 - sh.x0, sh.y1 - sh.y0) > 3 * uiScale();
      if (moved) commit(sh);
      else flush(); // 只是点了一下，把预览中的 draft 清掉
    };
    cv.addEventListener('pointerup', endDraw);
    cv.addEventListener('pointercancel', endDraw);

    function commit(sh) {
      shapes.push(sh);
      flush();
      if (onChange) onChange();
    }
    function undo() {
      if (!shapes.length) return;
      shapes.pop();
      if (shapes.length === 0) seq = 0;
      flush();
      if (onChange) onChange();
    }
    function clear() {
      if (!shapes.length) return;
      shapes = [];
      seq = 0;
      flush();
      if (onChange) onChange();
    }

    // 文字输入：浮在画布上的 input，跟着点击位置定位，Enter 或失焦落笔
    function openInput(p) {
      const r = cv.getBoundingClientRect();
      const k = uiScale();
      const inp = document.createElement('input');
      inp.className = 'ac-anno-input';
      inp.type = 'text';
      inp.placeholder = '输入文字后按 Enter';
      inp.style.left = Math.round(r.left + p.x / k) + 'px';
      inp.style.top = Math.round(r.top + p.y / k) + 'px';
      inp.style.font = `600 20px ${FONT}`;
      inp.style.color = color;
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        const v = inp.value.trim();
        inp.remove();
        if (ok && v) commit({ type: 'text', x: p.x, y: p.y, text: v, color, size: 2, fs: 20 });
      };
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      });
      inp.addEventListener('blur', () => finish(true));
      root.appendChild(inp);
      inp.focus();
    }

    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKey, true);
    const onResize = () => redraw();
    window.addEventListener('resize', onResize);

    // ---------- 对外 ----------
    // cb 在新图解码并画好之后触发（换底图后要重新自动复制，不能复制上一张）
    function setImage(url, cb) {
      const im = new Image();
      im.onerror = () => { if (cb) cb(); };
      im.onload = () => {
        const oldW = cv.width;
        const oldH = cv.height;
        img = im;
        const W = im.naturalWidth || im.width;
        const H = im.naturalHeight || im.height;
        for (const c of [cvBase, cv]) {
          c.width = W;
          c.height = H;
        }
        bctx.clearRect(0, 0, W, H);
        bctx.drawImage(im, 0, 0);
        // 换底图（如主题包背景开关）时尺寸会变，已有标注按比例跟着缩放，不丢
        if (oldW && oldH && (oldW !== W || oldH !== H) && shapes.length) {
          const sx = W / oldW;
          const sy = H / oldH;
          for (const sh of shapes) {
            if (sh.type === 'pen') sh.pts.forEach((p) => { p.x *= sx; p.y *= sy; });
            else if (sh.type === 'number' || sh.type === 'text') { sh.x *= sx; sh.y *= sy; }
            else { sh.x0 *= sx; sh.y0 *= sy; sh.x1 *= sx; sh.y1 *= sy; }
          }
        }
        flush();
        if (cb) cb();
      };
      im.src = url;
    }

    // 导出：底图 + 标注层合成；没有任何标注时直接返回原图 dataURL，省一次大图编码
    function exportUrl() {
      if (!img) return null;
      if (raf) flush(); // 还有没落笔的预览，先补上再合成
      if (!shapes.length) return img.src;
      const out = document.createElement('canvas');
      out.width = cv.width;
      out.height = cv.height;
      const octx = out.getContext('2d');
      octx.drawImage(cvBase, 0, 0);
      octx.drawImage(cv, 0, 0);
      return out.toDataURL('image/png');
    }

    setImage(dataUrl);

    return {
      el: stage,
      setImage,
      exportUrl,
      undo,
      clear,
      hasShapes: () => shapes.length > 0,
      onChange: (cb) => { onChange = cb; },
      destroy() {
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', onResize);
        if (raf) cancelAnimationFrame(raf);
        stage.remove();
      },
    };
  }

  globalThis.__acAnnotate = { create, COLORS, TOOLS };
})();
