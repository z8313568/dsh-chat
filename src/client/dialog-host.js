/**
 * 对话框宿主：**唯一**渲染 dsh-chat 三个对话框的地方。
 *
 * 挂在 `shell.overlay` 上。这个位置的关键性质是「frame-wide floating layer,
 * above every column and outside their scroll containers」——它是**常驻**的：
 * 切主面板、切会话、切导航都不会卸载它。
 *
 * 为什么必须常驻：第一版把对话框放在会话页的入口组件里，而那个组件位于
 * `main` 面板的 conversation 子树下。点「开启直播」→ 组件要求切主面板
 * → conversation 被卸载 → 入口组件连同它刚打开的对话框一起消失。
 * 用户看到的是「跳到面板了，但什么都没发生」。
 *
 * 这条教训值得单独记：**负责弹窗的组件，不能挂在任何会被导航卸载的子树里。**
 */
import { Fragment, h, useEffect, useState } from './kit.js';
import { intentStore } from './intent.js';
import { GoLiveDialog, LiveRoomDialog } from './live-room.js';
import { ShareDialog } from './share-dialog.js';

export function DialogHost({ client, t }) {
  const [intent, setIntent] = useState(intentStore.value);

  useEffect(() => intentStore.subscribe(setIntent), []);

  if (!intent) return null;
  const close = () => intentStore.clear();

  if (intent.kind === 'share') {
    return (
      <ShareDialog
        client={client}
        sessionId={intent.sessionId ?? null}
        t={t}
        onClose={close}
        onPublished={() => close()}
      />
    );
  }

  if (intent.kind === 'live') {
    return (
      <GoLiveDialog
        client={client}
        sessionId={intent.sessionId ?? null}
        t={t}
        onClose={close}
        // 开播成功后不关闭，直接切到直播间——用户点"开始直播"之后
        // 最想看到的是"真的在播了"，而不是回到空白。
        onOpened={(room) => intentStore.set({ kind: 'room', roomId: room.id, role: 'host' })}
      />
    );
  }

  if (intent.kind === 'room') {
    return (
      <LiveRoomDialog
        client={client}
        roomId={intent.roomId}
        role={intent.role ?? 'host'}
        t={t}
        onClose={close}
      />
    );
  }

  return null;
}
