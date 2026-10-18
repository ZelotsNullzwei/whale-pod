/**
 * 前端资源：样式与脚本。
 *
 * ## 为什么单独一个文件
 *
 * `server.js` 原本把 HTML/CSS/JS 全内联在模板字符串里，结果 41 KB。
 * 抽出来之后：
 *   - server.js 只管 HTTP 与 API
 *   - 这一份只管「长什么样」
 *
 * ## 为什么不用构建工具
 *
 * WhalePod 要能直接 `node src/index.js` 跑起来，不要 webpack/vite 那一套。
 * 所以这里是**手写的、浏览器直接能跑的** CSS 与 ES5 风格 JS。
 *
 * ## ⚠️ 模板字符串陷阱（踩过一次，页面全黑）
 *
 * 这两个常量的值来自模板字符串。里面凡是要出现在**浏览器字符串字面量**
 * 里的反斜杠转义，必须写双反斜杠（`\\n`）；写单反斜杠会被 Node 求值成
 * 真实换行，生成出「单引号字符串里有裸换行」的非法 JS。
 *
 * 另外：以 `[` 或 `(` 开头的语句**行首要补分号**，否则会被 ASI 粘到上一行
 * （`textContent = name` 换行后跟 `[].forEach` → 解析成 `name[].forEach`）。
 *
 * server.js 里有 `validateClientJs()` 在模块加载时校验，写错会立刻抛错。
 */

export const CLIENT_CSS = `
/* ══ 设计令牌 ═══════════════════════════════════════════════════
   浅色为默认，深色覆盖。三档主题靠 data-theme + 媒体查询。
   颜色语义：bg 底 / panel 卡 / line 分隔 / fg 主文 / dim 次文
            accent 主色 / ok warn err 状态色
   ═══════════════════════════════════════════════════════════════ */
:root{
  --bg:#f4f6f9; --bg-grad:radial-gradient(1200px 600px at 20% -10%, #e8eeff 0%, transparent 60%);
  --panel:#ffffff; --panel-2:#f2f5f9; --line:#e2e7ef; --line-2:#eef1f6;
  --fg:#111827; --fg-2:#374151; --dim:#6b7280; --dim2:#9ca3af;
  --accent:#3b6ef5; --accent-soft:#3b6ef51a;
  --ok:#0f9d58; --ok-soft:#0f9d581a;
  --warn:#c77700; --warn-soft:#c777001a;
  --err:#dc2626; --err-soft:#dc26261a;
  --hover:#0f172a08; --active:#0f172a12;
  --hairline:#0f172a0a;
  --shadow-sm:0 1px 2px #0f172a0a;
  --shadow:0 1px 3px #0f172a0d, 0 8px 24px -8px #0f172a1a;
  --radius:14px; --radius-sm:9px;
}
:root[data-theme="dark"]{
  --bg:#0b0d12; --bg-grad:radial-gradient(1200px 600px at 20% -10%, #1b2340 0%, transparent 60%);
  --panel:#151821; --panel-2:#0f1218; --line:#252a37; --line-2:#1c212c;
  --fg:#e8eaf0; --fg-2:#c8ccd8; --dim:#8b93a7; --dim2:#5d6678;
  --accent:#6b95ff; --accent-soft:#6b95ff1f;
  --ok:#3ecf8e; --ok-soft:#3ecf8e1a;
  --warn:#f5b83d; --warn-soft:#f5b83d1a;
  --err:#f2585b; --err-soft:#f2585b1a;
  --hover:#ffffff09; --active:#ffffff14;
  --hairline:#ffffff08;
  --shadow-sm:none; --shadow:none;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme]){
    --bg:#0b0d12; --panel:#151821; --panel-2:#0f1218; --line:#252a37; --line-2:#1c212c;
    --fg:#e8eaf0; --fg-2:#c8ccd8; --dim:#8b93a7; --dim2:#5d6678;
    --accent:#6b95ff; --accent-soft:#6b95ff1f;
    --ok:#3ecf8e; --ok-soft:#3ecf8e1a;
    --warn:#f5b83d; --warn-soft:#f5b83d1a;
    --err:#f2585b; --err-soft:#f2585b1a;
    --hover:#ffffff09; --active:#ffffff14;
    --hairline:#ffffff08; --shadow-sm:none; --shadow:none;
  }
}

/* ══ 基础 ═════════════════════════════════════════════════════ */
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; min-height:100vh; color:var(--fg);
  background:var(--bg); background-image:var(--bg-grad); background-attachment:fixed;
  font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif;
  transition:background-color .2s, color .2s;
  -webkit-font-smoothing:antialiased;
}
::selection{background:var(--accent-soft)}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--line);border-radius:99px;border:2px solid transparent;background-clip:content-box}
::-webkit-scrollbar-thumb:hover{background:var(--dim2);background-clip:content-box}

/* ══ 外壳：左侧栏 + 内容区 ═══════════════════════════════════
   侧栏可收起成图标条（64px），也可展开（224px）。状态记在 localStorage，
   pref 为 "auto" 时按窗口宽度自动决定（窄屏直接收成图标）。
   ═══════════════════════════════════════════════════════════ */
.shell{display:flex;min-height:100vh;align-items:stretch}

/* ── 侧栏 ── */
.side{
  flex:none;width:224px;position:sticky;top:0;height:100vh;z-index:60;
  display:flex;flex-direction:column;
  background:color-mix(in srgb, var(--panel) 72%, var(--bg));
  backdrop-filter:saturate(160%) blur(12px);
  -webkit-backdrop-filter:saturate(160%) blur(12px);
  border-right:1px solid var(--line);
  transition:width .18s cubic-bezier(.4,0,.2,1);
}
.shell.collapsed .side{width:64px}

.side .top{
  display:flex;align-items:center;gap:10px;
  height:56px;padding:0 14px;flex:none;overflow:hidden;
}
/* logo 是个按钮 —— 点开「关于 WhalePod」 */
.side .brandbtn{
  display:flex;align-items:center;gap:10px;
  appearance:none;background:transparent;border:0;padding:4px;margin:-4px;
  border-radius:11px;cursor:pointer;color:inherit;font:inherit;
  transition:background-color .13s;overflow:hidden;
}
.side .brandbtn:hover{background:var(--hover)}
/* ⚠️ 这里**不要**再加 border-radius —— 图标 PNG 本身已经是圆角方形
   （见 scripts/gen-icons.mjs），再裁一次会出现"圆角叠圆角"的毛边。
   要改形状请改生成脚本，而不是这里的 CSS。 */
.side .logo{
  width:30px;height:30px;flex:none;display:block;
  box-shadow:var(--shadow-sm);transition:transform .16s;
}
.side .brandbtn:hover .logo{transform:scale(1.08) rotate(-3deg)}
.side .name{
  font-size:14.5px;font-weight:650;letter-spacing:.2px;white-space:nowrap;
  opacity:1;transition:opacity .12s;
}
.shell.collapsed .side .name{opacity:0;pointer-events:none;width:0}
.shell.collapsed .side .brandbtn{justify-content:center}

/* ══ 弹层（关于 / 通用）═══════════════════════════════════════ */
.overlay{
  position:fixed;inset:0;z-index:200;
  background:#00000059;backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);
  display:grid;place-items:center;padding:24px;
  animation:fadein .16s ease;
}
@keyframes fadein{from{opacity:0}to{opacity:1}}

/* ══ 内置打开协议端管理界面（iframe 全屏浮层）═════════════════
   比新开标签页好在：① 不用离开 WhalePod ② token 自动带上，
   用户不用自己去日志/配置里找 token 再粘贴。 */
.webwrap{
  position:fixed;inset:0;z-index:300;
  background:var(--bg);display:flex;flex-direction:column;
  animation:fadein .16s ease;
}
.webhd{
  display:flex;align-items:center;gap:6px;flex-wrap:wrap;
  padding:10px 14px;border-bottom:1px solid var(--line);background:var(--panel);
  flex:0 0 auto;
}
.webhd .ico{display:inline-flex;color:var(--accent)}
.webhd .note{font-size:12px;color:var(--dim)}
.webnote{
  padding:6px 14px;border-bottom:1px solid var(--line);background:var(--bg-2);
  font-size:12px;color:var(--dim2);flex:0 0 auto;
}
.webbody{flex:1 1 auto;min-height:0;background:#fff}
.webbody iframe{width:100%;height:100%;border:0;display:block}
.overlay .modal{
  width:100%;max-width:520px;max-height:86vh;overflow:auto;
  background:var(--panel);border:1px solid var(--line);border-radius:18px;
  box-shadow:0 20px 60px -12px #00000059;
  animation:pop .19s cubic-bezier(.34,1.4,.64,1);
}
@keyframes pop{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}
.overlay .mhd{
  display:flex;align-items:center;gap:13px;padding:20px 22px 16px;
  border-bottom:1px solid var(--line-2);
}
/* 图标 PNG 自带圆角，这里只定尺寸（加 border-radius 会造成圆角叠圆角） */
.overlay .mhd img{width:52px;height:52px;flex:none;box-shadow:var(--shadow-sm)}
/* emoji 图标：和图片同样尺寸的方块，保证标题对齐 */
.overlay .mhd .mico{
  width:52px;height:52px;flex:none;display:grid;place-items:center;
  font-size:26px;line-height:1;border-radius:14px;
  background:var(--panel-2);border:1px solid var(--line);
}
/* SVG 图标：同样的方块，但图标本身随主题色 */
.overlay .mhd .mico.svg{color:var(--accent)}
.overlay .mhd .tt{min-width:0}
.overlay .mhd h2{margin:0 0 2px;font-size:17px;font-weight:680;letter-spacing:.2px}
.overlay .mhd p{margin:0;color:var(--dim);font-size:12.5px;line-height:1.5}
.overlay .mx{
  margin-left:auto;flex:none;width:30px;height:30px;border-radius:8px;
  appearance:none;background:transparent;border:1px solid var(--line);
  color:var(--dim);cursor:pointer;font-size:15px;line-height:1;
  display:grid;place-items:center;transition:all .13s;
}
.overlay .mx:hover{color:var(--fg);border-color:var(--dim2);background:var(--hover)}
.overlay .mbd{padding:18px 22px 22px}
.overlay .mbd h4{margin:0 0 7px;font-size:12px;font-weight:650;color:var(--dim);
  text-transform:uppercase;letter-spacing:.5px}
.overlay .mbd ul{margin:0 0 16px;padding-left:19px;color:var(--fg-2);font-size:13.5px;line-height:1.85}
.overlay .mbd ul:last-child{margin-bottom:0}
.overlay .mbd li::marker{color:var(--accent)}
.overlay .mbd code{font-size:12.5px}
.overlay .mft{padding:14px 22px;border-top:1px solid var(--line-2);
  display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.overlay .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}
.overlay .feat{padding:11px 13px;border:1px solid var(--line);border-radius:11px;
  background:var(--panel-2)}
.overlay .feat b{display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:3px}
.overlay .feat b svg{color:var(--accent);flex:none}
.overlay .feat span{color:var(--dim);font-size:12px;line-height:1.55}
@media (max-width:520px){.overlay .grid2{grid-template-columns:1fr}}

/* 导航项 */
.side .menu{flex:1;overflow-y:auto;overflow-x:hidden;padding:6px 10px 10px}
.side .menu::-webkit-scrollbar{width:6px}
.side .item{
  display:flex;align-items:center;gap:11px;
  width:100%;padding:9px 11px;margin-bottom:2px;
  appearance:none;border:0;background:transparent;color:var(--dim);
  border-radius:10px;cursor:pointer;font:inherit;font-size:13.5px;
  text-align:left;white-space:nowrap;position:relative;
  transition:color .13s, background-color .13s;
}
.side .item:hover{color:var(--fg);background:var(--hover)}
.side .item.on{color:var(--accent);background:var(--accent-soft);font-weight:600}
.side .item .ic{
  display:inline-flex;align-items:center;justify-content:center;
  flex:none;width:22px;height:22px;
}
.side .item .ic svg{display:block}
.side .item .lb{flex:1;overflow:hidden;text-overflow:ellipsis;opacity:1;transition:opacity .12s}
.shell.collapsed .side .item .lb{opacity:0;width:0;flex:0}
.shell.collapsed .side .item{justify-content:center;padding:9px 0}
.side .item .bdg{
  flex:none;font-size:11px;padding:1px 6px;border-radius:99px;
  background:var(--on);color:var(--dim);
}
.shell.collapsed .side .item .bdg{display:none}
/* 收起时，用浮层 tooltip 补上文字 */
.shell.collapsed .side .item::after{
  content:attr(data-tip);
  position:absolute;left:calc(100% + 8px);top:50%;transform:translateY(-50%);
  background:var(--fg);color:var(--bg);font-size:12px;font-weight:500;
  padding:4px 9px;border-radius:7px;white-space:nowrap;
  opacity:0;pointer-events:none;transition:opacity .12s;z-index:99;
}
.shell.collapsed .side .item:hover::after{opacity:1}

/* 侧栏底部 */
.side .bot{flex:none;padding:10px;border-top:1px solid var(--line-2);display:flex;flex-direction:column;gap:6px}
.side .bot .row2{display:flex;gap:6px;min-width:0}
/* 收起时竖排两个方块按钮 */
.shell.collapsed .side .bot .row2{flex-direction:column}
.iconbtn{
  display:flex;align-items:center;justify-content:center;gap:7px;
  height:34px;padding:0 10px;flex:1 1 0;min-width:0;
  appearance:none;background:transparent;border:1px solid var(--line);
  color:var(--dim);border-radius:9px;cursor:pointer;font:inherit;font-size:13px;
  transition:all .13s;white-space:nowrap;overflow:hidden;
}
.iconbtn:hover{color:var(--fg);border-color:var(--dim2);background:var(--hover)}
.iconbtn .lb{
  overflow:hidden;text-overflow:ellipsis;min-width:0;
}
.iconbtn svg{flex:none}
.shell.collapsed .iconbtn .lb{display:none}
.shell.collapsed .iconbtn{padding:0;flex:1 1 auto}

/* ── 内容区 ── */
.main-wrap{flex:1;min-width:0;display:flex;flex-direction:column}
.topbar{
  position:sticky;top:0;z-index:40;flex:none;
  display:flex;align-items:center;gap:12px;
  height:56px;padding:0 20px;
  background:color-mix(in srgb, var(--bg) 80%, transparent);
  backdrop-filter:saturate(180%) blur(14px);
  -webkit-backdrop-filter:saturate(180%) blur(14px);
  border-bottom:1px solid var(--line);
}
.topbar h1{margin:0;font-size:15px;font-weight:650;letter-spacing:.2px}
.topbar .sub{color:var(--dim);font-size:12.5px;margin-left:2px}
.topbar .sp{margin-left:auto;display:flex;align-items:center;gap:8px}

/* 移动端：默认收起，展开时浮在内容上 */
@media (max-width:820px){
  .side{position:fixed;left:0;top:0;box-shadow:var(--shadow)}
  .shell.collapsed .side{width:56px}
  .main-wrap{margin-left:56px}
  .shell:not(.collapsed) .main-wrap{margin-left:56px}
  .shell:not(.collapsed) .side{width:224px}
}

/* ══ 旧顶栏样式已移除 ════════════════════════════════════════
   这里原本有一套 header/nav/#themebtn 的规则（早期是顶部横向导航）。
   改成左侧栏后它们已经没人用，但 #themebtn 那条**仍然生效** ——
   ID 选择器优先级比 .iconbtn 高，于是侧栏底部的主题按钮被强行
   设成 display:grid + width:34px，和"收起"按钮宽度严重不均。
   整块删掉，别再留这种"看起来没人用其实在生效"的样式。 */

/* ══ 布局 ═════════════════════════════════════════════════════ */
main{padding:22px;max-width:1320px;margin:0 auto;width:100%;animation:fade .22s ease}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));align-items:start}
.grid.wide{grid-template-columns:repeat(auto-fit,minmax(420px,1fr))}
.span2{grid-column:span 2}
@media (max-width:760px){.span2{grid-column:span 1}}

/* ══ 卡片 ═════════════════════════════════════════════════════ */
.card{
  background:var(--panel); border:1px solid var(--line); border-radius:var(--radius);
  box-shadow:var(--shadow); overflow:hidden;
}
.card>.hd{
  display:flex;align-items:center;gap:9px;
  padding:13px 17px; border-bottom:1px solid var(--line-2);
}
.card>.hd h2{margin:0;font-size:13px;font-weight:650;color:var(--fg-2);letter-spacing:.2px}
/* 卡片标题图标：SVG 与文字对齐。
   SVG 默认 inline，会和文字之间留出基线间隙；用 flex 居中最稳。 */
.card>.hd .ico{
  display:inline-flex;align-items:center;justify-content:center;
  flex:none;color:var(--dim);
}
.card>.hd .ico svg{display:block}
/* 兜底：图标名不存在时按文字渲染（例如临时塞 emoji） */
.ico-txt{line-height:1;display:inline-block}

/* 通用 SVG 图标 */
svg.ic{display:block;flex:none}
.card>.hd .spacer{margin-left:auto}
.card>.bd{padding:6px 17px 13px}
.card>.bd.tight{padding:0}
.card>.ft{padding:11px 17px;border-top:1px solid var(--line-2);display:flex;gap:8px}

/* ══ 可折叠卡片 ═══════════════════════════════════════════════
   标题整行可点（点击区域大、键盘可达）；内容用 grid-template-rows
   从 0fr 到 1fr 过渡，这样高度未知也能平滑展开（比 max-height 猜测更稳）。

   ⚠️ 标题栏是 div[role=button] 而不是 <button>：右侧允许放搜索框、
   按钮等控件，而 HTML 禁止 button 嵌套 button（浏览器会把内层提出来，
   布局直接乱掉）。键盘可达性由 JS 的 keydown 补上。 */
.card.fold>.foldhd{
  width:100%;display:flex;align-items:center;gap:9px;
  padding:13px 17px;border:0;background:transparent;
  font:inherit;text-align:left;cursor:pointer;color:inherit;
  transition:background-color .13s, border-color .13s;
  user-select:none;
}
.card.fold>.foldhd:hover{background:var(--hover)}
.card.fold>.foldhd:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
/* 标题栏里的控件恢复"正常光标"，别显示成可折叠的手型 */
.card.fold>.foldhd input,.card.fold>.foldhd button,
.card.fold>.foldhd select,.card.fold>.foldhd a{cursor:auto}
.card.fold>.foldhd .ico{color:var(--dim)}
.card.fold>.foldhd h2{margin:0;font-size:13px;font-weight:650;color:var(--fg-2);
  letter-spacing:.2px;flex:none}
.card.fold>.foldhd .foldsub{
  color:var(--dim2);font-size:12px;font-weight:400;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;
}
.card.fold>.foldhd .foldchev{
  flex:none;color:var(--dim2);transition:transform .18s cubic-bezier(.4,0,.2,1);
}
.card.fold.open>.foldhd .foldchev{transform:rotate(180deg)}
/* 内容区：0fr → 1fr 平滑展开。
   ⚠️ 必须把内容包在**单个**子元素里（.foldinner）：grid-template-rows
   只定义了一条轨道，若 .foldbd 有多个直接子元素，多余的会落进
   **隐式行**（高度 auto），于是收起状态下依然撑开整张卡片。
   ⚠️ padding 也必须放在再内一层的 .foldpad：.foldinner 自己要零 padding，
   否则 box-sizing:border-box 下 padding 会撑出一个最小高度，
   折叠后仍留一截空白。 */
.card.fold>.foldbd{
  display:grid;grid-template-rows:0fr;
  transition:grid-template-rows .2s cubic-bezier(.4,0,.2,1);
}
.card.fold.open>.foldbd{grid-template-rows:1fr}
.card.fold>.foldbd>.foldinner{
  overflow:hidden;min-height:0;
}
.card.fold>.foldbd>.foldinner>.foldpad{
  padding:6px 17px 13px;
}
/* 收起时不占位、不可聚焦（避免 Tab 跳进看不见的控件） */
.card.fold:not(.open)>.foldbd{visibility:hidden}
/* ⚠️ .foldbd 也带 .bd 类，会被 ".card>.bd{padding:...}" 命中。
   那 19px 的上下 padding 让"收起"状态下仍留一条空白；
   这里显式清零，间距统一交给内层 .foldpad。 */
.card.fold>.foldbd{padding:0}
/* 折叠卡片的头下面不该再有分隔线（展开时由内容区自己管） */
.card.fold>.foldhd{border-bottom:1px solid transparent;transition:background-color .13s, border-color .13s}
.card.fold.open>.foldhd{border-bottom-color:var(--line-2)}

/* ══ 模型页 ═══════════════════════════════════════════════════ */
/* 优先级排序行（可拖拽 + 开关）
   紧凑单行：手柄·序号·名字·标签 …… 开关靠右。
   箭头按钮已去掉 —— 拖整行就够用，箭头白白吃掉一半行宽。 */
.ordrow{
  display:flex;align-items:center;gap:8px;padding:3px 10px 3px 2px;
  border:1px solid var(--line);border-radius:8px;margin-bottom:3px;
  background:var(--panel-2);
  transition:border-color .12s, opacity .12s, background-color .12s;
}
.ordrow:hover{border-color:var(--dim2)}
/* 拖动中的行：半透明 + 虚线边 */
.ordrow.dragging{opacity:.42;border-style:dashed}
/* 落点指示：在目标行的上/下沿画一条高亮线 */
.ordrow.dragover-top{box-shadow:0 -2px 0 0 var(--accent)}
.ordrow.dragover-bottom{box-shadow:0 2px 0 0 var(--accent)}
/* 拖拽手柄：平时淡化，hover 才明显 */
.ordrow .ordgrip{
  flex:none;display:grid;place-items:center;width:16px;height:20px;
  color:var(--dim2);cursor:grab;opacity:.45;transition:opacity .12s, color .12s;
}
.ordrow:hover .ordgrip{opacity:1;color:var(--dim)}
.ordrow .ordgrip:active{cursor:grabbing}
.ordrow .ordn{
  flex:none;width:17px;height:17px;border-radius:5px;
  background:var(--on);color:var(--dim);font-size:10px;font-weight:650;
  display:grid;place-items:center;font-variant-numeric:tabular-nums;
}
.ordrow .ordp{font-family:ui-monospace,Consolas,monospace;font-size:12px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 渠道列表：**单列**。
   双排虽然更省高度，但每栏只有 ~285px，塞进"编号+名字+模型数+延迟+
   徽标+开关"后必然挤压、显示不全 —— 用户明确要求回到单列。
   单列每行有整个卡片宽度，信息完整、不挤。
   高度上限 + 内部滚动：渠道再多也不撑高卡片。 */
.ordgrid{
  display:flex;flex-direction:column;gap:4px;
  max-height:340px;overflow-y:auto;overscroll-behavior:contain;
  padding-right:4px;
}

/* 试跑栏里的模型延迟：测哪个模型显示哪个，和渠道级延迟分工不同 */
.mtlat{
  font-family:ui-monospace,Consolas,monospace;font-size:11px;
  padding:2px 7px;border-radius:6px;font-variant-numeric:tabular-nums;
}
.mtlat.good{color:var(--ok);background:color-mix(in srgb,var(--ok) 13%,transparent)}
.mtlat.mid{color:var(--warn,#d9a441);background:color-mix(in srgb,var(--warn,#d9a441) 13%,transparent)}
.mtlat.bad{color:var(--err);background:color-mix(in srgb,var(--err) 13%,transparent)}

/* 单列布局：整行有完整卡片宽度，所以不需要任何"压进半栏"的收窄规则。
   （双排时期这里有过一套把字号/宽度压到极小的规则 —— 已删除，
   否则文字太小且白白占位。） */

/* 可用 / 已关闭 两组之间的分隔：只有一条虚线，不带文字
   （灰行自己就有「已关闭」徽标 + 划线，不需要再解释一遍） */
.orddivider{
  margin:6px 0 4px;padding-top:6px;
  border-top:1px dashed var(--line);
}

/* 延迟徽标：颜色区分快慢，一眼能看出该把谁排前面 */
.ordlat{
  flex:none;font-family:ui-monospace,Consolas,monospace;
  font-size:10px;padding:1px 5px;border-radius:5px;
  font-variant-numeric:tabular-nums;white-space:nowrap;
}
.ordlat.good{color:var(--ok);background:color-mix(in srgb,var(--ok) 13%,transparent)}
.ordlat.mid{color:var(--warn,#d9a441);background:color-mix(in srgb,var(--warn,#d9a441) 13%,transparent)}
.ordlat.bad{color:var(--err);background:color-mix(in srgb,var(--err) 13%,transparent)}
.ordlat.none{color:var(--dim2);background:var(--on)}

/* 模型数量：紧跟在渠道名后面，等宽数字对齐好扫读 */
.ordrow .ordcnt{
  flex:none;font-family:ui-monospace,Consolas,monospace;
  font-size:10.5px;color:var(--dim2);
  background:var(--on);border-radius:5px;padding:1px 6px;
  font-variant-numeric:tabular-nums;
}
/* 关掉的渠道：数量也压暗，别抢视觉 */
.ordrow.ordoff .ordcnt{opacity:.6}
/* 行内的标签也收小一号 */
.ordrow .chip{font-size:10px;padding:0 6px}
/* 开关推到最右：用 margin-left:auto，不需要占位的 spacer */
.ordrow .switch{margin-left:auto;flex:none}
/* 中间那片空白放状态说明，别让它空着浪费宽度。
   双排空间紧：允许它收缩到 0（信息在 title / 徽标里都有）。 */
.ordrow .ordnote{
  flex:1 1 auto;min-width:0;text-align:right;
  font-size:11px;color:var(--dim2);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  padding-right:2px;
}
/* 双排模式下更紧：优先保证名字/延迟/开关可见，说明文字让位 */
.ordgrid .ordnote{font-size:10px;padding-right:0;flex:0 1 auto}
/* 会被 auto 跳过的渠道：整体压暗，一眼能看出"排了但不会用" */
.ordrow.ordskip{opacity:.62;border-style:dashed}
/* 被开关关掉的渠道：更暗 + 名字划线，和 ordskip 视觉上区分开 */
.ordrow.ordoff{opacity:.5;background:transparent}
.ordrow.ordoff .ordp{text-decoration:line-through;color:var(--dim2)}

/* ── 开关 ────────────────────────────────────────────────────
   用纯 CSS 画（checkbox 本体透明），这样跟随主题色且体积可控。 */
.switch{
  position:relative;flex:none;display:inline-block;
  width:34px;height:19px;cursor:pointer;
}
.switch input{
  position:absolute;opacity:0;width:0;height:0;margin:0;
}
.switch>span{
  position:absolute;inset:0;border-radius:99px;
  background:var(--line);border:1px solid var(--line);
  transition:background-color .16s, border-color .16s;
}
.switch>span::before{
  content:'';position:absolute;top:2px;left:2px;
  width:13px;height:13px;border-radius:50%;
  background:var(--dim2);transition:transform .16s, background-color .16s;
}
.switch input:checked + span{background:var(--ok);border-color:var(--ok)}
.switch input:checked + span::before{transform:translateX(15px);background:#fff}
.switch input:focus-visible + span{box-shadow:0 0 0 3px var(--accent-soft)}
.switch:hover>span{border-color:var(--dim2)}

/* 后台模型身份核验：进度条 + 明确列出名不副实项 */
.auditbox{padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--panel-2)}
.audithead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px}
.audithead>b{font-size:13px;color:var(--fg)}
.audithead>span{color:var(--dim2)}
.auditcounts{margin-left:auto}
.auditcounts i{font-style:normal}
.auditcounts .bad{color:var(--err)}
.auditcounts .good{color:var(--ok)}
.auditbar{height:4px;border-radius:9px;background:var(--on);overflow:hidden;margin:8px 0}
.auditbar>span{display:block;height:100%;background:var(--accent);transition:width .25s}
.auditrows{display:flex;flex-direction:column;gap:4px;max-height:320px;overflow:auto}
.auditrow{display:grid;grid-template-columns:minmax(180px,1.2fr) auto minmax(180px,1fr);gap:6px 10px;align-items:center;padding:6px 8px;border-radius:7px;background:var(--panel)}
.auditrow.mismatch{border-left:3px solid var(--err)}
.auditrow.match{border-left:3px solid var(--ok)}
.auditrow.unknown{border-left:3px solid var(--dim2)}
.auditrow>code{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.auditbadge{font-size:10px;padding:2px 6px;border-radius:99px;background:var(--on);color:var(--dim)}
.auditrow.mismatch .auditbadge{color:var(--err);background:color-mix(in srgb,var(--err) 12%,transparent)}
.auditrow.match .auditbadge{color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}
.auditnote{font-size:11px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.auditsaid,.auditcached{grid-column:1/-1;font-size:10px;color:var(--dim2)}
@media(max-width:700px){.auditrow{grid-template-columns:1fr auto}.auditnote{grid-column:1/-1}}

/* 渠道列表：超过这个高度就内部滚动，别把下面整页顶下去。
   14 行约 420px；限到 ~300px 后一屏能同时看到优先级和模型清单。 */
.ordscroll{max-height:300px;overflow-y:auto;overscroll-behavior:contain;padding-right:2px}

/* 左右两栏等高布局：
   左 = 路由策略（总纲）+ 渠道优先级与开关
   右 = 模型选择 + 试跑模型（紧挨着，改完随手测）
   align-items:stretch 让两列拉平 —— 底部不留落差。
   窄屏（<900px）退回单列堆叠。 */
.mdcols{
  display:grid;grid-template-columns:1fr 1fr;gap:12px;
  align-items:stretch;
}
.mdcol{display:flex;flex-direction:column;gap:12px;min-width:0}
/* ⚠️ 两列各自按内容高度，不要让最后一张卡片被拉长。
   拉长的话卡片里会出现大片空白（用户反馈"下面空一大块"）。
   等高靠 grid 的 stretch 对齐行，而不是把卡片撑开。 */
.mdcol>.card:last-child{flex:0 0 auto}
@media(max-width:900px){.mdcols{grid-template-columns:1fr}}

/* ══ 模型清单（按模型归纳）═══════════════════════════════════
   每一行 = 一个模型（主体），下面挂可用它的渠道（附属）。
   渠道是可点的 chip —— 点一下就等于选定"该渠道 + 该模型"，
   省掉"先选渠道再选模型"两步。 */
.mdgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:2px}
.mdrow{
  display:flex;flex-direction:column;gap:3px;
  padding:7px 9px;border-radius:9px;min-width:0;
  border:1px solid transparent;transition:background-color .12s, border-color .12s;
}
.mdrow:hover{background:var(--hover);border-color:var(--line)}
.mdmain{min-width:0}
.mdrow .mdid{
  font-family:ui-monospace,Consolas,monospace;font-size:12.5px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--fg);font-weight:550;
}
/* 渠道（地址）跟在模型名后面，小一号、次要色 */
.mdprovs{display:flex;flex-wrap:wrap;gap:4px;margin-top:3px}
.provchip{
  appearance:none;cursor:pointer;font:inherit;
  font-size:11px;line-height:1.6;padding:1px 7px;border-radius:6px;
  background:var(--panel-2);border:1px solid var(--line);color:var(--dim);
  transition:all .12s;white-space:nowrap;
}
.provchip:hover{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}
.provchip.self{color:var(--dim2);border-style:dashed}
.provchip.self:hover{color:var(--accent);border-color:var(--accent)}

/* 折叠卡标题栏里的搜索框：别让它触发折叠，也别被挤扁。
   ⚠️ 选择器必须带 .foldhd 前缀。全局规则里有
   "input:not([type]){width:100%}"（优先级 0,1,1），而单独的
   ".mdsearch"（0,1,0）压不住它 —— 结果搜索框被撑成整行宽，
   把刷新按钮和折叠箭头挤出了标题栏。加一层类名升到 (0,2,0) 才稳。
   尺寸：平时窄（省地方），聚焦或已有输入时展开（方便看内容）。 */
.foldhd .mdsearch{
  flex:none;
  width:112px;height:26px;padding:0 9px;font-size:12.5px;
  border-radius:7px;background:var(--panel-2);border:1px solid var(--line);
  transition:width .18s cubic-bezier(.4,0,.2,1), border-color .13s;
}
.foldhd .mdsearch:focus{width:220px}
/* 已经输入了内容就保持展开，免得回看时只看到几个字 */
.foldhd .mdsearch:not(:placeholder-shown){width:220px}

/* ══ 模型组合框（输入 + 分组下拉）═════════════════════════════
   替代原生 datalist：能分组、能显示可用渠道、样式跟主题走。 */
.mcombo{position:relative;width:100%}
.mcombo-box{
  display:flex;align-items:center;
  background:var(--panel-2);border:1px solid var(--line);
  border-radius:var(--radius-sm);transition:border-color .13s, box-shadow .13s;
}
.mcombo.open .mcombo-box{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
/* ⚠️ 选择器要写全：全局 input:not([type]) 规则会覆盖单独的类选择器 */
.mcombo .mcombo-input{
  flex:1;min-width:0;width:auto;
  background:transparent;border:0;outline:none;box-shadow:none;
  font:inherit;font-size:13.5px;color:var(--fg);
  padding:8px 4px 8px 11px;
}
.mcombo .mcombo-input:focus{border:0;box-shadow:none}
.mcombo .mcombo-btn{
  flex:none;display:grid;place-items:center;
  width:30px;height:34px;padding:0;
  background:transparent;border:0;color:var(--dim);cursor:pointer;
  transition:color .13s, transform .18s;
}
.mcombo.open .mcombo-btn{transform:rotate(180deg);color:var(--accent)}
.mcombo-btn:hover{color:var(--fg)}

.mcombo-panel{
  position:absolute;left:0;right:0;top:calc(100% + 5px);z-index:60;
  max-height:min(46vh, 380px);overflow-y:auto;overscroll-behavior:contain;
  background:var(--panel);border:1px solid var(--line);
  border-radius:var(--radius);box-shadow:0 12px 34px rgba(0,0,0,.34);
  padding:5px;animation:pop .13s ease;
}
.mcombo-panel[hidden]{display:none}
.mcombo-group{margin-bottom:2px}
.mcombo-gt{
  display:flex;align-items:center;gap:7px;
  padding:7px 9px 4px;font-size:11px;font-weight:650;
  color:var(--dim2);text-transform:uppercase;letter-spacing:.5px;
  position:sticky;top:0;background:var(--panel);z-index:1;
}
.mcombo-gt>span{
  font-weight:400;letter-spacing:0;text-transform:none;
  background:var(--on);color:var(--dim2);
  padding:0 5px;border-radius:99px;font-size:10px;
}
.mcombo-item{
  display:flex;align-items:baseline;gap:10px;
  padding:5px 9px;border-radius:7px;cursor:pointer;
}
.mcombo-item.hot,.mcombo-item:hover{background:var(--accent-soft)}
.mcombo-name{
  flex:none;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;
  color:var(--fg);
}
.mcombo-prov{
  flex:1;min-width:0;text-align:right;
  font-size:11px;color:var(--dim2);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.mcombo-more{padding:3px 9px;font-size:11px;color:var(--dim2)}
.mcombo-empty{padding:14px 9px;text-align:center;color:var(--dim2);font-size:12.5px}

/* 能力过滤条：全部 / 能看图 / 纯文本。
   669 个模型里只有 ~156 个能看图，不分组的话想做图片识别根本找不着。 */
.mcombo-caps{
  display:flex;gap:6px;align-items:center;
  padding:7px 9px 8px;border-bottom:1px solid var(--line);
  position:sticky;top:0;background:var(--panel);z-index:1;
}
.mcombo-caps .chip{font-size:11.5px;padding:3px 9px}
/* 能看图的模型前面的眼睛标记 */
.mcombo-eye{
  flex:none;display:inline-flex;align-items:center;
  color:var(--accent);opacity:.85;
}
/* 「模型类型」选择器里的数量角标 */
#mdcap .capn{
  margin-left:5px;padding:0 5px;border-radius:6px;
  background:var(--bg-2);color:var(--dim2);
  font-size:10.5px;font-variant-numeric:tabular-nums;
}
#mdcap .chip.accent .capn{background:rgba(255,255,255,.18);color:inherit}
#mdcap .chip{display:inline-flex;align-items:center;gap:4px}

/* 组合框打开时，临时放开裁剪 —— 否则下拉面板被切成一小条。
   ⚠️ 真正的裁剪者是 **.card 自己**（见上面的 overflow:hidden），
   不是 .foldinner。两层都要放开才不会被切。
   面板打开时卡片已是展开态，放开不影响折叠动画。 */
.card.fold.combo-open{overflow:visible}
.card.fold.combo-open>.foldbd>.foldinner{overflow:visible}
.mcombo.drop-up .mcombo-panel{top:auto;bottom:calc(100% + 5px)}

/* 试跑失败后的"建议模型"列表：一列按钮，点了直接换过去重试 */
.sugbox{display:flex;flex-direction:column;gap:5px;margin-top:6px}
.sug{
  display:flex;flex-direction:column;align-items:flex-start;gap:2px;
  width:100%;text-align:left;appearance:none;cursor:pointer;font:inherit;
  padding:7px 10px;border-radius:9px;
  background:var(--panel-2);border:1px solid var(--line);color:var(--fg);
  transition:border-color .13s, background-color .13s;
}
.sug:hover{border-color:var(--accent);background:var(--accent-soft)}
.sugm{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;font-weight:550}
.sugw{font-size:11px;color:var(--dim2)}

/* 带说明文字的自定义复选框（原生 checkbox 太小、也不跟主题色） */
.chk{
  display:flex;align-items:flex-start;gap:8px;cursor:pointer;
  font-size:12.5px;color:var(--dim);user-select:none;
}
.chk>input{position:absolute;opacity:0;width:0;height:0;margin:0}
.chk>span:first-of-type{
  flex:none;width:16px;height:16px;margin-top:1px;border-radius:5px;
  border:1px solid var(--line);background:var(--panel-2);
  display:grid;place-items:center;transition:all .13s;
}
.chk>input:checked+span:first-of-type{
  background:var(--accent);border-color:var(--accent);
}
.chk>input:checked+span:first-of-type::after{
  content:'';width:4px;height:8px;margin-top:-2px;
  border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg);
}
.chk>input:focus-visible+span:first-of-type{box-shadow:0 0 0 3px var(--accent-soft)}
.chk:hover>span:first-of-type{border-color:var(--dim2)}
.chklb{line-height:1.5}

/* 试跑结果可能很长（模型输出 + 尝试链 + 建议列表）——
   同样**框内滚动**，不要让它把卡片撑高、把别的卡片顶走。 */
#mtout{
  max-height:min(38vh, 320px);overflow-y:auto;overscroll-behavior:contain;
}
#mtout pre{white-space:pre-wrap;word-break:break-word}

/* 自备渠道的添加/编辑区：和列表同在一张卡里，用底色区分开 */
.chform{
  padding:13px 14px;border-radius:11px;
  background:var(--panel-2);border:1px solid var(--line);
}
.chform-hd{
  display:flex;align-items:center;gap:10px;margin-bottom:10px;
}
.chform-hd>b{font-size:13px}
.chform-hd .chcancel{margin-left:auto}

/* ══ 键值行 ═══════════════════════════════════════════════════ */
.kv{display:flex;align-items:baseline;justify-content:space-between;gap:14px;
  padding:7px 0;border-bottom:1px solid var(--hairline)}
.kv:last-child{border-bottom:0}
.kv .k{color:var(--dim);font-size:13px;flex:none}
.kv .v{font-variant-numeric:tabular-nums;text-align:right;word-break:break-all;
  font-size:13px;color:var(--fg-2)}
.kv .v.strong{color:var(--fg);font-weight:600}
.kv .v.mono{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:12.5px}

/* ══ 大数字（指标卡）══════════════════════════════════════════
   ⚠️ 以前是 gap:2px + 背景色当分隔线 —— 四块并成一整条，
   看着像挤在一起、没有间隔。现在拆成各自独立的卡片。 */
.metrics{
  display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));
  gap:12px;
}
.metric{
  background:var(--panel);padding:13px 17px;
  border:1px solid var(--line);border-radius:var(--radius);
  box-shadow:var(--shadow);
}
.metric .n{font-size:23px;font-weight:650;letter-spacing:-.4px;line-height:1.2;
  font-variant-numeric:tabular-nums}
.metric .n small{font-size:13px;font-weight:500;color:var(--dim);margin-left:3px}
.metric .l{color:var(--dim);font-size:12px;margin-top:2px}
.metric.ok .n{color:var(--ok)} .metric.warn .n{color:var(--warn)} .metric.err .n{color:var(--err)}
.metric.accent .n{color:var(--accent)}

/* ══ 标签 ═════════════════════════════════════════════════════ */
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{
  display:inline-flex;align-items:center;gap:5px;
  padding:3px 10px;border-radius:99px;font-size:12px;line-height:1.7;
  border:1px solid var(--line);color:var(--dim);background:var(--panel-2);
  white-space:nowrap;
}
.chip.on{color:var(--ok);border-color:transparent;background:var(--ok-soft)}
.chip.off{color:var(--err);border-color:transparent;background:var(--err-soft)}
.chip.warn{color:var(--warn);border-color:transparent;background:var(--warn-soft)}
.chip.accent{color:var(--accent);border-color:transparent;background:var(--accent-soft)}
.chip.click{cursor:pointer;transition:all .13s}
.chip.click:hover{border-color:var(--dim2);color:var(--fg)}
.chip .x{opacity:.55;cursor:pointer}
.chip .x:hover{opacity:1}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}

/* ══ 按钮 ═════════════════════════════════════════════════════ */
/* ⚠️ 同时管 button 和 a —— 「打开主页 / 仓库」是链接，但外观要和按钮一致。
   原来只写了 button.act，所以 <a class="act"> 完全没样式，看起来像纯文字。 */
button.act, a.act{
  appearance:none;font:inherit;font-size:13px;cursor:pointer;
  padding:8px 15px;border-radius:var(--radius-sm);border:1px solid transparent;
  background:var(--accent);color:#fff;font-weight:550;
  display:inline-flex;align-items:center;gap:5px;text-decoration:none;
  transition:filter .13s, background-color .13s, border-color .13s;
}
button.act:hover, a.act:hover{filter:brightness(1.08)}
button.act:active, a.act:active{filter:brightness(.95)}
button.act:disabled{opacity:.5;cursor:not-allowed;filter:none}
button.act.ghost, a.act.ghost{background:transparent;color:var(--fg-2);border-color:var(--line)}
button.act.ghost:hover, a.act.ghost:hover{background:var(--hover);border-color:var(--dim2);filter:none}
button.act.danger{background:var(--err)}
button.act.sm, a.act.sm{padding:5px 11px;font-size:12.5px}
/* 纯图标按钮：正方形，只放一个 SVG */
button.act.icon-only, a.act.icon-only{
  padding:6px;width:30px;height:30px;justify-content:center;
}
button.act svg, a.act svg{flex:0 0 auto}

/* 日志页的关键词过滤框 */
input.lfilter{
  width:auto !important;min-width:180px;max-width:300px;
  padding:5px 10px;font-size:12.5px;border-radius:var(--radius-sm);
  background:var(--bg-2);border:1px solid var(--line);color:var(--fg);
}

/* ══ 表单 ═════════════════════════════════════════════════════ */
input[type=text],input[type=number],input:not([type]),textarea,select{
  width:100%;font:inherit;font-size:13.5px;color:var(--fg);
  background:var(--panel-2);border:1px solid var(--line);border-radius:var(--radius-sm);
  padding:8px 11px;transition:border-color .13s, box-shadow .13s;
}
input:focus,textarea:focus,select:focus{
  outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft);
}
input[type=checkbox]{width:auto;accent-color:var(--accent)}
textarea{min-height:80px;resize:vertical;line-height:1.55}
label{color:var(--dim);font-size:13px}
.field{display:flex;flex-direction:column;gap:5px}
.field>label{font-size:12.5px;color:var(--dim)}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
.row>.field{flex:1 1 150px}
.row.check{align-items:center;gap:16px}
.row.check label{display:inline-flex;align-items:center;gap:6px;cursor:pointer}

/* ══ 代码 / 日志 ══════════════════════════════════════════════ */
pre{
  margin:0;padding:13px 15px;background:var(--panel-2);
  border:1px solid var(--line);border-radius:var(--radius-sm);
  overflow:auto;max-height:46vh;font-size:12.5px;line-height:1.6;
  font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
}
code{background:var(--panel-2);padding:1.5px 6px;border-radius:5px;
  font-size:12.5px;font-family:ui-monospace,Consolas,monospace}
.log{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:12.5px;
  max-height:62vh;overflow:auto;padding:4px 0}
.log .ln{display:flex;gap:10px;padding:2px 17px;border-bottom:1px solid var(--hairline);
  white-space:pre-wrap;word-break:break-all;line-height:1.55}
.log .ln:hover{background:var(--hover)}
.log .t{color:var(--dim2);flex:none;font-variant-numeric:tabular-nums}
.log .lv{flex:none;width:38px;font-weight:600;font-size:11.5px;padding-top:1px}
.log .m{flex:1;min-width:0}
.log .l-info .lv{color:var(--accent)}
.log .l-warn .lv{color:var(--warn)}
.log .l-error .lv{color:var(--err)}
.log .l-debug .lv{color:var(--dim2)}
.log .l-error{background:var(--err-soft)}

/* ══ 空态 / 提示 ══════════════════════════════════════════════ */
.empty{padding:30px 20px;text-align:center;color:var(--dim);font-size:13px}
.empty .big{font-size:30px;display:block;margin-bottom:8px;opacity:.45}
.banner{
  margin:0 0 16px;padding:14px 17px;border-radius:var(--radius);
  border:1px solid var(--warn);background:var(--warn-soft);color:var(--warn);
  font-size:13.5px;line-height:1.65;
}
.banner.err{border-color:var(--err);background:var(--err-soft);color:var(--err)}
.banner.ok{border-color:var(--ok);background:var(--ok-soft);color:var(--ok)}
.banner code{background:#00000012;color:inherit}
.note{color:var(--dim);font-size:12.5px;line-height:1.7}
.center{display:grid;place-items:center;min-height:50vh}
.spinner{width:22px;height:22px;border-radius:50%;border:2.5px solid var(--line);
  border-top-color:var(--accent);animation:spin .7s linear infinite;margin:0 auto}
@keyframes spin{to{transform:rotate(360deg)}}
.hide{display:none!important}
.mono{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace}
.mt{margin-top:16px} .mt-sm{margin-top:9px}
/* 模型与渠道页的区块间隔：统一的 12px 呼吸间距。
   用 :not(:empty) 保证"空容器不留空白" —— bannerBox 没内容时
   不该在页面顶部撑出一段空隙。 */
.mdgap{margin-top:12px}

/* ══ 模型统计表 ═════════════════════════════════════════════════
   纯观测数据表。列宽固定，数字用等宽对齐，方便竖着对比。 */
.statstbl{max-height:300px;overflow-y:auto;border:1px solid var(--line);border-radius:var(--radius-sm)}
.statsrow{
  display:grid;
  grid-template-columns:1fr 46px 62px 62px 50px 50px;
  align-items:center;gap:6px;
  padding:5px 9px;font-size:12px;
  border-bottom:1px solid var(--hairline);
}
.statsrow:last-child{border-bottom:0}
.statsrow > span{text-align:right;font-variant-numeric:tabular-nums;color:var(--fg-2)}
.statsrow > span.m{
  text-align:left;color:var(--fg);
  font-family:ui-monospace,Consolas,monospace;font-size:11.5px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.statshd{
  position:sticky;top:0;background:var(--bg-2);z-index:1;
  font-size:11px;color:var(--dim2);font-weight:600;
}
.statshd > span{color:var(--dim2)}
.statsrow:hover{background:var(--hover)}
.mdgap:empty{margin-top:0;height:0}
.txt-ok{color:var(--ok)} .txt-warn{color:var(--warn)} .txt-err{color:var(--err)}
.txt-dim{color:var(--dim)}
`

export const CLIENT_JS = `
(function(){
  // ── 存储适配层 ──────────────────────────────────────────────
  // 为什么需要：某些环境下 localStorage 会直接抛异常
  // （隐私模式、禁 Cookie、或嵌在 sandbox iframe 里 —— 报
  //  "Access is denied for this document"）。一旦没包住，
  // 脚本会在第一行就挂掉，表现为**整页空白**（连外壳都不渲染）。
  // 所以这里统一走 safeStore，不可用时降级为内存 Map。
  var mem = {}
  var store = {
    get: function(k){
      try { var v = localStorage.getItem(k); return v == null ? (mem[k] || null) : v }
      catch (_) { return mem[k] || null }
    },
    set: function(k, v){
      mem[k] = v
      try { localStorage.setItem(k, v) } catch (_) { /* 降级：只用内存 */ }
    },
    del: function(k){
      delete mem[k]
      try { localStorage.removeItem(k) } catch (_) { /* ignore */ }
    },
  }

  var root = document.getElementById('root')

  // ── token 的四种来源（按可靠性排序）────────────────────────
  //
  //   1. window.__WHALE_POD_TOKEN__  —— 服务端注进 app.js 的常量
  //   2. <meta name="whale-pod-token"> —— 服务端注进 HTML 的 meta
  //   3. URL 的 ?token=
  //   4. 本地存储兜底
  //
  // 为什么前两个存在：WhalePod 常被嵌在**跨源 iframe** 里（如 DSH 侧栏
  // 的浏览器面板）。那种环境里 localStorage 直接抛 "Access is denied"，
  // Cookie 可能不通，地址栏又是干净的 —— 于是用户只看到「请重填 token」。
  // 所以服务端在**回环请求**时把 token 直接写进页面，让它走到哪都能自证。
  //
  // 安全性：只绑 127.0.0.1；同源策略保证外部站点读不到本页字节。
  var qs = new URLSearchParams(location.search)
  var metaTok = ''
  var metaAuthed = false
  try {
    var mt = document.querySelector('meta[name="whale-pod-token"]')
    if (mt) metaTok = mt.getAttribute('content') || ''
    var ma = document.querySelector('meta[name="whale-pod-authed"]')
    metaAuthed = !!ma && ma.getAttribute('content') === '1'
  } catch (_) {}
  var token = (typeof window !== 'undefined' && window.__WHALE_POD_TOKEN__) ||
              qs.get('token') ||
              metaTok ||
              store.get('whale-pod-token') || ''
  if (token) store.set('whale-pod-token', token)

  // ⚠️ 拿到 token 后**不要**再 history.replaceState 抹掉地址栏：
  //    在存不了 storage 的环境里，抹掉就等于永久丢失凭据，
  //    用户会以为"这个页面打不开"。开发期尤其不要这么做。
  var authed = root.dataset.authed === 'true' || metaAuthed || Boolean(token)
  var tokenNeeded = root.dataset.tokenNeeded === 'true'

  if (!authed || !token) {
    root.innerHTML = '<div class="center"><div class="card" style="max-width:520px;width:100%">' +
      '<div class="hd"><span class="ico">' + svgIcon('lock', 16) + '</span><h2>需要访问令牌</h2></div>' +
      '<div class="bd">' +
        '<div class="note">WhalePod 的管理接口需要 token。把它粘在下面即可，' +
        '之后会记在这个标签页里。</div>' +
        '<div class="mt-sm"><input id="tokin" type="text" placeholder="gdn-…" autocomplete="off" spellcheck="false"></div>' +
        '<div class="mt-sm" style="display:flex;gap:8px;align-items:center">' +
          '<button class="act" id="tokgo">进入</button>' +
          '<span class="note" id="tokmsg"></span>' +
        '</div>' +
        '<div class="note mt">token 在这儿找：</div>' +
        '<div class="note">· 启动日志里 <code>管理界面：http://…?token=…</code> 那一行</div>' +
        '<div class="note">· 或 <code>~/.whale-pod/config.json</code> 的 <code>web.token</code></div>' +
      '</div></div></div>'
    var inp = document.getElementById('tokin')
    var msg = document.getElementById('tokmsg')
    function submit(){
      var v = (inp.value || '').trim()
      if (!v) { msg.innerHTML = '<span class="txt-err">请先粘贴 token</span>'; return }
      msg.textContent = '验证中…'
      // 先验一下再跳，避免带着错 token 刷新后还是一样
      fetch('/api/status', { headers: { authorization: 'Bearer ' + v } }).then(function(r){
        if (r.ok) {
          store.set('whale-pod-token', v)
          location.search = '?token=' + encodeURIComponent(v)
        } else {
          msg.innerHTML = '<span class="txt-err">token 不对（HTTP ' + r.status + '）</span>'
        }
      }).catch(function(e){ msg.innerHTML = '<span class="txt-err">' + esc(e.message) + '</span>' })
    }
    document.getElementById('tokgo').onclick = submit
    inp.onkeydown = function(ev){ if (ev.key === 'Enter') submit() }
    setTimeout(function(){ try { inp.focus() } catch(_){} }, 50)
    return
  }

  // ── 身份已确认（token 来自服务端注入/meta/URL/存储）───────
  // 这里不再重复解析 token —— 上面已经做过了。

  function api(p, init) {
    init = init || {}
    var h = Object.assign({}, init.headers || {})
    if (token) h.authorization = 'Bearer ' + token
    init.headers = h
    return fetch(p, init).then(function(r){
      var ct = r.headers.get('content-type') || ''
      if (!r.ok) {
        return r.text().then(function(t){
          var msg = t
          try { msg = JSON.parse(t).error || t } catch(_){}
          throw new Error(r.status + ' ' + String(msg).slice(0, 200))
        })
      }
      return ct.indexOf('json') >= 0 ? r.json() : r.text()
    })
  }

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] }) }
  /**
   * 时长格式化。
   *
   * ⚠️ 秒级不要带小数。原来写的是 toFixed(1) 形式（如 29.4s），
   *    而刷新定时器正好也是每 1000ms 一跳 —— 两者同频，于是整数位在
   *    涨、小数位永远冻在同一个数字上：
   *        29.4s → 30.4s → 31.4s
   *    看起来就像计时器坏了。改整数秒后是干净的 29s → 30s → 31s。
   *
   * ⚠️ 本文件注释里**绝对不要出现反引号** —— CLIENT_JS 是模板字符串，
   *    一个裸反引号就会把它截断，整个模块报 "Unexpected identifier"。
   */
  function ms(v){
    if (v == null) return '-'
    var s = Math.floor(v / 1000)
    if (s < 60) return s + 's'
    var m = Math.floor(s / 60)
    if (m < 60) return m + 'm ' + (s % 60) + 's'
    var h2 = Math.floor(m / 60)
    if (h2 < 24) return h2 + 'h ' + (m % 60) + 'm'
    return Math.floor(h2 / 24) + 'd ' + (h2 % 24) + 'h'
  }
  function num(n){ return (n == null ? '-' : String(n)) }
  /**
   * 把一段 HTML 变成**元素**节点。
   *
   * ⚠️ 不能用 div.firstChild —— 模板拼接常留下前导换行/空白，
   * 那样 firstChild 是 Text 节点；更糟的是当 HTML 只含文本时也拿不到元素。
   * 所以这里遍历找第一个 ELEMENT 节点。
   *
   * 另外：某些输入可能完全没有元素（例如空串），此时返回一个空 div，
   * 而不是 null —— 否则调用方 appendChild(null) 会直接抛
   * "parameter 1 is not of type 'Node'"，整页渲染中断。
   */
  function el(html) {
    var d = document.createElement('div')
    d.innerHTML = String(html == null ? '' : html)
    for (var i = 0; i < d.childNodes.length; i++) {
      if (d.childNodes[i].nodeType === 1) return d.childNodes[i]
    }
    // 没有元素节点：把文本包一层，保证返回值永远是 Element
    var wrap = document.createElement('div')
    wrap.textContent = d.textContent || ''
    return wrap
  }
  /** 安全 append：拒绝 null/undefined，避免整页因一个节点挂掉。 */
  function add(parent, node) {
    if (parent && node) parent.appendChild(node)
    return parent
  }

  // ── 图标 ────────────────────────────────────────────────────
  //
  // 图标库由服务端注入（见 server.js 的 injectIcons）。这里只做两件事：
  //   1. 把几何数据包成 <svg>，线宽按渲染尺寸反算（小图标线细一点才清楚）
  //   2. 找不到名字时退回文字（方便临时用 emoji 兜底，不会渲染成空白）
  //
  // stroke="currentColor" 是关键：图标自动继承父元素文字颜色，
  // 主题切换、hover 高亮、禁用态全都自然生效，不需要额外写样式。
  var ICONS = (typeof window !== 'undefined' && window.__WHALE_POD_ICONS__) || {}

  /**
   * @param {string} name  图标名（见 icons.js）
   * @param {number} [size=18]  渲染尺寸 px
   * @param {string} [cls]  额外 class
   */
  function svgIcon(name, size, cls) {
    size = size || 18
    var d = ICONS[name]
    if (!d) {
      // 没这个图标：原样当文字显示（支持临时塞 emoji）
      return '<span class="ico-txt" style="font-size:' + size + 'px">' + esc(name) + '</span>'
    }
    // 线宽：24 的 viewBox 缩到 size 后，视觉线宽 = 1.6 * (size/24)。
    // 小图标（<=16）线太细会看不见，所以给一个下限。
    var sw = Math.max(1.4, Math.min(2, 24 / size * 1.6)).toFixed(2)
    return '<svg class="ic ' + (cls || '') + '" width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + sw +
      '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'
  }

  /**
   * 统一的卡片构造：图标 + 标题 + 内容。
   *
   * icon 可以是 icons.js 里的名字，也可以直接是 emoji 字符串 ——
   * svgIcon() 找不到名字时会原样当文字渲染，所以旧调用点不用全改。
   */
  function card(icon, title, bodyHtml, opts) {
    opts = opts || {}
    var cls = 'card' + (opts.span2 ? ' span2' : '')
    var hd = '<div class="hd"><span class="ico">' + svgIcon(icon, 16) + '</span>' +
      '<h2>' + esc(title) + '</h2>' + (opts.right || '') + '</div>'
    var bd = bodyHtml ? '<div class="bd' + (opts.tight ? ' tight' : '') + '">' + bodyHtml + '</div>' : ''
    return el('<div class="' + cls + '">' + hd + bd + '</div>')
  }
  /**
   * 可折叠卡片。
   *
   * 为什么需要：有些页面的表单/长列表很占竖向空间（比如渠道页的
   * "添加渠道"表单、模型页的模型清单），用户大多数时候只看状态，
   * 不想被表单挤走视线。默认收起，点标题展开。
   *
   * 状态存在 localStorage（按 key 记忆），刷新后保持用户的选择。
   *
   * @param {object} o
   * @param {string} o.icon
   * @param {string} o.title
   * @param {string} o.body        展开后的内容 HTML
   * @param {string} [o.sub]       标题右侧的次要说明（收起时也能看到）
   * @param {string} [o.key]       记忆键；不传则不记忆
   * @param {boolean} [o.open]     默认是否展开
   * @param {string} [o.right]     标题栏右侧 HTML（不会被折叠）
   */
  function collapsibleCard(o) {
    var memKey = o.key ? 'whale-pod-open-' + o.key : ''
    var open = o.open === true
    if (memKey) {
      var saved = store.get(memKey)
      if (saved === '1') open = true
      else if (saved === '0') open = false
    }

    // ⚠️ 标题栏用 <div role="button">，**不能用 <button>**。
    //    因为 right/body 允许放任意 HTML（搜索框、按钮…），而 HTML
    //    不允许 button 嵌套 button —— 浏览器会把内层按钮提到外面，
    //    于是刷新按钮被挤到卡片外另起一行。踩过一次。
    var c = el('<div class="card fold' + (open ? ' open' : '') + '">' +
      '<div class="hd foldhd" role="button" tabindex="0">' +
        '<span class="ico">' + svgIcon(o.icon, 16) + '</span>' +
        '<h2>' + esc(o.title) + '</h2>' +
        (o.sub ? '<span class="foldsub">' + esc(o.sub) + '</span>' : '') +
        '<span class="spacer"></span>' +
        (o.right || '') +
        '<span class="foldchev">' + svgIcon('chevronDown', 16) + '</span>' +
      '</div>' +
      // 两层包裹：.foldinner 负责裁剪（零 padding），.foldpad 负责间距。
      // 原因见 CSS 注释 —— padding 放在裁剪层会撑出最小高度。
      '<div class="bd foldbd"><div class="foldinner"><div class="foldpad">' +
        (o.body || '') + '</div></div></div>' +
    '</div>')

    var hd = c.querySelector('.foldhd')
    function toggle() {
      var isOpen = c.classList.toggle('open')
      if (memKey) store.set(memKey, isOpen ? '1' : '0')
    }
    /** 点击是否落在内部控件上（那样不该折叠卡片）。 */
    function onInnerControl(e) {
      var t = e.target
      if (!t || t === hd) return false
      return Boolean(t.closest && t.closest('input,button,select,textarea,a'))
    }
    // 注意：判断必须写在 click 处理里。若改成"在 hd 上 stopPropagation"
    // 是无效的 —— 同一个元素上的 onclick 会先于 addEventListener 触发。
    hd.onclick = function(e) {
      if (onInnerControl(e)) return
      toggle()
    }
    // 因为不再是 <button>，键盘可达性要自己保证
    hd.onkeydown = function(e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        if (onInnerControl(e)) return   // 在搜索框里按空格不该折叠
        e.preventDefault()
        toggle()
      }
    }
    // 展开后如果里面是异步填的内容，调用方可以拿到 root 再操作
    c.__body = c.querySelector('.foldpad')
    return c
  }

  /**
   * 从模型名里取"系列"名，用于分组。
   *
   * 优先用斜杠前的厂商目录名（模型 id 常有 "openai/gpt-4" 这种形态），
   * 没有斜杠才退回"开头字母序列"。
   *
   * 例：
   *   openai/gpt-4          → openai    （斜杠前）
   *   z-ai/glm-4.6          → z-ai      （斜杠前，而不是单字母 z）
   *   deepseek-v4.1-flash   → deepseek  （开头字母）
   *   MiniMax-M3            → minimax
   *   qwen3.8-max           → qwen
   *
   * ⚠️ 不能只看开头字母：z-ai/... 会得到单字母 "z"，
   *    分组标题变成 "z"、"x"、"q" 这种看不懂的东西。
   */
  function modelSeries(id) {
    var s = String(id || '')
    var slash = s.indexOf('/')
    if (slash > 0) {
      var vendor = s.slice(0, slash).toLowerCase()
      // 厂商名要像样（至少 2 个字符），否则还是走前缀规则
      if (vendor.length >= 2) return vendor
    }
    var m = s.match(/^[A-Za-z]+/)
    if (!m) return '其他'
    return m[0].toLowerCase()
  }

  /**
   * 常用厂商 —— 排在列表最前面，方便快速找到。
   * 其余分组按模型数量降序（模型多的自然靠前）。
   */
  var SERIES_FIRST = [
    'deepseek', 'openai', 'google', 'anthropic', 'qwen', 'glm',
    'kimi', 'moonshotai', 'doubao', 'minimax', 'meta', 'mistralai', 'xai',
  ]

  /** 把模型按系列分组。 */
  function groupBySeries(grouped) {
    var map = {}
    for (var i = 0; i < grouped.length; i++) {
      var g = grouped[i]
      var s = modelSeries(g.id)
      if (!map[s]) map[s] = []
      map[s].push(g)
    }
    var keys = Object.keys(map)
    function prio(k) {
      for (var j = 0; j < SERIES_FIRST.length; j++) {
        if (k === SERIES_FIRST[j] || k.indexOf(SERIES_FIRST[j]) === 0) return j
      }
      return 9999
    }
    keys.sort(function(a, b) {
      var d = prio(a) - prio(b)
      if (d !== 0) return d
      d = map[b].length - map[a].length      // 模型多的在前
      return d !== 0 ? d : (a < b ? -1 : a > b ? 1 : 0)
    })
    return keys.map(function(k) {
      // 组内按字母序（不区分大小写）—— 一眼能扫完，且顺序稳定可预期。
      // 不按长度排：那会把 "flash" 排到 "V4-Pro" 前面，看着莫名其妙。
      var items = map[k].slice().sort(function(a, b) {
        var x = a.id.toLowerCase(), y = b.id.toLowerCase()
        return x < y ? -1 : x > y ? 1 : 0
      })
      return { series: k, items: items }
    })
  }

  /**
   * 模型选择器：**输入框 + 分组下拉共存**。
   *
   * 为什么不用原生 <datalist>：
   *   · 无法分组（600 多个模型平铺成一长条）
   *   · 无法显示可用渠道
   *   · 样式不可控，无法跟随主题
   *
   * 交互：直接打字过滤；点输入框或 ▾ 展开；↑↓ 选择、Enter 确认、Esc 关闭；
   * 也允许输入列表里没有的模型名（手输自由保留）。
   *
   * @returns {HTMLElement}
   */
  function modelCombo(o) {
    var allGrouped = o.grouped || []
    var groups = groupBySeries(allGrouped)
    /**
     * 当前的能力过滤：'all' | 'vision' | 'text'
     *
     * 为什么要分：669 个模型里只有 156 个能看图。想做图片识别的话，
     * 用一个纯文本模型怎么也调不通 —— 而列表上看不出任何区别。
     */
    var capFilter = o.capFilter || 'all'
    /** 读当前能力过滤。外层卡片改类型后，这里要跟着变（capRef 是函数）。 */
    function curCap() { return o.capRef ? o.capRef() : capFilter }
    var wrap = el('<div class="mcombo">' +
      '<div class="mcombo-box">' +
        '<input class="mcombo-input" type="text" autocomplete="off" spellcheck="false"' +
          (o.inputId ? ' id="' + esc(o.inputId) + '"' : '') +
          ' value="' + esc(o.value || '') + '" placeholder="' + esc(o.placeholder || 'auto') + '">' +
        '<button class="mcombo-btn" type="button" tabindex="-1" aria-label="展开列表">' +
          svgIcon('chevronDown', 15) + '</button>' +
      '</div>' +
      '<div class="mcombo-panel" hidden></div>' +
    '</div>')
    var input = wrap.querySelector('.mcombo-input')
    var panel = wrap.querySelector('.mcombo-panel')
    var btn = wrap.querySelector('.mcombo-btn')

    /** 一个模型条目是否符合当前能力过滤。 */
    function capOk(cap) {
      var f = curCap()
      if (f === 'vision') return cap === 'yes'
      if (f === 'text') return cap !== 'yes'
      return true
    }

    /** 面板顶部的能力过滤条（始终显示，让用户知道有 VLM 可选）。 */
    function capBar() {
      // 外层卡片已经有一个「模型类型」选择器了，这里只在**外层没提供**
      // 的情况下才显示（避免两处都能改、还容易不一致）。
      if (o.capRef) return ''
      var opts = [
        ['all', '全部'],
        ['vision', '能看图'],
        ['text', '纯文本'],
      ]
      return '<div class="mcombo-caps">' +
        opts.map(function(x) {
          return '<span class="chip click' + (capFilter === x[0] ? ' accent' : '') +
            '" data-cap="' + x[0] + '">' + x[1] + '</span>'
        }).join('') +
        '</div>'
    }

    /** 把面板内容画出来（filter 为空则显示全部分组）。 */
    function paint(filter) {
      var f = (filter || '').trim().toLowerCase()
      var html = capBar()
      var shown = 0
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i]
        var items = !f ? g.items : g.items.filter(function(x) {
          return x.id.toLowerCase().indexOf(f) >= 0
        })
        // 能力过滤：组里没有符合条件的就整组跳过
        if (curCap() !== 'all') {
          items = items.filter(function(x) { return capOk(x.vision) })
        }
        if (items.length === 0) continue
        var isSeriesHit = !f || g.series.indexOf(f) >= 0
        html += '<div class="mcombo-group">' +
          '<div class="mcombo-gt">' + esc(g.series) + '<span>' + items.length + '</span></div>'
        for (var j = 0; j < items.length; j++) {
          var it = items[j]
          // 组名命中时把该组全部显示，否则最多每组建 8 条，避免刷屏
          if (!isSeriesHit && f && j >= 8) {
            html += '<div class="mcombo-more">还有 ' + (items.length - 8) + ' 个…</div>'
            break
          }
          shown++
          // 只显示"差异部分"，让名字短到能一眼扫完：
          //   deepseek-v4-flash      → v4-flash
          //   openai/gpt-4           → gpt-4
          //   deepseek/deepseek-r1   → r1
          var short = it.id
          var sl = short.indexOf('/')
          if (sl > 0 && short.slice(0, sl).toLowerCase() === g.series) short = short.slice(sl + 1)
          if (short.toLowerCase().indexOf(g.series) === 0) short = short.slice(g.series.length)
          short = short.replace(/^[-_./\s]+/, '') || it.id
          var provs = it.provs.map(function(p) { return p.provider }).join(' · ')
          // 能看图的加一个眼睛标记 —— 不标的话得逐个点开才知道
          var eye = it.vision === 'yes'
            ? '<span class="mcombo-eye" title="支持图片输入（VLM）">' + svgIcon('eye', 12) + '</span>'
            : ''
          html += '<div class="mcombo-item" data-v="' + esc(it.id) + '">' +
            eye +
            '<span class="mcombo-name">' + esc(short) + '</span>' +
            '<span class="mcombo-prov" title="' + esc(provs) + '">' + esc(provs) + '</span>' +
            '</div>'
        }
        html += '</div>'
      }
      if (!shown) {
        html += '<div class="mcombo-empty">' +
          (curCap() === 'vision' ? '没有能看图的模型（换个渠道试试）' : '没有匹配的模型') + '</div>'
      }
      panel.innerHTML = html
      // 能力过滤条的点击（仅在没有外层选择器时存在）
      ;[].forEach.call(panel.querySelectorAll('[data-cap]'), function(ch) {
        ch.onmousedown = function(e) { e.preventDefault() }
        ch.onclick = function(e) {
          e.preventDefault(); e.stopPropagation()
          capFilter = ch.dataset.cap
          if (o.onCapChange) o.onCapChange(capFilter)
          paint(input.value)
        }
      })
      // ⚠️ 选择动作绑在 **click**，mousedown 只用来阻止输入框失焦。
      //
      // 曾经把 pick() 直接绑在 mousedown 上（图省事），结果面板打开期间
      // 任何一次误触/合成鼠标事件都会**立刻改掉选择并自动保存** ——
      // 用户的模型就这么被悄悄换成了一个没点过的。踩过一次。
      ;[].forEach.call(panel.querySelectorAll('[data-v]'), function(el2) {
        el2.onmousedown = function(e) { e.preventDefault() }   // 别让输入框先失焦
        el2.onclick = function(e) {
          e.preventDefault()
          e.stopPropagation()
          pick(el2.dataset.v)
        }
      })
    }

    var outsideHandler = null

    function open() {
      if (wrap.classList.contains('open')) return
      wrap.classList.add('open')
      panel.hidden = false
      // ⚠️ 折叠卡的内容区有 overflow:hidden（折叠动画要靠它裁剪），
      //    会把绝对定位的下拉面板一起裁掉 —— 只显示四五项就没了。
      //    打开期间给所在的卡片挂个标记，让那一层临时可见。
      var fold = wrap.closest ? wrap.closest('.card.fold') : null
      if (fold) fold.classList.add('combo-open')
      // ⚠️ 打开时不要把当前值当过滤词。
      //    默认值是 "auto"，而 "auto" 恰好也是若干模型名的前缀 ——
      //    一过滤就只剩 2 组，用户点开下拉看不到任何东西。
      //    规则：值是 auto / 空 / 不在候选里时，一律显示全部。
      var v = input.value.trim()
      var isRealModel = v && v !== 'auto' && allGrouped.some(function(x) { return x.id === v })
      paint(isRealModel ? v : '')
      // 打开时滚到当前值附近
      if (isRealModel) {
        var cur = panel.querySelector('[data-v="' + v.replace(/"/g, '') + '"]')
        if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'center' })
      }
      // 下方空间不够就向上展开，别让面板戳出视口底部
      wrap.classList.remove('drop-up')
      var rect = panel.getBoundingClientRect()
      if (rect.bottom > window.innerHeight - 8 && rect.height < rect.top) {
        wrap.classList.add('drop-up')
      }
      // ⚠️ 监听器随开随注册、随关即移除。若只在初始化时挂一个全局监听，
      //    每次重渲染页面都会堆积一层，长期用下来会越来越慢。
      outsideHandler = function(e) {
        if (!wrap.contains(e.target)) close()
      }
      document.addEventListener('mousedown', outsideHandler)
    }
    function close() {
      wrap.classList.remove('open', 'drop-up')
      panel.hidden = true
      var fold = wrap.closest ? wrap.closest('.card.fold') : null
      if (fold) fold.classList.remove('combo-open')
      if (outsideHandler) {
        document.removeEventListener('mousedown', outsideHandler)
        outsideHandler = null
      }
    }
    function pick(v) {
      input.value = v
      close()
      if (typeof o.onChange === 'function') o.onChange(v)
    }

    input.onfocus = open
    input.oninput = function() { open(); paint(this.value) }
    input.onkeydown = function(e) {
      var items = [].slice.call(panel.querySelectorAll('[data-v]'))
      var idx = items.findIndex(function(x) { return x.classList.contains('hot') })
      function move(d) {
        if (items.length === 0) return
        var n = idx < 0 ? (d > 0 ? 0 : items.length - 1) : (idx + d + items.length) % items.length
        items.forEach(function(x) { x.classList.remove('hot') })
        items[n].classList.add('hot')
        if (items[n].scrollIntoView) items[n].scrollIntoView({ block: 'nearest' })
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); open(); move(1) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); open(); move(-1) }
      else if (e.key === 'Enter') {
        if (idx >= 0) { e.preventDefault(); pick(items[idx].dataset.v) }
        else { close(); if (typeof o.onChange === 'function') o.onChange(input.value) }
      } else if (e.key === 'Escape') { close() }
    }
    btn.onmousedown = function(e) {
      e.preventDefault()
      if (wrap.classList.contains('open')) close()
      else { input.focus(); open() }
    }
    wrap.__value = function() { return input.value }
    /**
     * 换一批数据（用于"上面关了渠道，下面要跟着变"）。
     * 面板开着就立刻重画，关着就等下次打开 —— 避免看不见的重排。
     */
    wrap.__setGrouped = function(list) {
      allGrouped = list || []
      groups = groupBySeries(allGrouped)
      if (wrap.classList.contains('open')) paint(input.value.trim() === 'auto' ? '' : input.value)
    }
    /** 供外部收起面板（例如点了"建议模型"之后）。 */
    wrap.__close = close
    /**
     * 外层改了「模型类型」→ 让面板按新条件重画。
     * 面板开着就立刻重画（用户能马上看到筛选结果）。
     */
    wrap.__setCap = function(cap) {
      capFilter = cap || 'all'
      if (wrap.classList.contains('open')) paint(input.value.trim() === 'auto' ? '' : input.value)
    }
    return wrap
  }

  /** 键值行组。 */
  function kvRows(rows) {
    return rows.map(function(r){
      if (r == null) return ''
      var k = r[0], v = r[1], cls = r[2] || ''
      return '<div class="kv"><span class="k">' + esc(k) + '</span>' +
             '<span class="v ' + cls + '">' + (v == null ? '-' : esc(v)) + '</span></div>'
    }).filter(Boolean).join('')
  }
  /** 指标卡组。 */
  function metrics(items) {
    return '<div class="metrics">' + items.map(function(m){
      return '<div class="metric ' + (m.tone || '') + '">' +
        '<div class="n"' + (m.id ? ' id="' + esc(m.id) + '"' : '') + '>' +
          esc(m.value) + (m.unit ? '<small>' + esc(m.unit) + '</small>' : '') + '</div>' +
        '<div class="l">' + esc(m.label) + '</div>' +
        (m.sub ? '<div class="s">' + esc(m.sub) + '</div>' : '') + '</div>'
    }).join('') + '</div>'
  }
  function chipHtml(text, tone, extra) {
    return '<span class="chip ' + (tone || '') + '" ' + (extra || '') + '>' +
      (tone === 'on' ? '<i class="dot"></i>' : '') + esc(text) + '</span>'
  }
  function loading(label){ return '<div class="card"><div class="bd"><div class="center"><div>' +
    '<div class="spinner"></div><div class="note mt-sm">' + esc(label || '加载中…') + '</div>' +
    '</div></div></div></div>' }
  function failure(e){ return '<div class="banner err"><b>出错了</b><br>' + esc(e.message || e) + '</div>' }

  /**
   * 弹出模态层。
   *
   * @param {object} o
   * @param {string} o.icon    图标。三种都支持：
   *                             · icons.js 里的名字（如 'trash'）→ 渲染成 SVG
   *                             · URL（以 / 或 http 开头）      → 渲染成 <img>
   *                             · 其它文本（如 emoji）          → 原样显示
   *                           注意 emoji 塞进 <img src> 会变成破图，踩过一次。
   * @param {string} o.title   标题
   * @param {string} o.sub     副标题
   * @param {string} o.body    正文 HTML（**调用方自己保证转义**）
   * @param {string} [o.footer] 底部 HTML
   * @returns {{close:Function, root:HTMLElement}}
   */
  function modal(o) {
    var iconHtml = ''
    if (o.icon) {
      // 判断顺序很重要：先看是不是已知图标名，再看是不是 URL，
      // 都不是才当文字。不用正则是因为反斜杠在模板字符串里要额外转义。
      var ic = String(o.icon)
      var isUrl = ic.indexOf('http://') === 0 || ic.indexOf('https://') === 0 ||
                  ic.charAt(0) === '/' || ic.indexOf('data:') === 0
      if (ICONS[ic]) {
        iconHtml = '<span class="mico svg">' + svgIcon(ic, 24) + '</span>'
      } else if (isUrl) {
        iconHtml = '<img src="' + esc(ic) + '" alt="">'
      } else {
        iconHtml = '<span class="mico">' + esc(ic) + '</span>'
      }
    }
    var ov = el('<div class="overlay" role="dialog" aria-modal="true">' +
      '<div class="modal">' +
        '<div class="mhd">' +
          iconHtml +
          '<div class="tt"><h2>' + esc(o.title) + '</h2>' +
            (o.sub ? '<p>' + esc(o.sub) + '</p>' : '') + '</div>' +
          '<button class="mx" aria-label="关闭">' + svgIcon('x', 15) + '</button>' +
        '</div>' +
        '<div class="mbd">' + (o.body || '') + '</div>' +
        (o.footer ? '<div class="mft">' + o.footer + '</div>' : '') +
      '</div></div>')

    function close() {
      try { ov.remove() } catch (_) {}
      document.removeEventListener('keydown', onKey, true)
      if (document.body.style.overflow === 'hidden') document.body.style.overflow = ''
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close() }
    }
    // 点遮罩空白处关闭；点内容区不关
    ov.addEventListener('click', function(e) { if (e.target === ov) close() })
    ov.querySelector('.mx').onclick = close
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(ov)
    document.body.style.overflow = 'hidden'
    setTimeout(function(){ try { ov.querySelector('.mx').focus() } catch(_){} }, 40)
    return { close: close, root: ov }
  }

  /**
   * 「关于 WhalePod」介绍。
   *
   * 内容写在这里而不是 HTML 里，是为了避免模板字符串里再嵌长 HTML
   * （反引号与 \n 的坑已经踩过两次）。
   */
  function showAbout() {
    var body =
      '<h4>它是什么</h4>' +
      '<ul>' +
        '<li>一个<b>常驻后台的 QQ 机器人运行时</b>，同时也是<b>免费优先的 LLM 网关</b>。</li>' +
        '<li>托盘运行、零窗口；所有配置与查看都在这个 Web 界面里。</li>' +
        '<li>依赖关系是<b>可选</b>的：有 DSH 就白拿 14 个免费渠道，没有也能用自备端点跑。</li>' +
      '</ul>' +
      '<div class="grid2">' +
        '<div class="feat"><b>' + svgIcon('zap', 15) + '省钱</b><span>免费渠道优先，付费只在必要时兜底。</span></div>' +
        '<div class="feat"><b>' + svgIcon('smile', 15) + '活人感</b><span>决策层先判断该不该说话，再决定说什么。</span></div>' +
        '<div class="feat"><b>' + svgIcon('plug', 15) + '通用</b><span>对外是标准 OpenAI 接口，任何客户端都能接。</span></div>' +
        '<div class="feat"><b>' + svgIcon('box', 15) + '开箱</b><span>内置下载协议端与框架，连 Python 都自动装。</span></div>' +
      '</div>' +
      '<h4>核心思路：为什么先决策再生成</h4>' +
      '<ul>' +
        '<li>真人不会每条消息都回 —— 会判断「是在问我吗」「我刚说过话要不要歇会」。</li>' +
        '<li>把这件事拆成两层：<b>决策层</b>（便宜、快，只给概率）→ <b>表达层</b>（贵、慢，才真正生成）。</li>' +
        '<li><b>省钱和活人感来自同一个设计</b>：大部分消息在决策层就被过滤掉了。</li>' +
      '</ul>' +
      '<h4>当前状态</h4>' +
      '<ul>' +
        '<li id="ab-status">读取中…</li>' +
      '</ul>' +
      '<h4>数据在哪</h4>' +
      '<ul>' +
        '<li><code>~/.whale-pod/</code> —— 配置、人格、记忆、日志、自带运行时。</li>' +
        '<li><b>卸载 = 删掉这个目录</b>，不留残余。</li>' +
        '<li>WhalePod 只绑回环地址（127.0.0.1），不对外暴露。</li>' +
      '</ul>'

    var m = modal({
      icon: '/icon.png',
      title: 'WhalePod',
      sub: 'QQ 机器人运行时 + 免费优先的 LLM 网关',
      body: body,
      footer: '<button class="act ghost sm" id="ab-close">知道了</button>' +
        '<a class="act ghost sm" style="text-decoration:none" href="' +
          esc(location.origin + '/app.js') + '" target="_blank" rel="noopener">查看前端源码</a>',
    })
    m.root.querySelector('#ab-close').onclick = m.close

    // 异步补上实时状态（模态已显示，不阻塞）
    api('/api/status').then(function(s) {
      var el2 = m.root.querySelector('#ab-status')
      if (!el2) return
      var up = ms(s.uptimeMs)
      el2.innerHTML = '已运行 <b>' + esc(up) + '</b>，' +
        esc(s.providers.count) + ' 个渠道、' + esc(s.catalog.count) + ' 个模型可用。'
    }).catch(function() {
      var el2 = m.root.querySelector('#ab-status')
      if (el2) el2.textContent = '（状态读取失败，不影响使用）'
    })
  }

  // ── 对话框（替代原生 confirm / alert / prompt）──────────────
  //
  // 为什么不用原生：风格与整体界面完全脱节，而且 confirm 会**阻塞**
  // 整个 JS 线程（渲染、SSE 日志、动画全卡住）。这里统一换成弹层 +
  // Promise，调用处 await uiConfirm(...) 即可，写法几乎不变。
  //
  // 注意：这些是 **async** 的，所有调用点都必须 await / .then，
  // 否则会拿到 Promise 对象本身（永远为真）。

  /**
   * 确认框。
   * @param {object} o
   * @param {string} o.title
   * @param {string} o.body      正文（HTML，调用方自行转义）
   * @param {string} [o.ok]      确认按钮文字
   * @param {string} [o.cancel]  取消按钮文字
   * @param {boolean} [o.danger] 危险操作（红色确认按钮）
   * @returns {Promise<boolean>}
   */
  function uiConfirm(o) {
    return new Promise(function(resolve) {
      var settled = false
      var m = modal({
        icon: o.icon || '',
        title: o.title || '确认',
        sub: o.sub || '',
        body: o.body || '',
        footer:
          '<button class="act' + (o.danger ? ' danger' : '') + ' sm" id="cf-ok">' +
            esc(o.ok || '确定') + '</button>' +
          '<button class="act ghost sm" id="cf-no">' + esc(o.cancel || '取消') + '</button>',
      })
      function done(v) {
        if (settled) return
        settled = true
        m.close()
        resolve(v)
      }
      m.root.querySelector('#cf-ok').onclick = function() { done(true) }
      m.root.querySelector('#cf-no').onclick = function() { done(false) }
      // 遮罩/Esc 关闭一律视为「取消」
      m.root.addEventListener('click', function(e) { if (e.target === m.root) done(false) })
      document.addEventListener('keydown', function esc2(e) {
        if (e.key === 'Escape') { document.removeEventListener('keydown', esc2, true); done(false) }
      }, true)
      setTimeout(function(){ try { m.root.querySelector('#cf-ok').focus() } catch(_){} }, 40)
    })
  }

  /** 提示框（只有一个「知道了」）。 */
  function uiAlert(o) {
    var opts = typeof o === 'string' ? { title: '提示', body: esc(o) } : o
    return new Promise(function(resolve) {
      var m = modal({
        icon: opts.icon || '',
        title: opts.title || '提示',
        sub: opts.sub || '',
        body: opts.body || '',
        footer: '<button class="act sm" id="al-ok">' + esc(opts.ok || '知道了') + '</button>',
      })
      var done = function() { m.close(); resolve() }
      m.root.querySelector('#al-ok').onclick = done
      m.root.addEventListener('click', function(e) { if (e.target === m.root) done() })
      setTimeout(function(){ try { m.root.querySelector('#al-ok').focus() } catch(_){} }, 40)
    })
  }

  /**
   * 输入框。
   * @returns {Promise<string|null>} 取消返回 null
   */
  function uiPrompt(o) {
    return new Promise(function(resolve) {
      var body = (o.body ? o.body : '') +
        '<div class="mt-sm"><input id="pm-in" type="text" autocomplete="off" spellcheck="false" placeholder="' +
          esc(o.placeholder || '') + '"></div>' +
        (o.hint ? '<div class="note mt-sm">' + o.hint + '</div>' : '')
      var m = modal({
        title: o.title || '输入',
        sub: o.sub || '',
        body: body,
        footer:
          '<button class="act sm" id="pm-ok">' + esc(o.ok || '确定') + '</button>' +
          '<button class="act ghost sm" id="pm-no">取消</button>',
      })
      var inp = m.root.querySelector('#pm-in')
      var settled = false
      function done(v) { if (settled) return; settled = true; m.close(); resolve(v) }
      m.root.querySelector('#pm-ok').onclick = function() { done((inp.value || '').trim() || null) }
      m.root.querySelector('#pm-no').onclick = function() { done(null) }
      m.root.addEventListener('click', function(e) { if (e.target === m.root) done(null) })
      inp.onkeydown = function(e) {
        if (e.key === 'Enter') { e.preventDefault(); done((inp.value || '').trim() || null) }
        if (e.key === 'Escape') { e.preventDefault(); done(null) }
      }
      setTimeout(function(){ try { inp.focus() } catch(_){} }, 40)
    })
  }

  // ── 主题：跟随系统 / 白天 / 夜晚 ──────────────────────────
  var THEME_KEY = 'whale-pod-theme'
  var themeMode = store.get(THEME_KEY) || 'system'
  var mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
  function effectiveTheme(){
    if (themeMode === 'light' || themeMode === 'dark') return themeMode
    return (mql && mql.matches) ? 'dark' : 'light'
  }
  function applyTheme(){
    if (themeMode === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', themeMode)
    var b = document.getElementById('themebtn')
    if (b) {
      var eff = effectiveTheme()
      var name = themeMode === 'system' ? '跟随系统' : (themeMode === 'dark' ? '夜晚' : '白天')
      // 图标随模式变：系统=显示器、夜晚=月亮、白天=太阳
      var iconName = themeMode === 'system' ? 'monitor' : (themeMode === 'dark' ? 'moon' : 'sun')
      var lb = b.querySelector('.lb')
      b.innerHTML = svgIcon(iconName, 17) + (lb ? '<span class="lb">主题</span>' : '')
      b.title = '主题：' + name + '（当前' + (eff === 'dark' ? '夜晚' : '白天') + '）— 点击切换'
    }
  }
  function cycleTheme(){
    themeMode = themeMode === 'system' ? 'light' : (themeMode === 'light' ? 'dark' : 'system')
    if (themeMode === 'system') store.del(THEME_KEY)
    else store.set(THEME_KEY, themeMode)
    applyTheme()
  }
  if (mql && mql.addEventListener) mql.addEventListener('change', function(){ if (themeMode === 'system') applyTheme() })

  // ── 外壳：可折叠左侧栏 ────────────────────────────────────
  //
  // 每个导航项带图标 + 标题，收起时只显示图标，悬停用浮层补上文字 ——
  // 这样窄空间也不丢可发现性。图标用内联 SVG（见 icons.js），
  // 单色描边、跟随主题，不用 emoji（彩色且各平台字形不一）。
  // 侧栏导航。
  //
  // 「模型」和「渠道」已合并成一个页面（都是"用哪些渠道、跑哪个模型"）：
  // 免费渠道的开关/排序在「模型」页，自备渠道的增删测试并入同一页下方的
  // 「自备渠道」卡片。原来分成两页时，用户要在两个页面之间来回跳才能
  // 搞清"到底有哪些渠道可用"。
  var TABS = [
    { k: 'ov', ic: 'dashboard', label: '总览', sub: '运行状态与用量' },
    { k: 'qq', ic: 'chat', label: 'QQ', sub: '机器人与消息' },
    { k: 'md', ic: 'cpu', label: '模型与渠道', sub: '选择、排序与来源' },
    { k: 'be', ic: 'layers', label: '组件', sub: '协议端与框架' },
    { k: 'dec', ic: 'route', label: '决策', sub: '该不该说话' },
    { k: 'persona', ic: 'smile', label: '人格', sub: '角色提示词' },
    { k: 'mem', ic: 'database', label: '记忆', sub: '上下文与摘要' },
    { k: 'log', ic: 'filetext', label: '日志', sub: '实时输出' },
    { k: 'cfg', ic: 'sliders', label: '配置', sub: '完整配置' },
  ]
  var cur = (location.hash || '#ov').slice(1)
  // 老链接可能还带 #ch（渠道页已并入 #md）
  if (cur === 'ch') { cur = 'md'; location.hash = '#md' }
  if (!TABS.some(function(t){ return t.k === cur })) cur = 'ov'

  // 侧栏展开状态：记在本地；读不到就用窗口宽度决定
  var SIDE_KEY = 'whale-pod-side'
  function wantCollapsed(){
    var saved = store.get(SIDE_KEY)
    if (saved === '1') return true
    if (saved === '0') return false
    return window.innerWidth < 1100   // 默认：窄屏收起
  }

  root.innerHTML = ''
  var shell = el('<div class="shell' + (wantCollapsed() ? ' collapsed' : '') + '">' +
    '<aside class="side">' +
      '<div class="top"><button class="brandbtn" id="about" title="关于 WhalePod">' +
        '<img class="logo" src="/icon.png" alt="WhalePod"><span class="name">WhalePod</span></button></div>' +
      '<div class="menu"></div>' +
      '<div class="bot"><div class="row2">' +
        '<button class="iconbtn" id="themebtn" title="切换主题">' + svgIcon('monitor', 17) +
          '<span class="lb">主题</span></button>' +
        '<button class="iconbtn" id="collapse" title="收起 / 展开侧栏（Ctrl+B）">' +
          svgIcon('chevronLeft', 17, 'collapse-ic') + '<span class="lb">收起</span></button>' +
      '</div></div>' +
    '</aside>' +
    '<div class="main-wrap">' +
      '<div class="topbar"><h1></h1><span class="sub"></span><span class="sp"></span></div>' +
      '<main></main>' +
    '</div>' +
  '</div>')

  var menu = shell.querySelector('.menu')
  TABS.forEach(function(t){
    var b = el('<button class="item" data-k="' + t.k + '" data-tip="' + esc(t.label) + '">' +
      '<span class="ic">' + svgIcon(t.ic, 19) + '</span>' +
      '<span class="lb">' + esc(t.label) + '</span></button>')
    b.onclick = function(){ go(t.k) }
    menu.appendChild(b)
  })

  var collapseBtn = shell.querySelector('#collapse')
  function toggleSide(force){
    var c = typeof force === 'boolean' ? force : !shell.classList.contains('collapsed')
    shell.classList.toggle('collapsed', c)
    store.set(SIDE_KEY, c ? '1' : '0')
    // 收起时箭头指向右（提示"展开"），展开时指向左
    var ic = collapseBtn.querySelector('.collapse-ic')
    if (ic) ic.outerHTML = svgIcon(c ? 'chevronRight' : 'chevronLeft', 17, 'collapse-ic')
    var lb = collapseBtn.querySelector('.lb')
    if (lb) lb.textContent = c ? '展开' : '收起'
  }
  collapseBtn.onclick = function(){ toggleSide() }
  // Ctrl/Cmd+B 切换（和多数编辑器一致）
  window.addEventListener('keydown', function(e){
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault(); toggleSide()
    }
  })

  shell.querySelector('#themebtn').onclick = cycleTheme
  shell.querySelector('#about').onclick = showAbout
  root.appendChild(shell)
  var main = shell.querySelector('main')
  var pageTitle = shell.querySelector('.topbar h1')
  var pageSub = shell.querySelector('.topbar .sub')
  applyTheme()
  toggleSide(shell.classList.contains('collapsed'))

  // 窗口变窄时自动收起（只提示一次，不强制覆盖用户的手动选择）
  var lastAuto = null
  window.addEventListener('resize', function(){
    var narrow = window.innerWidth < 820
    if (narrow !== lastAuto) {
      lastAuto = narrow
      if (narrow) toggleSide(true)
    }
  })

  function go(k){
    stopOverviewTimers()   // 离开总览页就别再打接口了
    cur = k
    location.hash = '#' + k
    paintNav()
    render()
  }
  function paintNav(){
    [].forEach.call(menu.children, function(b){ b.className = 'item' + (b.dataset.k === cur ? ' on' : '') })
    var t = TABS.filter(function(x){ return x.k === cur })[0]
    if (t) { pageTitle.textContent = t.label; pageSub.textContent = t.sub }
    try { document.title = 'WhalePod · ' + (t ? t.label : '控制台') } catch(_){}
  }
  window.addEventListener('hashchange', function(){
    var k = (location.hash || '#ov').slice(1)
    // 旧的 #ch（渠道页）已并入 #md。这里单独处理，否则会被当成
    // "不在 TABS 里的未知键"直接忽略，停在原页面不动。
    if (k === 'ch') { location.hash = '#md'; return }
    if (k !== cur && TABS.some(function(t){ return t.k === k })) { cur = k; paintNav(); render() }
  })

  var liveCleanup = null
  /**
   * 替换主内容区。
   *
   * ⚠️ 同时接受**字符串**与**节点** —— 因为 loading() / failure()
   * 返回的是 HTML 字符串，而 card() 返回的是元素。混用很容易写出
   * appendChild(<string>) 这种会抛 "parameter 1 is not of type 'Node'"
   * 的代码；一旦抛在渲染主路径上，整页就空白了。这里统一兜住。
   */
  function setMain(nodeOrHtml){
    if (liveCleanup) { try { liveCleanup() } catch(_){} liveCleanup = null }
    main.innerHTML = ''
    var node = typeof nodeOrHtml === 'string' ? el(nodeOrHtml) : nodeOrHtml
    if (node) main.appendChild(node)
  }

  /**
   * 渲染当前页。
   *
   * 包一层 try/catch：单个页面渲染失败时给出可见的错误卡片，
   * 而不是留下一片空白（那会让人以为服务没起来）。
   */
  function render(){
    try {
      if (cur === 'ov') return renderOverview()
      if (cur === 'qq') return renderQq()
      if (cur === 'md') return renderModels()
      // 'ch' 已并入 'md'（模型与渠道）。老书签/链接还带 #ch 时重定向，
      // 不让用户撞上"空白页"。
      if (cur === 'ch') { location.hash = '#md'; return }
      if (cur === 'be') return renderBackends()
      if (cur === 'dec') return renderDecision()
      if (cur === 'persona') return renderPersona()
      if (cur === 'mem') return renderMemory()
      if (cur === 'log') return renderLogs()
      if (cur === 'cfg') return renderConfig()
    } catch (err) {
      console.error('[whale-pod] 渲染失败', err)
      setMain('<div class="banner err"><b>页面渲染失败</b><br>' +
        esc(err && err.message ? err.message : String(err)) +
        '<br><br>这是在浏览器端发生的错误，服务本身可能是好的。' +
        '打开开发者工具的 Console 可以看到完整堆栈。</div>')
    }
  }
  paintNav()

  // ══ 总览 ══════════════════════════════════════════════════
  /**
   * 总览页。
   *
   * ⚠️ 指标要**实时更新**：运行时长每秒跳、token/费用随消息增长。
   *    之前只渲染一次，用户看到"运行时长 49.8s"永远停在那儿，
   *    会以为是卡死了。
   *
   * 做法：先渲染一次（立刻有内容），再起两个定时器：
   *   · 每秒：只重算运行时长（纯本地计算，不打接口）
   *   · 每 5 秒：拉一次 /api/status 刷新 token/费用/QQ 状态
   * 离开总览页时（切 tab）自动清掉，不留后台定时器。
   */
  var overviewTimer = null
  var overviewTick = null
  /** 运行时长基准：{ at, ms } —— 只在拿到 status 时更新一次。 */
  var ovBase = null
  var ovOnVisible = null
  function stopOverviewTimers() {
    if (overviewTimer) { clearInterval(overviewTimer); overviewTimer = null }
    if (overviewTick) { clearInterval(overviewTick); overviewTick = null }
    if (ovOnVisible) {
      document.removeEventListener('visibilitychange', ovOnVisible)
      ovOnVisible = null
    }
  }

  /**
   * 只更新"运行时长"那一个节点。
   *
   * 为什么单独写：原来是每秒调 paintMetrics()，而那会**重建整条指标栏的
   * innerHTML**（7 个卡片、一堆 span），每秒解析一次纯属浪费。
   * 运行时长是唯一每秒都在变的值，单独改它的文本就够。
   */
  function tickUptime() {
    if (!ovBase || document.hidden) return
    var node = document.getElementById('ovuptime')
    if (!node) return
    var el2 = node
    // 保留 <small> 单位节点（如果有），只换数字部分
    var txt = ms(ovBase.ms + (Date.now() - ovBase.at))
    if (el2.firstChild && el2.firstChild.nodeType === 3) el2.firstChild.nodeValue = txt
    else el2.textContent = txt
  }

  /** 统一的金额格式：很小的时候多给几位小数，别显示成 $0.00。 */
  function money(usd) {
    var v = Number(usd || 0)
    if (v === 0) return '$0'
    if (v < 0.01) return '$' + v.toFixed(4)
    if (v < 1) return '$' + v.toFixed(3)
    return '$' + v.toFixed(2)
  }
  function moneyCny(usd) {
    var v = Number(usd || 0) * 7.2
    if (v === 0) return '¥0'
    if (v < 0.1) return '¥' + v.toFixed(3)
    return '¥' + v.toFixed(2)
  }
  /** 大数字加千分位，token 一多就看不清了。 */
  function bigNum(n) {
    var v = Number(n || 0)
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
    if (v >= 1e4) return (v / 1e3).toFixed(1) + 'k'
    return String(v)
  }

  function renderOverview(){
    stopOverviewTimers()
    setMain(loading('读取状态…'))
    var lastStatus = null

    /**
     * 指标条：只用最新一次 status 渲染，避免整页重建导致闪烁。
     *
     * ⚠️ boxEl 必须能**显式传入**。原来只写 getElementById('ovmetrics')，
     *    而首次渲染时 wrap 还游离在文档外（setMain 在后面才调用）——
     *    于是查不到容器、直接 return，指标条一片空白。
     *    用户看到的就是"最上面那一栏要等一会儿才加载出来"
     *    （实际要等 1 秒后的 tick 或 5 秒后的刷新才补上）。
     */
    function paintMetrics(s, boxEl){
      if (!s) return
      var u = s.usage || {}
      var qq = s.qq || {}
      var box = boxEl || document.getElementById('ovmetrics')
      if (!box) return
      // 运行时长要**每秒跳**。服务端给的 uptimeMs 是"拉取那一刻"的值，
      // 所以记下基准时间，本地往前推算 —— 不用每秒打接口。
      var upMs = (s.uptimeMs || 0) + (Date.now() - (s.fetchedAt || Date.now()))
      // 记下基准，之后每秒由 tickUptime() 本地推算，不再重建整条指标栏
      ovBase = { at: Date.now(), ms: s.uptimeMs || 0 }
      var pv = s.providers || {}
      var cat = s.catalog || {}
      var offN = (pv.disabled || []).length
      box.innerHTML = metrics([
        // ⚠️ 运行时长单独给个 id：它每秒都要变，但**不该每秒重建整条指标栏**
        //    （那会反复解析一整段 HTML）。见下面的 tickUptime()。
        { label: '运行时长', value: ms(upMs), tone: 'accent', id: 'ovuptime' },
        { label: '启用渠道', value: num(pv.count),
          sub: offN ? (pv.total || pv.count) + ' 个中 ' + offN + ' 个已关闭' : '全部启用' },
        { label: '可用模型', value: num(cat.count), unit: '个',
          sub: (cat.total && cat.total !== cat.count) ? '共 ' + cat.total + ' 个，已关渠道的不计' : '' },
        { label: '其中视觉模型', value: num(cat.vision || 0), unit: '个',
          sub: (cat.vision > 0) ? '能看图，发图时走这些' : '当前没有可看图的模型' },
        { label: '累计调用', value: bigNum(u.calls || 0), unit: '次', tone: (u.failed ? 'warn' : '') },
        { label: 'tokens 用量', value: bigNum(u.tokensTotal || 0),
          sub: '入 ' + bigNum(u.tokensIn || 0) + ' · 出 ' + bigNum(u.tokensOut || 0) },
        { label: '预计金额', value: money(u.costUsd), tone: u.costUsd ? 'ok' : '',
          sub: u.costUsd ? ('约 ' + moneyCny(u.costUsd) + '（估算）') : '尚无用量' },
        { label: 'QQ', value: qq.enabled ? (qq.connected ? '在线' : '离线') : '未启用',
          tone: qq.enabled ? (qq.connected ? 'ok' : 'err') : '' },
      ])
    }
    /** 局部刷新：重拉 status 并只重绘指标条 + 用量卡（不重建整页）。 */
    function refreshOverview(){
      api('/api/status').then(function(s){
        s.fetchedAt = Date.now()
        lastStatus = s
        paintMetrics(s)
        var box = document.getElementById('ovusage')
        if (box) box.innerHTML = usageCardHtml(s.usage || {})
      }).catch(function(){ /* 网络抖动忽略，下个周期再试 */ })
    }

    api('/api/status').then(function(s){
      s.fetchedAt = Date.now()
      lastStatus = s
      var c = s.gateway.counters || {}
      var u = s.usage || {}
      var qq = s.qq || {}
      var wrap = el('<div></div>')

      // 顶部指标（容器留 id，便于局部重绘）
      var mbox = el('<div id="ovmetrics"></div>')
      wrap.appendChild(mbox)
      // 显式传容器 —— 此时 wrap 还没进文档，getElementById 查不到
      paintMetrics(s, mbox)

      var grid = el('<div class="grid mt"></div>')

      // LLM 网关
      grid.appendChild(card('globe', 'LLM 网关', kvRows([
        ['地址', s.gateway.url, 'mono'],
        ['策略', s.gateway.strategy],
        ['密钥', s.gateway.keyPrefix, 'mono'],
        ['成功 / 失败', (c.ok || 0) + ' / ' + (c.failed || 0), c.failed ? 'txt-warn' : ''],
        ['tokens 入 / 出', (c.tokensIn || 0) + ' / ' + (c.tokensOut || 0)],
      ])))

      // 用量与费用（局部可刷新的容器）
      grid.appendChild(card('chart', '用量与费用', '<div id="ovusage">' + usageCardHtml(u) + '</div>'))

      // 决策
      var byProv = s.decision.stats.byProvider || {}
      grid.appendChild(card('route', '决策层', kvRows([
        ['顺序', (s.decision.order || []).join(' → ')],
        ['阈值', s.decision.threshold],
        ['累计判断', s.decision.stats.calls || 0],
        ['降级次数', s.decision.stats.fallbacks || 0, s.decision.stats.fallbacks ? 'txt-warn' : ''],
        ['错误', s.decision.stats.errors || 0, s.decision.stats.errors ? 'txt-err' : ''],
      ])))

      // 凭据
      grid.appendChild(card('key', '凭据', kvRows([
        ['模式', s.credentials.mode],
        ['引用数', s.credentials.count],
        ['overlay 覆盖', s.credentials.overlayCount],
        ['DSH profile', s.dsh.profile || '-'],
        ['文件', s.credentials.file, 'mono'],
      ])))

      // 记忆 / 人格
      var memInfo = s.memory || {}
      var lt = s.longMemory || {}
      grid.appendChild(card('database', '记忆', kvRows([
        ['活跃会话', memInfo.sessions || 0],
        ['消息总数', memInfo.totalMessages || 0],
        ['长期记忆', lt.enabled ? '已启用' : '未启用'],
        ['已摘要会话', lt.withSummary || 0],
      ])))

      var per = s.persona || {}
      grid.appendChild(card('smile', '人格', kvRows([
        ['当前角色', per.active || '-', 'strong'],
        ['可用角色', (per.roles || []).length + ' 个'],
        ['角色列表', (per.roles || []).join('、') || '-'],
      ])))

      wrap.appendChild(grid)

      // 渠道：启用/关闭要分开显示 —— 只说"已注册 14 个"会让人以为 14 个都在用
      var provs = (s.providers.list || [])
      var offSet = {}
      ;(s.providers.disabled || []).forEach(function(p){ offSet[p] = true })
      var onList = provs.filter(function(p){ return !offSet[p] })
      var offList = provs.filter(function(p){ return offSet[p] })
      wrap.appendChild(el('<div class="mt"></div>'))
      wrap.appendChild(card('plug',
        '渠道（' + onList.length + ' 个启用' + (offList.length ? ' · ' + offList.length + ' 个已关闭' : '') + '）',
        '<div class="chips">' + (onList.length
          ? onList.map(function(p){ return chipHtml(p, 'on') }).join('')
          : '<span class="note">没有启用中的渠道 —— 去「模型与渠道」页打开几个</span>') + '</div>' +
        (offList.length
          ? '<div class="note mt-sm">已关闭（不参与路由）：</div><div class="chips mt-sm">' +
            offList.map(function(p){ return chipHtml(p, 'off') }).join('') + '</div>'
          : '')))

      setMain(wrap)

      // ── 实时刷新 ──────────────────────────────────────────
      // 每秒只更新"运行时长"那**一个文本节点**（不重建整条指标栏），
      // 每 5 秒才拉一次接口刷新其余指标。切走页面时清掉定时器。
      //
      // ⚠️ 还要看页面可不可见：浏览器把后台标签页的定时器降频（甚至冻结），
      //    但我们自己的 5 秒轮询如果一直发，等于用户把界面挂着就一直在请求。
      //    隐藏时直接停掉，切回来再补一次。
      overviewTick = setInterval(tickUptime, 1000)
      overviewTimer = setInterval(function(){
        if (document.hidden) return      // 后台标签页不轮询
        refreshOverview()
      }, 5000)
      ovOnVisible = function(){
        if (!document.hidden && cur === 'ov') refreshOverview()
      }
      document.addEventListener('visibilitychange', ovOnVisible)
    }).catch(function(e){ setMain(el(failure(e))) })
  }

  /** 用量卡的内容（单独抽出来，供局部刷新复用）。 */
  function usageCardHtml(u){
    if (!u) u = {}
    var srcRows = (u.bySource || []).map(function(x){
      var name = { qq: 'QQ 机器人', gateway: '网关 API', decision: '决策层' }[x.source] || x.source
      return [name, bigNum(x.calls) + ' 次 · ' + bigNum(x.tokensIn + x.tokensOut) + ' tokens · ' + money(x.costUsd)]
    })
    var provRows = (u.byProvider || []).slice(0, 6).map(function(x){
      return [x.id, x.calls + ' 次 · ' + bigNum(x.tokensIn + x.tokensOut) + ' tokens · ' + money(x.costUsd)]
    })
    var modelRows = (u.byModel || []).slice(0, 5).map(function(x){
      return [x.model, bigNum(x.calls) + ' 次 · ' + bigNum(x.tokensIn + x.tokensOut) + ' tokens']
    })
    var hasAny = (u.calls || 0) > 0
    return kvRows([
      ['累计调用', bigNum(u.calls || 0) + ' 次' + (u.failed ? '（失败 ' + u.failed + '）' : '')],
      ['tokens 总量', bigNum(u.tokensTotal || 0) + '（入 ' + bigNum(u.tokensIn || 0) + ' / 出 ' + bigNum(u.tokensOut || 0) + '）'],
      ['预计金额', money(u.costUsd) + ' ≈ ' + moneyCny(u.costUsd)],
    ]) +
      (srcRows.length ? '<div class="note mt-sm"><b>按来源</b></div>' + kvRows(srcRows) : '') +
      (provRows.length ? '<div class="note mt-sm"><b>按渠道</b></div>' + kvRows(provRows) : '') +
      (modelRows.length ? '<div class="note mt-sm"><b>按模型</b></div>' + kvRows(modelRows) : '') +
      (hasAny ? '' : '<div class="note mt-sm">还没有产生用量。QQ 每回一条消息都会记在这里。</div>') +
      '<div class="note mt-sm">' + esc(u.note || '费用按公开挂牌价估算；免费渠道实际支出为 0。') + '</div>'
  }

  // ══ QQ ════════════════════════════════════════════════════
  function renderQq(){
    setMain(loading('读取 QQ 状态…'))
    api('/api/qq').then(function(q){
      var wrap = el('<div></div>')
      if (q.enabled === false) {
        wrap.appendChild(el('<div class="banner">' +
          '<b>QQ 未启用</b><br>' +
          'WhalePod 本体（网关 / 决策 / 记忆）都在跑，只是没接 QQ。<br>' +
          '要接的话：装一个协议端（NapCat 或 SnowLuma），' +
          '然后在「配置」页把 <code>qq.enabled</code> 设为 <code>true</code> 并填好 OneBot 地址。' +
          '</div>'))
      }
      var c = q.counters || {}
      wrap.appendChild(el(metrics([
        { label: '连接', value: q.connected ? '在线' : '离线', tone: q.connected ? 'ok' : 'err' },
        { label: '收到消息', value: c.received || 0, unit: '条' },
        { label: '实际回复', value: c.replied || 0, unit: '条' },
        { label: '选择沉默', value: c.silent || 0, unit: '次' },
        { label: '被过滤', value: c.dropped || 0, unit: '条' },
      ])))

      var grid = el('<div class="grid mt"></div>')
      grid.appendChild(card('cpu', '机器人', kvRows([
        ['暂停', q.paused ? '⏸ 已暂停' : '▶ 运行中'],
        ['昵称', (q.self && q.self.name) || '-'],
        ['QQ 号', (q.self && q.self.id) || '-', 'mono'],
      ]), {
        right: '<div class="spacer"></div>' +
          '<button class="act ' + (q.paused ? '' : 'ghost') + ' sm" id="qpause">' +
          (q.paused ? '恢复' : '暂停') + '</button>',
      }))

      var stats = [
        ['决策次数', c.considered || 0],
        ['失败', c.failed || 0, c.failed ? 'txt-err' : ''],
      ]
      grid.appendChild(card('activity', '处理统计', kvRows(stats)))

      if (q.memory) {
        grid.appendChild(card('database', '记忆', kvRows([
          ['会话数', q.memory.sessions || 0],
          ['消息数', q.memory.totalMessages || 0],
        ])))
      }
      wrap.appendChild(grid)

      // 最近交互
      var recent = q.recent || []
      var body = recent.length
        ? recent.map(function(r){
            var d = r.decision || {}
            var tone = d.reply ? 'on' : 'off'
            var label = d.reply ? '发言' : '沉默'
            var p = d.probability == null ? '' : ' · p=' + d.probability
            return '<div style="padding:10px 0;border-bottom:1px solid var(--hairline)">' +
              '<div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">' +
                '<span class="chip ' + tone + '">' + label + '</span>' +
                '<b>' + esc(r.senderName || '?') + '</b>' +
                '<span class="txt-dim" style="font-size:12px">' + esc(r.text || '') + '</span>' +
              '</div>' +
              (r.reply ? '<div class="note" style="margin:4px 0 0 4px">↳ ' + esc(r.reply) + '</div>' : '') +
              '<div class="note" style="margin-top:3px;font-size:12px">' +
                esc(d.provider || '?') + p + (d.reason ? ' · ' + esc(d.reason) : '') +
              '</div>' +
            '</div>'
          }).join('')
        : '<div class="empty"><span class="big">' + svgIcon('chat', 30) + '</span>还没有交互记录<br>' +
          '<span class="note">机器人在白名单群里收到消息后会显示在这里</span></div>'
      wrap.appendChild(el('<div class="mt"></div>'))
      wrap.appendChild(card('clock', '最近交互', body, { tight: false }))

      // ── 白名单（之前只能改 config.json，用户被 fail-closed 静默丢弃）──
      //
      // ⚠️ 这是**最容易踩的坑**：白名单为空 + allowAllWhenEmpty=false 时，
      //    所有消息都会被丢掉，而且界面上完全看不出来 —— 用户只会觉得
      //    "机器人不回我"。所以放在最显眼的位置，并明确给出当前状态。
      var allow = (q.allow) || {}
      var privList = allow.private || []
      var grpList = allow.groups || []
      var allowAll = allow.allowAllWhenEmpty === true
      var blocked = privList.length === 0 && grpList.length === 0 && !allowAll

      wrap.appendChild(el('<div class="mt"></div>'))
      var wlCard = card('shield', '白名单',
        '<div id="wlwarn">' + (blocked ? '<div class="banner err" style="margin:0 0 12px">' +
            '<b>当前不会响应任何消息</b><br>' +
            '私聊和群名单都是空的，且「名单为空时全部放行」没打开 —— 这是 fail-closed 默认行为。' +
            '想让谁用，就把它的 QQ 号 / 群号加进来。</div>' : '') + '</div>' +
        '<div class="row">' +
          '<div class="field" style="flex:2 1 220px"><label>私聊白名单（QQ 号，逗号分隔）</label>' +
            '<input id="wlpriv" value="' + esc(privList.join(', ')) + '" placeholder="123456789"></div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="field" style="flex:2 1 220px"><label>群白名单（群号，逗号分隔）</label>' +
            '<input id="wlgrp" value="' + esc(grpList.join(', ')) + '" placeholder="987654321"></div>' +
        '</div>' +
        '<label class="chk"><input type="checkbox" id="wlall"' + (allowAll ? ' checked' : '') + '>' +
          '<span></span><span class="chklb">名单为空时全部放行（<b>不推荐</b> —— 任何加了机器人的群/好友都能指挥它）</span></label>' +
        '<div class="mt-sm" style="display:flex;gap:10px;align-items:center">' +
          '<button class="act ghost" id="wlme">把我自己加进去</button>' +
          // 不需要「保存」按钮 —— 输入即存（下面带防抖）。
          // 这里只做状态提示，让用户知道改动已经落下去了。
          '<span class="note" id="wlmsg">改动自动保存</span>' +
        '</div>' +
        '<div class="note mt-sm">改动立即生效，不用重启。留空表示"这一类消息一律不响应"。</div>')
      wrap.appendChild(wlCard)

      function parseIds(v){
        return String(v || '').split(/[,\s，、]+/).map(function(s){ return s.trim() }).filter(Boolean)
      }
      var privInp = wlCard.querySelector('#wlpriv')
      var grpInp = wlCard.querySelector('#wlgrp')
      var allChk = wlCard.querySelector('#wlall')
      var wlMsg = wlCard.querySelector('#wlmsg')

      /** 按当前输入重画"当前不会响应任何消息"的警告。 */
      function repaintWarn(){
        var p = parseIds(privInp.value)
        var g = parseIds(grpInp.value)
        var box = wlCard.querySelector('#wlwarn')
        if (!box) return
        var empty = p.length === 0 && g.length === 0 && !allChk.checked
        box.innerHTML = empty ? '<div class="banner err" style="margin:0 0 12px">' +
          '<b>当前不会响应任何消息</b><br>' +
          '私聊和群名单都是空的，且「名单为空时全部放行」没打开 —— 这是 fail-closed 默认行为。' +
          '想让谁用，就把它的 QQ 号 / 群号加进来。</div>' : ''
      }

      // ── 自动保存（防抖 700ms）──────────────────────────────
      //
      // 为什么不做「保存」按钮：这类"填完就该生效"的小表单，多一次点击
      // 只会让人忘记点。而且它就在聊天页上，用户改完立刻想试。
      //
      // ⚠️ 保存后**不要整页重渲染** —— 那会让输入框失焦、光标跳走，
      //    正在连着输入几个 QQ 号时会很难受。只更新状态文字和警告条。
      var wlTimer = null
      var wlSeq = 0
      function saveWhitelist(){
        var seq = ++wlSeq
        var payload = { qq: { allow: {
          private: parseIds(privInp.value),
          groups: parseIds(grpInp.value),
          allowAllWhenEmpty: allChk.checked,
        } } }
        wlMsg.innerHTML = '<span class="note">保存中…</span>'
        api('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload) })
          .then(function(){
            if (seq !== wlSeq) return          // 有更新的改动在路上，别覆盖提示
            wlMsg.innerHTML = '<span class="txt-ok">已保存</span>'
            setTimeout(function(){
              if (seq === wlSeq) wlMsg.innerHTML = '<span class="note">改动自动保存</span>'
            }, 1800)
          })
          .catch(function(e){
            if (seq !== wlSeq) return
            wlMsg.innerHTML = '<span class="txt-err">保存失败：' + esc(e.message) + '</span>'
          })
      }
      function scheduleSave(){
        repaintWarn()
        wlMsg.innerHTML = '<span class="note">待保存…</span>'
        if (wlTimer) clearTimeout(wlTimer)
        wlTimer = setTimeout(saveWhitelist, 700)
      }
      privInp.oninput = scheduleSave
      grpInp.oninput = scheduleSave
      allChk.onchange = scheduleSave

      wlCard.querySelector('#wlme').onclick = function(){
        var me = (q.self && q.self.id) ? String(q.self.id) : ''
        if (!me) return
        var cur = parseIds(privInp.value)
        if (cur.indexOf(me) < 0) cur.push(me)
        privInp.value = cur.join(', ')
        scheduleSave()
      }

      setMain(wrap)

      // ⚠️ liveCleanup 必须在 setMain **之后**赋值 —— setMain 会先调用
      //    并清空上一页留下的 cleanup。写在前面的话会被自己立刻执行掉，
      //    "离开页面前补一次保存"就失效了。
      liveCleanup = function(){
        if (wlTimer) { clearTimeout(wlTimer); wlTimer = null; saveWhitelist() }
      }

      var btn = wrap.querySelector('#qpause')
      if (btn) btn.onclick = function(){
        btn.disabled = true
        api('/api/qq/pause', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paused: !q.paused }) }).then(renderQq).catch(function(){ btn.disabled = false })
      }
    }).catch(function(e){ setMain(el(failure(e))) })
  }

  // ══ 模型（选择与路由）══════════════════════════════════════
  /**
   * 这一页管"用哪个模型、按什么顺序挑、给多少 token"。
   *
   * 之前这些只能在 config.json 里手改，界面上看得到模型列表却动不了。
   * 现在四组设置都在这里调，改完立刻生效（不需要重启）：
   *   · 路由策略    free-first / 只免费 / 只自备
   *   · 免费优先级  拖动或点上下来排渠道尝试顺序
   *   · 默认模型    QQ 对话固定用哪个（auto = 按策略自动）
   *   · token 上限  推理模型要给够，否则内容会被推理吃光
   */
  function renderModels(){
    setMain(loading('读取模型与渠道…'))
    // 同时取模型目录、自备渠道、LLM 健康三份数据 —— 本页已合并原「渠道」页，
    // 所以一次并行拿全，避免分两次渲染导致页面闪动。
    Promise.all([api('/api/models'), api('/api/channels'), api('/api/llm/health')]).then(function(res){
      var r = res[0]
      var h = res[1]
      var health = res[2]
      r.channels = h.channels || []
      r.presets = h.presets || {}
      r.health = health
      var wrap = el('<div></div>')
      var s = r.settings || {}
      var models = r.models || []
      var providers = r.providers || []

      // ── 顶部指标（可重算）───────────────────────────────────
      //
      // ⚠️ 「渠道数」容易误导：注册了 14 个渠道，但其中大部分没有已知
      //    模型名 —— auto 模式会直接跳过。所以这里额外给一个
      //    "实际可用于 auto 的渠道数"，让用户一眼看出真正能用几个。
      //
      // ⚠️ 这四项必须能**随渠道开关重算** —— 关掉某家渠道后，
      //    模型总数/渠道数/可用渠道数都变了。之前是一次性渲染死的，
      //    关了渠道数字还停在旧值，看起来像"开关没生效"。
      var metricsBox = el('<div></div>')
      function renderMetrics() {
        var enabledProviders = providers.filter(function(p) { return !disabled[p] })
        var usable = models.filter(function(m){ return !disabled[m.provider] })
        var freeCount = usable.filter(function(m){ return m.kind === 'free' }).length
        var selfCount = usable.filter(function(m){ return m.kind === 'self' }).length
        // 视觉模型（能看图）单独计数 —— 发图时只有这些模型能用。
        // 把 LLM / VLM 混在一起的话，用户选到纯文本模型后发图必然失败，
        // 却看不出是"模型不支持"还是"图没取到"。
        var vlmCount = usable.filter(function(m){ return m.vision === 'yes' }).length
        var usableCount = (r.orderDetail || []).filter(function(d){ return d.usable && !disabled[d.provider] }).length
        var autoUsable = (s.strategy || '') !== 'self-only' ? usableCount : selfCount
        var enabledCount = enabledProviders.length
        metricsBox.innerHTML = ''
        metricsBox.appendChild(el(metrics([
          { label: '可用模型', value: freeCount + selfCount, unit: '个', tone: 'accent' },
          { label: '其中视觉模型', value: vlmCount, unit: '个',
            sub: vlmCount > 0 ? '能看图，发图时走这些' : '当前没有可看图的模型' },
          { label: '渠道数', value: enabledCount + ' / ' + providers.length, unit: '' },
          {
            label: 'auto 实际可用渠道',
            value: autoUsable,
            unit: '个',
            tone: autoUsable === 0 ? 'err' : (autoUsable < enabledCount ? 'warn' : 'ok'),
          },
          { label: '当前策略', value: s.strategy || '-' },
        ])))
      }
      // disabled 要在 renderMetrics 之前就绪（下面第 2 步才定义，这里先建空对象）
      var disabled = {}
      ;(s.disabledProviders || []).forEach(function(p){ disabled[p] = true })
      renderMetrics()
      wrap.appendChild(metricsBox)
      // ⚠️ 指标卡和下面的内容之间也要留间隔。
      //    之前这里没有 spacer，四张指标卡直接贴着「路由策略」卡，
      //    看着像连在一起（用户反馈"上下间隔没了"）。
      //    用固定的 .mt（16px），和页面其它区块的间距一致。
      wrap.appendChild(el('<div class="mt"></div>'))

      // 只在"确实缺得多"时才用横幅打扰 —— 14 个里差 1 个不值得占一整条。
      // 差得少的话，折叠卡副标题里的「N 个会被跳过」已经够了。
      //
      // ⚠️ 这个横幅也要能随渠道开关重算：关掉几家渠道后，可用数会变。
      //    所以同样做成函数，由 refreshModelViews() 调用。
      var bannerBox = el('<div></div>')
      function renderBanner() {
        bannerBox.innerHTML = ''
        var enabledCount = providers.filter(function(p) { return !disabled[p] }).length
        var usableNow = (r.orderDetail || [])
          .filter(function(d){ return d.usable && !disabled[d.provider] }).length
        var strictRatio = enabledCount > 0 && usableNow < enabledCount * 0.6
        if (!strictRatio || (s.strategy || 'free-first') === 'self-only') return
        bannerBox.appendChild(el('<div class="banner">' +
          '<b>' + enabledCount + ' 个渠道里只有 ' + usableNow + ' 个能用于 auto 模式</b><br>' +
          '其余渠道没有已知的模型名，auto 会自动跳过它们（不报错但也不会被使用）。<br>' +
          '想让某个渠道生效：在「模型选择」里把模型填成 <code>该渠道/模型名</code>，' +
          '或在「渠道」页给它配好模型列表。' +
          '</div>'))
      }
      renderBanner()
      // 横幅容器：有内容时才占位。给它一个"有内容才生效"的间隔类，
      // 空的时候不该留空白（否则页面顶部会出现莫名空隙）。
      bannerBox.className = 'mdgap'
      wrap.appendChild(bannerBox)

      // ── 1. 路由策略 ─────────────────────────────────────────
      var stratDesc = {
        'free-first': '免费渠道优先，全失败才走付费兜底 —— 最省钱',
        'free-only': '只用免费渠道，失败就直接报错 —— 完全不花钱',
        'self-only': '只用自备渠道 —— 想固定用某个自建端点时选',
      }
      var stratBtns = ['free-first', 'free-only', 'self-only'].map(function(k){
        return '<span class="chip click ' + (s.strategy === k ? 'accent' : '') +
          '" data-strat="' + k + '">' + esc(k) + '</span>'
      }).join('')
      // 左栏第一张卡（它是"总纲"：先定策略，再谈优先级与模型）
      var stratCard = collapsibleCard({
        icon: 'route', title: '路由策略', key: 'md-strategy', open: true,
        sub: s.strategy,
        body: '<div class="chips">' + stratBtns + '</div>' +
          '<div class="note mt-sm" id="stratdesc">' + esc(stratDesc[s.strategy] || '') + '</div>' +
          '<div class="note">决定"一次请求按什么顺序挑渠道"。改完立即生效。</div>',
      })

      // ── 2. 免费渠道优先级 + 开关 ────────────────────────────
      //
      // 三种排列方式并存，照顾不同习惯：
      //   · 直接拖着整行走     —— 最快，适合鼠标
      //   · 上下箭头           —— 键盘可达 / 触摸精确控制
      //   · 全部自动保存       —— 不再需要点"保存顺序"
      //
      // 服务端给的 defaultOrder 已经是**应用过配置**的实际顺序，直接用它，
      // 不要在这里自己拼（否则界面显示的顺序和实际走的可能不一致）。
      var order = (r.defaultOrder || []).slice()
      // 兜底：万一服务端顺序漏了某个已注册渠道，补到末尾，别让它消失
      ;(providers || []).forEach(function(p){ if (!order.includes(p)) order.push(p) })

      // 哪些渠道没有已知模型名（auto 模式下会被跳过）
      var unusable = {}
      ;(r.orderDetail || []).forEach(function(d){ if (!d.usable) unusable[d.provider] = d.reason })

      // 哪些渠道需要挂代理才能用（服务端标注的，如 gemini 要连 Google）。
      // 这类渠道在本机直连时必定超时，界面要说明白 —— 否则用户只会看到
      // "auto 莫名其妙要等二十秒"，根本想不到是 Google 连不上。
      var needsProxy = {}
      ;(r.orderDetail || []).forEach(function(d){ if (d.needsProxy) needsProxy[d.provider] = d.needsProxy })

      // 每个渠道的模型数（去重后的模型名，不是目录条目数）。
      // 显示出来用户才知道"关掉这家会少多少可选模型" ——
      // 比如 cline 一家就有几百个，关了它模型列表会明显缩水。
      var modelCount = {}
      ;(models || []).forEach(function(m) {
        if (!modelCount[m.provider]) modelCount[m.provider] = {}
        modelCount[m.provider][m.id] = 1
      })
      function countOf(p) {
        return modelCount[p] ? Object.keys(modelCount[p]).length : 0
      }

      // 每个渠道的首字节延迟（服务端探测并存下来，见 /api/models 的 latency）。
      // 显示出来用户才能判断"把哪家排前面更快"。
      var latency = {}
      ;(r.latency || []).forEach(function(x){ latency[x.provider] = x })

      /** 延迟徽标：按快慢上色。没探到就显示 "—"。 */
      function latencyChip(p) {
        var L = latency[p]
        if (!L) return '<span class="ordlat none" title="还没测过延迟">— ms</span>'
        if (L.ms == null) {
          return '<span class="ordlat bad" title="' + esc(L.error || '不可用') + '">不可用</span>'
        }
        var tone = L.ms < 1500 ? 'good' : (L.ms < 4000 ? 'mid' : 'bad')
        return '<span class="ordlat ' + tone + '" title="最近一次探测：' + L.ms + 'ms' +
          (L.when ? '（' + esc(L.when) + '）' : '') + '">' + L.ms + ' ms</span>'
      }

      // ⚠️ disabled 已在顶部（renderMetrics 之前）声明并初始化 ——
      //    这里不能再声明一次，否则 const/var 重复会报错，而且指标
      //    第一次渲染时会读到 undefined。

      function orderRows(list) {
        // 已关闭的渠道排在最后（服务端也已分区，这里再保证一次 ——
        // 免得分区逻辑万一没生效时列表还是乱的）。
        // 编号只给启用的连续递增，已关闭的不编号（它们不参与尝试顺序）。
        var out = []
        var rank = 0
        var showedDivider = false
        list.forEach(function(p, i) {
          var off = disabled[p]
          if (off && !showedDivider) {
            showedDivider = true
            // 只留一条虚线分隔，不写文字 —— 下面的灰行本身都有
            // 「已关闭」徽标和划线，再加一行说明纯属视觉噪音。
            out.push('<div class="orddivider"></div>')
          }
          if (!off) rank++
          out.push(orderRow(p, i, off ? '' : rank))
        })
        return out.join('')
      }

      function orderRow(p, i, shownNumber) {
        var isSelf = (r.models || []).some(function(m) { return m.provider === p && m.kind === 'self' })
        var skip = unusable[p]
        var off = disabled[p]
        var proxy = needsProxy[p]
        var n = countOf(p)
        return '<div class="ordrow' + (skip ? ' ordskip' : '') + (off ? ' ordoff' : '') +
            '" data-p="' + esc(p) + '" data-i="' + i + '" draggable="true"' +
            ' title="' + (off ? '已关闭（拖动可调整位置，但不参与路由）' : '拖动可排序') + '">' +
          // 拖拽手柄：给鼠标一个明确的抓取点（整行也可拖）
          '<span class="ordgrip">' + svgIcon('grip', 13) + '</span>' +
          '<span class="ordn">' + esc(shownNumber) + '</span>' +
          '<span class="ordp">' + esc(p) + '</span>' +
          // 该渠道提供多少个模型：这是用户决定"关不关它"的关键信息
          '<span class="ordcnt" title="本渠道提供 ' + n + ' 个模型">' + n + '</span>' +
          // 延迟：决定排序时的重要参考
          latencyChip(p) +
          (isSelf ? '<span class="chip accent">自备</span>' : '<span class="chip on"><i class="dot"></i>免费</span>') +
          (off ? '<span class="chip off">已关闭</span>' : '') +
          // 需要代理的渠道：单独一个徽标，hover 看原因
          (proxy ? '<span class="chip warn" title="' + esc(proxy) + '">需代理</span>' : '') +
          // 中间的空档用一句话填上，别白占着宽度
          '<span class="ordnote">' + (off ? '不参与路由' : (skip ? esc(skip) : '')) + '</span>' +
          // 开关靠右；箭头已去掉（拖拽就够），少占一半宽度
          '<label class="switch" draggable="false" title="' + (off ? '已关闭，点击启用' : '已启用，点击关闭') + '">' +
            '<input type="checkbox" data-toggle="' + esc(p) + '"' + (off ? '' : ' checked') + '>' +
            '<span></span></label>' +
        '</div>'
      }

      var skipCount = Object.keys(unusable).length
      var offCount = Object.keys(disabled).length
      var ordCard = collapsibleCard({
        icon: 'shuffle', title: '渠道优先级与开关', key: 'md-order',
        sub: order.length + ' 个' +
          (offCount ? ' · ' + offCount + ' 个已关闭' : '') +
          (skipCount ? ' · ' + skipCount + ' 个会被跳过' : ''),
        body: '<div class="note">按编号依次尝试；前面失败才试后面的。' +
            '<b>拖整行即可排序</b>；开关控制是否参与路由。改动自动保存。</div>' +
          (skipCount
            ? '<div class="banner mt-sm" style="margin:8px 0 0">' +
              '<b>' + skipCount + ' 个渠道没有已知模型名</b>，auto 模式下会被直接跳过（不报错，但也不会被使用）。<br>' +
              '想让它们生效：在「模型选择」里把模型填成 <code>渠道/模型名</code>，或先给渠道配好模型列表。' +
              '</div>'
            : '') +
          // 双排布局：14 个渠道一屏放下，不需要滚动
          '<div id="ordlist" class="ordgrid mt-sm">' + orderRows(order) + '</div>' +
          '<div class="mt-sm" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
            '<button class="act ghost" id="ordreset">恢复默认顺序</button>' +
            '<button class="act ghost" id="ordallon">全部启用</button>' +
            '<button class="act ghost" id="ordlatency" title="测每个渠道的首字节延迟（约 10 秒）">测延迟</button>' +
            '<span class="note" id="ordmsg"></span>' +
          '</div>',
      })
      // 追加动作统一放到最后（见「最终布局」），这里只构造。

      // ── 3. 默认模型 + token ─────────────────────────────────
      //
      // 用自定义组合框（输入 + 分组下拉），不用原生 datalist：
      //   · datalist 无法分组 —— 600 多个模型平铺成一长条没法看
      //   · datalist 无法显示"这个模型哪几家有"
      //   · datalist 样式不可控，不跟随主题
      //
      // 分组按**模型系列前缀**：deepseek-* 一组、gemini-* 一组…
      //
      // 值仍是**纯模型名**（不带渠道前缀）—— 用哪家由上面的「渠道优先级」决定。
      //
      // ⚠️ 只列**启用中**的渠道所提供的模型：上面关掉某家，
      //    这里就不该再出现它的模型（否则用户关了渠道还能选到，
      //    选完发现根本用不了）。
      function computeGrouped() {
        return groupByModel(models.filter(function(m) { return !disabled[m.provider] }))
      }
      var grouped = computeGrouped()

      // ⚠️ 组合框必须用 **DOM 插入**（appendChild），不能拼进 HTML 字符串。
      //    拼字符串再交给 el() 解析，等于重新造了一批没有事件绑定的节点。
      //
      // 两级选择：**先选能力大类（全部 / 能看图 / 纯文本），再选具体模型**。
      // 669 个模型里只有 ~150 个能看图，全混在一个下拉里，想做图片识别
      // 根本不知道从哪找 —— 而且在外面选好大类，进去列表就只剩相关的，
      // 比在里面翻页筛要直观得多。
      var capCount = {
        all: grouped.length,
        vision: grouped.filter(function(g){ return g.vision === 'yes' }).length,
        text: grouped.filter(function(g){ return g.vision !== 'yes' }).length,
      }
      // ⚠️ 要**记住**用户选的类型（存 store，和侧栏折叠/主题同一机制）。
      //    原来每次都硬编码 'all'，用户切到「能看图」挑完模型，一离开
      //    这页再回来又变回「全部」，得重新点一次（被反馈过）。
      //    这段要在**建卡片之前**读出来，否则初始 HTML 会先画出"全部"再被改，
      //    有一瞬间的闪烁。
      var CAP_KEY = 'whale-pod-capmode'
      var savedCap = store.get(CAP_KEY)
      var capMode = (savedCap === 'vision' || savedCap === 'text') ? savedCap : 'all'
      var modelCard = collapsibleCard({
        icon: 'sliders', title: '模型选择', key: 'md-model',
        sub: s.qqModel === 'auto' ? '自动' : s.qqModel,
        body:
          '<div class="field"><label>模型类型</label>' +
            '<div class="chips" id="mdcap">' +
              '<span class="chip click' + (capMode === 'all' ? ' accent' : '') + '" data-cap="all">全部' +
                '<span class="capn">' + capCount.all + '</span></span>' +
              '<span class="chip click' + (capMode === 'vision' ? ' accent' : '') + '" data-cap="vision">' +
                svgIcon('eye', 12) + '能看图' +
                '<span class="capn">' + capCount.vision + '</span></span>' +
              '<span class="chip click' + (capMode === 'text' ? ' accent' : '') + '" data-cap="text">纯文本' +
                '<span class="capn">' + capCount.text + '</span></span>' +
            '</div>' +
          '</div>' +
          '<div class="note mt-sm" id="mdcaphint">' +
            (capMode === 'vision'
              ? '只显示<b>支持图片</b>的模型（VLM）。发图会走这些 —— 当前共 ' + capCount.vision + ' 个。'
              : capMode === 'text'
                ? '只显示<b>纯文本</b>模型（LLM）。它们收不到图片内容，只会看到 <code>[图片]</code>。'
                : '「能看图」= 支持图片输入（VLM），发图时必须选这类；' +
                  '「纯文本」（LLM）收到图片只会看到 <code>[图片]</code> 占位符。') +
          '</div>' +
          '<div class="row mt-sm">' +
            '<div class="field" style="flex:2 1 220px"><label>QQ 对话模型</label>' +
              '<div class="mcombo-slot"></div></div>' +
            '<div class="field"><label>最大 token</label>' +
              '<input id="mdmax" type="number" min="0" max="32768" step="64" value="' + esc(s.maxTokens) + '"' +
                ' placeholder="0 = 无限" title="0 或留空 = 不限制">' +
            '</div>' +
          '</div>' +
          '<div class="note mt-sm">' +
            '填 <code>auto</code> = 按上面的策略自动挑。<br>' +
            '填<b>模型名</b>（如 <code>deepseek-v4.1-flash</code>）= 固定这个模型，' +
            '<b>至于用哪家渠道，由上面的「渠道优先级」决定</b>。<br>' +
            '只有需要强制某一家时才写 <code>渠道/模型</code>。<br>' +
            '<b>最大 token 填 0 = 不限制</b>（推荐）。推理模型的思考没有天然终点 —— ' +
            '给一个"中等"上限它会把预算一路顶到极限，正文反而一个字都不剩。' +
          '</div>' +
          '<div class="mt-sm" style="display:flex;gap:8px;align-items:center;min-height:18px">' +
            '<span class="note" id="mdmsg"></span>' +
          '</div>',
      })

      /** 当前选中的能力大类；组合框按它过滤候选。 */
      // （capMode / CAP_KEY 已在建卡片之前读出来了）
      var modelComboEl = modelCombo({
        inputId: 'mdmodel',
        grouped: grouped,
        capFilter: capMode,
        // 外层改了类型 → 同步给组合框（面板开着也会立刻重画）
        capRef: function() { return capMode },
        value: s.qqModel,
        placeholder: 'auto',
        onChange: function(v) {
          var msg = modelCard.querySelector('#mdmsg')
          if (msg) msg.innerHTML = '<span class="note">已选择 <code>' + esc(v) + '</code></span>'
          // 点选即保存（点选是明确的动作，不用等防抖）
          saveModelSettings()
        },
      })
      modelCard.querySelector('.mcombo-slot').appendChild(modelComboEl)

      /** 把"模型类型"的选中态画出来（初次渲染 + 切换时都用它）。 */
      function paintCapChips(){
        ;[].forEach.call(modelCard.querySelectorAll('#mdcap [data-cap]'), function(x) {
          x.className = 'chip click' + (x.dataset.cap === capMode ? ' accent' : '')
        })
        var hint = modelCard.querySelector('#mdcaphint')
        if (!hint) return
        hint.innerHTML = capMode === 'vision'
          ? '只显示<b>支持图片</b>的模型（VLM）。发图会走这些 —— 当前共 ' + capCount.vision + ' 个。'
          : capMode === 'text'
            ? '只显示<b>纯文本</b>模型（LLM）。它们收不到图片内容，只会看到 <code>[图片]</code>。'
            : '「能看图」= 支持图片输入（VLM），发图时必须选这类；「纯文本」（LLM）收到图片只会看到 <code>[图片]</code> 占位符。'
      }
      paintCapChips()   // 按记住的选择初始化（否则界面显示和实际过滤不一致）

      // 外层「模型类型」按钮：切换后让组合框重新过滤
      ;[].forEach.call(modelCard.querySelectorAll('#mdcap [data-cap]'), function(ch) {
        ch.onclick = function() {
          capMode = ch.dataset.cap
          // 记住选择 —— 下次回这页还是这个类型
          try { store.set(CAP_KEY, capMode) } catch (_) { /* 存不了也不影响本次 */ }
          paintCapChips()
          modelComboEl.__setCap(capMode)
        }
      })

      // ── 5. 「全部模型」卡片已移除 ──────────────────────────
      //
      // 为什么删掉：模型列表的正确入口是「模型选择」里的组合框
      // （能按系列分组、能搜索、点一下直接选定）。再单开一张
      // 六百多行的"全部模型"卡片，既占半屏、又和组合框功能重复。
      function entryCount(list) {
        var n = 0
        for (var i = 0; i < list.length; i++) n += list[i].provs.length
        return n
      }

      // 试跑卡片（紧跟在模型选择下面）
      //
      // 不再单独填模型 —— 直接用「模型选择」里的那个。
      // 和模型选择放同一列上下紧挨着，改完就能随手测。
      // ⚠️ 不要再加"直接测上面那个模型"之类的说明文字：卡片副标题已经写了
      //    「紧跟模型选择」，下面又有「将测试：xxx」实时显示，再解释一遍是废话。
      var testCard = collapsibleCard({
        icon: 'flask', title: '试跑模型', key: 'md-test',
        sub: '紧跟模型选择',
        body:
          '<div class="field"><label>提示词</label>' +
            '<input id="mtprompt" value="用一句话自我介绍"></div>' +
          '<label class="chk mt-sm" title="这些免费渠道的模型名是渠道自己编的，经常和真实模型对不上">' +
            '<input type="checkbox" id="mtverify" checked>' +
            '<span></span>' +
            '<span class="chklb">核对模型身份 —— 顺带问它「你是谁」，和模型名对不上会标出来（多花 1~3 秒）</span>' +
          '</label>' +
          '<div class="mt-sm" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
            '<button class="act" id="mtgo">试跑</button>' +
            '<span class="note">将测试：<code id="mtcur">—</code></span>' +
            // 这次试跑的具体延迟：测哪个模型就显示哪个模型的耗时。
            // 渠道级别的延迟在左边的渠道行里，两者分工不同 ——
            // 这里回答"我刚测的这个模型有多快"。
            '<span class="mtlat" id="mtlat"></span>' +
          '</div>' +
          '<div id="mtout" class="mt-sm"></div>',
      })

      // ── 模型统计（纯观测，不做任何自动限制）─────────────────
      //
      // 为什么需要：免费渠道的模型差异极大 —— 实测同一个简单问题，
      // lobsterai/deepseek-flash 1.3 秒就回 11 字，而某些推理模型要 22~42 秒、
      // 推理写 3000+ 字、正文被挤成 0 字（用户看到的就是"不回话"）。
      //
      // 与其在代码里硬编码"避开某某模型"（渠道一更新就失效），不如把
      // 真实调用数据摆出来：哪个快、哪个总空回复、哪个在限流，一目了然。
      var statsCard = collapsibleCard({
        icon: 'activity', title: '模型统计', key: 'md-stats', open: false,
        sub: '来自真实调用，不做限制',
        body: '<div id="mdstats" class="statsbox"></div>',
      })

      // ── 最终布局 ────────────────────────────────────────────
      // 左右两栏等高：
      //   左列 = 路由策略（最上面，它是"总纲"）+ 渠道优先级与开关 + 模型统计
      //   右列 = 模型选择 + 试跑模型（上下紧挨，方便改完就测）
      // 两列用 align-items:stretch 拉平高度，底部不留落差。
      var cols = el('<div class="mdcols"></div>')
      var leftCol = el('<div class="mdcol"></div>')
      var rightCol = el('<div class="mdcol"></div>')
      leftCol.appendChild(stratCard)
      leftCol.appendChild(ordCard)
      leftCol.appendChild(statsCard)
      rightCol.appendChild(modelCard)
      rightCol.appendChild(testCard)
      cols.appendChild(leftCol)
      cols.appendChild(rightCol)
      wrap.appendChild(cols)

      // ── 6. 自备渠道（列表 + 添加/编辑 **二合一**）───────────
      //
      // 为什么并进来：它和上面的"免费渠道开关"是同一件事的两半 ——
      // 都在回答"我有哪些渠道可用"。分成两个页面时，用户得来回跳
      // 才能拼出完整图景。
      //
      // 为什么列表和表单合成一张卡：原来自备渠道列表和"添加/编辑表单"
      // 是两张独立卡片，占两行、还各带一次开合。点「编辑」明明是
      // 在改列表里的一条，却要滚到另一张卡去填 —— 合成一张后，
      // 点编辑直接在同一个框里改，位置也不跳。
      //
      // 用户自备的 OpenAI 兼容端点在启动时装载，改完要重启才生效。
      var selfCard = collapsibleCard({
        icon: 'plug', title: '自备渠道', key: 'md-self',
        sub: (h.channels || []).length + ' 个 · 不依赖 DSH',
        body:
          // ① 已有渠道列表
          '<div id="chlist">' + ((h.channels || []).length
            ? (h.channels || []).map(function(x){ return channelRow(x) }).join('')
            : '<div class="empty">' + svgIcon('plug', 26) + '<br>还没有自备渠道<br>' +
              '<span class="note">在下面填一个 OpenAI 兼容端点即可（Ollama / DeepSeek 等）</span></div>') +
          '</div>' +
          '<div class="note mt-sm">自备渠道不依赖 DSH，是本机没装渠道包时的唯一来源；' +
            '有 DSH 时它叠加在免费渠道之后（免费优先，省钱）。</div>' +
          // ② 添加 / 编辑表单（就在同一张卡里）
          '<div class="chform mt">' +
            '<div class="chform-hd">' +
              '<b id="chformtitle">添加渠道</b>' +
              '<button class="act ghost sm chcancel" id="chcancel" style="display:none">取消编辑</button>' +
            '</div>' +
            '<div class="row">' +
              '<div class="field"><label>类型（选一个自动填地址）</label>' +
                '<select id="chpreset">' +
                  '<option value="">— 手动填写 —</option>' +
                  Object.keys(h.presets || {}).map(function(k){
                    var p = h.presets[k]
                    return '<option value="' + esc(k) + '">' + esc(p.label) + '</option>'
                  }).join('') +
                '</select></div>' +
              '<div class="field"><label>id（英文，作为渠道名）</label>' +
                '<input id="chid" placeholder="ollama"></div>' +
            '</div>' +
            '<div class="field mt-sm"><label>Base URL（要含 /v1）</label>' +
              '<input id="churl" placeholder="http://127.0.0.1:11434/v1" class="mono"></div>' +
            '<div class="row mt-sm">' +
              '<div class="field" style="flex:2 1 260px"><label>API Key（本地模型可留空）</label>' +
                '<input id="chkey" type="password" placeholder="sk-…" autocomplete="off"></div>' +
              '<div class="field"><label>默认模型</label>' +
                '<input id="chmodel" placeholder="qwen2.5:7b"></div>' +
            '</div>' +
            '<div class="field mt-sm"><label>可用模型（逗号分隔，可留空）</label>' +
              '<input id="chmodels" placeholder="qwen2.5:7b, llama3.2"></div>' +
            '<div class="mt-sm" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
              '<button class="act" id="chsave">保存</button>' +
              '<button class="act ghost" id="chtest">测试连接</button>' +
              '<span class="note" id="chmsg"></span>' +
            '</div>' +
            '<div class="note mt-sm">改完要<b>重启 WhalePod</b> 才生效（渠道在启动时装载）。' +
              '保存后它会出现在上面的「渠道优先级」里。</div>' +
          '</div>',
      })
      wrap.appendChild(el('<div class="mt"></div>'))
      wrap.appendChild(selfCard)

      setMain(wrap)

      // 试跑卡片里的"将测试"跟着上面那栏实时走
      ;(function syncMtCur() {
        var md = document.getElementById('mdmodel')
        var cur = document.getElementById('mtcur')
        if (cur) cur.textContent = (md && md.value.trim()) || 'auto'
        if (md) md.addEventListener('input', syncMtCur)
      })()

      // ── 事件：策略 ──────────────────────────────────────────
      ;[].forEach.call(wrap.querySelectorAll('[data-strat]'), function(ch){
        ch.onclick = function(){
          var k = ch.dataset.strat
          api('/api/models/settings', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ strategy: k }) }).then(function(){
            s.strategy = k
            ;[].forEach.call(wrap.querySelectorAll('[data-strat]'), function(x){
              x.className = 'chip click' + (x.dataset.strat === k ? ' accent' : '')
            })
            var d = document.getElementById('stratdesc')
            if (d) d.textContent = stratDesc[k] || ''
            // 策略影响"auto 可用渠道"的口径（self-only 只算自备），
            // 所以顶部指标和卡片副标题也要跟着重算。
            var cardSub = stratCard.querySelector('.foldsub')
            if (cardSub) cardSub.textContent = k
            refreshModelViews()
          }).catch(function(e){ uiAlert({ icon: 'alert', title: '保存失败', body: esc(e.message) }) })
        }
      })

      // ── 事件：优先级排序 + 开关（自动保存）────────────────────
      //
      // 拖动与箭头/开关都走同一个 saveOrder()，且**自动保存**（防抖 400ms）——
      // 之前要点"保存顺序"按钮，排一次多点一次，太慢。
      var saveTimer = null
      function saveOrder(immediate) {
        var msg = ordCard.querySelector('#ordmsg')
        if (saveTimer) clearTimeout(saveTimer)
        if (msg) msg.innerHTML = '<span class="note">保存中…</span>'
        var doIt = function() {
          api('/api/models/settings', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              freeOrder: order,
              disabledProviders: Object.keys(disabled).filter(function(p){ return disabled[p] }),
            }),
          }).then(function() {
            if (msg) msg.innerHTML = '<span class="txt-ok">' + svgIcon('check', 13) + ' 已保存</span>'
            // 2 秒后淡出提示，别长期占着
            setTimeout(function() { if (msg) msg.innerHTML = '' }, 2000)
          }).catch(function(e) {
            if (msg) msg.innerHTML = '<span class="txt-err">' + svgIcon('alert', 13) + ' ' + esc(e.message) + '</span>'
          })
        }
        if (immediate) doIt()
        else saveTimer = setTimeout(doIt, 400)
      }

      /** 重画列表并重新绑定交互事件。 */
      function repaintOrder() {
        var box = ordCard.querySelector('#ordlist')
        if (box) box.innerHTML = orderRows(order)
        bindOrderEvents()
      }

      function bindOrderEvents() {
        var box = ordCard.querySelector('#ordlist')
        if (!box) return

        // 开关
        ;[].forEach.call(box.querySelectorAll('[data-toggle]'), function(cb) {
          cb.onchange = function() {
            var p = cb.dataset.toggle
            var nowOff = !cb.checked
            if (cb.checked) delete disabled[p]
            else disabled[p] = true
            var row = cb.closest ? cb.closest('.ordrow') : null
            if (row) {
              row.classList.toggle('ordoff', nowOff)
              cb.setAttribute('title', nowOff ? '已关闭，点击启用' : '已启用，点击关闭')
              // ⚠️ 光切 class 不够 —— 「已关闭」徽标和「不参与路由」是
              //    渲染时就写死的文本，不换的话点了开关看着像没反应。
              //    这里就地更新那一行的文字，不整表重画（重画会丢焦点、
              //    也会打断连续操作）。
              var chip = row.querySelector('.chip.off')
              if (nowOff && !chip) {
                // 插到「免费/自备」徽标后面
                var anchor = row.querySelector('.chip.on, .chip.accent')
                var add = el('<span class="chip off">已关闭</span>')
                if (anchor && anchor.nextSibling) row.insertBefore(add, anchor.nextSibling)
                else if (anchor) anchor.parentNode.appendChild(add)
                else row.insertBefore(add, row.querySelector('.ordnote'))
              } else if (!nowOff && chip) {
                chip.remove()
              }
              var note = row.querySelector('.ordnote')
              if (note) {
                note.textContent = nowOff
                  ? '不参与路由'
                  : (unusable[p] ? unusable[p] : '')
              }
            }
            // 下面的模型列表/选择器/顶部指标要跟着变 —— 关掉的渠道不该还能选到
            refreshModelViews()
            saveOrder()   // 开关立即保存，不给防抖（用户期待马上生效）
          }
          // 别让点开关触发整行拖拽
          cb.onmousedown = function(e) { e.stopPropagation() }
        })

        // ── 拖拽排序 ─────────────────────────────────────────
        // 用 HTML5 DnD（比手写 pointer 逻辑少一半代码，且自带拖影）。
        var rows = [].slice.call(box.querySelectorAll('.ordrow'))
        var dragFrom = -1

        rows.forEach(function(row) {
          row.ondragstart = function(e) {
            dragFrom = Number(row.dataset.i)
            row.classList.add('dragging')
            try {
              e.dataTransfer.effectAllowed = 'move'
              // 某些浏览器不设 data 就不触发 drop
              e.dataTransfer.setData('text/plain', row.dataset.p)
            } catch (_) {}
          }
          row.ondragend = function() {
            row.classList.remove('dragging')
            ;[].forEach.call(box.querySelectorAll('.ordrow'), function(r) {
              r.classList.remove('dragover-top', 'dragover-bottom')
            })
          }
          // dragover 只是画指示线，真正重排放在 drop
          row.ondragover = function(e) {
            if (dragFrom < 0) return
            e.preventDefault()
            try { e.dataTransfer.dropEffect = 'move' } catch (_) {}
            var rect = row.getBoundingClientRect()
            var after = e.clientY > rect.top + rect.height / 2
            ;[].forEach.call(box.querySelectorAll('.ordrow'), function(r) {
              r.classList.remove('dragover-top', 'dragover-bottom')
            })
            row.classList.add(after ? 'dragover-bottom' : 'dragover-top')
          }
          row.ondrop = function(e) {
            e.preventDefault()
            var to = Number(row.dataset.i)
            if (dragFrom < 0 || to < 0 || dragFrom === to) return

            // ⚠️ 可用/已关闭是**两个分区**，不能让拖动把它们混在一起。
            //    一旦混了，保存下来的顺序里就会出现"启用的排在已关闭的后面"，
            //    而服务端每次渲染又会做稳定分区把它们分开 ——
            //    用户会看到"刚拖的又跳回去了"。
            var dragged = order[dragFrom]
            var target = order[to]
            var draggedOff = Boolean(disabled[dragged])
            var targetOff = Boolean(disabled[target])
            if (draggedOff !== targetOff) {
              // 跨分区拖动：忽略（想调整已关闭渠道的相对顺序，先把它启用）
              var msg2 = ordCard.querySelector('#ordmsg')
              if (msg2) {
                msg2.innerHTML = '<span class="txt-err">' +
                  '可用与已关闭是两组，不能互相穿插。先开关切换再排序。</span>'
                setTimeout(function() { if (msg2) msg2.innerHTML = '' }, 2600)
              }
              dragFrom = -1
              return
            }

            var rect = row.getBoundingClientRect()
            var after = e.clientY > rect.top + rect.height / 2
            var move = order.splice(dragFrom, 1)[0]
            // 被拖走的元素如果插回原位之后，目标索引要相应调整
            var insertAt = after ? to + 1 : to
            if (dragFrom < insertAt) insertAt--
            order.splice(insertAt, 0, move)
            dragFrom = -1
            repaintOrder()
            saveOrder(true)
          }
        })
      }
      bindOrderEvents()

      /**
       * 渠道开关变化后，让下面两张卡片跟着变。
       *
       * 为什么要联动：上面关了某家渠道，下面的模型列表和选择器
       * 如果还列着那家的模型，用户会选到一个根本用不了的模型 ——
       * 选完才发现"没渠道可用"，很费解。
       */
      function refreshModelViews() {
        // 0) 顶部指标 + 提示横幅：关渠道后模型总数/渠道数/可用渠道数都变了，
        //    不重算的话数字停在旧值，看起来像"开关没生效"。
        renderMetrics()
        renderBanner()
        var g = computeGrouped()
        grouped = g
        // 1) 模型选择器（面板开着会立刻重画）—— 它现在是唯一的模型浏览入口
        if (modelComboEl.__setGrouped) modelComboEl.__setGrouped(g)
        // 2) 模型选择卡片的副标题显示模型总数，关了渠道它会变
        var msub = modelCard.querySelector('.foldsub')
        if (msub) {
          msub.textContent = (s.qqModel && s.qqModel !== 'auto' ? s.qqModel : '自动') +
            ' · ' + g.length + ' 个可用'
        }
        // 3) 渠道卡片的副标题
        var osub = ordCard.querySelector('.foldsub')
        if (osub) {
          var offN = Object.keys(disabled).length
          osub.textContent = order.length + ' 个' +
            (offN ? ' · ' + offN + ' 个已关闭' : '') +
            (skipCount ? ' · ' + skipCount + ' 个会被跳过' : '')
        }
      }

      // ── 模型统计的渲染 ────────────────────────────────────
      //
      // 纯"摆数据"：平均耗时 / 首字延迟 / 空回复率 / 失败率。
      // 不据此自动禁用或切换任何东西 —— 用户看数据自己决定。
      var statsSort = store.get('whale-pod-statssort') || 'calls'
      function renderModelStats() {
        var box = statsCard.querySelector('#mdstats')
        if (!box) return
        box.innerHTML = '<div class="spinner"></div>'
        api('/api/models/stats').then(function(r){
          var rows = (r.stats || []).slice()
          if (rows.length === 0) {
            box.innerHTML = '<div class="empty" style="padding:14px 0">' +
              '还没有调用记录。<br><span class="note">' +
              'QQ 每回一条消息、网关每处理一次请求，都会记一条 —— 跑一会儿再回来看。</span></div>'
            return
          }
          var keyFn = {
            calls: function(x){ return -(x.calls || 0) },
            speed: function(x){ return (x.avgMs == null ? 1e9 : x.avgMs) },
            ttft: function(x){ return (x.avgTtft == null ? 1e9 : x.avgTtft) },
            empty: function(x){ return -(x.emptyRate || 0) },
            fail: function(x){ return -(x.failRate || 0) },
          }[statsSort] || function(x){ return -(x.calls || 0) }
          rows.sort(function(a, b){ return keyFn(a) - keyFn(b) })

          var sorts = [['calls','调用最多'],['speed','最快'],['ttft','首字最快'],['empty','空回复多'],['fail','失败多']]
          box.innerHTML =
            '<div class="chips" style="margin-bottom:8px">' +
              sorts.map(function(p){
                return '<span class="chip click' + (statsSort === p[0] ? ' accent' : '') +
                  '" data-sort="' + p[0] + '">' + p[1] + '</span>'
              }).join('') +
            '</div>' +
            '<div class="statstbl">' +
              '<div class="statsrow statshd">' +
                '<span>模型</span><span title="调用次数">次数</span>' +
                '<span title="平均总耗时">耗时</span><span title="平均首字延迟">首字</span>' +
                '<span title="正文为空的占比（推理吃光 token 的典型症状）">空回</span>' +
                '<span title="失败率">失败</span>' +
              '</div>' +
              rows.slice(0, 40).map(function(x){
                var emptyPct = Math.round((x.emptyRate || 0) * 100)
                var failPct = Math.round((x.failRate || 0) * 100)
                return '<div class="statsrow" title="' +
                    esc((x.providers || []).join(', ') + (x.lastError ? ' · 最近错误：' + x.lastError : '')) + '">' +
                  '<span class="m" title="' + esc(x.model) + '">' + esc(x.model) + '</span>' +
                  '<span>' + x.calls + '</span>' +
                  '<span>' + (x.avgMs == null ? '—' : (x.avgMs < 1000 ? x.avgMs + 'ms' : (x.avgMs / 1000).toFixed(1) + 's')) + '</span>' +
                  '<span>' + (x.avgTtft == null ? '—' : (x.avgTtft < 1000 ? x.avgTtft + 'ms' : (x.avgTtft / 1000).toFixed(1) + 's')) + '</span>' +
                  '<span class="' + (emptyPct >= 30 ? 'txt-err' : emptyPct > 0 ? 'txt-warn' : '') + '">' +
                    (x.calls ? emptyPct + '%' : '—') + '</span>' +
                  '<span class="' + (failPct >= 30 ? 'txt-err' : failPct > 0 ? 'txt-warn' : '') + '">' +
                    (x.calls ? failPct + '%' : '—') + '</span>' +
                '</div>'
              }).join('') +
            '</div>' +
            '<div class="note mt-sm">' +
              '统计来自 ' + r.calls + ' 次真实调用，重启归零。' +
              '「空回」高说明推理把 token 吃光了 —— 给模型加大 token 或换一个。' +
            '</div>'

          ;[].forEach.call(box.querySelectorAll('[data-sort]'), function(ch){
            ch.onclick = function(){
              statsSort = ch.dataset.sort
              try { store.set('whale-pod-statssort', statsSort) } catch (_) {}
              renderModelStats()
            }
          })
        }).catch(function(e){
          box.innerHTML = '<div class="note txt-err">读取失败：' + esc(e.message) + '</div>'
        })
      }
      renderModelStats()

      ordCard.querySelector('#ordreset').onclick = function() {
        // "恢复默认" = **按首字母排序**（不是取服务端的 defaultOrder）。
        // 服务端的 defaultOrder 是"当前配置应用后的顺序"，点它会变成
        // 原地不动、看着像按钮坏了。这里明确按字母重排，行为可预期。
        order = providers.slice().sort(function(a, b) {
          var x = a.toLowerCase(), y = b.toLowerCase()
          return x < y ? -1 : x > y ? 1 : 0
        })
        repaintOrder()
        refreshModelViews()
        saveOrder(true)
      }
      ordCard.querySelector('#ordallon').onclick = function() {
        disabled = {}
        repaintOrder()
        refreshModelViews()   // 全部启用 → 下面的列表把模型加回来
        saveOrder(true)
      }

      // ── 事件：默认模型（自动保存，无需点按钮）───────────────
      //
      // 和「渠道优先级」一样走自动保存：改了就存（防抖 600ms）。
      // 模型名打字时每个字符都会触发 input，防抖是必须的 ——
      // 否则打 "deepseek-v4-flash" 会发 18 次请求。
      var mdSaveTimer = null
      var mdLastSaved = s.qqModel + '|' + s.maxTokens
      function saveModelSettings(immediate) {
        var m = modelCard.querySelector('#mdmsg')
        var modelVal = (document.getElementById('mdmodel') || {}).value
        var maxVal = (document.getElementById('mdmax') || {}).value
        var payload = {
          qqModel: String(modelVal || 'auto').trim() || 'auto',
          // 空 / 0 / 非数 → 0（= 不限制）。
          // ⚠️ 不能像以前那样写 Number(maxVal) || 1024 —— 那会把用户填的 0
          //    （"无限"）悄悄改成 1024，等于把刚设的无限又变回有限。
          maxTokens: (function() {
            var n = Number(maxVal)
            return (Number.isFinite(n) && n > 0) ? Math.round(n) : 0
          })(),
        }
        var key = payload.qqModel + '|' + payload.maxTokens
        if (key === mdLastSaved && !immediate) return   // 没变化就不发请求
        if (mdSaveTimer) clearTimeout(mdSaveTimer)
        if (m) m.innerHTML = '<span class="note">保存中…</span>'
        var doIt = function() {
          api('/api/models/settings', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }).then(function() {
            mdLastSaved = key
            if (m) m.innerHTML = '<span class="txt-ok">' + svgIcon('check', 13) + ' 已保存（立即生效）</span>'
            setTimeout(function() { if (m) m.innerHTML = '' }, 2000)
          }).catch(function(e) {
            if (m) m.innerHTML = '<span class="txt-err">' + svgIcon('alert', 13) + ' ' + esc(e.message) + '</span>'
          })
        }
        if (immediate) doIt()
        else mdSaveTimer = setTimeout(doIt, 600)
      }

      // 打字 / 改 token → 自动保存
      var mdIn = document.getElementById('mdmodel')
      if (mdIn) mdIn.addEventListener('input', function() { saveModelSettings() })
      var mdMaxIn = document.getElementById('mdmax')
      if (mdMaxIn) mdMaxIn.addEventListener('input', function() { saveModelSettings() })

      // ── 事件：模型清单（按模型归纳 + 搜索 + 分页）────────────
      //
      // 归纳方式：**以模型为主体**，同一个模型在多个渠道可用时合并成一行，
      // 渠道（也就是"地址"）作为附属信息跟在模型名后面。
      //
      // 为什么这么排：用户找的是"用哪个模型"，渠道只是实现细节；
      // 而且同一模型常在多处都有，平铺会把列表撑成重复的一大片。
      var shown = 60

      /** 把 [{id,provider,kind,vision}] 归纳成 [{id, vision, provs:[{provider,kind}]}] */
      function groupByModel(list) {
        var map = {}
        var seen = []
        for (var i = 0; i < list.length; i++) {
          var m = list[i]
          if (!map[m.id]) { map[m.id] = {}; seen.push(m.id) }
          // ⚠️ 同一渠道只保留一次 —— 模型目录里同一个 (渠道, 模型)
          //    可能有多条记录（不同后缀/重复项），不去重会渲染出
          //    "cline, cline, cline" 这样的重复 chip。
          if (!map[m.id][m.provider]) map[m.id][m.provider] = m.kind
        }
        // 能力：同一模型名在不同渠道上报可能不一致（比如 A 家说支持图、
        // B 家说纯文本）。取**最宽松**的判定 —— 只要有一家说能看图，
        // 就标为视觉模型（用户看到标记后再选渠道时仍能落到不支持的那家，
        // 但至少这个模型名本身是具备视觉能力的）。
        var cap = {}
        for (var k = 0; k < list.length; k++) {
          var mm = list[k]
          if (mm.vision === 'yes') cap[mm.id] = 'yes'
          else if (!cap[mm.id] && mm.vision) cap[mm.id] = cap[mm.id] || mm.vision
        }
        // ⚠️ 渠道 chip 必须按**用户拖出来的优先级**排，不能按 object key 顺序。
        //    否则「渠道优先级」里明明把 gemini 拖到第一位，模型行里却
        //    还是任意顺序 —— 看起来就像排序没生效（用户就是这么反馈的）。
        var rank = function(p) {
          var i = order.indexOf(p)
          return i < 0 ? 999 : i          // 没在顺序里的排到最后
        }
        return seen.map(function(id) {
          var provs = Object.keys(map[id]).map(function(p) {
            return { provider: p, kind: map[id][p] }
          })
          provs.sort(function(a, b) {
            var d = rank(a.provider) - rank(b.provider)
            if (d !== 0) return d
            // 顺序相同（都没进列表）时：免费在前、自备在后
            return (a.kind === 'self' ? 1 : 0) - (b.kind === 'self' ? 1 : 0)
          })
          return { id: id, vision: cap[id] || 'unknown', provs: provs }
        })
      }

      // ── 事件：测延迟 ────────────────────────────────────────
      //
      // 只在用户点击时探测（不在加载页面时自动跑）—— 14 个渠道要十来秒，
      // 每次开页面都测会白白占用上游额度。
      var latTimer = null
      var latencyBtn = ordCard.querySelector('#ordlatency')
      function paintLatency(list) {
        var msg = ordCard.querySelector('#ordmsg')
        if (!msg) return
        var okN = list.filter(function(x){ return x.ms != null }).length
        msg.innerHTML = '<span class="note">已测 ' + okN + '/' + list.length +
          ' 个渠道' + (okN < list.length ? '（其余不可用或超时）' : '') + '</span>'
      }
      function pollLatency() {
        api('/api/models/latency').then(function(d) {
          var probe = d.probe
          if (probe && probe.running) {
            var msg = ordCard.querySelector('#ordmsg')
            if (msg) msg.innerHTML = '<span class="note">测延迟 ' + probe.done + '/' + probe.total + '…</span>'
            latTimer = setTimeout(pollLatency, 1200)
          } else {
            // 测完重画整页，让每行的延迟徽标换成新值
            renderModels()
          }
        }).catch(function(){})
      }
      if (latencyBtn) latencyBtn.onclick = function() {
        latencyBtn.disabled = true
        latencyBtn.textContent = '探测中…'
        api('/api/models/latency', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }).then(function() {
          pollLatency()
        }).catch(function(e) {
          latencyBtn.disabled = false
          latencyBtn.textContent = '测延迟'
          uiAlert({ icon: 'alert', title: '延迟探测失败', body: esc(e.message) })
        })
      }
      // 页面打开时：如果服务端正在测（首次打开会自动触发），跟着轮询；
      // 已有结果就直接显示。这样用户什么都不用点就能看到延迟。
      api('/api/models/latency').then(function(d) {
        if (d.probe && d.probe.running) {
          if (latencyBtn) { latencyBtn.disabled = true; latencyBtn.textContent = '探测中…' }
          pollLatency()
        } else if (d.latency && d.latency.length) {
          paintLatency(d.latency)
        }
      }).catch(function(){})

      // ── 事件：试跑 ──────────────────────────────────────────
      wrap.querySelector('#mtgo').onclick = function(){
        var out = document.getElementById('mtout')
        // 读「默认模型」那一栏的当前值（未保存的改动也算），
        // 这样"上面填什么，下面就试什么"，不会出现两处不一致。
        var mdEl = document.getElementById('mdmodel')
        var model = (mdEl && mdEl.value.trim()) || 'auto'
        var cur = document.getElementById('mtcur')
        if (cur) cur.textContent = model
        out.innerHTML = '<div class="spinner"></div>'
        var verifyEl = document.getElementById('mtverify')
        api('/api/models/test', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: model,
            prompt: document.getElementById('mtprompt').value.trim(),
            verify: Boolean(verifyEl && verifyEl.checked),
          }) })
          .then(function(d){
            // 试跑栏里的"这个模型的延迟"：成功就显示本次耗时（首字节+生成），
            // 失败就标红 —— 用户在这里看到的始终是"我刚测的那个模型"的快慢。
            var latEl = document.getElementById('mtlat')
            if (latEl) {
              if (d.ok) {
                var tone = d.ms < 1500 ? 'good' : (d.ms < 5000 ? 'mid' : 'bad')
                latEl.className = 'mtlat ' + tone
                latEl.textContent = '延迟 ' + d.ms + ' ms'
              } else {
                latEl.className = 'mtlat bad'
                latEl.textContent = '未测通'
              }
            }
            // 刚测完就刷新统计 —— 用户马上能看到这次结果进了表
            try { renderModelStats() } catch (_) {}
            if (d.ok) {
              // 身份核对结果：一致就低调一行，不一致就醒目警告
              var idHtml = ''
              if (d.identity) {
                var id = d.identity
                if (id.match === false) {
                  idHtml = '<div class="banner warn" style="margin:8px 0 0">' +
                    svgIcon('alert', 14) + ' <b>模型名与实际不符</b>：' + esc(id.note) + '<br>' +
                    '<span class="note">它自称：' + esc((id.saidRaw || '').slice(0, 80)) + '</span><br>' +
                    '<span class="note">这些免费渠道的模型名是渠道自己编的标签，不代表背后的真实模型。</span>' +
                    '</div>'
                } else if (id.match === true) {
                  idHtml = '<div class="note mt-sm">' + svgIcon('check', 13) + ' 身份核对：' +
                    esc(id.note) + '（自称 ' + esc(id.said) + '）</div>'
                } else {
                  idHtml = '<div class="note mt-sm">身份核对：' + esc(id.note) +
                    (id.saidRaw ? '（它说：' + esc(id.saidRaw.slice(0, 60)) + '）' : '') + '</div>'
                }
              }
              out.innerHTML = '<div class="banner ok" style="margin:0">' +
                svgIcon('check',14) + ' <b>' + esc(d.picked ? d.picked.provider + '/' + d.picked.model : '') + '</b>' +
                '（' + d.ms + 'ms' + (d.usage ? '，' + (d.usage.inputTokens||0) + '/' + (d.usage.outputTokens||0) + ' tokens' : '') + '）' +
                '</div>' + idHtml +
                '<pre class="mt-sm" style="max-height:24vh">' + esc(d.text || '') + '</pre>' +
                (d.attempts && d.attempts.length > 1
                  ? '<div class="note mt-sm">尝试过程：' + d.attempts.map(function(a){
                      return esc(a.provider + '/' + a.model) + (a.ok ? ' ✅' : ' ❌')
                    }).join(' → ') + '</div>'
                  : '')
            } else {
              // 失败时把"建议换哪个模型"摆出来，点了直接填进上面并重试 ——
              // 光甩一句"渠道网络请求失败"，用户根本不知道下一步该填什么。
              var sg = d.suggestions || []
              out.innerHTML = '<div class="banner err" style="margin:0">' +
                  svgIcon('alert',14) + ' <b>失败</b>：' + esc(d.detail || '未知原因') +
                  (d.attempts && d.attempts.length
                    ? '<br><span class="note">试过：' + d.attempts.map(function(a){
                        return esc(a.provider + '/' + a.model) + (a.ok ? ' ✅' : ' ❌')
                      }).join(' → ') + '</span>'
                    : '') +
                '</div>' +
                (sg.length
                  ? '<div class="mt-sm"><div class="note">换成这些试试：</div>' +
                    '<div class="sugbox">' + sg.map(function(x){
                      return '<button class="sug" data-model="' + esc(x.model) + '">' +
                        '<span class="sugm">' + esc(x.model) + '</span>' +
                        '<span class="sugw">' + esc(x.why) + ' · ' + esc(x.providers.join(' · ')) + '</span>' +
                        '</button>'
                    }).join('') + '</div></div>'
                  : '<div class="note mt-sm">没有找到可推荐的替代模型（可能当前没有启用任何渠道）。</div>')
              ;[].forEach.call(out.querySelectorAll('[data-model]'), function(b){
                b.onclick = function() {
                  var mv = b.dataset.model
                  var inp = document.getElementById('mdmodel')
                  if (inp) {
                    inp.value = mv
                    inp.dispatchEvent(new Event('input', { bubbles: true }))   // 同步"将测试"+自动保存
                    // 派发 input 会顺带打开下拉，这里收起来，别挡住结果
                    if (modelComboEl.__close) modelComboEl.__close()
                  }
                  var cur = document.getElementById('mtcur')
                  if (cur) cur.textContent = mv
                  // 换好就立刻再试一次，省掉"点一下再点一下"
                  wrap.querySelector('#mtgo').click()
                }
              })
            }
          })
          .catch(function(e){ out.innerHTML = failure(e) })
      }

      // ── 事件：自备渠道表单（原来是独立「渠道」页的逻辑）────────
      var msg = document.getElementById('chmsg')
      var modelCache = []

      document.getElementById('chpreset').onchange = function() {
        var k = this.value
        var p = (r.presets || {})[k]
        if (!p) return
        document.getElementById('chid').value = k
        document.getElementById('churl').value = p.baseUrl
        document.getElementById('chmodel').value = (p.models || [])[0] || ''
        document.getElementById('chmodels').value = (p.models || []).join(', ')
      }

      function readChannelForm() {
        var modelsRaw = document.getElementById('chmodels').value || ''
        return {
          id: document.getElementById('chid').value.trim(),
          baseUrl: document.getElementById('churl').value.trim(),
          apiKey: document.getElementById('chkey').value,
          model: document.getElementById('chmodel').value.trim(),
          models: modelsRaw.split(',').map(function(s2){ return s2.trim() }).filter(Boolean),
          preset: document.getElementById('chpreset').value || 'custom',
        }
      }

      ;[].forEach.call(wrap.querySelectorAll('[data-edit]'), function(b) {
        b.onclick = function() {
          var id = b.dataset.edit
          var x = (r.channels || []).find(function(v){ return v.id === id })
          if (!x) return
          document.getElementById('chid').value = x.id
          document.getElementById('churl').value = x.baseUrl
          document.getElementById('chkey').value = ''   // 不回填密钥，避免覆盖
          document.getElementById('chmodel').value = x.model || ''
          document.getElementById('chmodels').value = (x.models || []).join(', ')
          document.getElementById('chkey').placeholder = x.hasKey ? '（已保存，留空则不改）' : 'sk-…'
          // 表单标题变成"编辑 xxx"，并露出取消按钮 ——
          // 列表和表单在同一张卡里，用户能立刻看出"我在改哪一条"。
          document.getElementById('chformtitle').textContent = '编辑：' + x.id
          document.getElementById('chcancel').style.display = ''
          msg.innerHTML = '<span class="note">留空 API Key 表示不修改</span>'
          var formEl = document.getElementById('churl')
          if (formEl && formEl.scrollIntoView) formEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
      })
      // 取消编辑：清空表单、回到"添加"状态
      document.getElementById('chcancel').onclick = function() {
        ;['chid', 'churl', 'chkey', 'chmodel', 'chmodels'].forEach(function(k) {
          var e2 = document.getElementById(k)
          if (e2) e2.value = ''
        })
        document.getElementById('chpreset').value = ''
        document.getElementById('chformtitle').textContent = '添加渠道'
        document.getElementById('chcancel').style.display = 'none'
        msg.innerHTML = ''
      }
      ;[].forEach.call(wrap.querySelectorAll('[data-del]'), function(b) {
        b.onclick = async function() {
          var id = b.dataset.del
          var ok = await uiConfirm({
            icon: 'trash',
            title: '删除渠道',
            body: '确定删除渠道 <b>' + esc(id) + '</b>？<br>' +
              '<span class="note">该渠道的配置会从 config.json 里移除，重启后生效。</span>',
            ok: '删除', danger: true,
          })
          if (!ok) return
          api('/api/channels/remove', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: id }) }).then(function(){ renderModels() })
        }
      })

      document.getElementById('chtest').onclick = function() {
        var ch = readChannelForm()
        if (!ch.baseUrl) { msg.innerHTML = '<span class="txt-err">先填 Base URL</span>'; return }
        msg.textContent = '测试中…'
        api('/api/channels/test', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel: ch }) }).then(function(x){
            if (x.ok) {
              modelCache = x.models || []
              msg.innerHTML = '<span class="txt-ok">' + esc(x.detail) + '（' + x.ms + 'ms）</span>'
              if (modelCache.length && !document.getElementById('chmodels').value) {
                document.getElementById('chmodels').value = modelCache.slice(0, 30).join(', ')
              }
            } else {
              msg.innerHTML = '<span class="txt-err">' + esc(x.detail) + '</span>'
            }
          }).catch(function(e){ msg.innerHTML = '<span class="txt-err">' + esc(e.message) + '</span>' })
      }

      document.getElementById('chsave').onclick = function() {
        var ch = readChannelForm()
        if (!ch.id) { msg.innerHTML = '<span class="txt-err">先填 id</span>'; return }
        if (!ch.baseUrl) { msg.innerHTML = '<span class="txt-err">先填 Base URL</span>'; return }
        msg.textContent = '保存中…'
        api('/api/channels/upsert', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel: ch }) }).then(function(){
          msg.innerHTML = '<span class="txt-ok">已保存（重启 WhalePod 后生效）</span>'
          setTimeout(renderModels, 900)
        }).catch(function(e){ msg.innerHTML = '<span class="txt-err">' + esc(e.message) + '</span>' })
      }
    }).catch(function(e){ setMain(el(failure(e))) })
  }

  // ══ 渠道（已并入「模型与渠道」页）══════════════════════════
  /**
   * 这一页原本解决「不用 DSH 也能跑」：用户自己填 OpenAI 兼容端点。
   *
   * 现在已并入「模型与渠道」页 —— 免费渠道的开关/延迟和自备渠道的
   * 增删测试其实是一件事的两半，分成两页会让人来回跳。
   * 这里只保留 channelRow()（行渲染），页面逻辑见 renderModels()。
   */

  /** 一行渠道展示。 */
  function channelRow(x){
    var tone = x.active ? 'on' : 'off'
    var label = x.active ? '已装载' : '未装载'
    return '<div style="padding:11px 0;border-bottom:1px solid var(--hairline);display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap">' +
      '<div style="flex:1;min-width:220px">' +
        '<div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">' +
          '<b>' + esc(x.label || x.id) + '</b>' +
          '<span class="chip ' + tone + '">' + label + '</span>' +
          (x.hasKey ? '<span class="chip">有密钥</span>' : '<span class="chip warn">无密钥</span>') +
        '</div>' +
        '<div class="note mono" style="margin-top:3px">' + esc(x.baseUrl) + '</div>' +
        '<div class="note">默认模型：' + esc(x.model || '（未设）') +
        (x.models && x.models.length ? '　可用 ' + x.models.length + ' 个' : '') + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px">' +
        '<button class="act ghost sm" data-edit="' + esc(x.id) + '">编辑</button>' +
        '<button class="act ghost sm" data-del="' + esc(x.id) + '">删除</button>' +
      '</div>' +
    '</div>'
  }

  // ══ 组件（协议端 / 框架）══════════════════════════════════
  /**
   * 这一页管三件事：
   *   1. 运行模式切换（谁当机器人框架）
   *   2. 组件安装（NapCat / AstrBot），**下载前必须确认许可**
   *   3. 组件启停与日志
   *
   * 许可确认不是走过场：NapCat 的许可要求再分发时附全文并标注来源，
   * SnowLuma 更明确禁止自动化部署。所以 UI 上把许可摆在按钮前面。
   */
  function renderBackends(){
    setMain(loading('读取组件状态…'))
    Promise.all([api('/api/backends'), api('/api/modes')]).then(function(r){
      var b = r[0], m = r[1]
      var wrap = el('<div></div>')

      // ── 模式 ────────────────────────────────────────────────
      //
      // 选中态必须**立即**反映到界面上。之前点了模式要等 1.2 秒重渲染
      // 才变色，用户会以为没点上、又点一次。
      function paintModeChips(current) {
        ;[].forEach.call(wrap.querySelectorAll('.chip[data-mode]'), function(ch) {
          var on = ch.dataset.mode === current
          ch.className = 'chip click' + (on ? ' accent' : '')
          // dot 只在选中项前面出现（和其它 chip 的选中样式保持一致）
          var hasDot = ch.querySelector('.dot')
          if (on && !hasDot) ch.insertAdjacentHTML('afterbegin', '<i class="dot"></i>')
          if (!on && hasDot) hasDot.remove()
        })
      }
      var modeCards = (m.modes || []).map(function(mode){
        var on = mode.id === m.current
        // 未完善的模式在 chip 上就带个警示标记，不用点进去才知道
        var warn = mode.incomplete ? ' ⚠️' : ''
        return '<div class="chip click ' + (on ? 'accent' : '') + '" data-mode="' + esc(mode.id) + '" ' +
          'style="padding:6px 12px;font-size:13px">' +
          (on ? '<i class="dot"></i>' : '') + esc(mode.name) + warn + '</div>'
      }).join('')
      var cur = (m.modes || []).find(function(x){ return x.id === m.current }) || {}
      wrap.appendChild(card('shuffle', '运行模式', '<div class="chips">' + modeCards + '</div>' +
        // 当前模式本身未完善时，把说明放在最前面 —— 这是用户最需要先知道的
        (cur.incomplete
          ? '<div class="banner" style="margin:10px 0 0">⚠️ 当前模式未完善：' + esc(cur.incompleteNote || '') + '</div>'
          : '') +
        '<div class="note mt-sm">' + esc(cur.summary || '') + '</div>' +
        (cur.pros ? '<div class="note mt-sm"><b>优点</b>：' + cur.pros.map(esc).join('；') + '</div>' : '') +
        (cur.cons ? '<div class="note"><b>代价</b>：' + cur.cons.map(esc).join('；') + '</div>' : '') +
        (m.readiness && !m.readiness.ok
          ? '<div class="banner" style="margin:10px 0 0">还需要：' + m.readiness.missing.map(esc).join('、') + '</div>'
          : '') +
        '<div id="modemsg" class="note mt-sm"></div>'))

      // ── 组件列表 ────────────────────────────────────────────
      //
      // 传入当前模式，让"正在被这个模式使用"的组件在卡片上标出来 ——
      // 否则用户看到 NapCat 卡片上还有「启动」按钮，会以为它没在起作用。
      var list = el('<div class="grid mt"></div>')
      ;(b.backends || []).forEach(function(x){
        list.appendChild(backendCard(x, b, m))
      })
      wrap.appendChild(list)

      // ── 安装进度 ────────────────────────────────────────────
      if (b.installing) {
        wrap.appendChild(el('<div class="mt"></div>'))
        wrap.appendChild(card('clock', '正在安装：' + esc(b.installing), '<div id="progbox" class="log" style="max-height:32vh"></div>'))
      }

      setMain(wrap)

      // 组件操作按钮（事件委托，避免每个卡片挂一堆 handler）
      ;[].forEach.call(wrap.querySelectorAll('button[data-act]'), function(btn){
        btn.onclick = function(){
          var act = btn.dataset.act
          var id = btn.dataset.id
          if (act === 'install') return doInstall(id, btn)
          if (act === 'start') return doStart(id, btn)
          if (act === 'stop') return doStop(id, btn)
          // 日志：直接跳到日志页，并让日志页按这个组件名过滤。
          // （原来在卡片里内联展开，只能看 200 行、不能搜，实际很难用）
          if (act === 'log') return goLogsFiltered(btn.dataset.name || id)
          if (act === 'web') return openBackendWeb(id)
        }
      })

      // 模式切换
      ;[].forEach.call(wrap.querySelectorAll('.chip[data-mode]'), function(ch){
        ch.onclick = function(){
          var to = ch.dataset.mode
          if (to === m.current) return
          var msg = document.getElementById('modemsg')
          // 立刻高亮到新选择 —— 不等接口返回，用户马上看到"已选它"
          paintModeChips(to)
          msg.innerHTML = '<span class="note">切换中…</span>'
          // 先拿计划（不带 confirm），展示给用户
          api('/api/modes/switch', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: to }) }).then(async function(plan){
              if (plan.needConfirm) {
                var listHtml = '<ul>' + (plan.steps || []).map(function(s){
                  return '<li>' + esc(s) + '</li>'
                }).join('') + '</ul>'
                var okGo = await uiConfirm({
                  icon: 'shuffle',
                  title: '切换运行模式',
                  sub: '改为「' + to + '」',
                  body: listHtml +
                    (plan.warning ? '<div class="banner" style="margin:0">' + esc(plan.warning) + '</div>' : ''),
                  ok: '切换',
                })
                if (!okGo) {
                  // 用户取消 → 高亮回退到当前真实模式，别停在没生效的那个上
                  paintModeChips(m.current)
                  msg.textContent = ''
                  return null
                }
                return api('/api/modes/switch', { method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ mode: to, confirm: true }) })
              }
              return plan
            }).then(function(done){
              if (!done) return
              if (done.ok) {
                msg.innerHTML = '<span class="txt-ok">' + (done.done || []).map(esc).join('；') + '</span>' +
                  (done.restartHint ? '<br><span class="txt-warn">' + esc(done.restartHint) + '</span>' : '') +
                  (done.needRestart ? '<br>重启 WhalePod 后生效。' : '')
                m.current = to
                paintModeChips(to)
                setTimeout(renderBackends, 1200)
              } else {
                // 失败也要回退高亮，否则界面显示的和实际生效的不一致
                paintModeChips(m.current)
                msg.innerHTML = '<span class="txt-err">' + esc(done.error || '切换失败') + '</span>'
              }
            }).catch(function(e){
              paintModeChips(m.current)
              msg.innerHTML = '<span class="txt-err">' + esc(e.message) + '</span>'
            })
        }
      })

      // 进度轮询
      if (b.installing) {
        var box = document.getElementById('progbox')
        var timer = setInterval(function(){
          api('/api/backends/progress').then(function(pr){
            if (box) {
              box.innerHTML = (pr.log || []).map(function(l){
                return '<div class="ln"><span class="t">' +
                  new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false }) + '</span>' +
                  '<span class="m">' + esc(l.text) + '</span></div>'
              }).join('')
              box.scrollTop = box.scrollHeight
            }
            if (!pr.installing) {
              clearInterval(timer)
              if (pr.error) uiAlert({ icon: 'alert', title: '安装失败', body: esc(pr.error) })
              renderBackends()
            }
          }).catch(function(){ clearInterval(timer) })
        }, 1500)
        liveCleanup = function(){ clearInterval(timer) }
      }
    }).catch(function(e){ setMain(el(failure(e))) })
  }

  /**
   * 安装一个组件。
   *
   * ⚠️ 许可确认是**强制**的：NapCat 的许可要求再分发时附完整许可并标注来源，
   * SnowLuma 更明确禁止自动化部署。所以这里必须让用户先看到许可，
   * 显式勾选后才发 acceptLicense。
   */
  function doInstall(id, btn){
    btn.disabled = true
    api('/api/backends').then(async function(snap){
      var x = (snap.backends || []).find(function(v){ return v.id === id })
      if (!x) { btn.disabled = false; return }
      var lic = x.license || {}

      // 许可展示：用结构化排版，而不是一大坨换行拼接的纯文本 ——
      // 用户真的要读这个，而"商业用途/再分发"两栏是判断能不能用的关键，
      // 必须一眼看到。
      var body =
        '<ul style="margin-bottom:14px">' +
          '<li>从上游<b>官方渠道</b>下载，WhalePod 不修改、不再分发这些文件。</li>' +
          '<li>会写入 <code>' +
            (id === 'astrbot' ? '~/.whale-pod/runtime/' : '~/.whale-pod/protocol/' + id + '/') +
            '</code>。</li>' +
          '<li>下载后需遵守该项目许可与《QQ 用户协议》，<b>建议使用小号</b>。</li>' +
        '</ul>' +
        '<h4>许可：' + esc(lic.name) + (lic.spdx ? '（' + esc(lic.spdx) + '）' : '') + '</h4>' +
        '<div class="grid2">' +
          '<div class="feat"><b>商业用途</b><span style="color:' +
            (lic.commercialUse ? 'var(--ok)' : 'var(--err)') + '">' +
            (lic.commercialUse ? '允许' : '禁止') + '</span></div>' +
          '<div class="feat"><b>再分发</b><span style="color:' +
            (lic.redistributable ? 'var(--ok)' : 'var(--err)') + '">' +
            (lic.redistributable ? '允许（须附全文并标注来源）' : '禁止') + '</span></div>' +
        '</div>' +
        (lic.note ? '<div class="note" style="margin-bottom:14px">' + esc(lic.note) + '</div>' : '') +
        '<div class="note">许可全文：<a href="' + esc(lic.url || x.repo) +
          '" target="_blank" rel="noopener">' + esc(lic.url || x.repo) + '</a></div>'

      var ok = await uiConfirm({
        icon: 'box',
        title: '下载并安装 ' + x.name,
        sub: '请先阅读下面的许可与说明',
        body: body,
        ok: '我已阅读并同意，开始下载',
      })
      if (!ok) { btn.disabled = false; return }

      api('/api/backends/install', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: id, acceptLicense: true }),
      }).then(function(){
        renderBackends()
      }).catch(function(e){
        uiAlert({ icon: 'alert', title: '启动安装失败', body: esc(e.message) })
        btn.disabled = false
      })
    }).catch(function(e){ uiAlert({ icon: 'alert', title: '出错了', body: esc(e.message) }); btn.disabled = false })
  }

  function doStart(id, btn){
    btn.disabled = true
    btn.textContent = '启动中…'
    api('/api/backends/start', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: id }) })
      .then(function(r){
        // ⚠️ 要看返回值 —— 后端可能 ok:false（如"已在运行"）。
        //    以前直接重渲染，失败了也当成功，用户看不出区别。
        if (r && r.ok === false) {
          uiAlert({ icon: 'alert', title: '没能启动', body: esc(r.reason || r.error || '未知原因') })
        }
        setTimeout(renderBackends, 800)
      })
      .catch(function(e){
        uiAlert({ icon: 'alert', title: '启动失败', body: esc(e.message) })
        btn.disabled = false
        btn.textContent = '启动'
      })
  }

  function doStop(id, btn){
    btn.disabled = true
    btn.textContent = '停止中…'
    api('/api/backends/stop', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: id }) })
      .then(function(r){
        // ⚠️ 同 doStart：必须看返回值。
        //    以前这里无视返回，后端回 {ok:false, reason:'未在运行'} 时
        //    界面照样重渲染 —— 状态没变，看起来就是"点了停止没反应"（实测反馈过）。
        if (r && r.ok === false) {
          uiAlert({
            icon: 'alert',
            title: '没能停止',
            body: esc(r.reason || r.error || '未知原因') +
              '<br><br>提示：如果它是你手动启动的，关掉它的窗口即可。',
          })
        }
        setTimeout(renderBackends, 900)
      })
      .catch(function(e){
        uiAlert({ icon: 'alert', title: '停止失败', body: esc(e.message) })
        btn.disabled = false
        btn.textContent = '停止'
      })
  }

  /**
   * 内置打开协议端的管理界面。
   *
   * 为什么用内嵌 iframe 而不是新开标签页：
   *   · 不用离开 WhalePod，看完设置回来接着调
   *   · token 可以自动带上（新窗口打开的话用户还得自己复制粘贴）
   *
   * ⚠️ 有些界面会设 X-Frame-Options: DENY，iframe 会白屏。
   *    所以面板顶部始终给一个「新窗口打开」的链接做退路，
   *    并说明"如果这里是空白，说明对方不允许被嵌入"。
   */
  function openBackendWeb(id){
    api('/api/backends').then(function(snap){
      var x = (snap.backends || []).find(function(v){ return v.id === id })
      if (!x) return
      var w = x.web || {}
      var base = w.url || x.webUrl
      if (!base) return uiAlert({ icon: 'info', title: '没有管理界面', body: '这个组件没有自己的 Web 管理页。' })

      // 带上 token 自动登录（NapCat 支持 ?token=xxx）
      var full = w.token
        ? base + (base.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(w.token)
        : base

      var overlay = el('<div class="webwrap">' +
        '<div class="webhd">' +
          '<span class="ico">' + svgIcon('home', 16) + '</span>' +
          '<b>' + esc(x.name) + ' 管理界面</b>' +
          '<span class="note mono" style="margin-left:8px">' + esc(base) + '</span>' +
          (w.token ? '<span class="chip on" style="margin-left:8px"><i class="dot"></i>已带上 token</span>' : '') +
          '<span style="margin-left:auto"></span>' +
          '<button class="act ghost sm" id="webreload">刷新</button>' +
          '<a class="act ghost sm" style="text-decoration:none;margin-left:6px" href="' + esc(full) +
            '" target="_blank" rel="noopener">新窗口打开</a>' +
          '<button class="act ghost sm" id="webclose" style="margin-left:6px">关闭</button>' +
        '</div>' +
        '<div class="webnote note">如果下面一片空白，说明这个界面不允许被嵌入（X-Frame-Options）。' +
          '点右上角「新窗口打开」即可。</div>' +
        '<div class="webbody"><iframe id="webframe" src="' + esc(full) + '" referrerpolicy="no-referrer"></iframe></div>' +
        '</div>')
      document.body.appendChild(overlay)

      function close(){ try { overlay.remove() } catch(_){} }
      overlay.querySelector('#webclose').onclick = close
      overlay.querySelector('#webreload').onclick = function(){
        var f = overlay.querySelector('#webframe')
        if (f) f.src = full
      }
      // Esc 关闭
      overlay.onkeydown = function(e){ if (e.key === 'Escape') close() }
      try { overlay.tabIndex = -1; overlay.focus() } catch(_){}
    }).catch(function(e){ uiAlert({ icon: 'alert', title: '打不开', body: esc(e.message) }) })
  }

  function toggleLog(id, wrap, btn){
    var box = wrap.querySelector('[data-log="' + id + '"]')
    if (!box) return
    if (!box.classList.contains('hide')) { box.classList.add('hide'); return }
    box.classList.remove('hide')
    box.innerHTML = '<div class="spinner"></div>'
    api('/api/backends/logs?id=' + encodeURIComponent(id) + '&n=200').then(function(r){
      var lines = r.lines || []
      box.innerHTML = lines.length
        ? lines.map(function(l){
            return '<div class="ln l-' + (l.stream === 'err' ? 'error' : 'info') + '">' +
              '<span class="t">' + new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false }) + '</span>' +
              '<span class="m">' + esc(l.text) + '</span></div>'
          }).join('')
        : '<div class="empty">暂无日志</div>'
    }).catch(function(e){ box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>' })
  }

  /** 单个组件卡片。 */
  function backendCard(x, snap, modes){
    // 这个组件是不是"当前模式正在用的"？
    //   whale-pod 模式：NapCat 是协议端（在用）
    //   astrbot  模式：NapCat 是协议端、AstrBot 是框架（都在用）
    // 用来在卡片上标「当前模式在用」，避免用户以为还得手动启用。
    var curMode = modes && modes.current
    var inUse = false
    if (curMode === 'astrbot') inUse = (x.kind === 'protocol' || x.id === 'astrbot')
    else if (curMode === 'whale-pod') inUse = (x.kind === 'protocol')
    else inUse = x.running

    var tags = [
      x.running ? '<span class="chip on"><i class="dot"></i>运行中</span>'
        : (x.installed ? '<span class="chip">已安装</span>' : '<span class="chip off">未安装</span>'),
      x.kind === 'protocol' ? '<span class="chip">协议端</span>' : '<span class="chip">框架</span>',
      // 当前模式在用 → 明确标出来
      (inUse && x.installed ? '<span class="chip accent">当前模式在用</span>' : ''),
      x.autoInstallable ? '<span class="chip accent">可自动安装</span>' : '<span class="chip warn">需手动安装</span>',
    ].filter(Boolean).join('')

    var body = '<div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:8px">' +
      tags + (x.version ? '<span class="chip">' + esc(x.version) + '</span>' : '') + '</div>' +
      '<div class="note">' + esc(x.summary) + '</div>' +
      // 运行实况：让用户看清"后台到底在跑什么、是谁启动的"。
      // 不是我们启动的进程，supervisor 拿不到 pid —— 这里用反查到的进程列表补上。
      (x.running ? '<div class="mt-sm">' + kvRows(
        x.managed
          ? [['运行方式', '由 WhalePod 托管（点「停止」可直接停掉）']]
          : [['运行方式', '不是 WhalePod 启动的', 'txt-warn'],
             ['进程', x.processCount ? (x.processCount + ' 个' + (x.memBytes ? ' · ' + Math.round(x.memBytes / 1048576) + ' MB' : '')) : '—'],
             ['说明', '点「停止」会按进程特征结束它']]
      ) + '</div>' : '') +
      '<div class="mt-sm">' + kvRows([
        ['许可', x.license.name + (x.license.spdx ? '（' + x.license.spdx + '）' : '')],
        ['商业用途', x.license.commercialUse ? '允许' : '禁止', x.license.commercialUse ? '' : 'txt-warn'],
        ['再分发', x.license.redistributable ? '允许' : '禁止', x.license.redistributable ? '' : 'txt-err'],
      ]) + '</div>' +
      (x.manualReason ? '<div class="banner" style="margin:10px 0 0">' + esc(x.manualReason) + '</div>' : '')

    var btns = []
    if (x.autoInstallable && !x.installed) {
      btns.push('<button class="act" data-act="install" data-id="' + esc(x.id) + '">下载并安装</button>')
    }
    // 已装且没在跑 → 给启动按钮（协议端和框架都能启动）
    if (x.installed && !x.running && x.autoInstallable && x.exe) {
      btns.push('<button class="act" data-act="start" data-id="' + esc(x.id) + '">启动</button>')
    }
    if (x.running) {
      btns.push('<button class="act ghost" data-act="stop" data-id="' + esc(x.id) + '">停止</button>')
    }
    // 日志：**跳到日志页并按这个组件过滤**，而不是在卡片里展开一小块。
    // 原来那种内联展开只能看 200 行、不能搜、也不能滚动回看，实际很难用。
    if (x.installed) {
      btns.push('<button class="act ghost" data-act="log" data-id="' + esc(x.id) +
        '" data-name="' + esc(x.name) + '">' +
        svgIcon('filetext', 13) + '<span>日志</span></button>')
    }
    // 打开管理界面（协议端/框架自己的 WebUI，如 NapCat 的 6099）。
    // 默认**内置打开**（标签页里嵌一个 iframe），带 token 自动登录；
    // 嵌不进去时（对方设了 X-Frame-Options）页面上有"新窗口打开"的退路。
    if (x.webUrl) {
      btns.push('<button class="act ghost" data-act="web" data-id="' + esc(x.id) +
        '" data-name="' + esc(x.name) + '" title="内置打开它的管理界面">' +
        svgIcon('home', 13) + '<span>主页</span></button>')
    }
    // 仓库 + 许可：窄图标按钮（文案放 title，悬浮可见），省掉两个长文字按钮
    btns.push('<a class="act ghost icon-only" style="text-decoration:none" href="' + esc(x.repo) +
      '" target="_blank" rel="noopener" title="打开仓库：' + esc(x.repo) + '">' +
      svgIcon('github', 14) + '</a>')
    if (x.autoInstallable && x.license?.url) {
      btns.push('<a class="act ghost icon-only" style="text-decoration:none" href="' + esc(x.license.url) +
        '" target="_blank" rel="noopener" title="读许可：' + esc(x.license.name) + '">' +
        svgIcon('book', 14) + '</a>')
    }

    // 卡片右上角：进程实况。
    // ⚠️ 进程**不是我们启动的**时，supervisor 给不出 pid ——
    //    那时也照样要显示（用反查到的进程信息），否则界面上只有
    //    一个"运行中"，用户完全看不到后台情况（实测反馈过）。
    var right = ''
    if (x.running) {
      var memTxt = x.memBytes ? ' · ' + Math.round(x.memBytes / 1048576) + ' MB' : ''
      var cnt = (x.processCount && x.processCount > 1) ? ' · ' + x.processCount + ' 个进程' : ''
      if (x.pid) {
        right = '<span class="note mono" style="margin-left:auto" title="' +
          (x.managed ? '由 WhalePod 启动，点「停止」可以直接停掉' : '不是 WhalePod 启动的') + '">' +
          'pid ' + x.pid + memTxt + '</span>'
      } else {
        right = '<span class="note mono" style="margin-left:auto">' +
          '运行中' + cnt + memTxt + '</span>'
      }
    }

    var c = card(x.kind === 'protocol' ? 'plug' : 'cpu', x.name, body, { right: right })
    c.appendChild(el('<div class="ft">' + btns.join('') + '</div>' + '<div class="log hide" data-log="' + esc(x.id) + '"></div>'))
    return c
  }

  function renderDecision(){
    setMain(loading('探测决策提供者…'))
    api('/api/decision/probe').then(function(r){
      var wrap = el('<div></div>')
      wrap.appendChild(card('layers', '决策提供者', '<div class="chips">' +
        (r.providers || []).map(function(p){
          return '<span class="chip ' + (p.ok ? 'on' : 'off') + '" title="' + esc(p.detail) + '">' +
            (p.ok ? '<i class="dot"></i>' : '') + esc(p.id) + '</span>'
        }).join('') + '</div>' +
        '<div class="note mt-sm">当前生效：<b>' + esc(r.active || '-') + '</b>' +
        '（按顺序尝试，失败自动降级到内置规则）</div>'))

      // 试判断表单
      var form = el('<div class="card mt"><div class="hd"><span class="ico">' + svgIcon('flask', 16) + '</span>' +
        '<h2>试一下（不会真的发消息）</h2></div><div class="bd">' +
        '<div class="row">' +
          '<div class="field" style="flex:2 1 240px"><label>消息内容</label>' +
            '<input id="dtext" value="在吗"></div>' +
          '<div class="field"><label>场景</label>' +
            '<select id="dscene"><option value="group">群聊</option><option value="private">私聊</option></select></div>' +
        '</div>' +
        '<div class="row mt-sm">' +
          '<div class="field"><label>距我上次发言（秒）</label>' +
            '<input id="dsince" type="number" value="60"></div>' +
          '<div class="field"><label>我已连续发言（轮）</label>' +
            '<input id="dturns" type="number" value="0"></div>' +
        '</div>' +
        '<div class="row check mt-sm"><label><input type="checkbox" id="dmention"> 这条 @ 了我</label></div>' +
        '<div class="mt-sm" style="display:flex;gap:8px">' +
          '<button class="act" id="dgo">判断</button>' +
          '<button class="act ghost" id="dgo2">被 @ 时判断</button>' +
        '</div>' +
        '<div id="dout" class="mt"></div>' +
        '</div></div>')
      wrap.appendChild(form)

      function run(forceMention){
        var mention = forceMention ? true : document.getElementById('dmention').checked
        var out = document.getElementById('dout')
        out.innerHTML = '<div class="spinner"></div>'
        api('/api/decision/test', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: document.getElementById('dtext').value,
            scene: { kind: document.getElementById('dscene').value, groupId: '0' },
            mentionsMe: mention,
            sinceMyLastMessage: Number(document.getElementById('dsince').value) * 1000,
            consecutiveTurns: Number(document.getElementById('dturns').value),
          }),
        }).then(function(d){
          // 显示要分清两种语义，否则会出现「意愿 0.8 … 却沉默」这种
          // 看着像坏了的组合（用户反馈过）：
          //   rule 这类"已决"提供者：probability 是**回复意愿**，
          //     最终结果由它自己掷骰子定 —— 意愿高也可能这次不中。
          //   其他（jev/custom）：probability 是**软概率**，外层阈值拿它筛。
          var pct = d.probability == null ? null : Math.round(d.probability * 100)
          var decided = d.decided === true
          var pLabel = pct == null ? ''
            : decided
              ? '　回复意愿 ' + pct + '%（随机判定：' + (d.reply ? '命中' : '未命中') + '）'
              : '　置信度 ' + pct + '%（阈值 ' + (d.threshold ?? '-') + '）'
          out.innerHTML =
            '<div class="banner ' + (d.reply ? 'ok' : '') + '" style="margin:0">' +
              '<b>' + (d.reply ? svgIcon('check',15) + ' 会发言' : svgIcon('x',15) + ' 不会发言') + '</b>' +
              pLabel +
              (d.delayMs ? '　延迟 ' + d.delayMs + 'ms' : '') +
              '<br><span style="opacity:.85">' + esc(d.provider || '') +
              (d.reason ? ' · ' + esc(d.reason) : '') + '</span>' +
            '</div>' +
            // 说清"意愿 ≠ 结果"，免得用户以为阈值没生效
            (decided && pct != null
              ? '<div class="note mt-sm">这个提供者自己掷骰子做最终判断：' +
                '「回复意愿 ' + pct + '%」表示本次有 ' + pct + '% 的概率接话，' +
                '掷骰子没中就沉默 —— 所以意愿高也可能这次不回（保留真人那种随机感）。' +
                '阈值只对返回软概率的提供者（jev / custom）生效。</div>'
              : '') +
            '<pre class="mt-sm" style="max-height:22vh">' + esc(JSON.stringify(d, null, 2)) + '</pre>'
        }).catch(function(e){ out.innerHTML = failure(e) })
      }
      wrap.appendChild(form)
      setMain(wrap)
      form.querySelector('#dgo').onclick = function(){ run(false) }
      form.querySelector('#dgo2').onclick = function(){ run(true) }
    }).catch(function(e){ setMain(el(failure(e))) })
  }

  // ══ 人格 ══════════════════════════════════════════════════
  function renderPersona(){
    setMain(loading('读取人格…'))
    api('/api/persona').then(function(p){
      var wrap = el('<div></div>')
      var chips = (p.roles || []).map(function(r){
        return '<span class="chip click ' + (r === p.current ? 'accent' : '') + '" data-role="' + esc(r) + '">' + esc(r) + '</span>'
      }).join('')
      wrap.appendChild(card('smile', '角色', '<div class="chips">' + (chips || '<span class="note">无</span>') + '</div>' +
        '<div class="note mt-sm">当前生效：<b id="pcur">' + esc(p.active) + '</b>　' +
        '目录：<span class="mono">' + esc(p.dir) + '</span></div>'))

      var edit = el('<div class="card mt"><div class="hd"><span class="ico">' + svgIcon('edit', 16) + '</span>' +
        '<h2>编辑「<span id="pname">' + esc(p.current) + '</span>」</h2>' +
        '<span class="spacer" style="margin-left:auto"></span>' +
        '<button class="act ghost sm" id="pnew">新建</button></div>' +
        '<div class="bd">' +
        '<textarea id="ptext" style="min-height:360px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px">' +
          esc(p.content) + '</textarea>' +
        '<div class="note mt-sm">写具体的说话习惯，别写形容词。「偶尔只发个草」比「你很幽默」有用得多。</div>' +
        '<div class="mt-sm" style="display:flex;gap:8px;align-items:center">' +
          '<button class="act" id="psave">保存</button>' +
          '<button class="act ghost" id="pactive">设为当前角色</button>' +
          '<span class="note" id="pmsg"></span>' +
        '</div></div></div>')
      wrap.appendChild(edit)
      setMain(wrap)

      var curRole = p.current
      function loadRole(name){
        api('/api/persona?name=' + encodeURIComponent(name)).then(function(x){
          curRole = name
          document.getElementById('ptext').value = x.content
          document.getElementById('pname').textContent = name
          // ⚠️ 行首分号不能省：下一行以 [ 开头，ASI 会粘成 name[].forEach
          ;[].forEach.call(wrap.querySelectorAll('.chip[data-role]'), function(ch){
            ch.className = 'chip click ' + (ch.dataset.role === name ? 'accent' : '')
          })
          document.getElementById('pmsg').textContent = ''
        }).catch(function(e){ document.getElementById('pmsg').innerHTML = svgIcon('alert',14) + ' ' + esc(e.message) })
      }
      ;[].forEach.call(wrap.querySelectorAll('.chip[data-role]'), function(ch){
        ch.onclick = function(){ loadRole(ch.dataset.role) }
      })
      document.getElementById('psave').onclick = function(){
        var m = document.getElementById('pmsg'); m.textContent = '保存中…'
        api('/api/persona', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: curRole, content: document.getElementById('ptext').value }) })
          .then(function(){ m.innerHTML = '<span class="txt-ok">已保存</span>' })
          .catch(function(e){ m.innerHTML = '<span class="txt-err">' + esc(e.message) + '</span>' })
      }
      document.getElementById('pactive').onclick = function(){
        var m = document.getElementById('pmsg'); m.textContent = '切换中…'
        api('/api/persona', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ active: curRole }) })
          .then(function(){
            m.innerHTML = '<span class="txt-ok">当前角色已切换</span>'
            document.getElementById('pcur').textContent = curRole
          })
          .catch(function(e){ m.innerHTML = '<span class="txt-err">' + esc(e.message) + '</span>' })
      }
      document.getElementById('pnew').onclick = async function(){
        var name = await uiPrompt({
          icon: 'smile',
          title: '新建角色',
          sub: '会给这个角色生成一份提示词模板',
          placeholder: '例如：anime-fan',
          hint: '建议用英文或拼音做文件名；中文也可以，但别带空格。',
          ok: '创建',
        })
        if (!name) return
        if (/\s/.test(name)) {
          uiAlert({ icon: 'alert', title: '名字不能有空格', body: '请换一个不带空格的名字。' })
          return
        }
        writeNew(name)
      }
      function writeNew(name){
        api('/api/persona', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: name, content: '# 角色：' + name + '\\n\\n（在这里写说话方式）\\n' }) })
          .then(function(){ renderPersona() })
          .catch(function(e){ uiAlert({ icon: 'alert', title: '创建失败', body: esc(e.message) }) })
      }
    }).catch(function(e){ setMain(el(failure(e))) })
  }

  // ══ 记忆 ══════════════════════════════════════════════════
  function renderMemory(){
    setMain(loading('读取记忆…'))
    api('/api/memory').then(function(m){
      var wrap = el('<div></div>')
      var s = m.short || {}, l = m.long || {}
      wrap.appendChild(el(metrics([
        { label: '活跃会话', value: s.sessions || 0, tone: 'accent' },
        { label: '消息总数', value: s.totalMessages || 0 },
        { label: '长期摘要', value: l.withSummary || 0, unit: '个会话' },
        { label: '摘要字数', value: l.totalChars || 0 },
      ])))

      var scopes = m.scopes || []
      wrap.appendChild(el('<div class="mt"></div>'))
      var sessionBody = scopes.length
        ? '<div class="chips">' + scopes.map(function(x){
            return '<span class="chip click" data-scope="' + esc(x) + '">' + esc(x) + '</span>'
          }).join('') + '</div><div id="mout" class="mt-sm"></div>'
        : '<div class="empty"><span class="big">' + svgIcon('database', 30) + '</span>还没有会话记忆<br>' +
          '<span class="note">QQ 机器人收到消息后会在这里建立会话</span></div>'
      wrap.appendChild(card('book', '会话', sessionBody, { tight: false }))

      wrap.appendChild(el('<div class="mt-sm" style="display:flex;gap:8px">' +
        '<button class="act ghost danger" id="mclr">清空全部记忆</button></div>'))

      setMain(wrap)
      var out = wrap.querySelector('#mout')
      ;[].forEach.call(wrap.querySelectorAll('.chip[data-scope]'), function(ch){
        ch.onclick = function(){
          out.innerHTML = '<div class="spinner"></div>'
          api('/api/memory/scope?scope=' + encodeURIComponent(ch.dataset.scope)).then(function(d){
            var lines = []
            lines.push('（连续发言 ' + d.consecutiveTurns + ' 轮，距上次 ' +
              (d.sinceMyLastMs == null ? '-' : Math.round(d.sinceMyLastMs / 1000) + 's') + '）')
            if (d.summary) { lines.push(''); lines.push('【长期摘要】'); lines.push(d.summary) }
            lines.push(''); lines.push('【最近消息】')
            ;(d.messages || []).forEach(function(x){
              lines.push((x.isMe ? '[我] ' : x.senderName + ': ') + x.text)
            })
            out.innerHTML = '<pre style="max-height:34vh">' + esc(lines.join('\\n')) + '</pre>'
          }).catch(function(e){ out.innerHTML = failure(e) })
        }
      })
      wrap.querySelector('#mclr').onclick = async function(){
        var ok = await uiConfirm({
          icon: 'broom',
          title: '清空全部记忆',
          body: '会删除所有会话的短期上下文<b>和长期摘要</b>。<br>' +
            '<span class="note">此操作不可撤销。机器人会「忘掉」之前聊过的内容。</span>',
          ok: '清空', danger: true,
        })
        if (!ok) return
        api('/api/memory', { method: 'DELETE' }).then(renderMemory)
      }
    }).catch(function(e){ setMain(el(failure(e))) })
  }

  // ══ 日志 ══════════════════════════════════════════════════
  /**
   * 跳到日志页并按关键词过滤。
   *
   * 组件卡片的「日志」按钮用它 —— 点了直接看到该组件的日志，
   * 而不是在卡片里挤一小块（那样只有 200 行、不能搜、不能回看）。
   */
  var pendingLogFilter = null
  function goLogsFiltered(kw){
    pendingLogFilter = String(kw || '')
    if (cur === 'log') { render(); return }
    go('log')
  }

  function renderLogs(){
    var box = el('<div class="card"><div class="hd"><span class="ico">' + svgIcon('filetext', 16) + '</span><h2>实时日志</h2>' +
      '<span class="spacer" style="margin-left:auto"></span>' +
      '<input id="lfilter" class="lfilter" placeholder="过滤关键词（组件名 / 渠道 / ERROR）" value="' +
        esc(pendingLogFilter || '') + '">' +
      '<span class="chip on" id="lstat" style="margin-left:8px"><i class="dot"></i>已连接</span>' +
      '<button class="act ghost sm" id="lpause" style="margin-left:8px">暂停</button>' +
      '<button class="act ghost sm" id="lclear" style="margin-left:6px">清屏</button>' +
      '</div><div class="bd tight"><div class="log" id="logbox"></div></div></div>')
    setMain(box)
    var logbox = box.querySelector('#logbox')
    var filtInput = box.querySelector('#lfilter')
    var paused = false
    var buf = []
    /** 当前过滤词（小写）。空串 = 不过滤。 */
    var filt = String(pendingLogFilter || '').toLowerCase()

    function matches(e){
      if (!filt) return true
      return (String(e.msg || '') + ' ' + String(e.level || '')).toLowerCase().indexOf(filt) >= 0
    }
    function line(e){
      if (!matches(e)) return
      var d = document.createElement('div')
      d.className = 'ln l-' + e.level
      d.innerHTML = '<span class="t">' + new Date(e.t).toLocaleTimeString('zh-CN', { hour12: false }) + '</span>' +
        '<span class="lv">' + esc(e.level.toUpperCase()) + '</span>' +
        '<span class="m">' + esc(e.msg) + '</span>'
      logbox.appendChild(d)
      while (logbox.children.length > 800) logbox.removeChild(logbox.firstChild)
      logbox.scrollTop = logbox.scrollHeight
    }
    /** 改过滤词后重画：历史日志要重新拉一次（按新条件筛）。 */
    function repaint(){
      logbox.innerHTML = ''
      api('/api/logs?n=600').then(function(r){
        (r.entries || []).forEach(line)
        if (!logbox.children.length) {
          logbox.innerHTML = '<div class="empty">' + (filt ? '没有匹配「' + esc(filt) + '」的日志' : '暂无日志') + '</div>'
        }
      }).catch(function(){})
    }

    api('/api/logs?n=300').then(function(r){
      (r.entries || []).forEach(line)
      if (!logbox.children.length) logbox.innerHTML = '<div class="empty">' + (filt ? '没有匹配「' + esc(filt) + '」的日志' : '暂无日志') + '</div>'
    }).catch(function(){})
    var es = new EventSource('/api/logs/stream' + (token ? '?token=' + encodeURIComponent(token) : ''))
    es.onmessage = function(ev){
      var e
      try { e = JSON.parse(ev.data) } catch(_) { return }
      if (paused) { buf.push(e); return }
      line(e)
    }
    es.onerror = function(){
      var s = box.querySelector('#lstat')
      if (s) { s.className = 'chip off'; s.innerHTML = '断线重连中' }
    }
    es.onopen = function(){
      var s = box.querySelector('#lstat')
      if (s) { s.className = 'chip on'; s.innerHTML = '<i class="dot"></i>已连接' }
    }
    filtInput.oninput = function(){
      filt = this.value.trim().toLowerCase()
      pendingLogFilter = this.value.trim()
      repaint()
    }
    box.querySelector('#lpause').onclick = function(){
      paused = !paused
      this.textContent = paused ? '继续' : '暂停'
      if (!paused && buf.length) { buf.forEach(line); buf = [] }
    }
    box.querySelector('#lclear').onclick = function(){ logbox.innerHTML = '' }

    liveCleanup = function(){ try { es.close() } catch(_){} }
  }

  // ══ 配置 ══════════════════════════════════════════════════
  function renderConfig(){
    setMain(loading('读取配置…'))
    api('/api/config').then(function(c){
      var wrap = el('<div></div>')
      wrap.appendChild(el('<div class="banner">' +
        '<b>配置文件</b>：<code>~/.whale-pod/config.json</code>（改完重启 WhalePod 生效）<br>' +
        '界面里只读展示（密钥已脱敏），避免误改导致起不来。' +
        '</div>'))
      wrap.appendChild(card('sliders', '当前配置',
        '<pre style="max-height:60vh">' + esc(JSON.stringify(c, null, 2)) + '</pre>'))
      setMain(wrap)
    }).catch(function(e){ setMain(el(failure(e))) })
  }

  render()
})()
`
