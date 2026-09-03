// 安装时写入默认配置
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get({ enabled: true }, (cfg) => {
    if (cfg.enabled === undefined) {
      chrome.storage.local.set({ enabled: true });
    }
  });
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
async function runCapture({ tabId, windowId, mode, clip, dpr = 1, vh = 0 }) {
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
    const err = classifyCaptureError(e);
    // 视口/框选退回 captureVisibleTab（只能拿当前可见区域，content 侧再按 k 裁剪）
    if (mode !== 'fullpage' && windowId !== undefined) {
      try {
        const url = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
        return { ok: true, data: String(url).split(',')[1] || '', via: 'visible', clip };
      } catch { /* 用 CDP 的错误文案返回 */ }
    }
    return { ok: false, error: err, via: 'none' };
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

// 浏览器启动时检查更新
chrome.runtime.onStartup.addListener(() => {
  checkUpdate();
});

// 每天检查一次更新（闹钟）
chrome.alarms.create('check-update', { periodInMinutes: 1440 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'check-update') {
    checkUpdate();
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

// 监听来自 popup 的手动检查更新请求
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'check-update-now') {
    checkUpdate().then(() => sendResponse({ ok: true }));
    return true; // 异步响应
  }
});
