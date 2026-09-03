// AnyComment 网页截图：选区 / 调度 / 合成 / 预览
// 真正的捕获动作在 background.js（chrome.debugger 只能在扩展进程调用，content script 无法 attach）
(() => {
  if (window.top !== window) return; // 只在顶级页面运行
  const card = globalThis.__acCard;
  if (!card) return;

  // 输出画布单边上限：CDP 与 Canvas 都有硬限制，整页长图靠降 clip.scale 兜住
  const MAX_OUT_PX = 8192;
  // 整页靠把视口撑到文档高度来截（见 background.js），再高 Chrome 拒绝创建那么高的视口
  const MAX_CSS_H = 16000;
  const MODES = ['selection', 'viewport', 'fullpage'];

  let host = null;
  let shadow = null;
  let cfg = { ...card.SHOT_DEFAULTS };
  let busy = false;

  chrome.storage.local.get(card.SHOT_DEFAULTS, (v) => {
    if (v) cfg = { ...card.SHOT_DEFAULTS, ...v };
  });
  // 改设置即时生效，不需要刷新页面
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const k of Object.keys(card.SHOT_DEFAULTS)) {
      if (changes[k]) cfg[k] = changes[k].newValue;
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'ac-capture-arm' && MODES.includes(msg.mode)) run(msg.mode);
  });

  function pageUrl() {
    return location.href.split('#')[0];
  }

  // 宿主元素：平时不接管任何鼠标事件，只有框选层激活时才接收
  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = 'ac-capture-host';
    host.style.cssText = 'all:initial; position:fixed; inset:0; z-index:2147483647; pointer-events:none;';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS_TEXT;
    shadow.appendChild(style);
    document.documentElement.appendChild(host);
  }

  function hideExtUi() { try { globalThis.__acUi?.hide(); } catch { /* 评论区未挂载 */ } }
  function showExtUi() { try { globalThis.__acUi?.show(); } catch { /* 评论区未挂载 */ } }

  async function run(mode) {
    if (busy) return;
    busy = true;
    ensureHost();
    shadow.querySelector('.ac-share-mask')?.remove(); // 上一次的预览不关掉会被截进新图
    hideExtUi();
    let shot = null;
    try {
      let clip = null;
      if (mode === 'selection') {
        clip = await pickRect();
        if (!clip) return; // 用户取消
      } else if (mode === 'fullpage') {
        await preScroll(); // captureBeyondViewport 不等懒加载，先滚一遍把图钓出来
        clip = fullPageClip();
        if (clip.height < docHeight()) toast(`页面过长，已截取顶部 ${clip.height}px`);
      } else {
        clip = viewportClip();
      }
      const res = await chrome.runtime.sendMessage({
        type: 'ac-capture', mode, clip,
        dpr: window.devicePixelRatio || 1, vh: Math.round(window.innerHeight),
      });
      if (!res || !res.ok || !res.data) {
        toast((res && res.error) || '截图失败');
        return;
      }
      let img = await loadImage('data:image/png;base64,' + res.data);
      // captureVisibleTab 兜底只能拿整个视口，框选结果按倍率裁出来
      if (res.via === 'visible' && mode === 'selection') img = cropToClip(img, clip);
      shot = { img, clip, res };
    } catch (e) {
      toast('截图失败：' + ((e && e.message) || e));
      return;
    } finally {
      showExtUi();
      busy = false;
    }
    try {
      const raw = 'data:image/png;base64,' + shot.res.data;
      const dataUrl = card.composeScreenshot({ img: shot.img, dataUrl: raw, url: pageUrl(), time: Date.now(), opts: cfg });
      card.showPreview(shadow, dataUrl, { alt: '网页截图', fileName: `anycomment-shot-${Date.now()}.png` });
    } catch (e) {
      toast('生成截图卡片失败');
    }
  }

  function viewportClip() {
    return {
      x: Math.round(window.scrollX),
      y: Math.round(window.scrollY),
      width: Math.round(window.innerWidth),
      height: Math.round(window.innerHeight),
      scale: 1,
    };
  }

  function docHeight() {
    const d = document.documentElement;
    return Math.max(d.scrollHeight, d.clientHeight, document.body ? document.body.scrollHeight : 0, window.innerHeight);
  }

  function fullPageClip() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(window.innerWidth);
    const height = Math.min(MAX_CSS_H, docHeight());
    // 输出像素 = clip × dpr × scale，长边超上限就整体降 scale（宁可糊一点，不要截断）
    const scale = Math.min(1, MAX_OUT_PX / (Math.max(width, height) * dpr));
    return { x: 0, y: 0, width, height, scale: Math.round(scale * 1000) / 1000 };
  }

  async function preScroll() {
    const start = window.scrollY;
    const step = Math.max(300, Math.round(window.innerHeight * 1.8));
    const total = docHeight();
    for (let y = 0, i = 0; y < total && i < 20; y += step, i++) {
      window.scrollTo(0, y);
      await raf2();
      await sleep(250);
    }
    window.scrollTo(0, total);
    await raf2();
    await sleep(250);
    window.scrollTo(0, start);
    await raf2();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = src;
    });
  }

  function cropToClip(img, clip) {
    const srcW = img.naturalWidth || img.width;
    const k = srcW / Math.max(1, Math.round(window.innerWidth));
    const x = Math.round((clip.x - window.scrollX) * k);
    const y = Math.round((clip.y - window.scrollY) * k);
    const w = Math.max(1, Math.round(clip.width * k));
    const h = Math.max(1, Math.round(clip.height * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
    return c;
  }

  // ========== 框选层 ==========

  function pickRect() {
    return new Promise((resolve) => {
      const layer = document.createElement('div');
      layer.className = 'ac-sel-layer';
      const box = document.createElement('div');
      box.className = 'ac-sel-box';
      box.style.display = 'none';
      const label = document.createElement('div');
      label.className = 'ac-sel-label';
      const hint = document.createElement('div');
      hint.className = 'ac-sel-hint';
      hint.textContent = '拖拽框选要截取的区域，松开鼠标完成 · Esc 取消';
      layer.append(box, label, hint);
      shadow.appendChild(layer);
      layer.style.pointerEvents = 'auto';

      let startX = 0;
      let startY = 0;
      let dragging = false;
      let rect = null;

      const draw = (e) => {
        const x = Math.min(startX, e.clientX);
        const y = Math.min(startY, e.clientY);
        const w = Math.abs(e.clientX - startX);
        const h = Math.abs(e.clientY - startY);
        rect = { x, y, w, h };
        box.style.display = '';
        box.style.left = x + 'px';
        box.style.top = y + 'px';
        box.style.width = w + 'px';
        box.style.height = h + 'px';
        label.style.display = '';
        label.style.left = x + 'px';
        label.style.top = (y > 26 ? y - 24 : y + h + 6) + 'px';
        label.textContent = Math.round(w * (window.devicePixelRatio || 1)) + ' × ' + Math.round(h * (window.devicePixelRatio || 1));
      };

      const onDown = (e) => {
        if (e.button !== 0) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        try { layer.setPointerCapture(e.pointerId); } catch { /* 老版本不支持 */ }
        e.preventDefault();
      };
      const onMove = (e) => { if (dragging) draw(e); };
      const finish = () => {
        cleanup();
        // 小于 10 CSS px 视为误点
        if (rect && rect.w >= 10 && rect.h >= 10) {
          resolve({
            x: Math.round(rect.x + window.scrollX),
            y: Math.round(rect.y + window.scrollY),
            width: Math.round(rect.w),
            height: Math.round(rect.h),
            scale: 1,
          });
        } else {
          resolve(null);
        }
      };
      const onUp = () => { if (dragging) finish(); };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          cleanup();
          resolve(null);
        }
      };
      function cleanup() {
        layer.removeEventListener('pointerdown', onDown);
        layer.removeEventListener('pointermove', onMove);
        layer.removeEventListener('pointerup', onUp);
        layer.removeEventListener('pointercancel', onUp);
        window.removeEventListener('keydown', onKey, true);
        layer.remove();
      }

      layer.addEventListener('pointerdown', onDown);
      layer.addEventListener('pointermove', onMove);
      layer.addEventListener('pointerup', onUp);
      layer.addEventListener('pointercancel', onUp);
      window.addEventListener('keydown', onKey, true);
    });
  }

  function toast(message) {
    const t = document.createElement('div');
    t.className = 'ac-shot-toast';
    t.textContent = message;
    shadow.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  const CSS_TEXT = `
    :host { all: initial; }
    .ac-sel-layer {
      position: fixed; inset: 0; cursor: crosshair; touch-action: none;
      background: rgba(15,18,28,.12);
      font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .ac-sel-box {
      position: fixed; border: 1px solid #2f6bff; background: rgba(255,255,255,.14);
      box-shadow: 0 0 0 9999px rgba(15,18,28,.34); pointer-events: none;
    }
    .ac-sel-label {
      position: fixed; padding: 2px 7px; border-radius: 5px; background: #2f6bff; color: #fff;
      font: 600 11px/16px system-ui, sans-serif; pointer-events: none;
    }
    .ac-sel-hint {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
      padding: 7px 14px; border-radius: 16px; background: rgba(15,18,28,.78); color: #fff;
      font: 500 12px/1 system-ui, sans-serif; pointer-events: none; white-space: nowrap;
    }
    .ac-shot-toast {
      position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
      padding: 10px 20px; border-radius: 8px; background: rgba(0,0,0,.8); color: #fff;
      font: 14px/1.4 system-ui, sans-serif; pointer-events: none;
    }
  `;
})();
