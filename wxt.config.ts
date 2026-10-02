import { defineConfig } from 'wxt';

// 版本号唯一来源：apps/extension/package.json 的 version（WXT 构建时写入 manifest）。
export default defineConfig({
  manifest: {
    name: 'AnyComment 网页评论',
    description: '在任意网页右侧展开评论区，发表评论、回复他人、参与讨论。',
    permissions: ['storage', 'alarms', 'downloads', 'clipboardWrite', 'debugger', 'activeTab'],
    host_permissions: [
      'https://anycomment.qimengcheng-47e.workers.dev/*',
      'https://anycomment-flower-pack.pages.dev/*',
      'https://anycomment-monet-pack.pages.dev/*',
      'https://anycomment-star-pack.pages.dev/*',
      'https://anycomment-geo-pack.pages.dev/*',
      'https://anycomment-festival-pack.pages.dev/*',
    ],
    commands: {
      'capture-selection': {
        suggested_key: { default: 'Ctrl+Shift+1' },
        description: '框选区域截图',
      },
      'capture-viewport': {
        suggested_key: { default: 'Ctrl+Shift+2' },
        description: '截取当前屏幕区域',
      },
      'capture-fullpage': {
        suggested_key: { default: 'Ctrl+Shift+3' },
        description: '截取完整页面',
      },
    },
    action: {
      default_popup: '/popup/index.html',
      default_title: 'AnyComment 设置',
    },
    options_ui: {
      // 目录特意叫 settings 而非 options：WXT 对名为 options 的 HTML 入口会自动接管 options_ui
      // 并把 open_in_tab 覆盖为 false。此处显式接管，保持「在新标签页打开」。
      page: '/settings.html',
      open_in_tab: true,
    },
    icons: {
      16: '/icons/icon16.png',
      48: '/icons/icon48.png',
      128: '/icons/icon128.png',
    },
  },
});
