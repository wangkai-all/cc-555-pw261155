'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createServer, App } = require('../server');

async function withServer(fn) {
  const app = new App({ sampleDir: path.join(__dirname, '..', 'samples') });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (base, p, body, raw) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw !== undefined ? raw : JSON.stringify(body || {}),
  });

test('HTTP：首页可访问且业务结果区带 data-evidence-result', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /data-evidence-result="idle"/);
    assert.match(html, /导入双轨字幕/);
    assert.match(html, /打断片段修补并恢复/);
    assert.match(html, /对比播放版本/);
  });
});

test('HTTP：完整流程 导入 → 打断修补并恢复 → 对比播放版本', async () => {
  await withServer(async (base) => {
    // 初始状态：播放器为空
    let state = await (await fetch(base + '/api/state')).json();
    assert.equal(state.data.playerVersion, null);

    // ① 导入双轨字幕
    const imp = await (await post(base, '/api/import')).json();
    assert.equal(imp.ok, true);
    assert.equal(imp.data.edition, 'E1');
    assert.equal(imp.data.dialogueSegments.length, 5);
    assert.equal(imp.data.sfxSegments.length, 4);
    assert.equal(imp.data.playerVersion, 'E1');
    assert.equal(imp.data.playback.tracks.dialogue.length, 5);
    assert.equal(imp.data.playback.tracks.sfx.length, 4);

    // ② 打断片段修补并恢复（段级补丁）
    const rev = await (await post(base, '/api/revise-patch', { mode: 'patch' })).json();
    assert.equal(rev.ok, true);
    assert.equal(rev.data.before, 'E1');
    assert.equal(rev.data.after, 'E2');
    const steps = Object.fromEntries(rev.data.steps.map((s) => [s.step, s]));
    assert.ok(steps['merge-validation'].rejected, '合并端应拒绝非法时间范围');
    assert.equal(steps['merge-validation'].rejected.code, 'MERGE_INVALID');
    assert.equal(steps['patch-interrupted'].playerVersionDuring, 'E1'); // 中断时旧字幕仍可读
    assert.equal(steps['patch-recovered'].strategy, 'rollback');
    assert.equal(steps['patch-reapplied'].checksumOk, true);
    // 采集端逐段版本：d2 有 v1/v2，d4 记录了从 dialogue 挪到 sfx
    assert.equal(rev.data.segmentHistory.d2.length, 2);
    const d4hist = rev.data.segmentHistory.d4;
    assert.deepEqual(d4hist.map((h) => h.track), ['dialogue', 'sfx']);

    // ③ 对比播放版本
    const cmp = await (await post(base, '/api/compare')).json();
    assert.equal(cmp.ok, true);
    assert.equal(cmp.data.a.version, 'E1');
    assert.equal(cmp.data.b.version, 'E2');
    const moved = cmp.data.ops.find((o) => o.reason === 'moved');
    assert.equal(moved.id, 'd4');
    assert.equal(moved.fromTrack, 'dialogue');
    assert.equal(moved.track, 'sfx');
    assert.ok(cmp.data.ops.some((o) => o.reason === 'changed' && o.id === 'd2'));

    // 播放器按版本读两轨
    const p2 = await (await fetch(base + '/api/playback?version=E2')).json();
    assert.equal(p2.data.version, 'E2');
    assert.equal(p2.data.tracks.sfx.some((c) => c.id === 'd4'), true);

    state = await (await fetch(base + '/api/state')).json();
    assert.equal(state.data.playerVersion, 'E2');
    assert.deepEqual(state.data.playerEditions, ['E1', 'E2']);
  });
});

test('HTTP：整片分发方式也能交付 E2', async () => {
  await withServer(async (base) => {
    await post(base, '/api/import');
    const rev = await (await post(base, '/api/revise-patch', { mode: 'full' })).json();
    assert.equal(rev.ok, true);
    assert.equal(rev.data.mode, 'full');
    assert.equal(rev.data.after, 'E2');
    assert.ok(rev.data.steps.some((s) => s.step === 'deliver-full'));
  });
});

test('HTTP：异常——未导入就修补 / 重复修补 / 过早对比', async () => {
  await withServer(async (base) => {
    let res = await post(base, '/api/revise-patch');
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'NOT_IMPORTED');

    res = await post(base, '/api/compare');
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'NOTHING_TO_COMPARE');

    await post(base, '/api/import');
    await post(base, '/api/revise-patch');
    res = await post(base, '/api/revise-patch');
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'ALREADY_REVISED');
  });
});

test('HTTP：异常——播放器混读两版 / 未知版本 / 空库', async () => {
  await withServer(async (base) => {
    // 空库直接读
    let res = await fetch(base + '/api/playback');
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'NOTHING_PUBLISHED');

    await post(base, '/api/import');

    // 混读：dialogue 要 E1、sfx 要 E2 → 拒绝
    res = await fetch(base + '/api/playback?version=E1&dialogueVersion=E1&sfxVersion=E2');
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, 'MIXED_VERSION');

    // 未知版本
    res = await fetch(base + '/api/playback?version=E9');
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'NO_SUCH_EDITION');
  });
});

test('HTTP：异常——未知路由 404 / 非法 JSON 400', async () => {
  await withServer(async (base) => {
    let res = await post(base, '/api/nope');
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'NOT_FOUND');

    res = await post(base, '/api/import', null, '{not json');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'BAD_JSON');
  });
});
