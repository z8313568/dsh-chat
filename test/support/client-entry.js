/**
 * 仅供渲染测试使用的重导出入口。
 *
 * `src/client/index.js` 只导出插件的 `name` / `inject` / `apply`（那是真正的交付契约），
 * 而渲染测试需要直接拿到各个组件。与其为了测试去污染交付接口，
 * 不如在这里单独开一个入口，让 esbuild 打出一份测试用的 ESM bundle。
 */
export { DshChatApp, SessionActions, SessionEntry } from '../../src/client/app.js';
export { ShareDialog } from '../../src/client/share-dialog.js';
export { DialogHost } from '../../src/client/dialog-host.js';
export { intentStore } from '../../src/client/intent.js';
export { GoLiveDialog, LiveRoomDialog } from '../../src/client/live-room.js';
export { DiscoverView, FavoritesView } from '../../src/client/views/discover.js';
export { FriendsView } from '../../src/client/views/friends.js';
export { MessagesView } from '../../src/client/views/messages.js';
export { MeView } from '../../src/client/views/me.js';
export { NodeView } from '../../src/client/views/node.js';
export { createHostClient, RpcError } from '../../src/client/rpc.js';
export { createLocalTranslator, zh, en, NS } from '../../src/client/i18n.js';
