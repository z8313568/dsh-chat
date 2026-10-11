/**
 * 插件样式表。
 *
 * 规则来自官方 UI 规范的硬要求：
 *   - **只用主题变量**（`--dsw-alias-*`），不写死颜色。这样浅色/深色切换会自动跟随宿主，
 *     而且即便某个 token 被改名，最坏结果是"外观退化"，不会"渲染不出来"。
 *   - 不 require 任何 `@deepseek-ai/dsh-client-*` 包；控件自己写。
 *   - 所有类名带 `dshc-` 前缀，避免和宿主或其它插件的样式撞车。
 *
 * 这里没有任何颜色字面量（除了极少数用于"色块"的中性透明值），
 * 也刻意没有覆盖宿主的全局选择器。
 */
export const STYLES = `
.dshc-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  font-size: 13px;
  line-height: 1.55;
}
.dshc-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dshc-title { font-size: 16px; font-weight: 600; margin: 0; }
.dshc-subtitle { margin: 2px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dshc-body { flex: 1; min-height: 0; display: flex; }
.dshc-nav {
  width: 148px;
  flex: 0 0 auto;
  border-right: 1px solid var(--dsw-alias-border-l1);
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: auto;
}
.dshc-navItem {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dshc-navItem:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dshc-navItem[aria-current="true"] {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
.dshc-navIcon { width: 16px; text-align: center; flex: 0 0 auto; }
.dshc-content { flex: 1; min-width: 0; overflow: auto; padding: 16px 20px 32px; }

.dshc-section { margin-bottom: 22px; }
.dshc-sectionTitle {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-secondary);
  margin: 0 0 8px;
}
.dshc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.dshc-card {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 12px 14px;
}
.dshc-card + .dshc-card { margin-top: 10px; }
.dshc-cardTitle { font-weight: 600; margin: 0 0 4px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dshc-cardMeta { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dshc-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshc-rowBetween { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.dshc-spacer { flex: 1; }

.dshc-btn {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  padding: 5px 12px;
  font: inherit;
  cursor: pointer;
}
.dshc-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dshc-btn:disabled { opacity: .5; cursor: not-allowed; }
.dshc-btnPrimary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-weight: 600; }
.dshc-btnDanger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dshc-btnGhost { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); }
.dshc-btnGhost:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dshc-btnSm { padding: 3px 8px; font-size: 12px; }

.dshc-input, .dshc-select, .dshc-textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  padding: 6px 9px;
  font: inherit;
}
.dshc-textarea { min-height: 64px; resize: vertical; }
.dshc-field { margin-bottom: 14px; }
.dshc-label { display: block; font-weight: 600; margin-bottom: 5px; font-size: 12px; }
.dshc-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-top: 4px; }

.dshc-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}
.dshc-badgeLive { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); font-weight: 700; }
.dshc-badgeOk { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.dshc-badgeWarn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.dshc-badgeIdle { border-color: var(--dsw-alias-state-idle-primary); color: var(--dsw-alias-state-idle-primary); }
.dshc-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex: 0 0 auto; }
.dshc-dotOn { background: var(--dsw-alias-state-success-primary); }

.dshc-notice {
  border: 1px solid var(--dsw-alias-border-l1);
  border-left-width: 3px;
  border-radius: 8px;
  padding: 9px 12px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  margin-bottom: 14px;
}
.dshc-noticeWarn { border-left-color: var(--dsw-alias-state-warn-primary); }
.dshc-noticeError { border-left-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dshc-noticeInfo { border-left-color: var(--dsw-alias-brand-primary); }

.dshc-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; word-break: break-all; }
.dshc-empty { color: var(--dsw-alias-label-secondary); padding: 24px 4px; text-align: center; }
.dshc-list { display: flex; flex-direction: column; gap: 8px; }
.dshc-scroll { overflow: auto; min-height: 0; }

.dshc-split { display: flex; gap: 14px; height: 100%; min-height: 0; }
.dshc-splitSide { width: 220px; flex: 0 0 auto; overflow: auto; border-right: 1px solid var(--dsw-alias-border-l1); padding-right: 12px; }
.dshc-splitMain { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.dshc-thread { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 4px 0 12px; }
.dshc-bubble { max-width: 78%; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 7px 11px; background: var(--dsw-alias-bg-layer-1); white-space: pre-wrap; word-break: break-word; }
.dshc-bubbleOut { align-self: flex-end; border-color: var(--dsw-alias-brand-primary); }
.dshc-bubbleMeta { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 3px; }

.dshc-sideItem {
  display: block;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  padding: 7px 9px;
  font: inherit;
  cursor: pointer;
}
.dshc-sideItem:hover { background: var(--dsw-alias-bg-layer-2); }
.dshc-sideItem[aria-current="true"] { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }

/*
 * 对话框遮罩。
 *
 * 之所以要一个很高的 z-index：这个对话框既可能从主面板里渲染，
 * 也可能从**会话页头部**里渲染（会话页的「分享会话/开启直播」按钮直接在原地弹窗，
 * 不依赖主面板能否切换）。后者意味着它要盖过整个会话界面。
 *
 * 已知限制：如果某个祖先元素带 transform/filter，position:fixed 会相对那个祖先定位。
 * 这种情况下遮罩可能被裁切——所以主面板那条路径始终保留，两条路互相兜底。
 */
.dshc-overlay {
  position: fixed;
  inset: 0;
  background: var(--dsw-alias-bg-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  z-index: 2000;
}
.dshc-modal {
  width: min(760px, 100%);
  max-height: min(84vh, 900px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay);
  overflow: hidden;
}
.dshc-modalHead { padding: 14px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1); display: flex; align-items: center; gap: 10px; }
.dshc-modalBody { padding: 16px 18px; overflow: auto; flex: 1; min-height: 0; }
.dshc-modalFoot { padding: 12px 18px; border-top: 1px solid var(--dsw-alias-border-l1); display: flex; gap: 8px; justify-content: flex-end; }

.dshc-previewItem { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; background: var(--dsw-alias-bg-layer-1); }
.dshc-previewItem[data-role="user"] { border-left: 3px solid var(--dsw-alias-brand-primary); }
.dshc-previewItem[data-role="assistant"] { border-left: 3px solid var(--dsw-alias-state-success-primary); }
.dshc-previewItem[data-role="tool"] { border-left: 3px solid var(--dsw-alias-state-warn-primary); }
.dshc-pre { white-space: pre-wrap; word-break: break-word; margin: 4px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }

.dshc-check { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; cursor: pointer; }
.dshc-check input { margin: 0; }

.dshc-kv { display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 4px 14px; font-size: 12px; }
.dshc-kv dt { color: var(--dsw-alias-label-secondary); }
.dshc-kv dd { margin: 0; word-break: break-word; }

.dshc-statusbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 9px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
`;
