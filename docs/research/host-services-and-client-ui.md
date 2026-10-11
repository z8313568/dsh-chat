# DSH Host Services & Client UI Extension Surface

Research for `dsh-chat` (decentralized AI social/creation network plugin). Target **DSH Desktop 0.2.0-rc.2**, asar `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`.

**Verification legend.** `✅ 实测` = read from a **live** `cordis_inspect_query` provider or observed on the live profile's disk. `⚠️ 未验证` = source-derived only (shipped `lib/*.js`, `README.md`, packaged skill docs).

> **CLIENT-INSPECT LIMITATION.** All five CLIENT providers (`Service`, `Event`, `Slots`, `Theme`, `Builtin`) were queried **9 times**; every call failed with `Client inspect query … timed out after 10000ms. Open or reconnect the Harness page, then retry.` Host providers answered normally. So **every client-side claim in §4, §5, §7 is `⚠️ 未验证`**, reconstructed from the shipped client bundles (the runtime ground truth for what the client plugin API is) plus the packaged authoring docs. Re-run those five queries from a connected page to promote them.

**Citation roots.** Packages unpacked read-only from the asar (no install, no profile modification): `/tmp/dshx/…`, `/tmp/dshy/…`, `/tmp/dshz/dsh/node_modules/@deepseek-ai/<pkg>/` — equivalent to `/dsh/node_modules/@deepseek-ai/<pkg>/…` inside the asar. Reference plugin: `/Users/twoants/.dsh/profiles/desktop/node_modules/@xmanrui/dsh-im/`. **No `.d.ts` ships**: `dsh-session/package.json` lists `lib/types/**/*.d.ts` in `files`, but `asar list` finds 0. Types come only from live inspect, JSDoc in `lib/*.js`, and READMEs.

---

## 1. Session services

Three complementary services (not generations — see §1.4): **`sessionQuery` for reads, `sessions` for lifecycle, `sessionPersistence` for the raw durable log.**

### 1.1 `ctx.sessionQuery` — unified live-preferred query service ✅ 实测

Verbatim: *"Unified live-preferred session query service. Exact reads, filters, and traces are backend-independent concrete behavior. A backend implements full-text observation, reconciliation, ranking, cursor generations, and query execution on the same `ctx.sessionQuery` service."* Access: `optional { expression: 'ctx.get("sessionQuery")', requiresUndefinedCheck: true }` / `hardDependency { inject: ["sessionQuery"], expression: "ctx.sessionQuery" }`.

```ts
observeSession(sessionId: SessionId, options: SessionObservationOptions = {}): Promise<SessionObservation>
abstract searchSessions(request: SessionSearchRequest, exec?: SessionSearchExecContext): Promise<SessionSearchPage<SessionSearchHit>>
abstract searchEvents(request: SessionEventSearchRequest, exec?: SessionSearchExecContext): Promise<SessionEventSearchPage>
listSessions(signal?: AbortSignal): Promise<SessionRecord[]>
async readSession(sessionId: SessionId): Promise<SessionLogSnapshot>
async filterSessions(filters: readonly SessionResultFilter[], signal?: AbortSignal): Promise<SessionRecord[]>
async readTitle(sessionId: SessionId, signal?: AbortSignal): Promise<SessionTitleSnapshot | undefined>
async readTitleSnapshot(sessionId: SessionId, signal?: AbortSignal): Promise<SessionTitleObservation>
async readTitleSnapshots(sessionIds: readonly SessionId[], signal?: AbortSignal): Promise<SessionTitleObservationResult[]>
async listEvents(sessionId: SessionId): Promise<SessionEventRecord[]>
async filterEvents(sessionId: SessionId, filters: readonly SessionEventResultFilter[]): Promise<SessionEventSearchDocument[]>
async readSurface(sessionId: SessionId): Promise<SessionSurfaceSnapshot>
async traceSession(sessionId: SessionId, signal?: AbortSignal): Promise<SessionLineageTrace>
async traceEvent(request: SessionEventTraceRequest, signal?: AbortSignal): Promise<SessionEventTraceObservation>
async readEvent(request: SessionEventReadRequest, signal?: AbortSignal): Promise<SessionEventWindow>
```

```ts
export interface SessionRecord { header: SessionHeader; live: boolean; persisted: boolean; }
export interface SessionHeader {
  readonly version: typeof SESSION_FORMAT_VERSION;   // = 4
  readonly id: SessionId; readonly createdAt: number; readonly cwd?: string;
  readonly parentSession?: SessionId; readonly isSeeded: boolean;
  readonly origin?: 'subagent'; readonly delegationDepth?: number; readonly agentPreset?: string;
}
export interface SessionLogSnapshot { session: SessionHeader; inheritedEventCount: SessionLogOffset; events: SessionEvent[]; }
export interface SessionEventRecord { sessionId: SessionId; seq: SessionSeq; type: SessionEventType; time: number; surface: SessionEventSurface; }
export interface SessionSurfaceSnapshot { session: SessionHeader; inheritedEventCount: SessionLogOffset; capturedThroughSeq: OptionalSessionSeq; events: SurfaceEvent[]; }
export interface SessionObservation extends Disposable {
  readonly source: 'live' | 'prepared'; readonly header: SessionHeader;
  readonly inheritedEventCount: SessionLogOffsetType; readonly events: readonly SessionEvent[];
  readonly cursor: SessionSeqCursor;                     // SessionSeq | -1
  readonly revision?: SessionPersistenceRevision; readonly projections?: ProjectionSnapshot;
  retain(): SessionObservation;
}
export interface SessionObservationOptions { readonly signal?: AbortSignal; readonly projectionMode?: 'all' | 'none'; }
export type SessionResultFilter =
  | { kind: 'id'; values: readonly SessionId[] } | { kind: 'cwd'; values: readonly (string | null)[] }
  | ({ kind: 'created-at' } & SessionResultRange) | { kind: 'parent'; values: readonly (SessionId | null)[] }
  | { kind: 'availability'; values: readonly SessionAvailability[] };        // 'live' | 'persisted'
export type SessionEventResultFilter =
  | ({ kind: 'seq' } & SessionResultRange) | ({ kind: 'time' } & SessionResultRange)
  | { kind: 'type'; values: readonly SessionEventType[] }
  | { kind: 'surface'; values: readonly SessionEventSurface[] } | { kind: 'text'; text: string };
export interface SessionEventReadRequest { sessionId: SessionId; seq: SessionSeq; before?: number; after?: number; }
export interface SessionEventWindow { session: SessionHeader; inheritedEventCount: SessionLogOffset; target: SessionEvent; events: SessionEvent[]; startSeq: SessionSeq; endSeq: SessionSeq; }
export type SessionLineageTrace = { target: SessionRecord; ancestors: SessionRecord[]; descendants: SessionLineageNode[] }
  & ({ complete: true; root: SessionRecord } | { complete: false; unresolvedParentId: SessionId });
export interface SessionEventTrace { target: SessionEventRecord; replacedBy?: SessionSeq; replacementChain: SessionSeq[]; replacedEventSeqs: SessionSeq[]; sourceEventSeqs: SessionSeq[]; derivedEventSeqs: SessionSeq[]; }
export interface SessionSearchPage<T> { items: readonly T[]; nextCursor?: SessionSearchCursor; }
export interface SessionResultRange { from?: number; to?: number; }
export interface SessionEventSearchPage extends SessionSearchPage<SessionEventSearchHit> { session: SessionHeader; }
```
`readSession` = *"cloned header and complete raw event log from one observation"*; `listEvents` = *"event records in ascending seq order"*; `readSurface` = *"cloned header, current surface, and the last sequence number included in the raw-log capture."*

### 1.2 `ctx.sessions` — in-memory session store ✅ 实测

Verbatim: *"In-memory session store (`ctx.sessions`). Persistence is intentionally not implemented here — the agent lifecycle attaches a session-log writer to each published session's write handle; a session published outside that lifecycle persists nothing."*

```ts
registerMessageProjection(projection: SessionMessageProjection): () => Promise<void>
create(id?: SessionId, options?: CreateSessionOptions): Session
prepare(id?: SessionId, options?: PrepareSessionOptions): Session
enter(session: Session): () => void
announce(session: Session): void
async flush(session: Session): Promise<boolean>
get(id: SessionId): Session | undefined
list(): Session[]
fork(source: SessionForkSource, boundary?: SessionSeq, childSessionId?: SessionId): Session
```
`fork` verbatim: *"Create a live child session from an exact prefix of a live source. `boundary` is an inclusive source event seq; omitted means the source's current last event. An open tail receives synthetic tool results and step/turn closers with the forked cause. Closed steps and turns remain unchanged, including any failed tool calls already missing results. `inheritedEventCount` counts only copied source events, excluding these closers."* `SessionForkSource = Session | SessionId`. `create` verbatim: *"Create a session owned by the calling fiber: disposing that fiber stops event notification and removes the session from the store."* Id omitted → store mints `session-<n>`.

```ts
export interface CreateSessionOptions {
  readonly seed?: readonly SessionEvent[]; readonly inheritedEventCount?: SessionLogOffset;
  readonly meta?: { readonly cwd?: string; readonly parentSession?: SessionId; readonly createdAt?: number;
    readonly isSeeded?: boolean; readonly origin?: 'subagent'; readonly delegationDepth?: number; readonly agentPreset?: string; };
}
export type PrepareSessionOptions = (CreateSessionOptions & { readonly eventState?: undefined }) | RestoredSessionOptions;
export interface RestoredSessionOptions { readonly seed: SessionEvent[]; readonly meta: SessionHeader; readonly inheritedEventCount: SessionLogOffset; readonly eventState: SessionSeedEventState; }
export type SessionSeedEventState = 'detached' | 'shared-frozen';
export interface SessionMessageProjection<T extends SessionEventType = SessionEventType> {
  type: T; project(event: SessionEvent<T>, context: SessionMessageProjectionContext): ReadonlyMap<SessionSeq, Message>;
}
// class Session — full surface (✅ 实测)
get surface(): SessionSurface;   // { nodes, replaceGeneration, contentGeneration }
readonly header: SessionHeader;  get id(): SessionId;  readonly inheritedEventCount: SessionLogOffset;
readonly firstLiveSeq: SessionLogOffset;  readonly firstLifecycleSeq: SessionLogOffset;  get seq(): SessionLogOffset;
static create(id, seed?, header?, inheritedEventCount?, projections?): Session;
static fromRestore(id, seed, header, inheritedEventCount, eventState, projections?): Session;
eventAt(seq: SessionSeq): SessionEvent | undefined;
snapshotEvents(fromSeq?: SessionLogOffset, toSeqExclusive?: SessionLogOffset): readonly SessionEvent[];
ownEvents(): readonly SessionEvent[];  isOwnSeq(seq: SessionSeq): boolean;
append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...opts): SessionEvent<T>;
requestHeader(): EpochHeader | undefined;  requestContext(): RequestContext | undefined;
toolHistory(): ToolHistory;  deriveMessages(): Message[];  deriveEventMessage(event: SessionEvent): Message | null;
```

### 1.3 `ctx.sessionPersistence` — durable append-only storage ✅ 实测

Verbatim (abridged): *"Durable append-only session storage addressed through per-session handles. … events are contiguous from seq 0 and never rewritten; a torn physical tail is never returned to a reader and is truncated by the write path before its first append; reads validate current-format records only and refuse unknown vocabulary fail-closed. `append` persists best-effort; `flush` — per handle or service-wide — is the durability barrier."*

```ts
readonly identity: symbol = Symbol('sessionPersistence')
abstract create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle>
abstract open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle>
abstract flush(): Promise<void>
abstract stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined>
abstract list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]>

export type SessionAccess = 'read' | 'write';
export interface SessionHandle extends AsyncDisposable {
  readonly id: SessionId; readonly header: SessionHeader;
  readonly inheritedEventCount: SessionLogOffset; readonly access: SessionAccess;
  read(offset?: number, length?: number, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult>;
  append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void>;
  flush(options?: SessionHandleFlushOptions): Promise<void>;
  close(): Promise<void>;
}
export interface SessionHandleReadResult { readonly eventState: SessionSeedEventState; readonly events: readonly SessionEvent[]; }
export interface SessionPersistenceSnapshot { readonly header: SessionHeader; readonly revision: SessionPersistenceRevision; readonly eventCount?: number; readonly sizeBytes?: number; }
```
`open` verbatim: *"`read` never takes ownership and works while another handle (or process) holds write ownership. `write` atomically claims single-writer ownership; an existing active owner rejects."* Throws `SessionPersistenceNotFoundError` / `SessionAlreadyOwnedError`. `stat`'s `revision`: *"an opaque change token comparable only against revisions from the same service instance and session id."*

### 1.4 Safety / deprecation verdict

**No deprecation markers exist.** `grep -i "deprecat\|legacy\|superseded"` over `dsh-session-query/README.md`, `dsh-session-persistence/README.md`, `dsh-session/README.md` returns nothing. The three are complementary.

| API | Verdict | Why |
| --- | --- | --- |
| `sessionQuery.*` reads (`readSession`, `listEvents`, `readSurface`, `observeSession`, `listSessions`, `readTitle*`, `filter*`, `trace*`, `search*`) | ✅ **primary read path** | Live-preferred, cloned results, takes no write ownership. `observeSession` returns a caller-owned lease (`Disposable` + `retain()`). |
| `sessions.get` / `sessions.list` | ✅ | Cheap live lookups; `list()` returns a fresh array. |
| `sessions.fork` | ✅ with care | Creates a **live** child owned by the calling fiber — `dsh-chat` "fork to share" must own that fiber. |
| `sessions.flush` | ✅ | *"THE flush entry point"*; do **not** dispatch raw `ctx.parallel('session/flush', …)`. |
| `sessions.create` / `prepare` / `enter` / `announce` | ⚠️ low-level | Store primitives. Agent-owned lifecycles must fold into the agent's effect via `prepare`+`enter`+`announce`, **not** `create`. Never use for agent sessions. |
| `sessionPersistence.open(id,'read')`, `.list`, `.stat` | ✅ | Read-only; never contends. |
| `sessionPersistence.open(id,'write')` | ❌ **avoid** | Claims single-writer ownership; fights the live agent's own handle. |
| `sessionPersistence.append` | ❌ **avoid** | Bypasses the store, and per `practices.md` never append a new event `type`: live `Session.append()` cannot set `ignorable: true`, so the session would refuse to reopen. |

---

## 2. Event contracts

### 2.1 `session/event` ✅ 实测

```
mode:      emit
signature: 'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
```
Verbatim: *"Post-commit, fire-and-forget append feed. The listener snapshot resolves before the log push, but callbacks run after it; observer failures are logged and contained without making the committed append fail. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only events from sessions entered through that agent's context."* Params: `session` = *"the session whose log grew"*; `event` = *"the appended event, exactly as recorded"*. Use `{ global: true }` (runtime-verified) to see every session.

### 2.2 `SessionEvent` envelope ✅ 实测

```ts
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K; seq: SessionSeq;      // BrandedNumber<'SessionSeq'>
    time: number; data: SessionEventMap[K]; ignorable?: true;
  } & (K extends SurfaceEventType ? SurfaceIntent<K> : { surfaceOp?: never; sourceEventSeqs?: never });
}[T];

export type SessionEventType = keyof SessionEventMap;
export type SessionSeq = BrandedNumber<'SessionSeq'>;      // Branded<B> = string & { readonly [BRAND]: B }
export type SessionId  = Branded<'SessionId'>;             // BrandedNumber<B> = number & { readonly [BRAND]: B }
export type SessionLogOffset = BrandedNumber<'SessionLogOffset'>;
export type SessionPersistenceRevision = Branded<'SessionPersistenceRevision'>;
export type OptionalSessionSeq = SessionSeq | null;
export type SessionSeqCursor = SessionSeq | -1;
export type SessionAvailability = 'live' | 'persisted';
export type SurfaceEventType = 'system/message' | 'developer/message' | 'user/message' | 'assistant/message' | 'tool/result';
export type SurfaceIntent<T extends SurfaceEventType = SurfaceEventType> =
  { surfaceOp: SurfaceOp } & (T extends 'assistant/message' ? { sourceEventSeqs?: never } : { sourceEventSeqs?: SessionSeq[] });
export type SurfaceOp = 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq };
export type SessionEventSurface = 'current' | 'shadowed' | 'log-only';
export type SurfaceEvent = SessionEvent<SurfaceEventType>;
export interface SessionSurface { readonly nodes: readonly SessionSeq[]; readonly replaceGeneration: number; readonly contentGeneration: number; }
```
So a committed event is exactly `{ type, seq, time, data, ignorable?, surfaceOp?, sourceEventSeqs? }` — the last two only on the five surface types, and `sourceEventSeqs` never on `assistant/message`. `SESSION_FORMAT_VERSION = 4` (`dsh-session/lib/types/types.js:54`).

### 2.3 Event-type vocabulary — 59 types ✅ 实测

`KNOWN_SESSION_EVENT_TYPES`, a `Set` literal at `/tmp/dshx/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js:21-81` (entries on lines 22–80 = **59**). Verbatim header: *"Every `SessionEventMap` member declared in this repository — the event vocabulary this build understands. The persistence read path refuses to interpret a log containing a type outside this set unless the event carries the envelope's `ignorable` marker … Downstream (out-of-repo) plugin events are outside this list by construction."*

In file order (1–59, exactly as written in the `Set`):

```
 1 agent-preset/selected            21 hook/result                       41 system/message
 2 agent/inbox/spliced              22 image/offload                     42 team/member
 3 approval/asked                   23 llm/retry                         43 team/message/delivered
 4 approval/decided                 24 llm/retry-started                 44 team/message/queued
 5 approval/policy                  25 model/selection                   45 team/task
 6 assistant/attempt                26 permission/preset                 46 todo/write
 7 assistant/message                27 plan/mode                         47 tool-workflow/agent-end
 8 command/done                     28 request/context                   48 tool-workflow/agent-start
 9 command/run                      29 request/header                    49 tool-workflow/run-end
10 compaction/end                   30 sandbox/mode                      50 tool-workflow/run-start
11 compaction/prune                 31 schedule/change                   51 tool/call
12 compaction/start                 32 session-log-deepseek/             52 tool/ptc-dispatch
13 compaction/summary                   delivery-accepted               53 tool/ptc-dispatch-start
14 deliverables/presented           33 session/end-seed                  54 tool/result
15 developer/message                34 session/title                     55 turn/end
16 feedback/message-delete          35 session/title-llm-request         56 turn/start
17 feedback/message-put             36 step/end                          57 user/message
18 feedback/record                  37 step/start                        58 web/deepseek-search-llm-request
19 goal/change                      38 subagent/catalog                  59 workspace/changes
20 hook/invoked                     39 subagent/descriptor
                                    40 subagent/model-selection-policy
```
(#32's value is the single string `session-log-deepseek/delivery-accepted`; it is wrapped above only for width.)
Also exported: `export const MESSAGE_PROJECTION_EVENT_TYPES = new Set(['image/offload'])` — *"Event types whose model-visible effects require an explicit pure interpreter."*

### 2.4 `assistant/message` and its embedded `AssistantStreamRecord` ✅ 实测

```ts
'assistant/message': { turn: number; step: number; message: AssistantMessage; stream: AssistantStreamRecord[]; usage?: TokenUsage; interrupted?: true };
'assistant/attempt': { turn: number; step: number; stream: AssistantStreamRecord[] };

export type AssistantStreamRecord =
  | { readonly type: 'text-chunks';      readonly time0: number; readonly index: number; readonly dt: readonly number[]; readonly texts: readonly string[] }
  | { readonly type: 'reasoning-chunks'; readonly time0: number; readonly index: number; readonly dt: readonly number[]; readonly texts: readonly string[] }
  | { readonly type: 'tool-call-chunks'; readonly time0: number; readonly index: number; readonly dt: readonly number[]; readonly id: ToolCallId; readonly name?: string; readonly args: readonly string[] }
  | { readonly type: 'chunk'; readonly time: number; readonly chunk: StreamChunk };

export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope };
```
**`dt[]` timing semantics.** `time0` is the base timestamp; `dt[k]` is a delta (ms) applied **cumulatively** to reach the time of `texts[k]` / `args[k]`. One delta per emitted fragment, so `dt.length === texts.length` (resp. `args.length`). A replay renderer walks `t = time0; for k: t += dt[k]; emit(texts[k], t)`. The `'chunk'` variant carries an absolute `time` instead of an array and holds one `StreamChunk` — used for block boundaries, usage and finish, which have no per-fragment text.

```ts
export type ContentBlockType = keyof ContentBlockMap;   // 'text'|'reasoning'|'image'|'file'|'tool-call'|'tool-addition'|'tool-removal'
export interface TokenUsage { inputTokens: number; outputTokens: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; }
export type FinishReason = FinishReasonMap[keyof FinishReasonMap];   // {kind:'stop'|'tool-calls'|'max-tokens'|'aborted'|'error'}
export interface AssistantMessage extends MessageBase { readonly role: 'assistant'; readonly source: ModelMessageSource; }
export interface ModelMessageSource extends AssistantProviderMetadata { kind: 'model' }
export interface AssistantProviderMetadata { provider: string; model: string; replayState?: unknown }
export interface ReplayEnvelope { response: unknown; blocks?: readonly unknown[]; }
export interface ToolCallBlock { type: 'tool-call'; id: ToolCallId; name: string; arguments: string; }
export interface ReasoningBlock { type: 'reasoning'; text: string; }
```

### 2.5 Other verified `SessionEventMap` members ✅ 实测

```ts
'turn/start': { turn: number };   'turn/end': { turn: number; reason: TurnEndReason };
'step/start': { turn: number; step: number };   'step/end': { turn: number; step: number };
'user/message': UserMessage;
'developer/message': { turn: number; step: number; message: DeveloperMessage; headerSeq?: SessionSeq };
'system/message':    { turn: number; step: number; message: SystemMessage };
'tool/call':   { turn: number; step: number; callId: ToolCallId; name: string; arguments: string };
'tool/result': { turn: number; step: number; message: ToolResultMessage; error?: { name: string; code: string; reason?: string }; meta?: JsonValue };
'request/header':  { header: EpochHeader; reason: RequestHeaderReason; startsSeries?: true };
'request/context': RequestContext;
'session/end-seed': { /* truncated in the inspect projection — full shape lives only in the unshipped .d.ts */ };
```
`TurnEndReason` = `{kind:'completed'} | {kind:'aborted', reason: TurnEndCancelCause} | {kind:'blocked'} | {kind:'error', error: LlmFailure} | {kind:'max-tokens'} | {kind:'interrupted'} | {kind:'forked'}`; `TurnEndCancelCause = AgentCancelCause | { kind: 'legacy' }`; `AgentCancelCause = {kind:'user'} | {kind:'parent'} | {kind:'hook', reason} | {kind:'disposed'}`; `RequestHeaderReason = 'initial' | 'resume' | 'change' | 'series'`; `EpochHeader = { config: LlmCallConfig; adapterDefaults?; tools?: ToolSchema[]; system?: never }`.

> ⚠️ **Honest gap.** The live projection renders `SessionEventMap` as `/* …truncated — full shape in source */` after `'session/end-seed'`, and no `.d.ts` ships. The 43 remaining event `data` shapes were **not** recovered. The types `dsh-chat` needs most (`user/message`, `assistant/message`, `tool/call`, `tool/result`, `turn/*`, `step/*`, `session/title`) **are** verified above. For the rest, read `dsh-session/README.md` or call `cordis_inspect_query({platform:'host', provider:'Event', method:'listEvents', input:{event:'session/event'}})`.

---

## 3. Host HTTP / realtime capability

**Yes — thoroughly.** A plugin can expose plain HTTP routes, **SSE streams**, and raw WebSocket upgrades; and separately it can push typed live data over the built-in RPC stream multiplexer without writing HTTP at all.

### 3.1 `ctx.webServer` ✅ 实测 (signature shape) / ⚠️ (type names)

Host service key `webServer`, *"The browser HTTP carrier service."* Implementation: `/tmp/dshx/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js:139` (`var WebServer = class extends Service`).

```ts
register(route: WebRoute): () => void
registerUpgrade(route: WebUpgradeRoute): () => void
registerFallback(handler: WebRoute['handler']): () => void
tapIndex(transform: (html: string) => string): () => void
applyIndexTaps(html: string): string
collectIndexInjections(): IndexInjection[]
renderIndex(html: string): string
get port(): number | undefined      // OS-assigned value when config.port is 0
get host(): '127.0.0.1' | '0.0.0.0'
```
```js
// lib/index.js:141-147 — WebServer.Config, verbatim
static Config = z.object({
  host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required(),
  port: z.natural().max(65535).required(),
  compression: z.union([z.const("none"), z.const("gzip")]).default("none"),
  compressionLevel: z.number().step(1).min(0).max(9).default(1),
  compressionThresholdBytes: z.natural().default(1024)
});
```

**Route objects are raw `node:http`, NOT Fetch API.** The surface's most misleading property; confirmed three ways: (1) the server is `createServer` from `node:http` (`:1`, `:246`); (2) dispatch passes the raw pair — `await route.handler(req, res)` (`:235`), `new URL(req.url ?? "/", "http://x").pathname` (`:232`), raw 404 via `res.writeHead(404); res.end();` (`:240-241`); (3) the working reference plugin does exactly that — `request.method`, `request.headers[…]`, `for await (const chunk of request)`, `response.writeHead(status, headers)`, `response.end(body)` at `dsh-im/plugin-src/host/delivery-http.mjs:52-84`.

```ts
// ⚠️ type names inferred from usage; .d.ts not shipped
interface WebRoute {
  kind: 'exact' | 'prefix';
  path: string;                                                    // must start with '/'
  handler(req: http.IncomingMessage, res: http.ServerResponse): void | Promise<void>;
}
interface WebUpgradeRoute {
  path: string;                                                    // exact match only
  handler(req: http.IncomingMessage, socket: Duplex, head: Buffer): void | Promise<void>;
}
```
`kind` selects the table (`route.kind === "exact" ? this.exact : this.prefixes`, `:178`). **Matching** (verbatim, `:322-332`): exact table first, then *"Longest-prefix-wins over the prefix table after an exact-table miss"* — a prefix matches when `pathname === prefix` **or** `pathname.startsWith(prefix + '/')`, so `/api` does **not** match `/apifoo`.

**One handler, one owner.** Duplicate `(kind, path)` throws (`webserver: duplicate ${kind} route "${path}"`, `:179`); duplicate upgrade path throws (`:192`); a second `registerFallback` throws (`webserver: fallback already registered`, `:207`). All three return a disposer; register inside `ctx.effect(() => …, 'label')` — the pattern every shipped package uses. `registerFallback` verbatim: *"Claim the fallback seat: the handler answering every request no named route matches (the SPA dist server in the shipped Web composition). One owner only."* In the shipped composition `dsh-host-frontend-static` owns it (`/tmp/dshy/…/dsh-host-frontend-static/lib/index.js:87`) and calls `ctx.webServer.renderIndex(...)` per index response (`:85`). **`dsh-chat` must not take the fallback seat.**

### 3.2 Streaming — SSE and long-lived responses ARE supported ✅ 实测

Direct evidence: the gzip filter refuses to compress SSE.
```js
// /tmp/dshx/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js:110-116
filter(request, response) {
  if (response.getHeader("content-range") !== void 0) return false;
  const contentType = response.getHeader("content-type");
  if (typeof contentType === "string" && contentType.toLowerCase().startsWith("text/event-stream")) return false;
  if (typeof contentType === "string" && /^multipart\/form-data(?:;|$)/i.test(contentType)) return true;
  return compressionMiddleware.filter(request, response);
}
```
Prose: *"Existing encodings, `Cache-Control: no-transform`, range responses, **SSE**, ZIP, and the packaged `.gz` Worker image remain unchanged."* (`dsh-host-webserver/README.md:41`.)

Mechanically nothing is withheld: the handler OWNS the `ServerResponse`, so `res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'})` then `res.write('data: …\n\n')` works indefinitely. Three framework behaviours to account for: **(a)** compression is off by default (`compression: 'none'`), and even with `'gzip'` SSE is excluded by the filter above; **(b)** disposal destroys connections — the `webServer.listen` effect runs `this.server.closeAllConnections()` then destroys every upgraded socket (`:306-320`), so a plugin's SSE responses die with its fiber (correct lifetime, but an unload closes live streams abruptly); **(c)** a handler throw answers 400, or destroys the socket if headers were already sent (`:248-256`; README: *"An HTTP request whose handler throws is answered 400 — or the socket destroyed when headers are already open"*) — so an SSE route must catch its own errors after `writeHead`.

**WebSocket.** `registerUpgrade` yields the raw `socket` + `head`; DSH does **not** hand you a `ws` WebSocket. The framework's own mux does the handshake itself:
```js
// dsh-api-gateway/lib/index.js:636-648
const route = {
  path: REMOTE_STREAM_MUX_PATH,                      // "/api/remote.mux"  (:12)
  handler: (req, socket, head) => {
    const admission = webCtx.connection.admit(req);
    if ("rejection" in admission) { rejectRemoteStreamUpgrade(socket, admission.rejection); return; }
    mux.handleUpgrade(req, socket, head, admission.peer);
  }
};
yield webCtx.webServer.registerUpgrade(route);
```
A `dsh-chat` WebSocket would need its own handshake (`ws`) or manual RFC 6455. **Prefer SSE — or better, §3.5.**

### 3.3 Index injection (boot HTML) — reference only

`collectIndexInjections()` does one `ctx.emit('webserver/index-inject', table)` per call; subscribers push rows (`:350-354`). `IndexInjection` row kinds (`:24-52`): `{kind:'global', name, value}` → `globalThis[name] = value` in `<head>`; `{kind:'script', placement, text}`; `{kind:'script-src', placement, src}`; `{kind:'script-preload', src}`; `{kind:'style', text}`; `{kind:'html', placement, html}`; `placement: 'head' | 'body'`. `renderIndex(html)` renders the structured rows, then applies raw `tapIndex` transforms in registration order (`:361-363`). Live examples: `dsh-client-connection/lib/index.js:826-832` pushes `__DSH_CONNECTION_RECOVERY__`; `dsh-client-modules` pushes the boot graph. `globalThis.__DSH_BOOT_READY__` gates the client entry (`:58-65`) — client code must await it before reading injected state.

### 3.4 The parallel registry: `ctx.connection.fetch` (real Fetch API, authenticated) ✅ 实测

Distinct from `webServer`: `dsh-client-connection` offers an **exact, Fetch-typed** route registry behind the single `/api` prefix. This is what the working plugin uses.

```ts
// Host service `connection` ✅ 实测
readonly rpc: HostConnectionRpc;   readonly fetch: HostConnectionFetch;   readonly operator: PeerScope;
createSharedFetchHandler(channel: '/api'): ConnectionFetchHandler
requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection
admit(request: ConnectionTrustRequest): PeerAdmission
authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean
authenticatedUrl(baseUrl: string): string
```
```js
// dsh-client-connection/lib/index.js:608-638, verbatim (abridged)
createSharedFetchHandler(channel) {
  return {
    requestBodyMode: ({ method, url }) => {
      const route = this.fetchRoutes.get(url.pathname);
      return route?.methods.has(method) === true ? route.requestBody : "buffered";
    },
    fetch: (request) => {
      const pathname = new URL(request.url).pathname;
      const route = this.fetchRoutes.get(pathname);
      if (route?.methods.has(request.method) === true) return route.fetch(request);
      const endpoint = endpointFromPath(channel, pathname);
      const interceptor = this.interceptors.get(channel);
      if (endpoint === void 0 || interceptor === void 0 || !interceptor.matches(endpoint))
        return Promise.resolve(new Response("not found", { status: 404 }));
      return interceptor.fetchHandler.fetch(request);
    }
  };
}
registerFetchRoute(owner, route) {
  assertFetchRoute(route);
  const registered = { methods: new Set(route.methods), requestBody: route.requestBody, fetch: route.fetch };
  return owner.effect(() => {
    if (this.fetchRoutes.has(route.path)) throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`);
    this.fetchRoutes.set(route.path, registered);
    return () => { this.fetchRoutes.delete(route.path); };
  }, `client-connection: ${route.path} Fetch route`);
}
```
`assertFetchRoute` (`:758-762`) requires `endpointFromPath('/api', route.path) !== undefined`, non-empty `methods`, no repeated method. So:
```ts
interface ConnectionFetchRoute {
  path: string;                       // must live under /api, e.g. "/api/dsh-chat/rpc"
  methods: readonly string[];         // e.g. ['POST']
  requestBody: 'buffered' | 'stream'; // declared BEFORE any bytes are read
  fetch(request: Request): Response | Promise<Response>;   // real Fetch API
}
```
Buffered routes cap at `maxRequestBodyBytes` (default `314572800` = 300 MiB, `lib/index.js:816`); `'stream'` is the documented opt-in for backpressured chunks that bypass the aggregate cap. **That concerns request bodies only.** Response *incremental* flush through this registry is not documented — the README only promises that *"Client disconnection aborts the handler signal; the bridge stops socket writes and drains any remaining response chunks"* (`dsh-client-connection/README.md:47`). **For incremental server→client push use SSE (§3.2) or §3.5.**

The working plugin's registration (closest precedent to `dsh-chat`):
```js
// dsh-im/plugin-src/management-rpc.mjs:52-80, verbatim (abridged)
export function registerManagementRpc(ctx, channel, handler, { authority } = {}) {
  const policy = resolveRpcAuthority(authority);
  const endpoint = rpcEndpoint(channel);                      // `dsh-im${channel}`
  if (typeof ctx?.connection?.fetch?.register !== 'function') {
    throw new TypeError('DSH Host Connection Fetch registry is required');
  }
  return ctx.connection.fetch.register({
    path: `/api/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) { /* DSH already applied browser auth + Host/Origin trust */ }
  });
}
```
→ The live façade spells the method **`register`** (the internal source name is `registerFetchRoute`). `dsh-im` feature-detects it, the right defensive posture given the name divergence.

### 3.5 The DSH-native realtime path: `@Remote({ mode: 'stream' })` ✅ 实测 (docs)

DSH's own answer to server→client push is **not** SSE: it is a typed logical stream multiplexed over one authenticated WebSocket at `/api/remote.mux`. Host service `ctx.typertGateway`; client service `ctx.remote` (`dsh-api-gateway/README.md:12`). Verbatim (`:35`, `:54`, `:60`, `:39`, `:89`): *"A stream Remote uses `@Remote({ mode: 'stream' })` and returns an `Iterable` or `AsyncIterable`. `ctx.typertGateway.stream()` applies the same endpoint, argument, lookup, and cancellation checks as unary invocation, then returns a cancellation-aware iterable over the business items. The Client opens the Gateway-owned `/api/remote.mux` WebSocket when its plugin activates and keeps it connected while idle."* … *"returns a `RemoteStreamHandle<Out, In>` … `send(item)` queues an uplink item … `end()` half-closes the uplink; `dispose()` sends `cancel`"* … *"`ctx.remote.$stream()` returns a single-consumer `RemoteStream` spanning physical carrier generations… `RemoteSnapshotStream` adds one opening snapshot followed by deltas. `RemoteJournalStream` adds follow-before-page opening, pagination, reconnect catch-up, and gap repair"* … uplinks are bounded by `streamInboxBytes` (262144 default) and overflow fails the stream with `gateway/uplink-overflow`; Ping heartbeat is 2 s and a missed Pong terminates the peer.

**Hard constraints for a third-party plugin** (this decides `dsh-chat`'s design): *"Host composition can register **one** application event source through `registerRemoteEvents()`. Gateway reserves the internal `$events` logical endpoint for that source… API Remotes owns the event selection"* (`:43`); and *"Every Client-supplied field requires a strict generated codec when its contribution mounts. SRC markers have no Client type projection and are not normal Client contribution inputs"* (`:85`). So `ctx.remote.$on(hostEvent)` is **not** extensible by a plugin, and a plugin's `@Remote` methods need **generated invocation descriptors** (a build step), not hand-written declarations.

### 3.6 Transport choice for `dsh-chat`

| | (a) `ctx.webServer.register` + SSE | (b) `ctx.connection.fetch.register` + `ctx.connection.rpc.call` |
| --- | --- | --- |
| Auth | **None.** *"the server carries no TLS, authentication, or origin policy of its own"* (`dsh-host-webserver/README.md:39`) — plugin must implement Host/Origin/token checks | **Free.** `/api` already admits: browser cookie → 401, Host/Origin trust → 403 (`dsh-client-connection/README.md:39,43`; `lib/index.js:833-839`) |
| Wire types | raw `node:http` | Fetch `Request`/`Response` |
| Push | true SSE (`res.write`) | request/response only |
| Reconnect / effort | plugin-owned / higher | plugin-owned / matches the shipped precedent exactly |

**Recommendation.** Serve `dsh-chat`'s UI data over **`ctx.connection.fetch.register`** under `/api/dsh-chat/*` (auth + trust inherited), called from the client with `ctx.connection.rpc.call('/api', 'dsh-chat…', …)` — byte-for-byte the `dsh-im` pattern, no codegen. Add a **`ctx.webServer.register` SSE route only for genuine server-push** (live co-editing / 直播 presence), and if you do, replicate `dsh-im`'s explicit loopback guard (`isLoopbackRequest`, `management-rpc.mjs:29-40`) plus `ctx.connection.admit(req)` before writing any body. Do **not** adopt `@Remote({mode:'stream'})` unless you also adopt the typert codegen pipeline.

### 3.7 Other HTTP-adjacent service keys ✅ 实测 (from the host Service directory)

- **`connection`** — §3.4.
- **`clientModules`** — *"The web plugin table service: incremental `dsh.client` scan + wire composition + bundle route + index injection rows."* `graph(): WebBootGraph`, `clientPath(id)`, `async fetchBundle(request: Request): Promise<Response>`, `artifactBaseline(id)`, `rebuilt(id)`, `onRebuilt(listener)`, `onGraphChanged(listener)`. Serves bundles as a **prefix** route (`dsh-client-modules/lib/index.js:545-552`).
- **`apiGateway` / `dsh-api-*`** — the `dsh-api-*-controller` packages back the generated `ctx.remote.*` namespaces. `dsh-api-session-controller` alone *"owns the Host `ctx.sessionController` service and the generated Client `session`, `skills`, and `fileReferences` Remote namespaces"* (`README.md:13`).
- **`web`** — **not** an HTTP server: the web *access* (search/fetch) seam (`registerSearchProvider`, `registerFetchProvider`, `search`, `fetch`).
- **`webhookRuntime`** — `register(rule)`, `dispatch(delivery)`: fire-and-forget **inbound** webhook rules.
- **Base URL / port.** `ctx.webServer.port` / `.host` give the bound listener ✅; `ctx.connection.authenticatedUrl(baseUrl)` returns a token-bearing URL ✅. The client normally needs neither — it POSTs the relative path `api/<endpoint>` (`dsh-client-connection/lib/client.js:1222`). A static desktop page may instead supply `__DSH_TRANSPORT__.streamBaseUrl` (`dsh-client-connection/README.md:28`).

---

## 4. Client half

All of §4/§5/§7 is ⚠️ 未验证 (client inspect unreachable). Sources: shipped client bundles + packaged authoring docs.

### 4a. Client plugin entry

**Shape A — installed package with a `./client` bundle (this is `dsh-chat`'s shape).** Manifest (verbatim, from `dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/package.json`):
```json
{
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
  }
}
```
`dsh-chat/package.json:18-50` already matches this (`dsh.client.inject` = `dsh-client-connection`, `dsh-client-ui-slots`, `dsh-client-ui-layout`, `dsh-client-locale`). Semantics (`dsh-client-modules/README.md:34,46`): *"A browser plugin package declares `dsh.client` in its `package.json` with `platform: 'web'`, exports a `./client` bundle, and lists any non-baseline module requests under `dsh.client.external`."* … *"The shell seeds a frozen module table (`PLATFORM_MODULES`: React, Cordis, and static UI libraries); every dynamic bundle resolves its externals against exactly that baseline."* `dsh.client.inject` entries *"only order activation"* — they do **not** make those packages importable. `<id>/client` and the bare id resolve to the same exports, *"because a plugin bundle is its package's client half"* (`:38`).

**Bundle format** — must self-register with the page module table (verbatim, `dsh-im/plugin-src/client/build.mjs:17-43`; identical in `templates/decoration/client.js`):
```js
window.__ModuleLoader__.load({
  id: '@xmanrui/dsh-im',                 // MUST equal the package name
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    /* esbuild: bundle:true, format:'cjs', platform:'browser', target:['chrome100'], external:['react','react-dom'] */
    return module.exports;
  }
});
```
Output goes to `lib/client.js` (matching `exports["./client"]`). *"Executing a plugin bundle only registers its factory; every module-body side effect (CSS injection included) lives in the factory closure and runs at materialization (`factory(require)` → exports, memoized in `loadCache`)"* (`dsh-client-modules/README.md:68`) — **keep factories side-effect free**.

**The plugin object returned by the factory** (verbatim, `dsh-im/plugin-src/client/index.js:88-89`, `:452`): `export const name = 'im-settings'; export const inject = ['slots', 'connection', 'locale', 'workspaces']; export function apply(ctx) { … }` — i.e. `{ name?, inject?: string[], apply(ctx) }`, same verbs as a host plugin, but `ctx` is the client Context. Everything registered inside `apply` is fiber-owned; return a cleanup, or use `ctx.effect(cb, label)`.

**Shape B — dynamic runtime package ("dynamic Client half").** A plain-JS async function, **no imports / JSX / TypeScript**, receiving exactly the `Builtin` names (§7). Hosted by `dsh-cordis-client-runner`. **Not `dsh-chat`'s path.**

### 4b. RPC — how a client plugin calls host plugin code

Three mechanisms, not interchangeable.

**(1) `ctx.connection.rpc.call` — generic unary RPC over the authenticated `/api` carrier. This is what `dsh-chat` should use.** Client side, verbatim (`/tmp/dshx/…/dsh-client-connection/lib/client.js:1212-1236`):
```js
async call(channel, endpoint, payload, signal) {
  assertTarget(channel, endpoint);
  const rpcId = RpcId(randomUuid());
  const message = { type: "client-request", rpcId, method: endpoint, payload };
  const response = await send(`${channel}/${endpoint}`.slice(1), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(message), ...signal === undefined ? {} : { signal }
  });
  if (!response.ok) throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${response.status}`);
  const full = /* multipart ? parseBinaryResponse : parseConnectionResponse */(…);
  signal?.throwIfAborted();
  if (full.rpcId !== rpcId) throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`);
  return full.result;
}
// and the worker-local stream carrier (:1233-1239):
open(channel, endpoint, payload, signal, uplink) {
  assertTarget(channel, endpoint);
  if (channel !== "/api") throw new Error(`connection: worker-local streams require the /api channel, got ${JSON.stringify(channel)}`);
  return openStream(endpoint, payload, signal, uplink);
}
```
Contract: `ctx.connection.rpc.call(channel, endpoint, payload, signal?) → Promise<RpcResult>`; `channel` matches `/^\/[A-Za-z0-9._~-]+$/`, `endpoint` matches `/^[A-Za-z0-9_$.-]+$/` (`CHANNEL_PATTERN`/`ENDPOINT_SEGMENT_PATTERN`, `:1202-1203`). Resolves to the `result` envelope (`{ok:true,value}` / `{ok:false,error:{code,message,details:{}}}`) and **throws** on transport failure — unlike `ctx.remote`, which folds carrier problems into `{ok:false}`. Client wrapper (verbatim, `dsh-im/plugin-src/management-rpc.mjs:88`): `await connection.rpc.call('/api', rpcEndpoint(channel), { method, payload }, signal)`.

**(2) `ctx.remote.<namespace>.<method>()` — generated Typert RPC.** Client service `ctx.remote` (`ClientRemote`). *"Each unary call … sends the typed values through `ctx.connection.rpc.call('/api', endpoint, …)` without executing Client-side schemas"*; resolves to *"`RemoteResult<T>` — `{ ok: true, value }` or `{ ok: false, error }` — and never rejects for a carrier problem"* (`dsh-api-gateway/README.md:54,56`). Host methods are marked `@Remote` / `@RemoteScope` from `dsh-typert-protocol` on a `TypertRemoteService` subclass (`:27`); the client mounts generated contributions with `ctx.remote.$mount()` (`:52`). **Requires codegen** (§3.5) — do not adopt initially.

**(3) `host.call(method, args)` — dynamic Client half only.** *"Package-private JSON RPC from Client to this Package's Host half."* (`dsh-cordis-client-runner/lib/client.js:6162-6165`). Shape B only.

**Host-side handler registration for (1)** — the exact working pattern:
```js
// dsh-im/plugin-src/management-rpc.mjs:52-80 (abridged)
ctx.connection.fetch.register({
  path: `/api/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
  async fetch(request) {                     // DSH already applied auth + trust
    if (policy === 'loopback' && !isLoopbackRequest(request)) return new Response('forbidden', { status: 403 });
    if (request.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase() !== 'application/json')
      return new Response('content type must be application/json', { status: 415 });
    const message = await request.json();
    const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request';
    // validate { type:'client-request', rpcId, method, payload:{method,payload} }
    return Response.json({ type: 'server-response', rpcId, result: /* {ok:true,value}|{ok:false,error} */ });
  },
});
```
The envelope is mandatory: `type: 'server-response'`, echo the same `rpcId`, `result` shaped `{ok:true,value}` / `{ok:false,error:{code,message,details:{}}}` — the client rejects on rpcId mismatch and requires `error.details`. Register it under `ctx.inject(['connection'], …)` or with `connection` in the plugin's `inject` array.

### 4c. Client services, and registering your own

**Provided by the shipped composition** (⚠️, harvested from `ctx.provide(...)` / `ctx.reflect.provide(...)` across `dsh-client-*/lib/*.js`; the live client `Service.listService` directory would supersede this): `connection`, `theme`, `layout`, `locale`, `modules`, `resources`, `uiRenderer`, `userQuestionPanels`, `sidebarRight`, `sidebarRightTabs`, `pluginNavigation`, `documentPreviews`, `feedbackUi`, `chatFileMentions`. Plus domain services consumed by client packages (⚠️, call-site frequency in client bundles): **`uiConversation` (52 sites)**, **`sessions` (36)**, `uiWorkspace` (8), `uiSession` (7), `jobs` (4), `workspaces` (1), `commands` (1).

| Service | Why it matters for a chat/social UI |
| --- | --- |
| **`sessions`** | *The* client session store, provided by `dsh-api-session-controller/lib/client.js:3192` (`rootCtx.reflect.provide("sessions", this, void 0)`). How a full-page social feed reads session metadata without raw RPC. |
| `connection` | RPC carrier (§4b) + `ctx.connection.state`, `reconnect()`. |
| `layout` | Full-page routing: `selectPanel(id)`, `toggleSidebar()`, `openRightbar(track, fullscreen)`, `closeRightbar()`, `panelInfo`, `beginNavigation()`. |
| `theme` / `locale` | Token overrides (§5) / all visible text must be localized. |
| `uiConversation` | `events.register(definition)` / `events.registerFallback(definition)` for custom Chat rows. |
| `sidebarRight`, `sidebarRightTabs` | Tab registration for a right-hand social panel. |
| `pluginNavigation` | `openBundle(packageName)` — deep-link into Plugin Manager. |

**Client `sessions` contract** (⚠️, verbatim, `dsh-api-session-controller/README.md:48,74,76`): *"`sessions.retain(target, { source, signal? })` immediately acquires one exact Client generation and starts its shared initial history opening… The returned reference supports idempotent `release()` and `Symbol.dispose`; its `ready` Promise follows the shared `Session.open()` result… `sessions.using(target, options, operation)` waits for that settlement, holds its reference until the callback settles."* Also `binding(id)` / `scope(id)` — *"only borrow an existing generation"* — and `retainInfo(id)` — *"observes stable read-only source counts independently of catalog membership and performs no history I/O."* The controller's `list` is a snapshot store (`{ ids, byId, phase, projectionsBySession }`, `lib/client.js:3165-3170`). **There is no client-side notifications/toasts service in the provided set** — ⚠️ unconfirmed rather than disproved; build in-slot UI instead.

**Registering a client-side service** (⚠️) — use `ctx.provide(name, value)`, which returns a disposer: `ctx.provide("theme", theme)` (`dsh-client-ui-theme/lib/client.js:1582`), `ctx.reflect.provide("layout", layout)` (`dsh-client-ui-layout/lib/client.js:600`), `ctx.reflect.provide("sessions", this, void 0)` (`dsh-api-session-controller/lib/client.js:3192`). Real precedent (`dsh-im/plugin-src/client/index.js:609-616`):
```js
if (typeof ctx.provide === 'function') {
  ctx.provide('dshImClient', Object.freeze({
    version: 1, render: (props) => disposed ? null : buildPanelElement(props),
    setSettingsVisible, settingsVisible: () => !disposed && registered,
  }));
}
```
Feature-detect (`typeof ctx.provide === 'function'`) — it is not guaranteed on every client Context.

**Client events** (⚠️). Emitted by shipped packages: `theme/change`, `locale/change`, `slots/changed`, plus `connection/reset` (documented in `dsh-api-gateway/README.md:58,66` as the reconnect signal). Listen with `ctx.on(name, listener)` — the restricted client `ctx` exposes exactly `ctx.get`, `ctx.on`, `ctx.provide`, `ctx.effect` (`dsh-cordis-client-runner/lib/client.js:6143-6150`).

### 4d. Slot topology

Registration API (⚠️, implementation `dsh-client-ui-slots/lib/index.js:163`):
```js
ctx.slots.register(options, component)     // returns disposer
ctx.slots.inject(ownerKey, () => { … })    // late-bound; reinstalls when the owner redeclares
ctx.slots.entries(key) / .subscribe(key, l) / .getVersion(key) / .snapshot(root?)
ctx.slots.registerFactory(definition)      // reusable Component Factory
```
`options` (verbatim, `lib/index.js:195-214`): `key?`, `id?`, `order?`, `label?`, `priority?`, `select?`, `inject?`, `children?`, `store?`, `locale?`, `registrant?`. **Slot kinds** (verbatim validation, `:169-191`) decide which option is mandatory:

| kind | requires | note |
| --- | --- | --- |
| `single` | — | one occupant per `priority`; a second throws |
| `keyed` | `key` | dispatch by key; one entry per `(key, priority)` |
| `list` | `id` | ordered by `priority` then `order` |
| `chain` | `select` | entries elect themselves; selectors run ascending `priority` |

*"Declaring a slot is claiming it: the registering entry becomes the only entry allowed to render that key, and registering into an undeclared slot … throws at load"* (`dsh-client-ui-slots/README.md`). Root slot `'root'` is seeded a priori. Inspect `Slots` trees use `type: 'slot' | 'factory'` nodes and nest Factory-owned child slots under their definition.

**Global app shell / nav.** Declared by `dsh-client-ui-layout` (verbatim, `dsh-client-ui-layout/lib/client.js:601-625`):
```js
ctx.slots.register({ name: "root", locale: "common", children: {
  "sidebar":       { kind: "single", scope: "root" },
  "main":          { kind: "keyed",  scope: "root" },
  "rightbar":      { kind: "single", scope: "root" },
  "shell.overlay": { kind: "list",   scope: "root" },
  "shell.leading": { kind: "single", scope: "root" },
} }, AppFrame);
```
Prose (`dsh-client-ui-layout/README.md:32`): *"Global panels occupy the root-scoped `main` keyed slot; `conversation` is the reserved key for the Conversation. `ctx.layout.selectPanel(id)` selects a registered panel, and `null` selects the Conversation without changing the current Session. No global panel is registered by the shipped composition."* Other shell seats: `shell.leading` (top-left, macOS-only, occupied by ui-sidebar), `shell.overlay` (list), `shell.quota-notice`, `sidebar.*`, `rightbar*`, `sidebar.panellist`, `sidebar.footer.action`, `sidebar.settings`, `sidebar.toggle.badge`.

**➜ FULL-PAGE / ROUTE SLOT: `main` (keyed).** This is `dsh-chat`'s page. Exact working pattern (verbatim, `dsh-im/plugin-src/client/plugin-page.js:36-58`):
```js
export function installImPluginPage(ctx, { packageName, renderPanel }) {
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['layout', 'pluginNavigation'], (pageCtx) =>
    pageCtx.slots.inject('main', () => {
      const unregisterPage = pageCtx.slots.register({
        name: 'main', key: IM_MAIN_PANEL_ID, locale: IM_LOCALE_NAMESPACE,
        inject: () => ({ renderPanel, onBack: () => pageCtx.pluginNavigation.openBundle(packageName) }),
      }, ImPluginPage);
      const stopActions = pageCtx.slots.inject('plugins.detail.actions', () =>
        pageCtx.slots.register({ name: 'plugins.detail.actions', id: 'xmanrui-dsh-im-open', order: 20,
          locale: IM_LOCALE_NAMESPACE,
          inject: () => ({ packageName, onOpen: () => pageCtx.layout.selectPanel(IM_MAIN_PANEL_ID) }) }, OpenImAction));
      return () => { stopActions(); unregisterPage(); };
    }));
}
```
Register a `main` entry with `key: <yourPanelId>`, then navigate with `ctx.layout.selectPanel(<yourPanelId>)`. `selectPanel` validates the live registry — *"an absent key throws and leaves the current panel intact"* (`:55`).

**Session page — header actions.** Declared by `dsh-client-ui-conversation` (verbatim, `lib/client.js:18262-18279`):
```js
"conversation.session.header.actions":   { kind: "list",   scope: "session" },
"conversation.session.header.utilities": { kind: "list",   scope: "session" },
"conversation.session.header.lineage":   { kind: "single", scope: "session" },
"conversation.session.header.corner":    { kind: "single", scope: "session" },
```
`conversation.session.header.actions` is the natural home for a **"分享此会话"** button — register with `{ name, id, order, locale, inject }`.

**Session page — side panels.** `rightbar` (single, root) plus the `sidebar.right.*` family: `sidebar.right.pane.tab` (+ `.title`), `sidebar.right.tab.document` (+ `.action` / `.actions` / `.unpreviewable` / `.office.pdf`), `sidebar.right.tab.files.actions`, `sidebar.right.tab.guide` (+ `.entry`), `sidebar.right.tab.menu.item`. Register right-panel tabs through `sidebarRightTabs` / `sidebarRight` and open with `ctx.layout.openRightbar(track, fullscreen)`. Left-side social list: `sidebar.panellist`, `sidebar.chat.conversation`.

**Session page — composer area.** Declared at `dsh-client-ui-conversation/lib/client.js:18163-18325` (verbatim):
```js
"conversation.composer.bar": { kind: "list", scope: "session" }
  children: {
    "conversation.input.attachments": { kind: "single", scope: "session-maybe" },
    "conversation.input.overlay":     { kind: "list",   scope: "session" },
    "conversation.input.permission":  { kind: "single", scope: "session" },
    "conversation.input.left":        { kind: "list",   scope: "session" },
    "conversation.input.plan":        { kind: "single", scope: "session" },
    "conversation.input.right":       { kind: "list",   scope: "session" },
    "conversation.input.model":       { kind: "single", scope: "session" },
    "conversation.input.activity":    { kind: "single", scope: "session" },
    "conversation.composer.dock":     { kind: "list",   scope: "session" },
  }
```
`conversation.composer.dock` is the documented low-risk seat for a simple decoration (`references/ui-plugin.md`); `conversation.input.right` / `.left` are the right seats for a composer action button. Also `conversation.composer`, `conversation.input.dock`, `conversation.chat.node` (+ `.turnTail`, `.assistant-actions`, `.commandview`), `conversation.view`, `conversation.message.images`, `conversation.trajectory.images`, `conversation.plan-review.actions`, `conversation.approval.detail`, `conversation.hero.*`, `conversation.header*`.

**Settings page.** Declared by `dsh-client-ui-settings-general` (verbatim, `lib/client.js:1136-1143`):
```js
"settings.section":    { kind: "list", scope: "root" },
"settings.onboarding": { kind: "list", scope: "root" },
"settings.close":      { kind: "single", scope: "root" },
```
Canonical registration with a child slot (verbatim `lib/client.js:1171-1179`; working plugin at `dsh-im/plugin-src/client/index.js:588-598`):
```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section",
  id: "dsh-chat",                 // list kind ⇒ id required
  order: 21,                      // after general(0), agent-presets(20)
  label: () => t("dshChat.nav"),
  locale: "dshChat",
  children: { "settings.general.item": { kind: "list", scope: "root" } },   // optional sub-seat
  inject: () => ({ /* business props */ }),
}, DshChatSettingsSection));
```
Others: `settings.header`, `settings.action`, `settings.trigger`, `settings.launcher`, `settings.models.*`, `settings.plugins.tab`, `plugins.*`.

**How to read props.** Every registered component receives five framework shares — *"the runtime share (`owner` from the parent's render call site, plus the session standard kit and global seat), the child-render share (`renderSlot` statically narrowed to declared children), the Factory-render share (`renderFactorySlot`), the store share (the declared handle's selector hook and draft-stripped actions), and the business share (inferred from `inject`)"* (`dsh-client-ui-slots/README.md`). Declare business props via `inject: () => ({…})` (a thunk, so resolution is lazy and re-runs on redeclaration). **Read session data through the selector hooks, subscribing to the smallest slice** (`practices.md`).

**Custom Chat rows.** Documented route (`practices.md`): *"Add a Chat row by registering an event definition with `ctx.uiConversation.events.register()` and its view in the `conversation.chat.node` slot under the definition's `kind`, which is the renderer key; the Conversation layer owns paging, Turn and Step placement, and incremental assembly."* Verified registry API (`dsh-client-ui-conversation/lib/client.js:2654-2676`): `register(definition)` (`definition.kind` must be unique; throws on duplicate) and `registerFallback(definition)` (exactly one; `definition.target` required).

**Full unique slot key list — 90 keys** (⚠️ source-derived; `slots.inject('<key>')` call sites across all `dsh-client-*/lib/*.js`): `conversation.approval.detail`, `conversation.chat.assistant-actions`, `conversation.chat.commandview`, `conversation.chat.node`, `conversation.chat.turnTail`, `conversation.composer`, `conversation.composer.bar`, `conversation.composer.dock`, `conversation.header`, `conversation.header.leading`, `conversation.hero.agentPreset`, `conversation.hero.brand.mark`, `conversation.hero.workspace`, `conversation.hero.workspace.directoryFlow`, `conversation.input.activity`, `conversation.input.attachments`, `conversation.input.dock`, `conversation.input.left`, `conversation.input.model`, `conversation.input.overlay`, `conversation.input.permission`, `conversation.input.plan`, `conversation.input.right`, `conversation.message.images`, `conversation.plan-review.actions`, `conversation.session`, `conversation.session.header`, `conversation.session.header.actions`, `conversation.session.header.corner`, `conversation.session.header.lineage`, `conversation.session.header.utilities`, `conversation.trajectory.images`, `conversation.view`, `deliverables.file.actions`, `deliverables.review.file.actions`, `main`, `main.conversation`, `plugins.bundle.activation`, `plugins.bundle.config`, `plugins.detail.actions`, `plugins.detail.badge`, `plugins.detail.section`, `plugins.item`, `plugins.row.config`, `rightbar`, `rightbar.session`, `root`, `settings.action`, `settings.close`, `settings.general.item`, `settings.header`, `settings.launcher`, `settings.models.footer`, `settings.models.provider-card`, `settings.models.sign-in`, `settings.onboarding`, `settings.plugins.tab`, `settings.section`, `settings.trigger`, `shell.leading`, `shell.overlay`, `shell.quota-notice`, `sidebar`, `sidebar.brand.mark`, `sidebar.brand.name`, `sidebar.chat.conversation`, `sidebar.footer.action`, `sidebar.panellist`, `sidebar.right.pane.tab`, `sidebar.right.pane.tab.title`, `sidebar.right.tab.document`, `sidebar.right.tab.document.action`, `sidebar.right.tab.document.actions`, `sidebar.right.tab.document.office.pdf`, `sidebar.right.tab.document.unpreviewable`, `sidebar.right.tab.files.actions`, `sidebar.right.tab.guide`, `sidebar.right.tab.guide.entry`, `sidebar.right.tab.menu.item`, `sidebar.session.row.hover`, `sidebar.session.row.leading`, `sidebar.settings`, `sidebar.toggle.badge`, `sidebar.workspaces`, `sidebar.workspaces.directoryFlow`, `sidebar.workspaces.session.menu.item`, `sidebar.workspaces.session.row.action`, `tool.call.images`, `tool.call.toolview`, `tool.view.cordis`.

---

## 5. Theme

⚠️ 未验证 (client `Theme.listTokens` timed out). Source: `dsh-client-ui-theme`.

**Token prefix is `--dsw-`, not `--dsh-`.** 403 distinct `--dsw-*` names appear in `dsh-client-ui-theme/lib/client.js`. (One unrelated variable does use `--dsh-`: `--dsh-content-font-size`.)

- **`--dsw-alias-*` — the semantic, theme-aware layer, and per `practices.md` the ONLY styling surface a plugin may use:** *"Style with the theme tokens that `cordis_inspect_query` `Theme` lists (`--dsw-alias-*`); literal colors are for artwork only."* Examples: `--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1|2|3`, `--dsw-alias-bg-overlay`, `--dsw-alias-bg-mask-1|2|3`, `--dsw-alias-border-l1|l2|l3|l4`, `--dsw-alias-brand-primary`, `--dsw-alias-brand-text`, `--dsw-alias-label-primary|secondary|tertiary|caption|dimmed|inverted|primary-foreground`, `--dsw-alias-link`, `--dsw-alias-state-error-primary`, `--dsw-alias-state-success-primary`, `--dsw-alias-state-warn-primary`, `--dsw-alias-interactive-bg-hover|active`, `--dsw-alias-button-primary-fill|hover`, `--dsw-alias-toast-bg|label`, `--dsw-alias-tooltip-bg`, `--dsw-alias-settings-card-fill|stroke`, `--dsw-alias-scrollbar-bg-l1|l2`, `--dsw-alias-markdown-*`, `--dsw-alias-code-diff-*`, `--dsw-alias-turn-trigger-bg`, `--dsw-alias-menu-*`, `--dsw-alias-onboarding-*`.
- **`--dsw-static-*` — raw palettes** (`neutral-*`, `neutral-bluish-*`, `deepseek-*`, `blue-*`, `red-*`, `green-*`, `amber-*`). **Not theme-aware** — avoid for surfaces.
- **`--dsw-font-*`** — composite families (`--dsw-font-base-16`, `--dsw-font-s-14`, `--dsw-font-markdown-*`, …) each with `-font-family` / `-font-size` / `-font-weight` / `-line-height` sub-tokens, plus `--dsw-font-family`, `--dsw-font-family-brand`.
- `--dsw-radius-xs|sm|md|lg|xl|panel`, `--dsw-elevation-soft|panel|prominent|stroke`, `--dsw-shadow-lv1|lv2|lv3`, `--dsw-focus-ring-color|width`, `--dsw-mask-blur`, `--dsw-menu-backdrop-filter`, `--dsw-corner-shape`, `--dsw-specific-*`.

**Light/dark override is MANDATORY and runtime-enforced.** Every override is a `{ light, dark }` **pair of strings**; a bare string throws a teaching error (verbatim, `dsh-client-ui-theme/lib/client.js:1540-1556`):
```js
function validateOverrides(source, tokens) {
  const validated = {};
  for (const [name, value] of Object.entries(tokens)) {
    if (typeof value === "string") throw new TypeError(`theme override "${name}" from "${source}" is a bare string — pass { light: ${JSON.stringify(value)}, dark: ${JSON.stringify(value)} } (repeat the value when it is the same in both palettes); a single value goes illegible when the user switches color scheme`);
    if (typeof value !== "object" || value === null || typeof value.light !== "string" || typeof value.dark !== "string") throw new TypeError(`theme override "${name}" from "${source}" must map to a { light, dark } pair of strings — one value per color scheme`);
    …
  }
  return validated;
}
```
Selection happens in `composeActive` (`:1508-1512`): `for (const layer of [...this.overrides.values()].sort((a,b) => a.seq - b.seq)) for (const [name, modes] of Object.entries(layer.tokens)) tokens[name] = modes[active.colorScheme];` — the **last-registered layer wins per token**, and `colorScheme` is the resolved `light`/`dark` (`system` resolves through `prefers-color-scheme`, `:1498`).

**Two registration APIs** (verbatim signatures, `:1446`, `:1474`):
```js
ctx.theme.register(definition)             // { id, colorScheme, tokens }; duplicate id throws;
                                           // "system" is not a registrable id; returns a disposer
ctx.theme.overrideTokens(source, tokens)   // source = layer identity (use your package id);
                                           // tokens: { [tokenName]: { light: string, dark: string } }
                                           // re-calling with the same source replaces its whole layer
```
`ctx.theme` is provided at `:1582` (`ctx.provide("theme", theme)`) — reach it with `ctx.get('theme')` + undefined check, or `inject: ['theme']`. `overrideTokens` is the documented extension point: *"Third-party themes can register alias-token overrides through `ctx.theme`; the override layer folds into the active snapshot's tokens in registration order"* (`README.md`). Also: `setTheme(id)`, `exportInspectTokens()` (`:1397`, what `listTokens` returns), `theme/change`.

**What `listTokens` returns** (⚠️, from `exportInspectTokens` at `:1397-1401`): every `BUILTIN_INSPECT_TOKENS` entry (`:1234`) plus a dynamic entry per token any registered theme/override adds. Each token is `{ name, description, valueType, requiresLightAndDark, cssVariable? }` — e.g. `{ name: "--dsw-alias-bg-base", description: "Application base background.", valueType: "CSS color", requiresLightAndDark: true, cssVariable: "--dsw-alias-bg-base" }`. Dynamic tokens get `description: "Theme token registered by the current Client composition."`, `valueType: "CSS value"`, `requiresLightAndDark: true`.

**Rule for `dsh-chat`:** consume tokens as plain CSS `var(--dsw-alias-…)`; override only via `ctx.theme.overrideTokens('dsh-chat', {…})` with both palettes supplied; never hard-code a colour outside artwork.

---

## 6. Persistent storage and Config

### 6.1 Where a plugin stores data

The DSH user-data root is **`$DSH_HOME`, default `~/.dsh`**. Resolution order — *"An explicit path wins over `$DSH_HOME`, which wins over `~/.dsh`; blank environment values are ignored"* (`dsh-home-paths/README.md:12`). Public helpers (`dsh-home-paths/lib/index.js:107`): `defaultDshHome`, `resolveDshHome`, `dshHomePath`, `dshHomeDisplay`, `dshCachePath`, `expandHomePath`, `canonicalizeWatchPath`, `DSH_HOME_DIR_NAME`, `DSH_HOME_ENV`, `DEFAULT_DSH_HOME_DISPLAY`. Use it *"as a direct library dependency, not through `cordis.yml`"* (`:12`).

Live `~/.dsh` ✅ 实测: `.credentials.yaml`, `.anonymous-user-id`, `.agent-presets/`, `.dsh-memory/`, `dsh-pocket/`, `dsh-runtimes/`, `attachments/`, `cache/`, `im/`, `integrations/`, `llm-deepseek/`, `logs/`, `speech-to-text/`, `profiles/desktop/`, `sessions/`, **`storages/`**. Live `~/.dsh/storages/` ✅ 实测: `workspace.json`, `session_projcache.json`, `session_projcache/sessions/*.json` — exactly the `single` + `per-record` layouts below.

**Three sanctioned mechanisms, in order of preference.**

**(a) `ctx.storageDomain` + `dsh-storage-json` — recommended for `dsh-chat`'s durable social data.** Already wired in the shipped base composition (`/tmp/dshz/…/dsh-base/cordis.patch.yml:166-179`, verbatim):
```yaml
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-json
  name: '@deepseek-ai/dsh-storage-json'
  config:
    root: !!js dshHomePath('storages')
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
```
So `ctx.storageDomain` is live and the JSON backend root is `~/.dsh/storages` ✅ 实测. Declare once in the owning package, open per feature (verbatim, `dsh-storage-domain/README.md:38-58`):
```js
const chatSpec = defineDomain({
  name: 'dsh_chat', version: 1,
  tables: { friends: domainTable(friendRecordSchema), shares: domainTable(shareRecordSchema) },
});
const domain = await ctx.storageDomain.open(chatSpec);
await domain.table('shares').put(id, { /* … */ });
const record = domain.table('shares').get(id);          // synchronous, from memory
domain.table('shares').update(id, (r) => ({ ...r, title }));
// release with domain.close() in your own ctx.effect disposer
```
Facts (verbatim, `dsh-storage-domain/README.md:87,94`; `dsh-storage-json/README.md:12,36,50,56,72,88`): *"Record schemas are **zod**, so `z.infer` avoids duplicating consumer types; plugin `Config` stays schemastery."* · `open()` fails wholly on `already-open`, `backend-not-found`, `facet-unsupported`, `version-mismatch`, `malformed-medium`, `invalid-record`; only the `kv` facet exists. · *"No data migration — a domain whose stored version differs from its spec rejects at open."* · Layouts: `single` → one complete `<root>/<unit>.json` (`{ "unit": {"name","version"}, "version", "global"?, "tables": {…} }`); `per-record` → one document per record at `<root>/<unit>/<table>/<key>.json` shaped `{ "version", "record" }`, plus optional `<root>/<unit>/global.json`. **The spec selects the layout; the plugin has no override.** · Record keys must match `[a-zA-Z0-9_-]+`; unsafe keys reject before any file operation. · Durability: *"A write uses a temporary file, fsync, atomic `rename()` replacement, and a parent-directory fsync on POSIX."* · Root is created `0o700` on demand; `root` has **no** `process.cwd()` fallback. · ⚠️ *"The unit does not serialize concurrent writes — ordering belongs to the caller."* Serialize `dsh-chat`'s writes. · Layer separation: `ctx.storage` is the hub (`backend`, `mount(form, facility)`, `form(form)`); `ctx.storageDomain` is the domain facility (`open(spec)`, `get(name)`, `closeAll()`); *"A mounted data form resolves as `ctx.storage.<form>`; the domain form is additionally served directly as `ctx.storageDomain`"* (`dsh-storage/README.md:51`).

**(b) `ctx.credentials` — secrets only.** `dsh-im` adapts the *"real DSH `ctx.credentials` seam"* (`plugin-src/host/channels/feishu/credential-store.mjs:27`); the local provider persists to `$DSH_HOME/.credentials.yaml` ✅ 实测 (file present at `/Users/twoants/.dsh/.credentials.yaml`; also `dsh-client-connection/README.md:41`). Contract ✅ 实测: `resolve`, `describe`, `set`, `unset`, `readRecord`, `describeRecord`, `listRecords`, `modifyRecord`, `deleteRecord`. Use for `dsh-chat` node identity keys / relay tokens — never bulk social data.

**(c) A profile-relative directory — the `dshmarket` precedent.** `dshmarket` computes `join(profileDir, '.dsh-market', 'state.json')` (`dshmarket/lib/hot.js:199`; `HOT_DIR = '.dsh-market'` at `:83`), where `profileDir` defaults to `join(resolveDshHome(), 'profiles', profile)` (`dshmarket/lib/profile.js:32-40`). Live result: `/Users/twoants/.dsh/profiles/desktop/.dsh-market/{state.json,log.ndjson}` ✅ 实测. This is a **market-specific convention, not a framework contract** — it works because the market owns both halves of the path. Prefer (a).

Also present: `~/.dsh/profiles/desktop/data/roleplay_data/{transcripts,roleplay}` ✅ 实测. ⚠️ **Not attributable:** grepping the entire profile `node_modules` for `roleplay_data` returns **nothing**, so no shipped or installed plugin computes that path. Treat `<profile>/data/<plugin>/` as a directory that *exists* but is **not** a documented or framework-provided convention. Packaged guidance is explicitly against hand-making profile paths: *"Do not write the profile's `package.json` or `cordis.patch.yml`, create packages under `$DSH_HOME`, or run pnpm in the profile directory"* (`SKILL.md`).

**Recommended for `dsh-chat`:** durable social/graph/relay state → `ctx.storageDomain` (lands under `~/.dsh/storages/dsh_chat…`, atomic + schema-validated); secrets/identity → `ctx.credentials`; per-process caches → in-memory maps. **Do not** invent `<profile>/data/dsh-chat/` and do not write into `~/.dsh` directly.

### 6.2 Plugin Config in a host half ⚠️

Export form (verbatim, `references/host-plugin.md`): *"`index.js` exports one of these forms; do not mix them: — `export function apply(ctx, config) {}` with optional `export const inject = ['tools']` and `export const Config`. — A service class as the default export."* And: *"A plugin that declares `Config` validates the row's `config` at activation; query `Config.listConfigs` for an installed plugin's schema before writing its `config`, and follow `$defs` references in the returned document."*

**Schema library: schemastery, as the default `z` export.** Plugin `Config` is **schemastery**; `ctx.storageDomain` record schemas are **zod** (`dsh-storage-domain/README.md:87`). Idiomatic form (verified across 8+ shipped packages, e.g. `dsh-agent-default-model/lib/index.js:2,21`):
```js
import z from "@deepseek-ai/schemastery";

export const Config = z.object({
  host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required(),
  port: z.natural().max(65535).required(),
  compression: z.union([z.const("none"), z.const("gzip")]).default("none"),
});
export function apply(ctx, config) { /* config is the validated, defaulted object */ }
```
A service class instead uses `static Config = z.object({…})` (`dsh-host-webserver/lib/index.js:141`, `dsh-api-gateway/lib/index.js:596`, …). Observed schemastery vocabulary: `z.object`, `z.string`, `z.boolean`, `z.natural()`, `z.number().step(1).min(0).max(9)`, `z.union([z.const(x), …])`, `.required()`, `.default(v)`. `dsh-im` reaches config via `apply(ctx, config = {})` (`plugin-src/host/index.mjs:213`) and namespaces per-channel sub-configs (`channelConfig(config, name, deliveryService)`, `:34`) — a good pattern for `dsh-chat`'s per-feature settings (share / live / relay).

**Declaring the row.** `cordis.patch.yml` is a top-level YAML array of loader patch entries. `dsh-chat`'s patch is already correct (`/Users/twoants/DeepSeek WorkSpace/dsh-chat/cordis.patch.yml:12-14`):
```yaml
- insert:
    - id: dsh-chat
      name: dsh-chat
```
`config` is optional and *"a matching override replaces the complete `config`"* (`host-plugin.md`). The dialect also expresses `disabled: true/false` and `!!js` expressions — both used in the live profile (`/Users/twoants/.dsh/profiles/desktop/cordis.patch.yml:4-59`). **A user's patch layer survives upgrades** (`practices.md`).

**Reading/writing config at runtime** ✅ 实测: `ctx.configEditor` — *"Persist complete raw configs and apply them through the normal Loader path."*
```ts
entries(): Entry[]
configuration(): Array<{ entry: Entry; inherited: Record<string, unknown>; override: Record<string, unknown> }>
async edit(entry: Entry, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void>
```
Use `edit` for "remember this setting" writes; the returned `override` is the user's patch layer. For client-side settings the shipped pattern is the `ui-theme` settings namespace: *"A loopback client stores both values in the `ui-theme` settings namespace, which the local provider persists in `$DSH_HOME/cordis.patch.yml` by default"* (`dsh-client-ui-theme/README.md`).

**Manifest extras** (verbatim, `host-plugin.md`): display text in `locale/en.json` + `locale/zh.json`; icon as top-level `"icon": "./icon.svg"` (relative; SVG/PNG/JPEG/WebP ≤ 256 KiB; absolute paths, URLs, escapes and symlinks rejected); and `"exports": { "./package.json": "./package.json", "./locale/*.json": "./locale/*.json" }`. ⚠️ `dsh-chat/package.json` currently exports **neither** `./package.json` nor `./locale/*.json`, so Plugin Manager / Settings could not read its manifest metadata or locale files — add both before shipping localized UI text.

---

## 7. Client UI building blocks

⚠️ 未验证 (client `Builtin.listBuiltins` timed out). Authoritative source: the provider's own registry at `/tmp/dshz/…/dsh-cordis-client-runner/lib/client.js:6141-6176`.

### 7.1 Is React available? Yes — via the module table, not a global

*"React comes from the browser module table; no duplicate React installation, CDN script, or UMD search is needed."* (`references/ui-plugin.md`.) Confirmed by the shell's seed table: *"The shell seeds a frozen module table (`PLATFORM_MODULES`: React, Cordis, and static UI libraries); every dynamic bundle resolves its externals against exactly that baseline."* (`dsh-client-modules/README.md:46`.)

**How to obtain it (installed plugin — `dsh-chat`'s shape):** `const React = require('react'); const h = React.createElement;` — no JSX transform at runtime. `require('react')` / `require('react-dom')` resolve against `PLATFORM_MODULES`; the canonical template does exactly this (verbatim, `templates/decoration/client.js:3-5`).

Version: `dsh-im` pins **React 18.3.1** as a *devDependency* for building/testing its client bundle (`package.json`: `"react": "18.3.1"`, `"react-dom": "18.3.1"`, `"react-test-renderer": "18.3.1"`) and keeps `react`/`react-dom` **external** in esbuild (`plugin-src/client/build.mjs:19`) — the runtime instance is the shell's. ⚠️ The exact runtime React version was not read from the live page (inspect down); do not rely on React 19-only APIs.

For a dynamic Client half (Shape B), React arrives as an injected name instead: *"It receives a fixed set of names — `React`, `console`, `styles`, and `host` — while browser globals like `fetch` and `setTimeout` are unavailable."* (`dsh-cordis-client-runner/README.md`.)

### 7.2 The `Builtin` list — exactly five symbols

Verbatim from `dsh-cordis-client-runner/lib/client.js:6141-6176`:

| Name | Description (verbatim) | Signatures |
| --- | --- | --- |
| `ctx` | *"Restricted Cordis Context. Prefer ctx.get(name) with an undefined check; use inject only for hard dependencies."* | `ctx.get(name: string): unknown \| undefined`; `ctx.on(name: string, listener: Function): () => void`; `ctx.provide(name: string, value: unknown): () => void`; `ctx.effect(callback: Function, label?: string): () => void` |
| `React` | *"React runtime exposed without JSX transformation."* | `React.createElement(type, props, ...children): ReactElement`; `React.useState(initial)`; `React.useEffect(effect, deps)` |
| `host` | *"Package-private JSON RPC from Client to this Package's Host half."* | `host.call(method: string, args?: JsonValue): Promise<JsonValue>` |
| `styles` | *"Package-owned stylesheet insertion cleaned up with the Client run."* | `styles.insert(css: string): () => void` |
| `console` | *"Package-tagged browser logging."* | `console.log(...values): void`; `console.error(...values): void` |

The list is **closed** — no component library, no icon set, no JSX runtime, no `fetch`/`setTimeout`, no CSS-in-JS. `ctx`, `React`, `styles`, `console` are Shape-B injections; `host.call` is Shape-B only.

### 7.3 UI primitives are NOT available. Write your own.

`@deepseek-ai/dsh-client-ui-primitives` exists in the tree (`/tmp/dshz/…/dsh-client-ui-primitives/`), but importing it is **explicitly forbidden** (verbatim, `references/practices.md`, UI section):

> *"Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client package as a module; `dsh.client.inject` entries only order activation and stay allowed. They change without notice, a plain-JS plugin has no type check, and a throwing component blanks your slot entry (console: `slot entry crashed in '<slot>'`). Write your own controls and match the host instead: copy markup, CSS, and behavior from the primitive into the plugin (`src/*.tsx` and `*.module.css` in a DSH source checkout, or the installed package's `lib/index.js` and `lib/**/*.css`), or inspect the rendered host control in the connected page. Rename copied classes under your plugin's prefix, keep only `--dsw-alias-*` token references, and keep the behavior that users rely on, such as Modal focus and Escape handling, `role="switch"` with `aria-checked`, and Tooltip placement. Tokens then remain the only shared styling dependency."*

The same rule is in `SKILL.md`'s verification checklist: *"the plugin imports no Harness Client package such as `@deepseek-ai/dsh-client-ui-primitives`"*. Note the asymmetry: `dsh-chat/package.json:33-38` lists four `@deepseek-ai/dsh-client-*` packages under `dsh.client.inject`. That is **legal** — those entries only order activation — but they must never appear in a `require(...)` call.

**Exactly what a `dsh-chat` client half may use for rendering:** (1) `require('react')` / `require('react-dom')` from `PLATFORM_MODULES`; (2) `React.createElement` — JSX is unavailable **at runtime**, but precompiling JSX in `scripts/build.mjs` is fine (the shipped format is plain CJS; the transform is your build's choice); (3) your own CSS — injected from the factory via `styles.insert(css)` (Shape B) or compiled into `lib/client.js` by esbuild (Shape A), cleaned up on fiber disposal; (4) host theme tokens as `var(--dsw-alias-*)`; (5) client services from §4c via `ctx.get(name)` (feature-detect) or `inject`; (6) slots from §4d; (7) the client locale service for all visible text.

**Additional hard rules for the client half** (verbatim, `practices.md` / `ui-plugin.md`): *"Render plugin pages as React components in a slot. Do not serve an HTML page from the Host and embed it in an iframe: an iframe document does not receive the host's theme tokens, light/dark switching, or `ctx.locale`."* — this **rules out** the obvious "ship a web app over HTTP and iframe it" design for `dsh-chat`'s UI. · *"Do not write DOM outside your component or append to `document.body`."* · *"Do not replace the app root or append a second application to `document.body`."* · *"Do not read another plugin's DOM, stylesheet, or component source to estimate placement; choose a slot that already allocates space."* · *"Keep factories free of side effects. Register styles, timers, listeners and other resources inside `apply` with `ctx.effect`/`ctx.on` and return their cleanup functions."* · *"Route visible UI text through the Client locale service."*

### 7.4 Derived state: use projections, not rescanning

*"When the Client needs a value derived from a session, declare `wire.view` on the Host projection. The value reaches the Client already computed; the Client does not fold session events itself."* And per-session state belongs in a `ctx.sessionProjections` unit rather than a `session/event` subscription that rescans: *"`apply(state, event)` is pure and synchronous and returns the same reference for events it ignores… Keep projection state plain JSON and bump `stateVersion` when fields or fold semantics change."* (`practices.md`, Performance.) This matters directly for `dsh-chat`'s shareable session summaries.

---

## 8. Decisions and open unknowns for `dsh-chat`

| Question | Answer |
| --- | --- |
| Session read API | `ctx.sessionQuery.readSession/listEvents/readSurface/listSessions/observeSession` — ✅ 实测; takes no write ownership |
| Session live feed | `ctx.on('session/event', (session, event) => …, { global: true })` — post-commit, fire-and-forget, synchronous in the append path ✅ (prior verified report) |
| Token streaming | `ctx.on('agent/assistant-stream', ({ agent, frame }) => …, { global: true })` ✅ (prior verified report) |
| Durable session bytes | `ctx.sessionPersistence.list/stat/open(id,'read')` only ✅ |
| Serve HTTP | `ctx.webServer.register({ kind:'exact'\|'prefix', path, handler(req,res) })` — **raw node:http** ✅ 实测 |
| Serve SSE | **Yes** — handler owns `res`; SSE explicitly excluded from gzip (`dsh-host-webserver/lib/index.js:113`, `README.md:41`); wrap in `ctx.effect` ✅ |
| Serve WebSocket | `ctx.webServer.registerUpgrade({ path, handler(req, socket, head) })` — raw socket; you do the handshake ✅ 实测 |
| Authenticated RPC route | `ctx.connection.fetch.register({ path:'/api/dsh-chat/…', methods:['POST'], requestBody:'buffered', fetch(req) })` ✅ 实测 (live precedent) |
| Client → host call | `ctx.connection.rpc.call('/api', 'dsh-chat…', { method, payload }, signal)` → `{ok:true,value}\|{ok:false,error}`; throws on transport failure ✅ 实测 |
| Client entry | `lib/client.js` = `window.__ModuleLoader__.load({ id:'dsh-chat', factory(require){ … return { name, inject, apply(ctx) } } })` ✅ source-verified |
| React | `require('react')` from `PLATFORM_MODULES`; external in esbuild; no JSX at runtime ✅ source-verified |
| Full-page UI | keyed `main` slot + `ctx.layout.selectPanel(key)` ✅ source-verified |
| Settings page | `settings.section` (list, root) with `{ name, id, order, label, locale, inject }` ✅ source-verified |
| Session header action | `conversation.session.header.actions` (list, session) ✅ source-verified |
| Composer action | `conversation.input.right` / `.left` (list, session); decoration → `conversation.composer.dock` ✅ source-verified |
| Right side panel | `rightbar` (single, root) + `sidebar.right.pane.tab`; open with `ctx.layout.openRightbar(track, fullscreen)` ✅ source-verified |
| Theme | `--dsw-alias-*` CSS vars; overrides via `ctx.theme.overrideTokens(source, { token: { light, dark } })` — **both palettes mandatory, runtime-enforced** ✅ source-verified |
| Durable data | `ctx.storageDomain.open(defineDomain({ name, version, tables: domainTable(zodSchema) }))` → `~/.dsh/storages/…`, atomic ✅ |
| Secrets | `ctx.credentials.*` → `~/.dsh/.credentials.yaml` ✅ 实测 |
| Plugin Config | `export const Config = z.object({…})` with `z` from `@deepseek-ai/schemastery`; row declared in `cordis.patch.yml` ✅ |
| **Do NOT** | iframe a host-served HTML page; `require` any `@deepseek-ai/dsh-client-*`; append session events with a new `type`; `open(id,'write')` on a live session; take the `webServer` fallback seat; poll `agent/status` |

### Top unknowns (ranked; each blocks a concrete decision)

1. **The live client Service / Event / Slots / Theme / Builtin contracts.** All five client inspect providers timed out 9×. Everything in §4/§5/§7 is source-derived. Concrete risk: the `dsh-chat` client half needs `ctx.connection` and `ctx.slots` to exist as *client* services under exactly those names — source strongly implies yes (`dsh.client.inject` is by package name, and `dsh-im` calls `ctx.connection.rpc.call` / `ctx.slots.register` at runtime), but it is unconfirmed for this build. **Action: re-run the five client queries from a connected page before writing the client half.**
2. **`SessionEventMap` shapes for 43 of the 59 event types.** The live projection truncates after `'session/end-seed'` and `.d.ts` is unshipped. `dsh-chat`'s share/live features will want `session/title`, `goal/change`, `todo/write`, `deliverables/presented`, `team/*`, `subagent/descriptor`. **Action: query `Event.listEvents('session/event')` in a page session, or read `dsh-session/README.md`.**
3. **Whether `ctx.connection.fetch.register` is stable public API in 0.2.0-rc.2.** The host Service directory exposes `connection.fetch` as a property, but the *method* name differs between source (`registerFetchRoute`, `lib/index.js:625`) and the live façade (`register`, used by `dsh-im`) — and `dsh-im` feature-detects it (`management-rpc.mjs:54`), which suggests version drift. **Action: verify `typeof ctx.connection.fetch.register === 'function'` on the live host; keep the feature-detect plus a `webServer` SSE fallback.**
4. *(secondary)* Response **streaming** semantics through the `/api` Fetch bridge — the README documents request-body modes and response draining but not incremental response flush. Determines whether `dsh-chat` can stream over `/api` or must add an SSE route. **Action: measure with a long-running `fetch` handler.**

### Environment facts used

Asar `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`; reader `/Users/twoants/DeepSeek WorkSpace/dsh-chat-会话事件验证/asar-tool.js`. No DSH package ships `src/*.ts`; `lib/*.js` + `README.md` are the shipped documentation. Live profile `/Users/twoants/.dsh/profiles/desktop/` (`cordis.yml` = `[]`; composition assembled from `package.json`'s `dsh.profile.bundles` → `cordis.patch.yml` → CLI overlays). Packaged authoring docs: `/tmp/dshz/…/dsh-agent-preset/skills/cordis-plugin-development/` (`SKILL.md`, `references/{ui-plugin,host-plugin,practices,user-actions,verification,mcp-bundle}.md`, `templates/decoration/*`). **No file, install, config, or profile state was modified**; all package reads were extractions into `/tmp`.
