// 内容脚本入口壳：content.js（评论侧栏）与 capture.js（截图）合并为同一 bundle，
// 二者原有的「同隔离世界 globalThis 桥」已升级为显式 import（见 src/ui-bridge.js 等）。
// main() 在各模块顶层求值之后执行；两文件内部已按 window.top 自行守卫。
import '../src/content.js';
import '../src/capture.js';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_idle',
  main() {
    // 副作用全部在模块顶层完成，此处留空
  },
});
