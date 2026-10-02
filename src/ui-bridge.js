// 评论侧栏 UI 的跨模块句柄（原 globalThis.__acUi）。
// content.js 挂载后写入 impl；capture.js 截图前调用 hide()/show() 隐藏/恢复自身浮层。
export const uiBridge = { impl: null };
