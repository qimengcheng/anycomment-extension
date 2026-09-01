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

// 手动检查更新（直接在popup里调用API，不依赖background消息传递）
async function checkUpdateNow() {
  $('checkUpdateNow').textContent = '检查中...';
  $('checkUpdateNow').disabled = true;
  try {
    const res = await fetch('https://api.github.com/repos/qimengcheng/anycomment-extension/releases/latest', { cache: 'no-store' });
    if (!res.ok) throw new Error('网络错误');
    const data = await res.json();
    const latest = data.tag_name ? data.tag_name.replace(/^v/, '') : null;
    if (!latest) throw new Error('获取版本失败');

    const hasUpdate = compareVersion(latest, currentVersion) > 0;
    const updateUrl = data.html_url || 'https://github.com/qimengcheng/anycomment-extension/releases';

    // 保存到storage，供background自动检查和下次打开popup时读取
    chrome.storage.local.set({
      update_available: hasUpdate,
      latest_version: latest,
      update_url: updateUrl,
      last_check: Date.now(),
    });

    // 更新UI
    if (hasUpdate) {
      $('updateBar').classList.add('show');
      $('latestVersion').textContent = latest;
      $('checkUpdateNow').textContent = '发现新版本';
    } else {
      $('updateBar').classList.remove('show');
      $('checkUpdateNow').textContent = '已是最新';
    }
    setTimeout(() => {
      $('checkUpdateNow').textContent = '检查更新';
      $('checkUpdateNow').disabled = false;
    }, 2000);
  } catch (e) {
    $('checkUpdateNow').textContent = '检查失败';
    setTimeout(() => {
      $('checkUpdateNow').textContent = '检查更新';
      $('checkUpdateNow').disabled = false;
    }, 2000);
  }
}

$('checkUpdateNow').addEventListener('click', checkUpdateNow);
$('checkLink').addEventListener('click', checkUpdateNow);

// 页面加载时刷新更新状态
refreshUpdateUI();