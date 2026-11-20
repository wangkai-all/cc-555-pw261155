'use strict';

// 极简 SRT 解析器（仅依赖内置模块）。
// 输入本地 .srt 文本，输出 [{ index, start, end, text }]，时间单位为毫秒。
// 时间范围是否合法（start < end、是否重叠）由合并端校验，解析器只负责读懂文件。

function parseTime(ts) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(String(ts).trim());
  if (!m) {
    const err = new Error(`无法解析时间戳: ${ts}`);
    err.code = 'SRT_PARSE';
    throw err;
  }
  const [, h, mm, s, ms] = m;
  return ((Number(h) * 60 + Number(mm)) * 60 + Number(s)) * 1000 + Number(ms.padEnd(3, '0'));
}

function parseSrt(text) {
  const normalized = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const blocks = normalized.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    let i = 0;
    let index = null;
    if (lines.length && /^\d+$/.test(lines[0].trim())) {
      index = Number(lines[0].trim());
      i = 1;
    }
    const timing = lines[i] || '';
    const m = /^\s*(\S+)\s*-->\s*(\S+)/.exec(timing);
    if (!m) {
      const err = new Error(`无法解析字幕块: ${block.slice(0, 60)}`);
      err.code = 'SRT_PARSE';
      throw err;
    }
    cues.push({
      index,
      start: parseTime(m[1]),
      end: parseTime(m[2]),
      text: lines.slice(i + 1).join('\n'),
    });
  }
  return cues;
}

module.exports = { parseSrt, parseTime };
