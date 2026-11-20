'use strict';

// 应用门面：把核心域模型串成页面/测试要用的三个场景。
// 状态保存在内存中：制作端（采集+合并+版本库）与播放端（版本库+播放器）分开，
// 分发是两者之间唯一的通道（整片包 或 段级补丁）。

const fs = require('node:fs');
const path = require('node:path');
const { parseSrt } = require('./srt');
const {
  SubtitleError,
  Collector,
  Merger,
  EditionStore,
  Player,
  Distributor,
  PatchApplier,
} = require('./core');

class App {
  constructor({ sampleDir }) {
    this.sampleDir = sampleDir;
    this.reset();
  }

  reset() {
    this.collector = new Collector();
    this.merger = new Merger(this.collector);
    this.authoring = new EditionStore(); // 制作端版本库（保留所有版本）
    this.playerStore = new EditionStore(); // 播放端版本库（通过分发获得版本）
    this.player = new Player(this.playerStore);
    this.distributor = new Distributor();
    this.editionSeq = 0;
  }

  state() {
    return {
      playerVersion: this.playerStore.currentId,
      playerEditions: this.playerStore.list(),
      authoringEditions: this.authoring.list(),
      segmentCount: this.collector.segments.size,
    };
  }

  // 场景一：导入本地两套字幕来源（对白轨 + 音效轨），合并出 E1 并整片分发到播放端。
  importSamples() {
    this.reset();
    const dialogue = parseSrt(fs.readFileSync(path.join(this.sampleDir, 'dialogue.srt'), 'utf8'));
    const sfx = parseSrt(fs.readFileSync(path.join(this.sampleDir, 'sfx.srt'), 'utf8'));
    const dialogueIds = this.collector.importTrack('dialogue', dialogue);
    const sfxIds = this.collector.importTrack('sfx', sfx);
    const e1 = this.merger.merge(++this.editionSeq);
    this.authoring.install(e1);
    const pkg = this.distributor.fullPackage(e1); // 首版只能整片分发
    this.playerStore.install(pkg.edition);
    return {
      dialogueSegments: dialogueIds,
      sfxSegments: sfxIds,
      edition: e1.id,
      checksum: e1.checksum,
      delivery: 'full',
      playerVersion: this.playerStore.currentId,
      playback: this.player.playback(e1.id),
    };
  }

  // 场景二：修订（替换一段 + 挪一段到另一轨）→ 合并出 E2 → 段级补丁分发，
  // 中途打断补丁，验证旧字幕仍可读，再恢复并完成。
  reviseAndPatch(mode = 'patch') {
    if (!this.authoring.current()) {
      throw new SubtitleError('NOT_IMPORTED', '请先「导入双轨字幕」');
    }
    if (this.authoring.list().length > 1) {
      throw new SubtitleError('ALREADY_REVISED', '本批样例已完成修订；如需重演请重新「导入双轨字幕」');
    }
    const steps = [];
    const before = this.playerStore.currentId;
    const base = this.authoring.current();

    // 1) 修订一：只替换一段（d2 改词），采集端保留 v1/v2 两个版本。
    const r1 = this.collector.replaceSegment('d2', { text: '外面好像有人，别出声。' });
    steps.push({ step: 'revise-replace', segment: 'd2', version: r1.v, note: '替换一段：改词' });

    // 2) 合并端时间范围校验的异常演示：故意提交一个 start >= end 的修订。
    this.collector.replaceSegment('d3', { start: 9000, end: 8000 });
    let rejected = null;
    try {
      this.merger.merge(this.editionSeq + 1);
    } catch (err) {
      rejected = { code: err.code, message: err.message };
    }
    steps.push({ step: 'merge-validation', rejected, note: '合并端拒绝非法时间范围' });

    // 3) 修正 d3（v3：合法且延长了结束时间），再演示第二种修订：d4 从对白轨挪到音效轨。
    const r2 = this.collector.replaceSegment('d3', { start: 7000, end: 9500 });
    steps.push({ step: 'revise-fix', segment: 'd3', version: r2.v, note: '修正非法修订并调整时间' });
    const r3 = this.collector.moveSegment('d4', 'sfx');
    steps.push({ step: 'revise-move', segment: 'd4', toTrack: 'sfx', version: r3.v, note: '把一段挪到另一轨' });

    // 4) 合并端重新校验并产出 E2。
    const e2 = this.merger.merge(++this.editionSeq);
    this.authoring.install(e2);
    steps.push({ step: 'merge', edition: e2.id, checksum: e2.checksum, note: '合并端校验通过，产出新版本' });

    if (mode === 'full') {
      // 整片分发：整包原子替换，没有中间态。
      const pkg = this.distributor.fullPackage(e2);
      this.playerStore.install(pkg.edition);
      steps.push({ step: 'deliver-full', note: '整片分发：一次原子替换，不存在可读一半的状态', playerVersion: this.playerStore.currentId });
    } else {
      // 段级补丁分发：只传变化的分段。
      const patch = this.distributor.makePatch(base, e2);
      steps.push({
        step: 'patch-built',
        id: patch.id,
        ops: patch.ops.length,
        detail: patch.ops.map((o) => `${o.reason}:${o.cue ? o.cue.id : o.id}`),
        note: '段级补丁只携带变化的分段',
      });

      // 5) 应用第 1 个段操作后模拟传输中断。
      const applier = new PatchApplier(this.playerStore);
      const { token } = applier.begin(patch);
      applier.applyNext(token);
      let interrupted = null;
      try {
        throw new SubtitleError('LINK_DOWN', '模拟传输中断：补丁只应用了一部分');
      } catch (err) {
        interrupted = { code: err.code, message: err.message };
      }
      const during = this.player.playback(); // 中断瞬间：播放器仍读旧版本
      steps.push({
        step: 'patch-interrupted',
        applied: 1,
        total: patch.ops.length,
        error: interrupted,
        playerVersionDuring: during.version,
        note: '中断时旧字幕仍可读（暂存区对播放器不可见）',
      });

      // 6) 恢复：回滚暂存区，确认系统回到一致的旧版本。
      const rec = applier.recover(token, 'rollback');
      steps.push({ step: 'patch-recovered', ...rec, note: '恢复：丢弃半成品暂存区，旧版本依然完整可读' });

      // 7) 恢复后重新应用同一补丁并提交，校验和一致才发布。
      const retry = new PatchApplier(this.playerStore);
      const { token: t2 } = retry.begin(patch);
      for (let i = 0; i < patch.ops.length; i++) retry.applyNext(t2);
      const committed = retry.commit(t2);
      steps.push({
        step: 'patch-reapplied',
        committed: committed.id,
        checksumOk: committed.checksum === patch.targetChecksum,
        playerVersion: this.playerStore.currentId,
        note: '恢复后补丁完整重放并原子提交',
      });
    }

    return {
      mode,
      before,
      after: this.playerStore.currentId,
      steps,
      segmentHistory: {
        d2: this.collector.history('d2'),
        d3: this.collector.history('d3'),
        d4: this.collector.history('d4'),
      },
    };
  }

  // 场景三：对比两个播放版本（播放器视角，两轨均来自同一版）。
  compare() {
    const ids = this.playerStore.list();
    if (ids.length < 2) {
      throw new SubtitleError('NOTHING_TO_COMPARE', '播放端还没有两个版本；请先「导入双轨字幕」再「打断片段修补并恢复」');
    }
    const aId = ids[0];
    const bId = ids[ids.length - 1];
    const a = this.player.playback(aId);
    const b = this.player.playback(bId);
    const diff = this.distributor.makePatch(this.playerStore.get(aId), this.playerStore.get(bId));
    return { a, b, ops: diff.ops };
  }
}

module.exports = { App };
