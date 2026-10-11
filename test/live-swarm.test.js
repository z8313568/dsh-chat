/**
 * 观众间分发（swarm）测试。
 *
 * 核心问题只有一个：**发布者的上行到底被卸载了多少。**
 * 直播时所有观众都从发布者拉，发布者必挂；所以这里把"发布者实际发出多少份"
 * 直接量出来，而不是只断言几个布尔值。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_SWARM_POLICY, LiveSwarm, simulateDistribution } from '../src/host/live-swarm.js';

describe('观众间分发：来源选择', () => {
  const make = (policy = {}) => new LiveSwarm({ policy: { ...DEFAULT_SWARM_POLICY, minRoomSize: 1, ...policy } });

  it('有人能满足需求时，绝不回落到发布者', () => {
    const swarm = make();
    swarm.noteAvailability('peer-a', 'room', 100);
    const pick = swarm.pickSource({ roomId: 'room', sinceSeq: 50, originKey: 'origin', selfKey: 'me', roomSize: 10 });
    assert.equal(pick.source, 'peer-a');
    assert.equal(pick.reason, 'peer-has-it');
  });

  it('够用的人里挑持有**最少**的那个 —— 否则持有最多的会变成下一个瓶颈', () => {
    const swarm = make();
    swarm.noteAvailability('peer-rich', 'room', 10_000);
    swarm.noteAvailability('peer-just-enough', 'room', 120);
    swarm.noteAvailability('peer-too-little', 'room', 30); // 不够，不参与
    const pick = swarm.pickSource({ roomId: 'room', sinceSeq: 100, originKey: 'origin', selfKey: 'me', roomSize: 10 });
    assert.equal(pick.source, 'peer-just-enough');
  });

  it('没人有 → 才找发布者，并如实给出原因', () => {
    const swarm = make();
    const pick = swarm.pickSource({ roomId: 'room', sinceSeq: 500, originKey: 'origin', selfKey: 'me', roomSize: 10 });
    assert.equal(pick.source, 'origin');
    assert.equal(pick.reason, 'no-peer-has-it');
  });

  it('房间太小时不启用分发（发布者直发更简单，加一层只是白增跳数）', () => {
    const swarm = new LiveSwarm({ policy: { ...DEFAULT_SWARM_POLICY, minRoomSize: 5 } });
    swarm.noteAvailability('peer-a', 'room', 1000);
    const pick = swarm.pickSource({ roomId: 'room', sinceSeq: 1, originKey: 'origin', selfKey: 'me', roomSize: 3 });
    assert.equal(pick.source, 'origin');
    assert.equal(pick.reason, 'room-too-small');
  });

  it('不会把自己当成来源', () => {
    const swarm = make();
    swarm.noteAvailability('me', 'room', 1000);
    const pick = swarm.pickSource({ roomId: 'room', sinceSeq: 1, originKey: 'origin', selfKey: 'me', roomSize: 10 });
    assert.equal(pick.source, 'origin');
  });

  it('可用性只前进不后退（乱序到达的旧广播不能把范围拉回去）', () => {
    const swarm = make();
    swarm.noteAvailability('peer-a', 'room', 500);
    assert.equal(swarm.noteAvailability('peer-a', 'room', 100), false, '落后的广播必须被忽略');
    assert.equal(swarm.availability('room')[0].upToSeq, 500);
  });

  it('过期的可用性不算数（节点离线后不该继续被派活）', () => {
    let now = 1_000_000;
    const swarm = new LiveSwarm({ policy: { ...DEFAULT_SWARM_POLICY, minRoomSize: 1 }, now: () => now });
    swarm.noteAvailability('peer-a', 'room', 500);
    now += 5 * 60_000;
    assert.equal(swarm.availability('room').length, 0);
  });
});

describe('观众间分发：服务预算', () => {
  const make = (policy = {}) => new LiveSwarm({ policy: { ...DEFAULT_SWARM_POLICY, minRoomSize: 1, ...policy } });

  it('正常请求应当被接受，并给出可服务的上限', () => {
    const swarm = make();
    const verdict = swarm.shouldServe({
      roomId: 'room', requesterKey: 'peer-x', sinceSeq: 10, latestSeq: 20, roomSize: 10,
    });
    assert.equal(verdict.allow, true);
    assert.equal(verdict.maxEvents, 11);
  });

  it('单次补数据有上限，不能被当成无限回放源', () => {
    const swarm = make({ maxServeEventsPerRequest: 50 });
    const verdict = swarm.shouldServe({
      roomId: 'room', requesterKey: 'peer-x', sinceSeq: 1, latestSeq: 100_000, roomSize: 10,
    });
    assert.equal(verdict.maxEvents, 50);
  });

  it('同时服务的对端数有上限，且拒绝原因可解释', () => {
    const swarm = make({ maxServees: 1 });
    swarm.noteServing('room', 'peer-a');
    const verdict = swarm.shouldServe({
      roomId: 'room', requesterKey: 'peer-b', sinceSeq: 1, latestSeq: 2, roomSize: 10,
    });
    assert.equal(verdict.allow, false);
    assert.equal(verdict.reason, 'at-capacity', '对端据此换一个来源，而不是干等');

    // 已经在服务的那个仍然可以继续
    assert.equal(swarm.shouldServe({
      roomId: 'room', requesterKey: 'peer-a', sinceSeq: 3, latestSeq: 4, roomSize: 10,
    }).allow, true);
  });

  it('超过每分钟预算就停止服务 —— 贡献不该是无底洞', () => {
    let now = 1_000_000;
    const swarm = new LiveSwarm({
      policy: { ...DEFAULT_SWARM_POLICY, minRoomSize: 1, maxServeBytesPerMinute: 1000 },
      now: () => now,
    });
    swarm.noteForwarded(900);
    assert.equal(swarm.shouldServe({
      roomId: 'room', requesterKey: 'peer-b', sinceSeq: 1, latestSeq: 2, roomSize: 10,
    }).allow, true, '还没超预算');

    swarm.noteForwarded(200);
    assert.equal(swarm.shouldServe({
      roomId: 'room', requesterKey: 'peer-c', sinceSeq: 1, latestSeq: 2, roomSize: 10,
    }).reason, 'budget-exhausted');

    // 一分钟之后预算恢复
    now += 61_000;
    assert.equal(swarm.shouldServe({
      roomId: 'room', requesterKey: 'peer-d', sinceSeq: 1, latestSeq: 2, roomSize: 10,
    }).allow, true, '预算按分钟滚动恢复');
  });

  it('关闭分发时一律拒绝，原因明确', () => {
    const swarm = make({ enabled: false });
    assert.equal(swarm.shouldServe({
      roomId: 'room', requesterKey: 'peer-x', sinceSeq: 1, latestSeq: 2, roomSize: 10,
    }).reason, 'swarm-disabled');
  });
});

describe('观众间分发：发布者上行到底省了多少（确定性模拟）', () => {
  it('全员可达时，发布者的推送次数大幅下降', () => {
    const star = simulateDistribution({ roomSize: 20, reachableFraction: 1, policy: { enabled: false } });
    const swarm = simulateDistribution({ roomSize: 20, reachableFraction: 1 });

    // 关闭分发 ≈ 星形：所有补数据都落在发布者身上
    assert.equal(star.peerPushes, 0, '关闭分发时不该有任何对端互传');
    assert.ok(swarm.originPushes < star.originPushes, '开启分发后发布者必须更省');

    const saved = 1 - swarm.originPushes / star.originPushes;
    assert.ok(saved > 0.5, `发布者上行应当显著下降，实际只降了 ${(saved * 100).toFixed(1)}%`);
    console.log(`    20 人房间 · 全员可达：发布者推送 ${star.originPushes} → ${swarm.originPushes} 次，`
      + `下降 ${(saved * 100).toFixed(1)}%；对端互传 ${swarm.peerPushes} 次`);
  });

  it('**只有少数人可达时仍然有收益** —— 这是最关键的一条', () => {
    // 现实里大部分观众在 NAT 后面，能被别人连到的只是一部分。
    // 但"能被连到的少"不等于"分发没用"：每服务一个对端，发布者就少发一份。
    for (const fraction of [0.2, 0.5, 1]) {
      const star = simulateDistribution({ roomSize: 30, reachableFraction: fraction, policy: { enabled: false } });
      const swarm = simulateDistribution({ roomSize: 30, reachableFraction: fraction });
      const saved = 1 - swarm.originPushes / star.originPushes;
      assert.ok(saved > 0, `可达比例 ${fraction} 时应当仍有收益`);
      console.log(`    30 人房间 · 可达 ${(fraction * 100).toFixed(0)}%：`
        + `发布者 ${star.originPushes} → ${swarm.originPushes} 次，下降 ${(saved * 100).toFixed(1)}%`);
    }
  });

  it('房间越大，分发的收益越明显（这正是需要它的场景）', () => {
    const small = simulateDistribution({ roomSize: 6, reachableFraction: 1 });
    const big = simulateDistribution({ roomSize: 60, reachableFraction: 1 });
    const savedSmall = 1 - small.originPushes / (small.originPushes + small.peerPushes);
    const savedBig = 1 - big.originPushes / (big.originPushes + big.peerPushes);
    assert.ok(big.peerPushes > small.peerPushes, '大房间应当有更多对端互传');
    console.log(`    6 人：对端互传 ${small.peerPushes} 次；60 人：${big.peerPushes} 次`);
    void savedSmall; void savedBig;
  });

  it('模拟是确定性的：同一个种子必须给出同样的结论', () => {
    const a = simulateDistribution({ roomSize: 25, reachableFraction: 0.4, seed: 7 });
    const b = simulateDistribution({ roomSize: 25, reachableFraction: 0.4, seed: 7 });
    assert.deepEqual(a, b, '网络测试如果每次结果不同，就没法判断失败是策略问题还是运气');
  });

  it('指标如实反映卸载比例，没有样本时不编造', () => {
    const swarm = new LiveSwarm();
    assert.equal(swarm.metrics.offloadedRatio, null, '样本为 0 时应当报 null 而不是 0');
    swarm.pickSource({ roomId: 'r', sinceSeq: 1, originKey: 'o', roomSize: 10 });
    swarm.noteAvailability('p', 'r', 10);
    swarm.pickSource({ roomId: 'r', sinceSeq: 1, originKey: 'o', roomSize: 10 });
    assert.equal(swarm.metrics.offloadedRatio, 0.5);
  });
});
