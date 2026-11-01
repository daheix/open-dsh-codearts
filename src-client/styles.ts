/**
 * 码道（codearts）控制台样式 —— 白色系高对比主题（2026-11-01 用户实测裁决）。
 *
 * 教训：dsw 令牌在宿主深色主题下解析出的文字色对比度不足（看不清）。本页面改为
 * **自带深色面板**（rgba(20,20,24,.92) 级）+ 固定白色系文字（主 #ffffff / 次级
 * #cfcfcf / 弱化 #9a9a9a），边框 #3a3a40，不再依赖 dsw 令牌做文字色——任何宿主
 * 主题下对比度恒定。状态色用高对比亮色（绿 #4ade80 / 红 #f87171 / 琥珀 #fbbf24 /
 * 蓝 #60a5fa）。前缀 dshca- 统一命名。
 */

export const PANEL_STYLES = `
.dshca-page{display:flex;flex-direction:column;height:100%;min-height:520px;max-width:1400px;padding:12px 16px 20px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;font-size:13px;line-height:1.55;color:#ffffff;background:rgba(20,20,24,.92);border:1px solid #3a3a40;border-radius:10px;box-sizing:border-box;gap:10px}
.dshca-page h1{font-size:15px;margin:0;display:flex;align-items:center;gap:8px;color:#ffffff}
.dshca-sub{color:#9a9a9a;font-size:12px;margin:0}
.dshca-section{border:1px solid #3a3a40;border-radius:10px;background:rgba(30,30,36,.92);padding:10px 12px}
.dshca-h2{font-size:13px;font-weight:700;margin:0 0 8px;display:flex;align-items:center;gap:8px;color:#ffffff}
.dshca-h2 .dshca-h2note{font-weight:400;color:#9a9a9a;font-size:11px}
.dshca-errbar{display:flex;gap:8px;align-items:flex-start;border:1px solid #f87171;border-radius:8px;background:rgba(248,113,113,.12);color:#f87171;padding:6px 10px;font-size:12px;margin-bottom:8px;word-break:break-all}
.dshca-note{font-size:12px;color:#cfcfcf;min-height:16px;margin-top:6px;word-break:break-all}
.dshca-note-ok{color:#4ade80}
.dshca-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.dshca-proc{border:1px solid #3a3a40;border-radius:8px;padding:6px 10px;min-width:210px;background:rgba(20,20,24,.92)}
.dshca-proc b{font-size:12px;color:#ffffff}
.dshca-proc .dshca-dim{color:#9a9a9a;font-size:11px;margin-top:2px;word-break:break-all}
.dshca-badge{display:inline-block;font-size:11px;padding:1px 8px;border-radius:99px;background:rgba(255,255,255,.08);color:#cfcfcf;font-weight:600;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
.dshca-badge-ok{background:rgba(74,222,128,.16);color:#4ade80}
.dshca-badge-warn{background:rgba(251,191,36,.16);color:#fbbf24}
.dshca-badge-err{background:rgba(248,113,113,.16);color:#f87171}
.dshca-badge-cur{background:rgba(96,165,250,.18);color:#60a5fa}
.dshca-btn{border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;color:#ffffff;background:#2563eb}
.dshca-btn:hover{background:#1d4ed8}
.dshca-btn:disabled{opacity:.45;cursor:default}
.dshca-btn-ghost{border:1px solid #3a3a40;background:transparent;color:#e5e5e5;cursor:pointer;border-radius:8px;padding:5px 10px;font-size:12px}
.dshca-btn-ghost:hover{background:rgba(255,255,255,.08)}
.dshca-btn-ghost:disabled{opacity:.45;cursor:default}
.dshca-btn-danger{border:1px solid rgba(248,113,113,.55);background:transparent;color:#f87171;cursor:pointer;border-radius:8px;padding:5px 10px;font-size:12px}
.dshca-btn-danger:hover{background:rgba(248,113,113,.1)}
.dshca-btn-danger:disabled{opacity:.45;cursor:default}
.dshca-input{border:1px solid #3a3a40;border-radius:8px;padding:6px 9px;font-size:12px;background:rgba(20,20,24,.92);color:#ffffff;min-width:0}
.dshca-input::placeholder{color:#9a9a9a}
.dshca-input:focus{outline:1px solid #60a5fa}
.dshca-form{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px;padding-top:8px;border-top:1px dashed #3a3a40}
.dshca-empty{color:#9a9a9a;font-size:12px;padding:4px 0}
.dshca-spin{display:inline-block;animation:dshca-spin 0.9s linear infinite}
@keyframes dshca-spin{to{transform:rotate(360deg)}}

/* ---------- Tab 导航（Tab 化改版：TUI 终端独占整页，其余分页完整展示） ---------- */
.dshca-tabs{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid #3a3a40;flex:none}
.dshca-tab{border:none;background:transparent;color:#cfcfcf;font:inherit;font-size:13px;font-weight:600;cursor:pointer;padding:7px 14px;border-radius:8px 8px 0 0;border-bottom:2px solid transparent}
.dshca-tab:hover{background:rgba(255,255,255,.06);color:#ffffff}
.dshca-tab-active{color:#ffffff;background:rgba(96,165,250,.1);border-bottom:2px solid #60a5fa}
.dshca-section{flex:none}
.dshca-termspan{flex:1 !important;min-height:calc(42 * 18px + 24px) !important;height:calc(42 * 18px + 24px)}

/* ---------- ③ 交互流主窗口（核心） ---------- */
.dshca-timeline{flex:1 1 auto;min-height:260px;display:flex;flex-direction:column;border:1px solid #3a3a40;border-radius:10px;background:rgba(24,24,28,.95);overflow:hidden}
.dshca-tlhead{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid #3a3a40;font-size:12px;color:#cfcfcf;flex:none}
.dshca-tlhead .dshca-tltitle{font-weight:700;color:#ffffff}
.dshca-tlscroll{flex:1;min-height:0;overflow-y:auto;padding:8px 12px;display:flex;flex-direction:column;gap:6px}
.dshca-item{border-radius:8px;padding:6px 10px;font-size:12.5px;word-break:break-all;white-space:pre-wrap}
.dshca-item .dshca-itemtime{font-size:10.5px;color:#9a9a9a;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin-right:8px}
.dshca-item-user{border-left:3px solid #60a5fa;background:rgba(96,165,250,.08);color:#e8f0fe}
.dshca-item-assistant{background:rgba(255,255,255,.06);color:#f0f0f0;border:1px solid #3a3a40}
.dshca-item-tool{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:#bdbdbd;background:transparent;border:1px dashed #3a3a40;padding:3px 10px}
.dshca-item-error{background:rgba(248,113,113,.12);color:#f87171;border:1px solid rgba(248,113,113,.4)}
.dshca-item-system{color:#9a9a9a;font-size:11.5px;background:transparent}
.dshca-tlend{color:#9a9a9a;font-size:11px;text-align:center;padding:6px 0 2px}

/* ---------- 原始日志（降级为可折叠次级区块，默认收起） ---------- */
.dshca-logwrap{margin-top:0}
.dshca-loghead{display:flex;align-items:center;gap:10px;margin-bottom:6px;font-size:12px;color:#cfcfcf}
.dshca-log{margin:0;height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.5;background:rgba(16,16,20,.95);border:1px solid #3a3a40;border-radius:8px;padding:8px 10px;color:#cfcfcf}

/* ---------- ④ 模型单选卡片列表 ---------- */
.dshca-mrow{display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid #3a3a40;border-radius:8px;margin-bottom:6px;cursor:pointer;user-select:none;background:rgba(24,24,28,.9)}
.dshca-mrow:hover{border-color:#60a5fa;background:rgba(96,165,250,.06)}
.dshca-mrow-cur{border-color:#4ade80;background:rgba(74,222,128,.07)}
.dshca-mrow-ok{border-color:#4ade80;background:rgba(74,222,128,.14)}
.dshca-mrow-busy{opacity:.6;cursor:wait}
.dshca-mid{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ffffff}
.dshca-msrc{font-size:10px;color:#9a9a9a;flex:none}
.dshca-mgroup{font-size:11px;font-weight:700;color:#9a9a9a;margin:10px 0 4px;letter-spacing:.5px}
.dshca-mcheck{color:#4ade80;font-weight:700;flex:none}
.dshca-merr{color:#f87171;font-size:11px;flex-basis:100%;word-break:break-all;padding-left:2px}

/* ---------- 目标管理 ---------- */
.dshca-gcard{border:1px solid #3a3a40;border-radius:8px;margin-bottom:8px;background:rgba(24,24,28,.9)}
.dshca-ghead{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;user-select:none;border-radius:8px}
.dshca-ghead:hover{background:rgba(255,255,255,.05)}
.dshca-gobj{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:12px;color:#ffffff}
.dshca-gmeta{font-size:11px;color:#9a9a9a;flex:none}
.dshca-gdetail{border-top:1px dashed #3a3a40;padding:8px 12px 10px;font-size:12px}
.dshca-gdetail dl{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:6px 0}
.dshca-gdetail dt{color:#9a9a9a}
.dshca-gdetail dd{margin:0;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:#e5e5e5}
.dshca-gerr{color:#f87171;word-break:break-all;font-size:11px;margin-top:4px}
.dshca-stats{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.dshca-stat{font-size:11px;border:1px solid #3a3a40;border-radius:6px;padding:2px 7px;color:#9a9a9a}
.dshca-stat b{color:#ffffff}

/* ---------- legacy DOM 注入路径（slots 不可用时启用，见 src-client/legacy.tsx） ---------- */
.dshca-entry{display:flex;align-items:center;gap:8px;position:relative;width:calc(100% - 8px);margin:2px 4px;padding:6px 10px;border:none;border-radius:8px;background:transparent;color:var(--dsw-text-secondary,inherit);font:inherit;font-size:13px;cursor:pointer;text-align:left}
.dshca-entry:hover{background:var(--dsw-hover,rgba(128,128,128,.12));color:var(--dsw-text-primary,inherit)}
.dshca-entry[data-active="true"]{background:var(--dsw-active,rgba(128,128,128,.18));color:var(--dsw-text-primary,inherit);font-weight:500}
.dshca-entry svg{flex:none}
[data-sidebar-collapsed] [data-dshca-entry],[class*="_collapsed"] [data-dshca-entry]{width:36px;margin:2px auto;padding:8px 0;justify-content:center}
[data-sidebar-collapsed] [data-dshca-entry] .dshca-entry-label,[class*="_collapsed"] [data-dshca-entry] .dshca-entry-label{display:none}
html[data-dshca-active] [data-pane="conversation"] > *:not([data-dshca-view]),
html[data-dshca-active] [class*="centerCol"] > *:not([data-dshca-view]),
html[data-dshca-active] .dshDesktopConversationSurface > *:not([data-dshca-view]){display:none !important}
.dshca-view{display:none}
html[data-dshca-active] .dshca-view{display:flex;flex-direction:column;height:calc(100vh - 24px);overflow:hidden;padding:8px}
`
