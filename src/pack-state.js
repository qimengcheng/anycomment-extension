// 主题包引擎「当前胜出包」的共享状态槽（原 globalThis.__acThemePack）。
// themepacks.js 的 publish() 写入；card.js / content.js / capture.js / options.js 同步读取。
export const packState = { active: null };
