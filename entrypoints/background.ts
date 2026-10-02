// 后台 service worker 入口壳：chrome.* 事件监听在 src/background.js 的模块顶层注册，
// SW 启动即求值本模块图，与旧版 manifest 直载 background.js 的时序等价。
import '../src/background.js';

export default defineBackground(() => {
  // 逻辑全部在模块顶层（见 src/background.js），此处留空
});
