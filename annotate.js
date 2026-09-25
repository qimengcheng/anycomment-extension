// AnyComment 分享图标注（微信截图同款）：箭头 / 直线 / 矩形 / 椭圆 / 画笔 / 马赛克 / 文字 / 序号
// 与 card.js 的 showPreview 协作：底层 canvas 画原图，上层 canvas 画标注，导出时两层合成。
// 所有形状坐标存「原图像素」，线宽/字号存「屏幕像素」，绘制时乘 uiScale() 换算，
// 这样长图（整页截图）被缩到视口高度预览时，笔触粗细与最终导出一致。
(() => {
  const FONT = '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
  const COLORS = ['#e5342c', '#ff8c1a', '#ffc60a', '#22c55e', '#2f6bff', '#8b5cf6', '#1f2430', '#ffffff'];
  const SIZES = [
    { v: 2, label: '细', d: 4 },
    { v: 4, label: '中', d: 8 },
    { v: 7, label: '粗', d: 12 },
  ];
  // 序号工具：点击处画一个带数字的圆点，数字自动递增
  const TOOLS = [
    { id: 'arrow', label: '箭头', svg: '<path d="M2.6 13.4 L13.2 2.8"/><path d="M7.6 2.8 H13.2 V8.4"/>' },
    { id: 'line', label: '直线', svg: '<path d="M2.6 13.4 L13.4 2.6"/>' },
    { id: 'rect', label: '矩形', svg: '<rect x="2.6" y="3.4" width="10.8" height="9.2" rx="1.4"/>' },
    { id: 'ellipse', label: '椭圆', svg: '<ellipse cx="8" cy="8" rx="6.2" ry="5.2"/>' },
    { id: 'pen', label: '画笔', svg: '<path d="M3 13l1.2-3.6L10.6 3l2.6 2.6L6.8 12.9z"/>' },
    { id: 'mosaic', label: '马赛克', fill: true, svg: '<path d="M2.6 2.6h4.8v4.8H2.6zM8.6 2.6h4.8v4.8H8.6zM2.6 8.6h4.8v4.8H2.6zM8.6 8.6h4.8v4.8H8.6z"/>' },
    { id: 'text', label: '文字', svg: '<path d="M3 3.6h10"/><path d="M8 3.6v8.8"/>' },
    { id: 'number', label: '序号', svg: '<circle cx="8" cy="8" r="6"/><text x="8" y="11.4" font-size="9" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">1</text>' },
    { id: 'sticker', label: '贴纸', svg: '<path d="M2 4h8l4 4v6a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M5 7l1.5 2 2-1.5-1.5 2 2 .8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' },
  ];

  // 内置手账贴纸库：原创 SVG 设计，清新手绘风格
  // 每个贴纸用 SVG 字符串定义，运行时转为 Image 对象缓存
  const STICKER_SVG = {
    // ---------- 装饰小物 ----------
    star_pink: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 6l6.5 18.5L57 27l-15 12 5.5 19L32 47l-15.5 11 5.5-19L7 27l18.5-2.5z" fill="#ff8fab" stroke="#e05780" stroke-width="2" stroke-linejoin="round"/><circle cx="26" cy="24" r="2.5" fill="#fff" opacity=".7"/></svg>`,
    heart_red: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 54s-22-13-22-30a14 14 0 0126-8 14 14 0 0126 8c0 17-22 30-22 30z" fill="#ff6b6b" stroke="#d64545" stroke-width="2" stroke-linejoin="round"/><ellipse cx="22" cy="22" rx="4" ry="3" fill="#fff" opacity=".45" transform="rotate(-25 22 22)"/></svg>`,
    flower_yellow: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="#ffd93d" stroke="#f5a623" stroke-width="2" stroke-linejoin="round"><ellipse cx="32" cy="14" rx="8" ry="12"/><ellipse cx="50" cy="32" rx="12" ry="8"/><ellipse cx="32" cy="50" rx="8" ry="12"/><ellipse cx="14" cy="32" rx="12" ry="8"/></g><circle cx="32" cy="32" r="10" fill="#ff8c42" stroke="#e67329" stroke-width="2"/><circle cx="29" cy="29" r="2.5" fill="#fff" opacity=".5"/></svg>`,
    bow_pink: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M12 22c0-8 10-12 18-6l2 4 2-4c8-6 18-2 18 6 0 8-12 14-20 10l-2-4-2 4c-8 4-20-2-20-10z" fill="#ff8fab" stroke="#e05780" stroke-width="2" stroke-linejoin="round"/><rect x="28" y="24" width="8" height="16" rx="2" fill="#ff6b95" stroke="#e05780" stroke-width="2"/><path d="M28 38l-6 14M36 38l6 14" stroke="#e05780" stroke-width="2" stroke-linecap="round"/></svg>`,
    leaf_green: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M12 52c0-22 18-40 40-40 0 22-18 40-40 40z" fill="#7ec850" stroke="#5ba336" stroke-width="2" stroke-linejoin="round"/><path d="M14 50L50 14" stroke="#5ba336" stroke-width="2" stroke-linecap="round"/><path d="M20 40l8-8M26 46l10-10M16 34l6-6" stroke="#5ba336" stroke-width="1.5" stroke-linecap="round" opacity=".7"/></svg>`,
    cloud_blue: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M18 44c-8 0-12-6-10-13 2-6 7-9 13-9 1-7 7-12 15-12 8 0 14 5 16 12 7 1 12 6 12 13s-6 12-13 12H18z" fill="#a8d8ff" stroke="#6ba8e0" stroke-width="2" stroke-linejoin="round"/><ellipse cx="24" cy="26" rx="6" ry="4" fill="#fff" opacity=".5"/></svg>`,
    rainbow: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="none" stroke-width="5" stroke-linecap="round"><path d="M8 48a24 24 0 0148 0" stroke="#ff6b6b"/><path d="M14 48a18 18 0 0136 0" stroke="#ffd93d"/><path d="M20 48a12 12 0 0124 0" stroke="#7ec850"/><path d="M26 48a6 6 0 0112 0" stroke="#6ba8e0"/></g></svg>`,
    sparkle_yellow: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="#ffd93d" stroke="#f5a623" stroke-width="2" stroke-linejoin="round"><path d="M32 6l4 22 22 4-22 4-4 22-4-22-22-4 22-4z"/><path d="M50 16l2 8 8 2-8 2-2 8-2-8-8-2 8-2z" transform="translate(0 28)"/></g></svg>`,
    clover: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="#7ec850" stroke="#5ba336" stroke-width="2" stroke-linejoin="round"><ellipse cx="32" cy="20" rx="12" ry="14"/><ellipse cx="44" cy="32" rx="14" ry="12"/><ellipse cx="32" cy="44" rx="12" ry="14"/><ellipse cx="20" cy="32" rx="14" ry="12"/></g><path d="M32 48v10" stroke="#5ba336" stroke-width="3" stroke-linecap="round"/></svg>`,
    balloon_pink: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><ellipse cx="32" cy="26" rx="18" ry="22" fill="#ff8fab" stroke="#e05780" stroke-width="2"/><ellipse cx="24" cy="18" rx="5" ry="7" fill="#fff" opacity=".45" transform="rotate(-20 24 18)"/><path d="M32 48l-2 4h4l-2-4z" fill="#e05780"/><path d="M32 52c0 4-4 6-4 10" stroke="#8a90a5" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>`,
    gift_box: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="10" y="24" width="44" height="32" rx="3" fill="#ffd93d" stroke="#f5a623" stroke-width="2"/><rect x="10" y="20" width="44" height="10" rx="2" fill="#ff8c42" stroke="#e67329" stroke-width="2"/><rect x="28" y="20" width="8" height="36" fill="#ff6b6b" stroke="#d64545" stroke-width="1.5"/><path d="M32 20c-8-8-16-4-16 4 0 6 10 6 16 0M32 20c8-8 16-4 16 4 0 6-10 6-16 0" fill="#ff6b6b" stroke="#d64545" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
    crystal: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 6l20 18-12 34H24L12 24z" fill="#a8d8ff" stroke="#6ba8e0" stroke-width="2" stroke-linejoin="round"/><path d="M12 24h40M32 6v52M20 24l12 34M44 24L32 58" stroke="#6ba8e0" stroke-width="1.5" opacity=".5"/><path d="M20 14l6 6" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".6"/></svg>`,

    // ---------- 标签/对话框 ----------
    tag_blue: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M8 18h32l16 16-16 16H8a2 2 0 01-2-2V20a2 2 0 012-2z" fill="#6ba8e0" stroke="#4a8cc7" stroke-width="2" stroke-linejoin="round"/><circle cx="18" cy="32" r="4" fill="#fff" opacity=".6"/></svg>`,
    speech_pink: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M12 16h40a4 4 0 014 4v20a4 4 0 01-4 4H28l-10 8v-8H12a4 4 0 01-4-4V20a4 4 0 014-4z" fill="#ffc1d6" stroke="#e07ba0" stroke-width="2" stroke-linejoin="round"/></svg>`,
    sticky_note: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M10 10h38l6 6v38a2 2 0 01-2 2H10a2 2 0 01-2-2V12a2 2 0 012-2z" fill="#fff59e" stroke="#e0c840" stroke-width="2" stroke-linejoin="round"/><path d="M48 10v6h6" stroke="#e0c840" stroke-width="2" stroke-linejoin="round"/><path d="M16 24h24M16 32h28M16 40h20M16 48h16" stroke="#d4b830" stroke-width="1.5" stroke-linecap="round" opacity=".6"/></svg>`,
    flag_red: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M16 8v48" stroke="#8a90a5" stroke-width="3" stroke-linecap="round"/><path d="M16 10h34l-6 8 6 8H16z" fill="#ff6b6b" stroke="#d64545" stroke-width="2" stroke-linejoin="round"/></svg>`,
    tape_pink: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><rect x="0" y="8" width="64" height="16" fill="#ffc1d6" opacity=".85"/><path d="M0 8h64v16H0z" fill="url(#tp)" opacity=".5"/><defs><pattern id="tp" width="8" height="16" patternUnits="userSpaceOnUse"><path d="M0 0h4v16H0z" fill="#fff" opacity=".3"/></pattern></defs></svg>`,
    tape_blue: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><rect x="0" y="8" width="64" height="16" fill="#a8d8ff" opacity=".85"/><defs><pattern id="tb" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="5" cy="5" r="1.5" fill="#fff" opacity=".5"/></pattern></defs><rect x="0" y="8" width="64" height="16" fill="url(#tb)" opacity=".6"/></svg>`,
    tape_yellow: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><rect x="0" y="8" width="64" height="16" fill="#ffe08a" opacity=".85"/><defs><pattern id="ty" width="6" height="16" patternUnits="userSpaceOnUse"><path d="M3 0v16" stroke="#fff" stroke-width="1.5" opacity=".5"/></pattern></defs><rect x="0" y="8" width="64" height="16" fill="url(#ty)" opacity=".6"/></svg>`,
    tape_green: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><rect x="0" y="8" width="64" height="16" fill="#b8e0a0" opacity=".85"/><defs><pattern id="tg" width="12" height="12" patternUnits="userSpaceOnUse"><path d="M0 6l6-6 6 6-6 6z" fill="#fff" opacity=".35"/></pattern></defs><rect x="0" y="8" width="64" height="16" fill="url(#tg)" opacity=".6"/></svg>`,

    // ---------- 生活元素 ----------
    coffee: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M16 20h28v26a6 6 0 01-6 6H22a6 6 0 01-6-6V20z" fill="#f5e6d3" stroke="#c4a77d" stroke-width="2" stroke-linejoin="round"/><path d="M44 24h6a6 6 0 010 12h-6" fill="none" stroke="#c4a77d" stroke-width="2" stroke-linecap="round"/><ellipse cx="30" cy="20" rx="14" ry="4" fill="#8b5a3c" stroke="#6b4226" stroke-width="2"/><g fill="none" stroke="#a89078" stroke-width="2" stroke-linecap="round"><path d="M22 10c0-4 4-6 4-10M30 10c0-4 4-6 4-10M38 10c0-4 4-6 4-10"/></g></svg>`,
    camera: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="8" y="18" width="48" height="36" rx="4" fill="#5b6172" stroke="#3d4150" stroke-width="2"/><path d="M18 18l4-6h20l4 6" fill="#5b6172" stroke="#3d4150" stroke-width="2" stroke-linejoin="round"/><circle cx="32" cy="36" r="12" fill="#fff" stroke="#3d4150" stroke-width="2"/><circle cx="32" cy="36" r="7" fill="#2f6bff" stroke="#1f4fcc" stroke-width="2"/><circle cx="48" cy="26" r="3" fill="#ff6b6b" stroke="#d64545" stroke-width="1.5"/></svg>`,
    music_note: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M28 10l20-4v30" stroke="#8b5cf6" stroke-width="3" stroke-linecap="round" fill="none"/><ellipse cx="24" cy="40" rx="10" ry="12" fill="#8b5cf6" stroke="#6d47d9" stroke-width="2"/><ellipse cx="44" cy="36" rx="8" ry="10" fill="#a78bfa" stroke="#8b5cf6" stroke-width="2"/><path d="M48 36V6l-20 4v30" stroke="#6d47d9" stroke-width="2" stroke-linecap="round" fill="none"/></svg>`,
    book: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M10 14h20v38c-6 0-12-2-16-6V16a2 2 0 012-2zM54 14H34v38c6 0 12-2 16-6V16a2 2 0 00-2-2z" fill="#ff8c42" stroke="#e67329" stroke-width="2" stroke-linejoin="round"/><path d="M32 14v38" stroke="#e67329" stroke-width="2"/><path d="M16 22h12M16 28h12M16 34h10M36 22h12M36 28h12M36 34h10" stroke="#c45e20" stroke-width="1.5" stroke-linecap="round" opacity=".7"/></svg>`,
    envelope: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="8" y="16" width="48" height="32" rx="3" fill="#fff" stroke="#8a90a5" stroke-width="2"/><path d="M8 18l24 20 24-20" fill="none" stroke="#8a90a5" stroke-width="2" stroke-linejoin="round"/><circle cx="46" cy="40" r="6" fill="#ff6b6b" stroke="#d64545" stroke-width="1.5"/><text x="46" y="43" font-size="9" font-weight="bold" fill="#fff" text-anchor="middle">3</text></svg>`,
    bulb: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 10c-10 0-18 8-18 18 0 8 5 13 8 17l2 5h16l2-5c3-4 8-9 8-17 0-10-8-18-18-18z" fill="#ffd93d" stroke="#f5a623" stroke-width="2" stroke-linejoin="round"/><rect x="26" y="50" width="12" height="4" rx="1" fill="#8a90a5" stroke="#6b7080" stroke-width="1.5"/><rect x="28" y="55" width="8" height="3" rx="1" fill="#8a90a5" stroke="#6b7080" stroke-width="1.5"/><path d="M24 22l4 4M40 22l-4 4M32 18v8" stroke="#f5a623" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    pencil: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M10 54L46 18l8 8L18 62l-8 2z" fill="#ffd93d" stroke="#f5a623" stroke-width="2" stroke-linejoin="round"/><path d="M46 18l8 8" stroke="#d64545" stroke-width="3" stroke-linecap="round"/><path d="M10 54l8-8" stroke="#c4a77d" stroke-width="2"/><path d="M40 12l12 12" stroke="none"/><path d="M44 16l4 4" stroke="#d64545" stroke-width="2"/></svg>`,
    plant: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M20 40h24v14a2 2 0 01-2 2H22a2 2 0 01-2-2V40z" fill="#c4a77d" stroke="#a88860" stroke-width="2" stroke-linejoin="round"/><path d="M32 40V20" stroke="#5ba336" stroke-width="3" stroke-linecap="round"/><path d="M32 28c-8-4-12-12-10-20 6 0 12 6 10 16z" fill="#7ec850" stroke="#5ba336" stroke-width="2" stroke-linejoin="round"/><path d="M32 22c8-4 12-12 10-20-6 0-12 6-10 16z" fill="#7ec850" stroke="#5ba336" stroke-width="2" stroke-linejoin="round"/><circle cx="28" cy="14" r="2" fill="#ff8fab"/><circle cx="36" cy="18" r="2" fill="#ffd93d"/></svg>`,
    cake: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M8 38h48v16a2 2 0 01-2 2H10a2 2 0 01-2-2V38z" fill="#ffc1d6" stroke="#e07ba0" stroke-width="2" stroke-linejoin="round"/><path d="M8 38c4-6 20-6 24 0s20 6 24 0" fill="#ff8fab" stroke="#e05780" stroke-width="2" stroke-linejoin="round"/><rect x="30" y="14" width="4" height="16" fill="#ffd93d" stroke="#f5a623" stroke-width="1.5"/><path d="M32 8c-2 4 2 6 0 10 2-4-2-6 0-10z" fill="#ff6b6b"/></svg>`,
    glasses: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="18" cy="32" r="12" fill="none" stroke="#5b6172" stroke-width="3"/><circle cx="46" cy="32" r="12" fill="none" stroke="#5b6172" stroke-width="3"/><path d="M30 32h4" stroke="#5b6172" stroke-width="3" stroke-linecap="round"/><path d="M6 32l-4-2M58 32l4-2" stroke="#5b6172" stroke-width="3" stroke-linecap="round"/><circle cx="14" cy="28" r="3" fill="#a8d8ff" opacity=".6"/></svg>`,
    calendar: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="10" y="14" width="44" height="42" rx="4" fill="#fff" stroke="#5b6172" stroke-width="2"/><rect x="10" y="14" width="44" height="12" rx="4" fill="#ff6b6b" stroke="#d64545" stroke-width="2"/><path d="M20 6v8M44 6v8" stroke="#5b6172" stroke-width="2.5" stroke-linecap="round"/><g fill="#5b6172" font-size="8" text-anchor="middle" font-family="sans-serif"><text x="20" y="34">1</text><text x="28" y="34">2</text><text x="36" y="34">3</text><text x="44" y="34">4</text><text x="20" y="44">5</text><text x="28" y="44">6</text><text x="36" y="44">7</text><text x="44" y="44">8</text><text x="20" y="52">9</text><text x="28" y="52">10</text></g><circle cx="36" cy="41" r="6" fill="#ff6b6b" opacity=".25"/></svg>`,

    // ---------- 手绘符号 ----------
    check_mark: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M12 32l14 14 26-28" fill="none" stroke="#22c55e" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    cross_mark: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M16 16l32 32M48 16L16 48" fill="none" stroke="#ff6b6b" stroke-width="5" stroke-linecap="round"/></svg>`,
    exclamation: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="52" r="4" fill="#ff8c1a"/><rect x="28" y="10" width="8" height="30" rx="4" fill="#ff8c1a"/></svg>`,
    question: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M22 20c0-8 8-14 18-14s14 6 14 12c0 8-10 8-10 14" fill="none" stroke="#8b5cf6" stroke-width="4" stroke-linecap="round"/><circle cx="34" cy="50" r="4" fill="#8b5cf6"/></svg>`,
    arrow_curved: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M12 48c0-16 12-28 28-28h8" fill="none" stroke="#2f6bff" stroke-width="4" stroke-linecap="round"/><path d="M40 14l8-6 6 8" fill="none" stroke="#2f6bff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    hand_drawn_circle: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 8c14 0 24 10 24 24s-10 24-24 24S8 46 8 32 18 8 32 8z" fill="none" stroke="#e5342c" stroke-width="3" stroke-linecap="round" stroke-dasharray="4 3"/></svg>`,
    underline: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M10 48c6-3 12-4 22-4s16 1 22 4" fill="none" stroke="#ffd93d" stroke-width="6" stroke-linecap="round"/></svg>`,
  };

  const STICKER_CATEGORIES = [
    {
      name: '装饰',
      items: ['star_pink', 'heart_red', 'flower_yellow', 'bow_pink', 'leaf_green', 'cloud_blue', 'rainbow', 'sparkle_yellow', 'clover', 'balloon_pink', 'gift_box', 'crystal'],
    },
    {
      name: '标签',
      items: ['tag_blue', 'speech_pink', 'sticky_note', 'flag_red', 'tape_pink', 'tape_blue', 'tape_yellow', 'tape_green', 'check_mark', 'cross_mark', 'exclamation', 'question'],
    },
    {
      name: '生活',
      items: ['coffee', 'camera', 'music_note', 'book', 'envelope', 'bulb', 'pencil', 'plant', 'cake', 'glasses', 'calendar', 'arrow_curved'],
    },
    {
      name: '符号',
      items: ['hand_drawn_circle', 'underline', 'star_pink', 'heart_red', 'sparkle_yellow', 'check_mark', 'cross_mark', 'exclamation', 'question', 'arrow_curved', 'flower_yellow', 'gift_box'],
    },
  ];

  // SVG 贴纸转 Image 对象的缓存
  const stickerImageCache = new Map();
  function getStickerImage(id) {
    if (stickerImageCache.has(id)) return stickerImageCache.get(id);
    const svg = STICKER_SVG[id];
    if (!svg) return null;
    const img = new Image();
    // SVG 必须有 xmlns，直接用 dataURL 加载
    const encoded = encodeURIComponent(svg);
    img.src = 'data:image/svg+xml;charset=utf-8,' + encoded;
    stickerImageCache.set(id, img);
    return img;
  }

  const CSS = `
    .ac-anno-stage { display: flex; flex-direction: column; gap: 10px; align-items: center; max-width: 100%; }
    .ac-anno-bar {
      display: flex; align-items: center; gap: 5px; flex-wrap: wrap; justify-content: center;
      padding: 7px 9px; border-radius: 10px; background: #f6f7fb; border: 1px solid #eceef4;
      font: 500 12px/1 ${FONT}; user-select: none;
      position: relative; z-index: 2;
    }
    .ac-anno-tool {
      width: 30px; height: 30px; padding: 0; border: none; border-radius: 7px;
      background: #fff; color: #5b6172; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .ac-anno-tool:hover { background: #eceffb; }
    .ac-anno-tool.on { background: #4f6ef7; color: #fff; }
    .ac-anno-text-btn {
      width: auto; height: 30px; padding: 0 10px; border-radius: 7px; border: none;
      background: #fff; color: #5b6172; cursor: pointer; font: 600 12px/1 ${FONT};
    }
    .ac-anno-text-btn:hover { background: #eceffb; }
    .ac-anno-sep { width: 1px; height: 20px; background: #e2e5ef; margin: 0 3px; }
    .ac-anno-sw {
      width: 18px; height: 18px; padding: 0; border-radius: 50%; cursor: pointer;
      border: 2px solid transparent; box-shadow: 0 0 0 1px rgba(31,36,48,.14) inset;
    }
    .ac-anno-sw.on { border-color: #1f2430; }
    .ac-anno-sz {
      width: 30px; height: 26px; padding: 0; border: none; border-radius: 6px; background: #fff;
      color: #5b6172; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
    }
    .ac-anno-sz.on { background: #4f6ef7; color: #fff; }
    .ac-anno-sz i { display: block; border-radius: 99px; background: currentColor; }
    .ac-anno-wrap { position: relative; z-index: 1; display: inline-block; line-height: 0; max-width: 100%; }
    /* 宽度上限直接用 vw：wrap 是 shrink-to-fit，canvas 再用 100% 会与父级宽度互相依赖算不准 */
    .ac-anno-base { display: block; max-height: 58vh; max-width: 88vw; border-radius: 8px; border: 1px solid #eceef4; }
    .ac-anno-layer { position: absolute; left: 0; top: 0; width: 100%; height: 100%; cursor: crosshair; touch-action: none; }
    .ac-anno-input {
      position: fixed; z-index: 2147483647; min-width: 140px; max-width: 420px;
      padding: 4px 8px; border-radius: 6px; border: 2px solid #4f6ef7; outline: none;
      background: #fff; color: #1f2430; box-shadow: 0 6px 18px rgba(15,18,28,.22);
    }
    .ac-anno-tip { color: #8a90a5; font: 400 11px/1 ${FONT}; }
    /* 贴纸选择面板 */
    .ac-anno-sticker-panel {
      position: absolute; left: 50%; top: calc(100% + 6px); transform: translateX(-50%);
      z-index: 10; background: #fff; border: 1px solid #e2e5ef; border-radius: 10px;
      box-shadow: 0 6px 20px rgba(15,18,28,.15); padding: 8px; width: 280px;
      font: 500 12px/1 ${FONT}; user-select: none;
    }
    .ac-anno-sticker-cats { display: flex; gap: 4px; margin-bottom: 8px; border-bottom: 1px solid #eef0f6; padding-bottom: 6px; }
    .ac-anno-sticker-cat {
      padding: 4px 10px; border-radius: 6px; cursor: pointer; color: #5b6172; font-size: 12px;
    }
    .ac-anno-sticker-cat:hover { background: #f0f2fa; }
    .ac-anno-sticker-cat.on { background: #4f6ef7; color: #fff; }
    .ac-anno-sticker-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; }
    .ac-anno-sticker-item {
      display: flex; align-items: center; justify-content: center;
      width: 100%; aspect-ratio: 1; font-size: 24px; cursor: pointer;
      border-radius: 6px; transition: background .15s;
    }
    .ac-anno-sticker-item:hover { background: #f0f2fa; transform: scale(1.1); }
    /* 选中标注框 */
    .ac-anno-sel {
      position: absolute; pointer-events: none; border: 1.5px dashed #4f6ef7;
      box-sizing: border-box; border-radius: 2px;
    }
    .ac-anno-sel-handle {
      position: absolute; width: 12px; height: 12px; background: #fff;
      border: 1.5px solid #4f6ef7; border-radius: 50%; pointer-events: auto;
      cursor: grab; box-sizing: border-box;
    }
    .ac-anno-sel-handle:hover { background: #4f6ef7; }
    .ac-anno-sel-handle.tl { left: -6px; top: -6px; cursor: nwse-resize; }
    .ac-anno-sel-handle.tr { right: -6px; top: -6px; cursor: nesw-resize; }
    .ac-anno-sel-handle.bl { left: -6px; bottom: -6px; cursor: nesw-resize; }
    .ac-anno-sel-handle.br { right: -6px; bottom: -6px; cursor: nwse-resize; }
    .ac-anno-sel-rotate {
      position: absolute; width: 14px; height: 14px; left: 50%; top: -22px;
      transform: translateX(-50%); background: #fff; border: 1.5px solid #4f6ef7;
      border-radius: 50%; pointer-events: auto; cursor: grab; box-sizing: border-box;
      display: flex; align-items: center; justify-content: center; font-size: 9px; color: #4f6ef7;
    }
    .ac-anno-sel-rotate:hover { background: #4f6ef7; color: #fff; }
    .ac-anno-sel-line {
      position: absolute; left: 50%; top: -10px; width: 1.5px; height: 10px;
      background: #4f6ef7; transform: translateX(-50%);
    }
    .ac-anno-sticker-cursor { cursor: grab; }
    .ac-anno-sticker-cursor:active { cursor: grabbing; }
  `;

  function ensureStyle(root) {
    if (root.querySelector('style[data-ac-anno]')) return;
    const s = document.createElement('style');
    s.setAttribute('data-ac-anno', '');
    s.textContent = CSS;
    root.appendChild(s);
  }

  function svgIcon(tool, cls) {
    const el = document.createElement('span');
    el.className = cls || '';
    el.innerHTML =
      `<svg width="17" height="17" viewBox="0 0 16 16" fill="${tool.fill ? 'currentColor' : 'none'}" ` +
      `stroke="${tool.fill ? 'none' : 'currentColor'}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${tool.svg}</svg>`;
    return el;
  }

  function create(root, dataUrl, opts = {}) {
    ensureStyle(root);
    const stage = document.createElement('div');
    stage.className = 'ac-anno-stage';

    const bar = document.createElement('div');
    bar.className = 'ac-anno-bar';
    const wrap = document.createElement('div');
    wrap.className = 'ac-anno-wrap';
    const cvBase = document.createElement('canvas');
    cvBase.className = 'ac-anno-base';
    const cv = document.createElement('canvas');
    cv.className = 'ac-anno-layer';
    wrap.append(cvBase, cv);
    stage.append(bar, wrap);

    let img = null;
    let shapes = [];
    let draft = null;
    let tool = opts.tool || 'arrow';
    let color = opts.color || COLORS[0];
    let size = opts.size || SIZES[1].v;
    let seq = 0;
    let onChange = null;
    let raf = 0;
    let selectedIdx = -1; // 选中的贴纸索引
    let stickerPanelEl = null; // 贴纸选择面板
    let selOverlay = null; // 选中标注框覆盖层

    const ctx = cv.getContext('2d');
    const bctx = cvBase.getContext('2d');

    // 显示宽度 → 原图像素的换算比（原图被缩到 62vh 预览时，这个比值会很大）
    const uiScale = () => {
      const r = cv.getBoundingClientRect();
      return r.width ? cv.width / r.width : 1;
    };
    const toImg = (e) => {
      const r = cv.getBoundingClientRect();
      const k = r.width ? cv.width / r.width : 1;
      return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
    };

    // ---------- 工具栏 ----------
    const toolBtns = new Map();
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.className = 'ac-anno-tool' + (t.id === tool ? ' on' : '');
      b.type = 'button';
      b.title = t.label;
      b.setAttribute('aria-label', t.label);
      b.append(svgIcon(t));
      b.addEventListener('click', () => setTool(t.id));
      toolBtns.set(t.id, b);
      bar.append(b);
    }
    bar.append(sep());
    const swBtns = [];
    for (const c of COLORS) {
      const b = document.createElement('button');
      b.className = 'ac-anno-sw' + (c === color ? ' on' : '');
      b.type = 'button';
      b.style.background = c;
      b.title = c;
      b.addEventListener('click', () => {
        color = c;
        swBtns.forEach((x) => x.classList.toggle('on', x.dataset.c === c));
      });
      b.dataset.c = c;
      swBtns.push(b);
      bar.append(b);
    }
    bar.append(sep());
    const szBtns = [];
    for (const s of SIZES) {
      const b = document.createElement('button');
      b.className = 'ac-anno-sz' + (s.v === size ? ' on' : '');
      b.type = 'button';
      b.title = '笔触' + s.label;
      const i = document.createElement('i');
      i.style.width = '16px';
      i.style.height = s.d + 'px';
      b.append(i);
      b.addEventListener('click', () => {
        size = s.v;
        szBtns.forEach((x) => x.classList.toggle('on', Number(x.dataset.v) === s.v));
      });
      b.dataset.v = String(s.v);
      szBtns.push(b);
      bar.append(b);
    }
    bar.append(sep());
    const btnUndo = document.createElement('button');
    btnUndo.className = 'ac-anno-text-btn';
    btnUndo.type = 'button';
    btnUndo.textContent = '撤销';
    btnUndo.title = '撤销上一步（Ctrl+Z）';
    btnUndo.addEventListener('click', undo);
    const btnClear = document.createElement('button');
    btnClear.className = 'ac-anno-text-btn';
    btnClear.type = 'button';
    btnClear.textContent = '清空';
    btnClear.addEventListener('click', clear);
    bar.append(btnUndo, btnClear);
    const tip = document.createElement('span');
    tip.className = 'ac-anno-tip';
    bar.append(tip);

    function sep() {
      const d = document.createElement('span');
      d.className = 'ac-anno-sep';
      return d;
    }
    function setTool(id) {
      tool = id;
      toolBtns.forEach((b, k) => b.classList.toggle('on', k === id));
      tip.textContent = id === 'text' ? '点击图片输入文字，Enter 完成' : id === 'number' ? '点击图片添加序号' : id === 'sticker' ? '选择贴纸后点击添加，拖拽调整' : '';
      if (id === 'sticker') {
        showStickerPanel();
      } else {
        hideStickerPanel();
        clearSelection();
      }
    }
    setTool(tool);

    // 隐藏/显示工具栏（供外部切换模式用，如划线分享的荧光笔/贴纸模式切换）
    function showToolbar() {
      bar.style.display = '';
      cv.classList.remove('ac-anno-no-toolbar');
    }
    function hideToolbar() {
      bar.style.display = 'none';
      hideStickerPanel();
      clearSelection();
      cv.classList.add('ac-anno-no-toolbar');
    }
    if (opts.hideToolbar) hideToolbar();

    // ---------- 贴纸选择面板 ----------
    function showStickerPanel() {
      if (stickerPanelEl) return;
      stickerPanelEl = document.createElement('div');
      stickerPanelEl.className = 'ac-anno-sticker-panel';
      const catsEl = document.createElement('div');
      catsEl.className = 'ac-anno-sticker-cats';
      const gridEl = document.createElement('div');
      gridEl.className = 'ac-anno-sticker-grid';
      let curCat = 0;

      function renderCat(idx) {
        curCat = idx;
        catsEl.querySelectorAll('.ac-anno-sticker-cat').forEach((el, i) => {
          el.classList.toggle('on', i === idx);
        });
        gridEl.innerHTML = '';
        for (const sid of STICKER_CATEGORIES[idx].items) {
          const item = document.createElement('div');
          item.className = 'ac-anno-sticker-item';
          const svgData = STICKER_SVG[sid];
          if (svgData) {
            item.innerHTML = svgData;
            const svgEl = item.querySelector('svg');
            if (svgEl) {
              svgEl.style.width = '100%';
              svgEl.style.height = '100%';
              svgEl.style.display = 'block';
            }
          }
          item.title = '点击添加贴纸';
          item.addEventListener('click', () => addSticker(sid));
          gridEl.appendChild(item);
        }
      }

      STICKER_CATEGORIES.forEach((cat, i) => {
        const catBtn = document.createElement('div');
        catBtn.className = 'ac-anno-sticker-cat' + (i === 0 ? ' on' : '');
        catBtn.textContent = cat.name;
        catBtn.addEventListener('click', () => renderCat(i));
        catsEl.appendChild(catBtn);
      });
      stickerPanelEl.append(catsEl, gridEl);
      renderCat(0);
      bar.appendChild(stickerPanelEl);
    }
    function hideStickerPanel() {
      if (stickerPanelEl) {
        stickerPanelEl.remove();
        stickerPanelEl = null;
      }
    }
    function addSticker(sid) {
      if (!img) return;
      const baseSize = Math.min(cv.width, cv.height) * 0.15;
      // 胶带类贴纸是横向的，保持原始宽高比 2:1
      const isTape = sid.startsWith('tape_') || sid === 'underline' || sid === 'rainbow';
      const w = isTape ? baseSize * 2 : baseSize;
      const h = isTape ? baseSize * 0.6 : baseSize;
      const sh = {
        type: 'sticker',
        sid,
        x: cv.width / 2,
        y: cv.height / 2,
        w,
        h,
        rotation: 0,
      };
      commit(sh);
      selectedIdx = shapes.length - 1;
      updateSelectionOverlay();
      // 确保贴纸图片加载完成后重绘
      const simg = getStickerImage(sid);
      if (simg && !simg.complete) {
        simg.onload = () => { redraw(); };
      }
    }

    // ---------- 选中覆盖层（移动/缩放/旋转手柄） ----------
    // 贴纸命中测试：返回命中的贴纸索引，未命中返回 -1
    function hitTestSticker(px, py) {
      // 从后往前遍历（上面的贴纸优先命中）
      for (let i = shapes.length - 1; i >= 0; i--) {
        const sh = shapes[i];
        if (sh.type !== 'sticker') continue;
        // 将点变换到贴纸本地坐标系（逆旋转 + 逆平移）
        const dx = px - sh.x;
        const dy = py - sh.y;
        const cos = Math.cos(-(sh.rotation || 0));
        const sin = Math.sin(-(sh.rotation || 0));
        const lx = dx * cos - dy * sin;
        const ly = dx * sin + dy * cos;
        const halfW = sh.w / 2;
        const halfH = sh.h / 2;
        if (Math.abs(lx) <= halfW && Math.abs(ly) <= halfH) {
          return i;
        }
      }
      return -1;
    }
    // 缩放/旋转手柄的 pointerdown 事件
    function bindHandleEvents() {
      if (!selOverlay) return;
      selOverlay.querySelectorAll('.ac-anno-sel-handle, .ac-anno-sel-rotate').forEach((el) => {
        el.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          e.preventDefault();
          if (selectedIdx < 0 || !shapes[selectedIdx]) return;
          const handle = el.dataset.handle;
          try { cv.setPointerCapture(e.pointerId); } catch {}
          dragStart = { x: e.clientX, y: e.clientY };
          dragSticker = { ...shapes[selectedIdx], handle };
          dragMode = handle === 'rotate' ? 'rotate' : 'resize';
        });
      });
    }
    function createSelectionOverlay() {
      if (selOverlay) return;
      selOverlay = document.createElement('div');
      selOverlay.className = 'ac-anno-sel';
      selOverlay.style.display = 'none';
      // 四个角缩放手柄
      ['tl', 'tr', 'bl', 'br'].forEach((pos) => {
        const h = document.createElement('div');
        h.className = 'ac-anno-sel-handle ' + pos;
        h.dataset.handle = pos;
        selOverlay.appendChild(h);
      });
      // 顶部连接线和旋转手柄
      const line = document.createElement('div');
      line.className = 'ac-anno-sel-line';
      selOverlay.appendChild(line);
      const rot = document.createElement('div');
      rot.className = 'ac-anno-sel-rotate';
      rot.textContent = '↻';
      rot.dataset.handle = 'rotate';
      selOverlay.appendChild(rot);
      wrap.appendChild(selOverlay);

      // 绑定手柄事件
      bindHandleEvents();
    }
    function updateSelectionOverlay() {
      if (selectedIdx < 0 || !shapes[selectedIdx]) {
        if (selOverlay) selOverlay.style.display = 'none';
        cv.classList.remove('ac-anno-sticker-cursor');
        return;
      }
      createSelectionOverlay();
      const sh = shapes[selectedIdx];
      const k = uiScale();
      const halfW = (sh.w || 60) / 2;
      const halfH = (sh.h || 60) / 2;
      const rect = cv.getBoundingClientRect();
      // 用屏幕坐标计算覆盖层位置
      const cx = sh.x / k;
      const cy = sh.y / k;
      const wScreen = sh.w / k;
      const hScreen = sh.h / k;

      selOverlay.style.display = 'block';
      selOverlay.style.left = (cx - wScreen / 2) + 'px';
      selOverlay.style.top = (cy - hScreen / 2) + 'px';
      selOverlay.style.width = wScreen + 'px';
      selOverlay.style.height = hScreen + 'px';
      selOverlay.style.transform = `rotate(${sh.rotation || 0}rad)`;
      selOverlay.style.transformOrigin = 'center center';
      cv.classList.add('ac-anno-sticker-cursor');
    }
    function clearSelection() {
      selectedIdx = -1;
      updateSelectionOverlay();
    }

    // ---------- 绘制 ----------
    // 拖拽过程用 rAF 节流；提交/撤销/换图必须同步画完（flush），
    // 否则紧接着导出会拿到还没落笔的图层（页面在后台时 rAF 甚至不会触发）
    function redraw() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        render();
      });
    }
    function flush() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      render();
    }
    function render() {
      if (!cv.width || !cv.height) return;
      ctx.clearRect(0, 0, cv.width, cv.height);
      const k = uiScale();
      for (const sh of shapes) paint(sh, k);
      if (draft) paint(draft, k);
    }

    function paint(sh, k) {
      const w = Math.max(1, sh.size * k);
      ctx.save();
      ctx.strokeStyle = sh.color;
      ctx.fillStyle = sh.color;
      ctx.lineWidth = w;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      switch (sh.type) {
        case 'line': {
          ctx.beginPath();
          ctx.moveTo(sh.x0, sh.y0);
          ctx.lineTo(sh.x1, sh.y1);
          ctx.stroke();
          break;
        }
        case 'arrow':
          paintArrow(sh, k, w);
          break;
        case 'rect': {
          const x = Math.min(sh.x0, sh.x1);
          const y = Math.min(sh.y0, sh.y1);
          ctx.beginPath();
          ctx.rect(x, y, Math.abs(sh.x1 - sh.x0), Math.abs(sh.y1 - sh.y0));
          ctx.stroke();
          break;
        }
        case 'ellipse': {
          const cx = (sh.x0 + sh.x1) / 2;
          const cy = (sh.y0 + sh.y1) / 2;
          ctx.beginPath();
          ctx.ellipse(cx, cy, Math.abs(sh.x1 - sh.x0) / 2, Math.abs(sh.y1 - sh.y0) / 2, 0, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case 'pen': {
          if (sh.pts.length === 1) {
            ctx.beginPath();
            ctx.arc(sh.pts[0].x, sh.pts[0].y, w / 2, 0, Math.PI * 2);
            ctx.fill();
            break;
          }
          ctx.beginPath();
          sh.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          ctx.stroke();
          break;
        }
        case 'mosaic':
          paintMosaic(sh, k);
          break;
        case 'text': {
          const fs = sh.fs * k;
          ctx.font = `600 ${fs}px ${FONT}`;
          ctx.textBaseline = 'top';
          ctx.lineWidth = Math.max(2, fs * 0.16);
          ctx.strokeStyle = 'rgba(255,255,255,.92)';
          ctx.strokeText(sh.text, sh.x, sh.y);
          ctx.lineWidth = w; // 还原，避免影响后续
          ctx.fillStyle = sh.color;
          ctx.fillText(sh.text, sh.x, sh.y);
          break;
        }
        case 'number': {
          const r = Math.max(10 * k, w * 1.7);
          ctx.beginPath();
          ctx.arc(sh.x, sh.y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = `700 ${Math.round(r * 1.15)}px ${FONT}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(sh.n), sh.x, sh.y + r * 0.04);
          break;
        }
        case 'sticker': {
          if (!sh.sid) break;
          const w2 = sh.w || 60;
          const h2 = sh.h || 60;
          const simg = getStickerImage(sh.sid);
          if (!simg || !simg.complete || !simg.naturalWidth) break; // 图片还没加载好就跳过
          ctx.save();
          ctx.translate(sh.x, sh.y);
          if (sh.rotation) ctx.rotate(sh.rotation);
          ctx.drawImage(simg, -w2 / 2, -h2 / 2, w2, h2);
          ctx.restore();
          break;
        }
      }
      ctx.restore();
    }

    // 微信同款箭头：细杆 + 明显外扩的实心三角头，尖端要锐
    // 关键：杆不能用圆头线帽画到终点（圆帽会把尖头顶钝），三角头单独 fill 出来
    function paintArrow(sh, k, w) {
      const dx = sh.x1 - sh.x0;
      const dy = sh.y1 - sh.y0;
      const len = Math.hypot(dx, dy);
      if (len < 0.5) return;
      const ux = dx / len;
      const uy = dy / len;
      const nx = -uy; // 法向
      const ny = ux;
      // 头长 ≈ 2.8 倍杆宽、头半宽 ≈ 1.5 倍杆宽（即头宽 ≈ 3 倍杆宽），比老版更"胖"，贴近微信
      const full = Math.max(9 * k, w * 2.8);
      const half = Math.max(4.5 * k, w * 1.5);
      // 拖得太短就同比缩小头部，避免变成一个大脑袋
      const headLen = Math.min(len, full);
      const headHalf = half * (headLen / full);
      // 杆画进三角头里一点，接缝不会露缝；圆头线帽的外扩被三角头完全盖住
      const tail = len - headLen * 0.9;
      if (tail > 0.5) {
        ctx.beginPath();
        ctx.moveTo(sh.x0, sh.y0);
        ctx.lineTo(sh.x0 + ux * tail, sh.y0 + uy * tail);
        ctx.stroke();
      }
      const bx = sh.x1 - ux * headLen;
      const by = sh.y1 - uy * headLen;
      ctx.beginPath();
      ctx.moveTo(sh.x1, sh.y1);
      ctx.lineTo(bx + nx * headHalf, by + ny * headHalf);
      ctx.lineTo(bx - nx * headHalf, by - ny * headHalf);
      ctx.closePath();
      ctx.fill();
    }

    // 马赛克：把原图对应区域缩到极小再放大回来（关闭插值 → 色块）
    function paintMosaic(sh, k) {
      const x = Math.min(sh.x0, sh.x1);
      const y = Math.min(sh.y0, sh.y1);
      const w = Math.abs(sh.x1 - sh.x0);
      const h = Math.abs(sh.y1 - sh.y0);
      if (!img || w < 2 || h < 2) return;
      const block = Math.max(6, sh.size * k * 2.2);
      const small = document.createElement('canvas');
      small.width = Math.max(1, Math.round(w / block));
      small.height = Math.max(1, Math.round(h / block));
      const sctx = small.getContext('2d');
      sctx.drawImage(img, x, y, w, h, 0, 0, small.width, small.height);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.drawImage(small, x, y, w, h);
      ctx.restore();
    }

    // ---------- 交互 ----------
    let drawing = false;
    let startPt = null;
    // 贴纸拖拽状态
    let dragMode = null; // 'move' | 'resize' | 'rotate' | null
    let dragStart = null; // { x, y } 起始屏幕坐标
    let dragSticker = null; // 拖拽开始时贴纸状态快照

    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !img) return;
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch { /* 老版本不支持 */ }
      const p = toImg(e);
      if (tool === 'sticker') {
        // 贴纸工具：先做命中测试
        const hitIdx = hitTestSticker(p.x, p.y);
        if (hitIdx >= 0) {
          selectedIdx = hitIdx;
          dragMode = 'move';
          dragStart = { x: e.clientX, y: e.clientY };
          dragSticker = { ...shapes[hitIdx] };
          updateSelectionOverlay();
          return;
        } else {
          clearSelection();
        }
        return;
      }
      if (tool === 'text') {
        openInput(p);
        return;
      }
      if (tool === 'number') {
        seq += 1;
        commit({ type: 'number', x: p.x, y: p.y, n: seq, color, size: 4 });
        return;
      }
      drawing = true;
      startPt = p;
      draft = tool === 'pen'
        ? { type: 'pen', pts: [p], color, size }
        : { type: tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y, color, size };
      redraw();
    });

    cv.addEventListener('pointermove', (e) => {
      // 贴纸拖拽
      if (dragMode && selectedIdx >= 0 && shapes[selectedIdx]) {
        const k = uiScale();
        const dx = (e.clientX - dragStart.x) * k;
        const dy = (e.clientY - dragStart.y) * k;
        const sh = shapes[selectedIdx];

        if (dragMode === 'move') {
          sh.x = dragSticker.x + dx;
          sh.y = dragSticker.y + dy;
        } else if (dragMode === 'resize') {
          // 缩放：以对角落为锚点，等比缩放
          const handle = dragSticker.handle; // 'tl', 'tr', 'bl', 'br'
          const orig = dragSticker;
          // 计算角点在贴纸本地坐标系的位置
          const cos = Math.cos(orig.rotation || 0);
          const sin = Math.sin(orig.rotation || 0);
          // 把鼠标位移转换到贴纸的本地坐标系（旋转前）
          const localDx = dx * cos + dy * sin;
          const localDy = -dx * sin + dy * cos;

          let newW = orig.w;
          let newH = orig.h;
          let anchorX = orig.x; // 锚点（对角落）在世界坐标
          let anchorY = orig.y;

          // 根据 handle 确定对角落作为锚点
          const halfW = orig.w / 2;
          const halfH = orig.h / 2;
          // 对角落的本地偏移
          let anchorLocalX = 0, anchorLocalY = 0;
          let dragLocalX = 0, dragLocalY = 0;
          if (handle === 'br') { anchorLocalX = -halfW; anchorLocalY = -halfH; dragLocalX = halfW; dragLocalY = halfH; }
          else if (handle === 'bl') { anchorLocalX = halfW; anchorLocalY = -halfH; dragLocalX = -halfW; dragLocalY = halfH; }
          else if (handle === 'tr') { anchorLocalX = -halfW; anchorLocalY = halfH; dragLocalX = halfW; dragLocalY = -halfH; }
          else if (handle === 'tl') { anchorLocalX = halfW; anchorLocalY = halfH; dragLocalX = -halfW; dragLocalY = -halfH; }

          // 锚点世界坐标
          anchorX = orig.x + anchorLocalX * cos - anchorLocalY * sin;
          anchorY = orig.y + anchorLocalX * sin + anchorLocalY * cos;

          // 拖拽角的新本地坐标
          const newDragLocalX = dragLocalX + localDx;
          const newDragLocalY = dragLocalY + localDy;

          // 等比缩放：保持宽高比。锚点（对角）到角点的距离本来就等于整个宽/高，
          // 所以归一化分母必须是 orig.w / orig.h 全值——写成 /2 会让零位移时 scale 就等于 2
          // （手还没拖就翻倍，且增益是鼠标位移的两倍），正是「拖一点就变得很大」的根因
          const ratio = orig.w / orig.h;
          let scaleX = Math.abs(newDragLocalX - anchorLocalX) / (orig.w || 60);
          let scaleY = Math.abs(newDragLocalY - anchorLocalY) / (orig.h || 60);
          const scale = Math.max(0.1, Math.max(scaleX, scaleY));

          newW = orig.w * scale;
          newH = orig.h * scale;

          // 中心相对锚点的本地偏移：锚点在中心的哪一侧，中心就朝反方向挪半个新宽高。
          // 只取 ±newHalf——再把 anchorLocal 加进去等于整体多推走半个原始尺寸，
          // 表现为「按住的那个对角不钉住、贴纸跟着往反方向滑」
          const newHalfW = newW / 2;
          const newHalfH = newH / 2;
          const centerLocalX = dragLocalX > anchorLocalX ? newHalfW : -newHalfW;
          const centerLocalY = dragLocalY > anchorLocalY ? newHalfH : -newHalfH;

          sh.w = newW;
          sh.h = newH;
          sh.x = anchorX + centerLocalX * cos - centerLocalY * sin;
          sh.y = anchorY + centerLocalX * sin + centerLocalY * cos;
        } else if (dragMode === 'rotate') {
          // 旋转：以贴纸中心为原点
          const angleStart = Math.atan2(dragStart.y - cv.getBoundingClientRect().top - dragSticker.y / uiScale(),
                                         dragStart.x - cv.getBoundingClientRect().left - dragSticker.x / uiScale());
          const angleNow = Math.atan2(e.clientY - cv.getBoundingClientRect().top - dragSticker.y / uiScale(),
                                       e.clientX - cv.getBoundingClientRect().left - dragSticker.x / uiScale());
          sh.rotation = dragSticker.rotation + (angleNow - angleStart);
        }

        redraw();
        updateSelectionOverlay();
        return;
      }
      if (!drawing || !draft) return;
      const p = toImg(e);
      if (draft.type === 'pen') {
        const last = draft.pts[draft.pts.length - 1];
        // 采样节流：屏幕上移动不足 1px 的点丢掉，长图上能少掉一大半数据
        const k = uiScale();
        if (Math.hypot(p.x - last.x, p.y - last.y) < k) return;
        draft.pts.push(p);
      } else {
        draft.x1 = p.x;
        draft.y1 = p.y;
      }
      redraw();
    });

    const endDraw = (e) => {
      // 贴纸拖拽结束
      if (dragMode) {
        dragMode = null;
        dragStart = null;
        dragSticker = null;
        try { cv.releasePointerCapture(e.pointerId); } catch { /* 未捕获到 */ }
        if (onChange) onChange();
        return;
      }
      if (!drawing || !draft) return;
      drawing = false;
      try { cv.releasePointerCapture(e.pointerId); } catch { /* 未捕获到 */ }
      const sh = draft;
      draft = null;
      const moved = sh.type === 'pen'
        ? sh.pts.length > 1
        : Math.hypot(sh.x1 - sh.x0, sh.y1 - sh.y0) > 3 * uiScale();
      if (moved) commit(sh);
      else flush(); // 只是点了一下，把预览中的 draft 清掉
    };
    cv.addEventListener('pointerup', endDraw);
    cv.addEventListener('pointercancel', endDraw);

    function commit(sh) {
      shapes.push(sh);
      flush();
      if (onChange) onChange();
    }
    function undo() {
      if (!shapes.length) return;
      shapes.pop();
      if (shapes.length === 0) seq = 0;
      if (selectedIdx >= shapes.length) selectedIdx = -1;
      flush();
      updateSelectionOverlay();
      if (onChange) onChange();
    }
    function clear() {
      if (!shapes.length) return;
      shapes = [];
      seq = 0;
      selectedIdx = -1;
      flush();
      updateSelectionOverlay();
      if (onChange) onChange();
    }

    // 文字输入：浮在画布上的 input，跟着点击位置定位，Enter 或失焦落笔
    function openInput(p) {
      const r = cv.getBoundingClientRect();
      const k = uiScale();
      const inp = document.createElement('input');
      inp.className = 'ac-anno-input';
      inp.type = 'text';
      inp.placeholder = '输入文字后按 Enter';
      inp.style.left = Math.round(r.left + p.x / k) + 'px';
      inp.style.top = Math.round(r.top + p.y / k) + 'px';
      inp.style.font = `600 20px ${FONT}`;
      inp.style.color = color;
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        const v = inp.value.trim();
        inp.remove();
        if (ok && v) commit({ type: 'text', x: p.x, y: p.y, text: v, color, size: 2, fs: 20 });
      };
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      });
      inp.addEventListener('blur', () => finish(true));
      root.appendChild(inp);
      inp.focus();
    }

    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      }
      // 删除选中的贴纸
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIdx >= 0 && tool === 'sticker') {
        e.preventDefault();
        shapes.splice(selectedIdx, 1);
        selectedIdx = -1;
        flush();
        updateSelectionOverlay();
        if (onChange) onChange();
      }
    };
    window.addEventListener('keydown', onKey, true);
    const onResize = () => { redraw(); updateSelectionOverlay(); };
    window.addEventListener('resize', onResize);

    // ---------- 对外 ----------
    // cb 在新图解码并画好之后触发（换底图后要重新自动复制，不能复制上一张）
    function setImage(url, cb) {
      const im = new Image();
      im.onerror = () => { if (cb) cb(); };
      im.onload = () => {
        const oldW = cv.width;
        const oldH = cv.height;
        img = im;
        const W = im.naturalWidth || im.width;
        const H = im.naturalHeight || im.height;
        for (const c of [cvBase, cv]) {
          c.width = W;
          c.height = H;
        }
        bctx.clearRect(0, 0, W, H);
        bctx.drawImage(im, 0, 0);
        // 换底图（如主题包背景开关）时尺寸会变，已有标注按比例跟着缩放，不丢
        if (oldW && oldH && (oldW !== W || oldH !== H) && shapes.length) {
          const sx = W / oldW;
          const sy = H / oldH;
          for (const sh of shapes) {
            if (sh.type === 'pen') sh.pts.forEach((p) => { p.x *= sx; p.y *= sy; });
            else if (sh.type === 'number' || sh.type === 'text') { sh.x *= sx; sh.y *= sy; }
            else if (sh.type === 'sticker') { sh.x *= sx; sh.y *= sy; sh.w *= sx; sh.h *= sy; }
            else { sh.x0 *= sx; sh.y0 *= sy; sh.x1 *= sx; sh.y1 *= sy; }
          }
        }
        flush();
        if (cb) cb();
      };
      im.src = url;
    }

    // 导出：底图 + 标注层合成；没有任何标注时直接返回原图 dataURL，省一次大图编码
    function exportUrl() {
      if (!img) return null;
      if (raf) flush(); // 还有没落笔的预览，先补上再合成
      if (!shapes.length) return img.src;
      const out = document.createElement('canvas');
      out.width = cv.width;
      out.height = cv.height;
      const octx = out.getContext('2d');
      octx.drawImage(cvBase, 0, 0);
      octx.drawImage(cv, 0, 0);
      return out.toDataURL('image/png');
    }

    setImage(dataUrl);

    return {
      el: stage,
      setImage,
      exportUrl,
      undo,
      clear,
      hasShapes: () => shapes.length > 0,
      onChange: (cb) => { onChange = cb; },
      setTool: (id) => setTool(id),
      showToolbar,
      hideToolbar,
      destroy() {
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', onResize);
        if (raf) cancelAnimationFrame(raf);
        stage.remove();
      },
    };
  }

  globalThis.__acAnnotate = { create, COLORS, TOOLS };
})();
