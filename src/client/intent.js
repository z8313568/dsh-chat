/**
 * 对话框意图（一个模块级的极小状态容器）。
 *
 * 为什么需要它：dsh-chat 有**三个互不相邻的挂载点**都想弹同一个对话框——
 *   1. 会话页头部的「分享会话 / 开启直播」按钮（`conversation.session.header.actions`）；
 *   2. 发现页的「观看」按钮（`main` 面板里）；
 *   3. 侧栏图标 / 外部插件通过 `dshChatClient` 服务调用。
 *
 * 而这三处所在的组件都可能被**卸载**：切主面板会卸载会话页，
 * 切会话会卸载整个 conversation。如果对话框的 state 存在这些组件里，
 * 它就会跟着一起消失——第一版正是这么写的，用户看到的是
 * 「点了开启直播，跳到面板，然后什么都没发生」。
 *
 * 所以把意图提到模块级，由一个**常驻**的宿主（挂在 `shell.overlay` 上）来渲染对话框。
 * 意图存储与挂载点是解耦的：谁被卸载都不影响对话框。
 */
const listeners = new Set();

let current = null;

export const intentStore = {
  /** 当前意图；null 表示没有对话框。 */
  get value() {
    return current;
  },

  /**
   * 设置一个意图。
   * @param {{kind: 'share'|'live'|'room', sessionId?: string, roomId?: string, role?: string, section?: string}} next
   */
  set(next) {
    current = next ?? null;
    emit();
  },

  /** 关闭当前对话框。 */
  clear() {
    if (current === null) return;
    current = null;
    emit();
  },

  /**
   * 只更新 section（用于"顺便切到某个导航页"），不影响已打开的对话框。
   * 把它和 set() 分开，是因为这两件事的语义不同：
   * 一个是"弹出某个东西"，一个是"导航到某处"。
   */
  setSection(section) {
    current = { ...(current ?? {}), section };
    emit();
  },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

function emit() {
  for (const listener of listeners) {
    try {
      listener(current);
    } catch (error) {
      console.error('[dsh-chat] 对话框意图订阅者出错', error);
    }
  }
}
