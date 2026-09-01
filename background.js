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
    const res = await fetch('https://api.github.com/repos/qimengcheng/anycomment-extension/releases/latest');
    if (!res.ok) return;
    const data = await res.json();
    const latest = data.tag_name ? data.tag_name.replace(/^v/, '') : null;
    if (!latest) return;

    const hasUpdate = compareVersion(latest, current) > 0;
    chrome.storage.local.set({
      update_available: hasUpdate,
      latest_version: latest,
      update_url: data.html_url || 'https://github.com/qimengcheng/anycomment/releases',
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
