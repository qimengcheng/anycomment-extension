// ========== 自动刷新标签页 ==========
// popup 开关按 tab 粒度设置：chrome.alarms（最小周期 0.5 分钟 = 30 秒）到期后
// chrome.tabs.reload 该标签页。状态 { tabId: intervalSec } 落 storage.local 持久化，
// tab 关闭时清理；扩展重载/浏览器重启会清掉 alarms，onInstalled/onStartup 里按存储重建。
const AR_PREFIX = 'ac-autorefresh-';
const AR_MIN_SEC = 30;
let arTabs = null; // SW 内存缓存，首次访问从 storage 读

async function arLoad() {
  if (arTabs) return arTabs;
  const r = await chrome.storage.local.get({ autorefresh_tabs: {} });
  arTabs = r.autorefresh_tabs || {};
  return arTabs;
}

function arSave() {
  chrome.storage.local.set({ autorefresh_tabs: arTabs || {} });
}

// intervalSec > 0 开启，0 关闭；返回最终生效间隔（可能被钳到下限）
async function arSet(tabId, intervalSec) {
  const tabs = await arLoad();
  const sec = Number(intervalSec) || 0;
  if (sec > 0) {
    const eff = Math.max(AR_MIN_SEC, sec);
    tabs[tabId] = eff;
    // Chrome 120 起闹钟最小周期 0.5 分钟，更小的值会被浏览器强制钳到 0.5，行为一致
    chrome.alarms.create(AR_PREFIX + tabId, { periodInMinutes: Math.max(0.5, eff / 60) });
    // 角标显示间隔，让用户不用开 popup 也能确认这个 tab 还开着自动刷新
    chrome.action.setBadgeText({ text: eff >= 60 ? Math.round(eff / 60) + 'm' : eff + 's', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#1a9c5b', tabId });
  } else {
    delete tabs[tabId];
    chrome.alarms.clear(AR_PREFIX + tabId);
    chrome.action.setBadgeText({ text: '', tabId });
  }
  arSave();
  return tabs[tabId] || 0;
}

// 扩展重载 / 浏览器重启后 alarms 丢失，按存储重建（create 同名闹钟 = 重置周期，仅在生命周期事件里调）
async function arReconcile() {
  const tabs = await arLoad();
  for (const id of Object.keys(tabs)) {
    await arSet(Number(id), tabs[id]);
  }
}

async function arCleanupIfGone(tabId) {
  const tabs = await arLoad();
  if (tabs[tabId] !== undefined) {
    delete tabs[tabId];
    arSave();
  }
  chrome.alarms.clear(AR_PREFIX + tabId);
  chrome.action.setBadgeText({ text: '', tabId });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  // 没加载过状态时只清闹钟，避免每个无关 tab 关闭都触发一次 storage 读
  if (arTabs) arCleanupIfGone(tabId);
  else chrome.alarms.clear(AR_PREFIX + tabId);
});

// 安装时写入默认配置
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get({ enabled: true }, (cfg) => {
    if (cfg.enabled === undefined) {
      chrome.storage.local.set({ enabled: true });
    }
  });
  // 闹钟在生命周期事件中创建（模块顶层会在 service worker 每次唤醒时重复执行）
  chrome.alarms.create('check-update', { periodInMinutes: 1440 });
  arReconcile();
  // 安装后立即检查一次更新
  checkUpdate();
});

// ========== 网页截图 ==========
// 实际捕获只能在扩展进程做（chrome.debugger 不允许 content script attach），
// content 侧负责选区/预滚动/隐藏自身 UI，这里只是 CDP 代理 + 失败兜底。

const COMMAND_MODES = {
  'capture-selection': 'selection',
  'capture-viewport': 'viewport',
  'capture-fullpage': 'fullpage',
};

// 快捷键：Chrome 直接给出命令来源的 tab，不要再用 tabs.query 猜
chrome.commands.onCommand.addListener((command, tab) => {
  const mode = COMMAND_MODES[command];
  if (!mode || !tab || tab.id === undefined) return;
  armCapture(tab.id, mode);
});

async function armCapture(tabId, mode) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ac-capture-arm', mode });
  } catch (e) {
    // 页面里没有可注入的扩展进程（浏览器内部页 / 应用商店页 / 刚刷新还没注入完）
    flashBadgeError(tabId);
  }
}

// 不给 chrome:// 页面弹通知（需要 notifications 权限），用 tab 级角标提示
function flashBadgeError(tabId) {
  chrome.action.setBadgeText({ text: '!', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#c03538', tabId });
  setTimeout(() => { chrome.action.setBadgeText({ text: '', tabId }); }, 2500);
}

// clip 是文档 CSS 像素坐标系（CDP 实测：captureBeyondViewport true/false 都是文档坐标系），
// 输出像素 = clip 尺寸 × devicePixelRatio × clip.scale，所以 scale 由 content 侧按页面高度反算。
// 注意不要拿 Page.getLayoutMetrics 的 cssVisualViewport 反过来纠正 clip：实测它的
// clientWidth/clientHeight 不含滚动条，且 attach 后调试横幅还会再把视口压矮约 47px，
// 用它重算会得到一张比用户按快捷键时更小（右侧少一条）的图。
//
// selection / viewport 默认走 chrome.tabs.captureVisibleTab：不 attach debugger、不弹顶部
// 「AnyComment 网页评论 已开始调试此浏览器」横幅，框选由 content 侧 cropToClip 按 clip 裁。
// 整页（屏外）必须 CDP；captureVisibleTab 在受限页面被拒时也兜底走 CDP（会弹横幅，但比截不上强）。
async function runCapture({ tabId, windowId, mode, clip, dpr = 1, vh = 0 }) {
  if (mode !== 'fullpage' && windowId !== undefined) {
    try {
      const url = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      const data = String(url).split(',')[1] || '';
      if (data) return { ok: true, data, via: 'visible', clip };
      // 空数据走下面的 CDP 兜底
    } catch { /* captureVisibleTab 被拒，降级到 CDP */ }
  }
  const target = { tabId };
  let attached = false;
  let override = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    attached = true;
    await chrome.debugger.sendCommand(target, 'Page.enable');
    // 整页：captureBeyondViewport 只重现合成器已经光栅化过的瓦片，屏外没画过的地方
    // 会把当前视口整块平铺进长图（实测每 900px 重复一次）。DevTools 自己的"捕获整页"
    // 是先把视口撑到全文档高度再截，这里照做——顺带让 fixed 元素不再在长图里重复出现。
    if (mode === 'fullpage' && clip.height > vh + 2) {
      await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
        width: clip.width,
        height: clip.height,
        deviceScaleFactor: dpr || 1,
        mobile: false,
      });
      override = true;
      await new Promise((r) => setTimeout(r, 350)); // 等一次重排 + 光栅化
    }
    const shot = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png',
      // 屏外区域只有 beyond:true 才会真正渲染（实测 beyond:false 截到的是空白/错位）
      captureBeyondViewport: true,
      clip,
    });
    return { ok: true, data: shot.data, via: 'cdp', clip };
  } catch (e) {
    return { ok: false, error: classifyCaptureError(e), via: 'none' };
  } finally {
    if (override) {
      try { await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride'); } catch { /* 已断开 */ }
    }
    // MV3 service worker 随时可能被回收，attach 状态必须成对释放
    if (attached) {
      try { await chrome.debugger.detach(target); } catch { /* 已断开 */ }
    }
  }
}

function classifyCaptureError(e) {
  const m = String((e && e.message) || e || '');
  if (/Cannot access a (chrome|edge|devtools|chrome-extension|moz-extension)/i.test(m)) return '此页面不允许截图（浏览器内部页面）';
  if (/Another debugger is already attached/i.test(m)) return '该标签页已被 DevTools 占用，请先关闭开发者工具';
  if (/debugger/i.test(m) && /permission|denied/i.test(m)) return '截图权限被拒绝';
  return '截图失败：' + (m || '未知错误');
}

// 监听来自 popup 的手动检查更新请求 / 来自 content 与 popup 的截图请求
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'check-update-now') {
    checkUpdate().then(() => sendResponse({ ok: true }));
    return true; // 异步响应
  }
  if (msg.type === 'ac-capture') {
    const tab = sender.tab || {};
    runCapture({ tabId: tab.id, windowId: tab.windowId, mode: msg.mode, clip: msg.clip, dpr: msg.dpr, vh: msg.vh })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: classifyCaptureError(e) }));
    return true; // 异步响应
  }
  if (msg.type === 'ac-autorefresh-get') {
    arLoad().then((tabs) => {
      sendResponse({ ok: true, interval: tabs[msg.tabId] || 0 });
    });
    return true; // 异步响应
  }
  if (msg.type === 'ac-autorefresh-set') {
    if (typeof msg.tabId !== 'number') {
      sendResponse({ ok: false });
      return;
    }
    arSet(msg.tabId, msg.intervalSec).then((interval) => sendResponse({ ok: true, interval }));
    return true; // 异步响应
  }
  if (msg.type === 'ac-arm-capture') {
    // popup 已带上它所在标签页；拿不到时才回退查最后聚焦窗口的活动标签
    if (typeof msg.tabId === 'number') {
      armCapture(msg.tabId, msg.mode || 'viewport');
      sendResponse({ ok: true });
      return;
    }
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([tab]) => {
      if (tab && tab.id !== undefined) armCapture(tab.id, msg.mode || 'viewport');
      sendResponse({ ok: !!(tab && tab.id !== undefined) });
    });
    return true;
  }
});

// 浏览器启动时检查更新（旧版 Chrome 闹钟不跨会话，这里幂等补建一次）
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('check-update', { periodInMinutes: 1440 });
  arReconcile();
  checkUpdate();
});

// 每天检查一次更新（闹钟创建见上方 onInstalled/onStartup）
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'check-update') {
    checkUpdate();
    return;
  }
  if (alarm.name.startsWith(AR_PREFIX)) {
    const tabId = Number(alarm.name.slice(AR_PREFIX.length));
    if (!Number.isInteger(tabId)) return;
    chrome.tabs.get(tabId).then((tab) => {
      // 已被丢弃的休眠标签页重载没意义，直接清理
      if (tab && !tab.discarded) chrome.tabs.reload(tabId);
      else arCleanupIfGone(tabId);
    }).catch(() => arCleanupIfGone(tabId));
  }
});

// 检查更新：通过 GitHub API 获取最新 release 版本
async function checkUpdate() {
  try {
    const current = chrome.runtime.getManifest().version;
    const res = await fetch('https://anycomment.qimengcheng-47e.workers.dev/api/extension/latest');
    if (!res.ok) return;
    const data = await res.json();
    const latest = data.version;
    if (!latest) return;

    const hasUpdate = compareVersion(latest, current) > 0;
    chrome.storage.local.set({
      update_available: hasUpdate,
      latest_version: latest,
      update_url: data.url || 'https://github.com/qimengcheng/anycomment-extension/releases',
      download_url: data.download_url || '',
      last_check: Date.now(),
    });

    // 有新版本时在扩展图标上显示角标
    if (hasUpdate) {
      chrome.action.setBadgeText({ text: '•' });
      chrome.action.setBadgeBackgroundColor({ color: '#4f6ef7' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) {
    // 静默失败，网络问题不影响使用
  }
}

// 版本号比较：返回 1 表示 a > b，-1 表示 a < b，0 表示相等
function compareVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}
