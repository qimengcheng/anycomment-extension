const DEFAULT_SERVER = 'https://anycomment.qimengcheng-47e.workers.dev';
const $ = (id) => document.getElementById(id);

const currentVersion = chrome.runtime.getManifest().version;
$('currentVersion').textContent = currentVersion;
$('versionText').textContent = currentVersion;

chrome.storage.local.get({ enabled: true }, (cfg) => {
  $('enabled').checked = cfg.enabled;
});

// 开关切换后即时保存，无需单独保存按钮
$('enabled').addEventListener('change', () => {
  chrome.storage.local.set({ enabled: $('enabled').checked });
});

// 个人中心：默认打开当前用户的全屏个人中心页；未登录则先进入登录页
$('profile').addEventListener('click', () => {
  chrome.storage.local.get({ ac_user: null }, (r) => {
    const uid = r.ac_user ? r.ac_user.id : null;
    const url = uid
      ? `${DEFAULT_SERVER}/profile?profile=${encodeURIComponent(uid)}`
      : `${DEFAULT_SERVER}/login`;
    chrome.tabs.create({ url });
  });
});

// 检查更新状态并显示
function refreshUpdateUI() {
  chrome.storage.local.get({ update_available: false, latest_version: '', update_url: '' }, (r) => {
    if (r.update_available && r.latest_version) {
      $('updateBar').classList.add('show');
      $('latestVersion').textContent = r.latest_version;
    } else {
      $('updateBar').classList.remove('show');
    }
  });
}

// 下载更新按钮
$('downloadUpdate').addEventListener('click', () => {
  chrome.storage.local.get({ update_url: 'https://github.com/qimengcheng/anycomment-extension/releases' }, (r) => {
    chrome.tabs.create({ url: r.update_url });
  });
});

// 手动检查更新
function checkUpdateNow() {
  $('checkUpdateNow').textContent = '检查中...';
  $('checkUpdateNow').disabled = true;
  chrome.runtime.sendMessage({ type: 'check-update-now' }, () => {
    setTimeout(() => {
      refreshUpdateUI();
      $('checkUpdateNow').textContent = '检查更新';
      $('checkUpdateNow').disabled = false;
      // 如果没有更新，提示一下
      chrome.storage.local.get({ update_available: false }, (r) => {
        if (!r.update_available) {
          $('checkUpdateNow').textContent = '已是最新';
          setTimeout(() => { $('checkUpdateNow').textContent = '检查更新'; }, 2000);
        }
      });
    }, 1500);
  });
}

$('checkUpdateNow').addEventListener('click', checkUpdateNow);
$('checkLink').addEventListener('click', checkUpdateNow);

// 页面加载时刷新更新状态
refreshUpdateUI();