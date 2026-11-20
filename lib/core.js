'use strict';

// 核心域模型：采集端（逐段版本）→ 合并端（时间范围校验）→ 分发（整片/段级补丁）→ 播放器（只读同一版双轨）。
// 仅使用 Node.js 内置模块。

const crypto = require('node:crypto');

const TRACKS = ['dialogue', 'sfx'];

class SubtitleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SubtitleError';
    this.code = code;
  }
}

function assertTrack(track) {
  if (!TRACKS.includes(track)) throw new SubtitleError('BAD_TRACK', `未知字幕轨: ${track}`);
}

// 统一字段顺序，保证同一内容得到同一校验和。
function canonicalCue(c) {
  return { id: c.id, v: c.v, start: c.start, end: c.end, text: c.text };
}

function sortCues(cues) {
  return cues
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function checksumTracks(tracks) {
  const payload = JSON.stringify({
    dialogue: tracks.dialogue.map(canonicalCue),
    sfx: tracks.sfx.map(canonicalCue),
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

// ---------- 采集端：保留每一段的完整版本历史 ----------

class Collector {
  constructor() {
    this.segments = new Map(); // id -> { id, history: [ {v, op, track, start, end, text} ] }
    this.seqByTrack = { dialogue: 0, sfx: 0 };
  }

  importTrack(track, cues) {
    assertTrack(track);
    const ids = [];
    for (const cue of cues) {
      const id = `${track[0]}${++this.seqByTrack[track]}`;
      this.segments.set(id, {
        id,
        history: [{ v: 1, op: 'import', track, start: cue.start, end: cue.end, text: cue.text }],
      });
      ids.push(id);
    }
    return ids;
  }

  mustGet(segId) {
    const seg = this.segments.get(segId);
    if (!seg) throw new SubtitleError('NO_SUCH_SEGMENT', `未知分段: ${segId}`);
    return seg;
  }

  current(segId) {
    const seg = this.mustGet(segId);
    return seg.history[seg.history.length - 1];
  }

  // 修订方式一：只替换某一段（内容/时间），旧版本保留在 history 里。
  replaceSegment(segId, patch) {
    const seg = this.mustGet(segId);
    const cur = seg.history[seg.history.length - 1];
    const next = {
      v: cur.v + 1,
      op: 'replace',
      track: cur.track,
      start: patch.start !== undefined ? patch.start : cur.start,
      end: patch.end !== undefined ? patch.end : cur.end,
      text: patch.text !== undefined ? patch.text : cur.text,
    };
    seg.history.push(next);
    return next;
  }

  // 修订方式二：把某一段从一个轨挪到另一个轨，历史同样保留。
  moveSegment(segId, toTrack) {
    assertTrack(toTrack);
    const seg = this.mustGet(segId);
    const cur = seg.history[seg.history.length - 1];
    if (cur.track === toTrack) {
      throw new SubtitleError('SAME_TRACK', `分段 ${segId} 已在 ${toTrack} 轨`);
    }
    const next = { v: cur.v + 1, op: 'move', track: toTrack, start: cur.start, end: cur.end, text: cur.text };
    seg.history.push(next);
    return next;
  }

  history(segId) {
    return this.mustGet(segId).history.map((h) => ({ ...h }));
  }

  // 当前版本快照，按轨分组（合并端的输入）。
  snapshot() {
    const byTrack = { dialogue: [], sfx: [] };
    for (const [id, seg] of this.segments) {
      const cur = seg.history[seg.history.length - 1];
      byTrack[cur.track].push({ id, v: cur.v, start: cur.start, end: cur.end, text: cur.text });
    }
    return byTrack;
  }
}

// ---------- 合并端：检查时间范围，产出不可变的播放版本 ----------

class Merger {
  constructor(collector) {
    this.collector = collector;
  }

  validateTrack(track, cues) {
    const problems = [];
    for (const c of cues) {
      if (!Number.isFinite(c.start) || !Number.isFinite(c.end) || c.start < 0 || c.end < 0) {
        problems.push(`${c.id}: 时间不是有效非负数`);
      } else if (c.start >= c.end) {
        problems.push(`${c.id}: start(${c.start}) >= end(${c.end})`);
      }
    }
    const sorted = sortCues(cues);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start < sorted[i - 1].end) {
        problems.push(`${sorted[i - 1].id} 与 ${sorted[i].id} 时间重叠`);
      }
    }
    if (problems.length) {
      throw new SubtitleError('MERGE_INVALID', `${track} 轨时间范围校验失败: ${problems.join('; ')}`);
    }
    return sorted.map(canonicalCue);
  }

  merge(seq) {
    const snap = this.collector.snapshot();
    const tracks = {};
    const pin = {}; // 记录每个分段被钉在哪个版本，证明播放版本的一致性
    for (const t of TRACKS) {
      tracks[t] = this.validateTrack(t, snap[t]);
      for (const c of tracks[t]) pin[c.id] = c.v;
    }
    const edition = { id: `E${seq}`, seq, tracks, pin };
    edition.checksum = checksumTracks(tracks);
    return edition;
  }
}

// ---------- 版本库（播放器一侧）：只存放完整版本，切换是原子的 ----------

class EditionStore {
  constructor() {
    this.editions = new Map();
    this.currentId = null;
  }

  install(edition) {
    const copy = JSON.parse(JSON.stringify(edition));
    this.editions.set(copy.id, copy);
    this.currentId = copy.id;
    return copy;
  }

  has(id) {
    return this.editions.has(id);
  }

  get(id) {
    const e = this.editions.get(id);
    if (!e) throw new SubtitleError('NO_SUCH_EDITION', `不存在播放版本: ${id}`);
    return JSON.parse(JSON.stringify(e));
  }

  current() {
    return this.currentId ? this.get(this.currentId) : null;
  }

  list() {
    return [...this.editions.keys()];
  }
}

// ---------- 播放器：只能读同一版的两轨 ----------

class Player {
  constructor(store) {
    this.store = store;
  }

  playback(versionId, opts = {}) {
    const id = versionId || this.store.currentId;
    if (!id) throw new SubtitleError('NOTHING_PUBLISHED', '播放器还没有任何版本');
    if (opts.trackVersions) {
      const { dialogue, sfx } = opts.trackVersions;
      if (dialogue !== sfx) {
        throw new SubtitleError(
          'MIXED_VERSION',
          `播放器只能读同一版的两轨，收到 dialogue=${dialogue} sfx=${sfx}`
        );
      }
      if (dialogue !== id) {
        throw new SubtitleError('MIXED_VERSION', `分轨版本 ${dialogue} 与请求版本 ${id} 不一致`);
      }
    }
    const e = this.store.get(id); // 两轨来自同一个版本对象，结构上无法混读
    return { version: e.id, checksum: e.checksum, tracks: e.tracks };
  }
}

// ---------- 分发：整片包 或 段级补丁 ----------

class Distributor {
  fullPackage(edition) {
    return { kind: 'full', edition: JSON.parse(JSON.stringify(edition)) };
  }

  // 段级 diff：只携带发生变化的分段（替换/移轨/新增/删除）。
  makePatch(base, target) {
    const segOf = (e) => {
      const m = new Map();
      for (const t of TRACKS) for (const c of e.tracks[t]) m.set(c.id, { cue: c, track: t });
      return m;
    };
    const a = segOf(base);
    const b = segOf(target);
    const ops = [];
    for (const [id, { cue, track }] of b) {
      const prev = a.get(id);
      if (!prev) {
        ops.push({ op: 'upsert', reason: 'added', id, track, cue });
      } else if (prev.track !== track) {
        ops.push({ op: 'upsert', reason: 'moved', id, track, fromTrack: prev.track, prev: prev.cue, cue });
      } else if (
        prev.cue.v !== cue.v ||
        prev.cue.text !== cue.text ||
        prev.cue.start !== cue.start ||
        prev.cue.end !== cue.end
      ) {
        ops.push({ op: 'upsert', reason: 'changed', id, track, prev: prev.cue, cue });
      }
    }
    for (const [id, { cue, track }] of a) {
      if (!b.has(id)) ops.push({ op: 'remove', reason: 'removed', id, track, prev: cue });
    }
    return {
      id: `P-${base.id}->${target.id}`,
      base: base.id,
      target: target.id,
      targetChecksum: target.checksum,
      ops,
    };
  }
}

// ---------- 补丁应用器（播放器一侧）：暂存区 + 提交两段式，中断可恢复 ----------

class PatchApplier {
  constructor(store) {
    this.store = store;
    this.journal = null;
  }

  mustJournal(token) {
    if (!this.journal || this.journal.status !== 'applying' || this.journal.patchId !== token) {
      throw new SubtitleError('NO_PATCH_IN_FLIGHT', '没有进行中的补丁或令牌不匹配');
    }
    return this.journal;
  }

  begin(patch) {
    const cur = this.store.current();
    if (!cur || cur.id !== patch.base) {
      throw new SubtitleError(
        'PATCH_BASE_MISMATCH',
        `补丁基线 ${patch.base} 与当前版本 ${cur ? cur.id : '(空)'} 不一致`
      );
    }
    if (this.journal && this.journal.status === 'applying') {
      throw new SubtitleError('PATCH_IN_FLIGHT', '已有补丁正在应用');
    }
    // 暂存区是基线的私有副本：提交前播放器完全看不到中间态。
    const staging = new Map();
    for (const t of TRACKS) {
      for (const c of cur.tracks[t]) staging.set(c.id, { ...canonicalCue(c), track: t });
    }
    this.journal = { patchId: patch.id, patch, status: 'applying', applied: 0, staging };
    return { token: patch.id, ops: patch.ops.length };
  }

  applyNext(token) {
    const j = this.mustJournal(token);
    if (j.applied >= j.patch.ops.length) {
      throw new SubtitleError('PATCH_EXHAUSTED', '补丁操作已全部应用');
    }
    const op = j.patch.ops[j.applied++];
    if (op.op === 'upsert') {
      j.staging.set(op.cue.id, { ...canonicalCue(op.cue), track: op.track });
    } else if (op.op === 'remove') {
      j.staging.delete(op.id);
    }
    return { applied: j.applied, total: j.patch.ops.length };
  }

  commit(token) {
    const j = this.mustJournal(token);
    if (j.applied !== j.patch.ops.length) {
      throw new SubtitleError('PATCH_INCOMPLETE', `补丁未应用完: ${j.applied}/${j.patch.ops.length}`);
    }
    const tracks = { dialogue: [], sfx: [] };
    for (const c of j.staging.values()) tracks[c.track].push(canonicalCue(c));
    for (const t of TRACKS) tracks[t] = sortCues(tracks[t]);
    const pin = {};
    for (const t of TRACKS) for (const c of tracks[t]) pin[c.id] = c.v;
    const edition = { id: j.patch.target, tracks, pin };
    edition.checksum = checksumTracks(tracks);
    if (edition.checksum !== j.patch.targetChecksum) {
      throw new SubtitleError(
        'PATCH_CHECKSUM',
        `重建结果校验和 ${edition.checksum} 与目标 ${j.patch.targetChecksum} 不一致，已拒绝提交`
      );
    }
    this.store.install(edition); // 原子发布：这一刻起播放器才看到新版本
    j.status = 'committed';
    if (this.journal === j) this.journal = null;
    return edition;
  }

  // 中断后的恢复：rollback = 丢弃暂存区回到旧版本；resume = 保留进度继续。
  recover(token, strategy) {
    const j = this.mustJournal(token);
    if (strategy === 'rollback') {
      this.journal = null;
      return { strategy, playerVersion: this.store.currentId, note: '暂存区已丢弃，旧版本仍可读' };
    }
    if (strategy === 'resume') {
      return { strategy, applied: j.applied, total: j.patch.ops.length, note: '保留进度，可继续 applyNext 后 commit' };
    }
    throw new SubtitleError('BAD_STRATEGY', `未知恢复策略: ${strategy}`);
  }
}

module.exports = {
  TRACKS,
  SubtitleError,
  Collector,
  Merger,
  EditionStore,
  Player,
  Distributor,
  PatchApplier,
  checksumTracks,
  canonicalCue,
  sortCues,
};
