'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSrt } = require('../lib/srt');
const {
  SubtitleError,
  Collector,
  Merger,
  EditionStore,
  Player,
  Distributor,
  PatchApplier,
} = require('../lib/core');

const DIALOGUE = [
  { start: 1000, end: 3000, text: '你听见了吗？' },
  { start: 4000, end: 6000, text: '外面好像有人。' },
  { start: 7000, end: 9000, text: '我去看看。' },
  { start: 10000, end: 11500, text: '[门砰地关上]' },
];
const SFX = [
  { start: 500, end: 2000, text: '[雷声轰鸣]' },
  { start: 8000, end: 9500, text: '[脚步声靠近]' },
];

// 搭好「导入 + 合并出 E1 + 整片分发到播放端」的初始状态。
function setup() {
  const collector = new Collector();
  collector.importTrack('dialogue', DIALOGUE);
  collector.importTrack('sfx', SFX);
  const merger = new Merger(collector);
  const e1 = merger.merge(1);
  const authoring = new EditionStore();
  authoring.install(e1);
  const playerStore = new EditionStore();
  const distributor = new Distributor();
  playerStore.install(distributor.fullPackage(e1).edition);
  const player = new Player(playerStore);
  return { collector, merger, e1, authoring, playerStore, player, distributor };
}

// 在初始状态上做出 E2：替换 d2 + 把 d4 挪到 sfx。
function makeE2(ctx) {
  ctx.collector.replaceSegment('d2', { text: '外面好像有人，别出声。' });
  ctx.collector.moveSegment('d4', 'sfx');
  const e2 = ctx.merger.merge(2);
  ctx.authoring.install(e2);
  return e2;
}

// ---------- SRT 解析 ----------

test('SRT 解析：正常文件解析为毫秒时间轴', () => {
  const cues = parseSrt('1\n00:00:01,000 --> 00:00:03,500\n你好\n\n2\n00:00:05.000 --> 00:00:06.250\n世界\n');
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { index: 1, start: 1000, end: 3500, text: '你好' });
  assert.equal(cues[1].end, 6250);
});

test('SRT 解析：非法时间戳报错（异常）', () => {
  assert.throws(() => parseSrt('1\nxx --> 00:00:03,000\n你好\n'), /时间戳/);
});

test('SRT 解析：缺少 --> 的字幕块报错（异常）', () => {
  assert.throws(() => parseSrt('1\n这不是时间行\n你好\n'), /字幕块/);
});

// ---------- 采集端：逐段版本 ----------

test('采集端：替换一段会保留旧版本', () => {
  const { collector } = setup();
  const v2 = collector.replaceSegment('d2', { text: '改过的台词' });
  assert.equal(v2.v, 2);
  const hist = collector.history('d2');
  assert.equal(hist.length, 2);
  assert.equal(hist[0].text, '外面好像有人。');
  assert.equal(hist[1].text, '改过的台词');
});

test('采集端：把一段挪到另一轨，历史记录 move', () => {
  const { collector } = setup();
  const v2 = collector.moveSegment('d4', 'sfx');
  assert.equal(v2.track, 'sfx');
  const hist = collector.history('d4');
  assert.deepEqual([hist[0].track, hist[1].track], ['dialogue', 'sfx']);
  assert.equal(hist[1].op, 'move');
});

test('采集端：挪到同一轨被拒绝（异常）', () => {
  const { collector } = setup();
  assert.throws(() => collector.moveSegment('d4', 'dialogue'), (e) => e.code === 'SAME_TRACK');
});

test('采集端：未知分段报错（异常）', () => {
  const { collector } = setup();
  assert.throws(() => collector.replaceSegment('nope', { text: 'x' }), (e) => e.code === 'NO_SUCH_SEGMENT');
});

// ---------- 合并端：时间范围校验 ----------

test('合并端：合法输入产出稳定校验和', () => {
  const { merger } = setup();
  const a = merger.merge(1);
  const b = merger.merge(2);
  assert.equal(a.checksum, b.checksum); // 内容相同则校验和相同，与版本号无关
  assert.deepEqual(a.tracks.dialogue.map((c) => c.id), ['d1', 'd2', 'd3', 'd4']);
});

test('合并端：start >= end 被拒绝（异常）', () => {
  const { collector, merger } = setup();
  collector.replaceSegment('d2', { start: 6000, end: 4000 });
  assert.throws(() => merger.merge(2), (e) => e.code === 'MERGE_INVALID' && /start/.test(e.message));
});

test('合并端：同轨时间重叠被拒绝（异常）', () => {
  const { collector, merger } = setup();
  collector.replaceSegment('d2', { start: 2000, end: 5000 }); // 与 d1(1000-3000) 重叠
  assert.throws(() => merger.merge(2), (e) => e.code === 'MERGE_INVALID' && /重叠/.test(e.message));
});

// ---------- 播放器：只读同一版的两轨 ----------

test('播放器：一次读到同一版本的两轨', () => {
  const { player } = setup();
  const p = player.playback('E1');
  assert.equal(p.version, 'E1');
  assert.equal(p.tracks.dialogue.length, 4);
  assert.equal(p.tracks.sfx.length, 2);
});

test('播放器：空库 / 未知版本报错（异常）', () => {
  const empty = new Player(new EditionStore());
  assert.throws(() => empty.playback(), (e) => e.code === 'NOTHING_PUBLISHED');
  const { player } = setup();
  assert.throws(() => player.playback('E9'), (e) => e.code === 'NO_SUCH_EDITION');
});

test('播放器：混读两版的分轨请求被拒绝（异常）', () => {
  const { player } = setup();
  assert.throws(
    () => player.playback('E1', { trackVersions: { dialogue: 'E1', sfx: 'E2' } }),
    (e) => e.code === 'MIXED_VERSION'
  );
});

// ---------- 分发：整片 与 段级补丁 ----------

test('整片分发：整包原子安装后播放器切到新版本', () => {
  const ctx = setup();
  const e2 = makeE2(ctx);
  ctx.playerStore.install(ctx.distributor.fullPackage(e2).edition);
  const p = ctx.player.playback();
  assert.equal(p.version, 'E2');
  assert.equal(p.tracks.sfx.some((c) => c.id === 'd4'), true); // 挪轨后的段出现在音效轨
});

test('段级补丁：只携带变化的分段（替换 + 移轨）', () => {
  const ctx = setup();
  const e2 = makeE2(ctx);
  const patch = ctx.distributor.makePatch(ctx.e1, e2);
  assert.equal(patch.ops.length, 2);
  const changed = patch.ops.find((o) => o.id === 'd2');
  const moved = patch.ops.find((o) => o.id === 'd4');
  assert.equal(changed.reason, 'changed');
  assert.equal(moved.reason, 'moved');
  assert.equal(moved.fromTrack, 'dialogue');
  assert.equal(moved.track, 'sfx');
});

test('段级补丁：完整应用后重建结果与目标校验和一致', () => {
  const ctx = setup();
  const e2 = makeE2(ctx);
  const patch = ctx.distributor.makePatch(ctx.e1, e2);
  const applier = new PatchApplier(ctx.playerStore);
  const { token } = applier.begin(patch);
  for (let i = 0; i < patch.ops.length; i++) applier.applyNext(token);
  const committed = applier.commit(token);
  assert.equal(committed.checksum, e2.checksum);
  assert.equal(ctx.player.playback().version, 'E2');
});

test('补丁中断：旧字幕仍可读，回滚恢复后依旧一致', () => {
  const ctx = setup();
  const e2 = makeE2(ctx);
  const patch = ctx.distributor.makePatch(ctx.e1, e2);
  const applier = new PatchApplier(ctx.playerStore);
  const { token } = applier.begin(patch);
  applier.applyNext(token); // 只应用了 1/2，模拟此时中断

  // 中断瞬间：播放器读到的仍是旧版本，暂存区不可见
  assert.equal(ctx.player.playback().version, 'E1');
  assert.deepEqual(ctx.playerStore.list(), ['E1']);

  // 恢复（回滚）：暂存区丢弃，旧版本仍完整
  const rec = applier.recover(token, 'rollback');
  assert.equal(rec.playerVersion, 'E1');
  assert.equal(ctx.player.playback().tracks.dialogue.length, 4);

  // 恢复后重放同一补丁可正常完成
  const retry = new PatchApplier(ctx.playerStore);
  const { token: t2 } = retry.begin(patch);
  for (let i = 0; i < patch.ops.length; i++) retry.applyNext(t2);
  retry.commit(t2);
  assert.equal(ctx.player.playback().version, 'E2');
});

test('补丁中断：resume 策略保留进度继续完成', () => {
  const ctx = setup();
  const e2 = makeE2(ctx);
  const patch = ctx.distributor.makePatch(ctx.e1, e2);
  const applier = new PatchApplier(ctx.playerStore);
  const { token } = applier.begin(patch);
  applier.applyNext(token);
  const rec = applier.recover(token, 'resume');
  assert.equal(rec.applied, 1);
  applier.applyNext(token); // 继续剩余操作
  const committed = applier.commit(token);
  assert.equal(committed.checksum, e2.checksum);
});

test('补丁异常：基线不符 / 重复 begin / 提前 commit / 篡改内容', () => {
  const ctx = setup();
  const e2 = makeE2(ctx);
  const patch = ctx.distributor.makePatch(ctx.e1, e2);

  // 基线不符：播放端当前是 E1，却拿 base=E2 的补丁
  const fakeTarget = ctx.merger.merge(3);
  const wrongBase = ctx.distributor.makePatch(e2, fakeTarget);
  assert.throws(() => new PatchApplier(ctx.playerStore).begin(wrongBase), (e) => e.code === 'PATCH_BASE_MISMATCH');

  // 重复 begin
  const applier = new PatchApplier(ctx.playerStore);
  const { token } = applier.begin(patch);
  assert.throws(() => applier.begin(patch), (e) => e.code === 'PATCH_IN_FLIGHT');

  // 没应用完就 commit
  assert.throws(() => applier.commit(token), (e) => e.code === 'PATCH_INCOMPLETE');

  // 篡改补丁内容 → 重建校验和与目标不一致，拒绝提交
  const tampered = JSON.parse(JSON.stringify(patch));
  tampered.ops[0].cue.text = '被篡改的内容';
  const ap2 = new PatchApplier(ctx.playerStore);
  const { token: t2 } = ap2.begin(tampered);
  for (let i = 0; i < tampered.ops.length; i++) ap2.applyNext(t2);
  assert.throws(() => ap2.commit(t2), (e) => e.code === 'PATCH_CHECKSUM');
  assert.equal(ctx.player.playback().version, 'E1'); // 篡改未污染播放器

  // 未知恢复策略 / 错误令牌
  const ap3 = new PatchApplier(ctx.playerStore);
  const { token: t3 } = ap3.begin(patch);
  assert.throws(() => ap3.recover(t3, 'whatever'), (e) => e.code === 'BAD_STRATEGY');
  assert.throws(() => ap3.applyNext('wrong-token'), (e) => e.code === 'NO_PATCH_IN_FLIGHT');
});
