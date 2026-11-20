'use strict';

// 仅使用 Node.js 内置模块的 HTTP 服务。
// 启动：node server.js （读取环境变量 PORT，默认 3000；绑定 127.0.0.1）

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { App } = require('./lib/app');
const { SubtitleError } = require('./lib/core');

const INDEX_HTML = path.join(__dirname, 'public', 'index.html');

const ERROR_STATUS = {
  NO_SUCH_EDITION: 404,
  NOTHING_PUBLISHED: 404,
  NOT_IMPORTED: 409,
  ALREADY_REVISED: 409,
  NOTHING_TO_COMPARE: 409,
  PATCH_BASE_MISMATCH: 409,
  PATCH_IN_FLIGHT: 409,
  PATCH_INCOMPLETE: 409,
  NO_PATCH_IN_FLIGHT: 409,
  MERGE_INVALID: 422,
  PATCH_CHECKSUM: 422,
  MIXED_VERSION: 422,
  BAD_JSON: 400,
  BAD_TRACK: 400,
  SAME_TRACK: 400,
  BAD_STRATEGY: 400,
  NO_SUCH_SEGMENT: 404,
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendError(res, err) {
  const code = err instanceof SubtitleError || err.code ? err.code : 'INTERNAL';
  const status = ERROR_STATUS[code] || (code === 'INTERNAL' ? 500 : 400);
  sendJson(res, status, { ok: false, error: { code, message: err.message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(Object.assign(new Error('请求体过大'), { code: 'BAD_JSON' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new SubtitleError('BAD_JSON', '请求体不是合法 JSON');
  }
}

function createServer(app) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const route = `${req.method} ${url.pathname}`;

      if (route === 'GET /') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(INDEX_HTML));
        return;
      }
      if (route === 'GET /api/state') {
        sendJson(res, 200, { ok: true, data: app.state() });
        return;
      }
      if (route === 'GET /api/playback') {
        const version = url.searchParams.get('version') || undefined;
        const dv = url.searchParams.get('dialogueVersion');
        const sv = url.searchParams.get('sfxVersion');
        const opts = dv || sv ? { trackVersions: { dialogue: dv, sfx: sv } } : {};
        sendJson(res, 200, { ok: true, data: app.player.playback(version, opts) });
        return;
      }
      if (route === 'POST /api/import') {
        await parseJsonBody(req); // 允许空 body，但非法 JSON 要报 400
        sendJson(res, 200, { ok: true, data: app.importSamples() });
        return;
      }
      if (route === 'POST /api/revise-patch') {
        const body = await parseJsonBody(req);
        const mode = body.mode === 'full' ? 'full' : 'patch';
        sendJson(res, 200, { ok: true, data: app.reviseAndPatch(mode) });
        return;
      }
      if (route === 'POST /api/compare') {
        await parseJsonBody(req);
        sendJson(res, 200, { ok: true, data: app.compare() });
        return;
      }
      if (route === 'GET /favicon.ico') {
        res.writeHead(204).end();
        return;
      }
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `未知路由: ${route}` } });
    } catch (err) {
      sendError(res, err);
    }
  });
}

if (require.main === module) {
  const app = new App({ sampleDir: path.join(__dirname, 'samples') });
  const PORT = Number(process.env.PORT || 3000);
  createServer(app).listen(PORT, '127.0.0.1', () => {
    console.log(`双轨字幕演示已启动: http://127.0.0.1:${PORT}`);
  });
}

module.exports = { createServer, App };
