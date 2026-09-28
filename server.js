/**
 * 서울 지하철 실시간 대시보드 - Express 프록시 서버
 *
 * 기능:
 *  1. /api/subway/*   -> swopenapi.seoul.go.kr (실시간 지하철 API, 포트 80)
 *  2. /api/general/*  -> openapi.seoul.go.kr:8088 (서울 열린데이터광장 통계 API)
 *  3. /api/claude      -> api.anthropic.com/v1/messages (AI 분석, SSE 스트리밍 지원)
 *  4. /health, /debug  -> 헬스체크 / 진단용 엔드포인트
 *
 * 필요 환경변수:
 *  - ANTHROPIC_API_KEY : Claude API 키
 *  - PORT (선택)       : 서버 포트 (기본 3000)
 *
 * 실행:
 *  npm install
 *  ANTHROPIC_API_KEY=sk-ant-xxxx node server.js
 */

const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// -----------------------------------------------------------------------
// 공통 미들웨어
// -----------------------------------------------------------------------
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// 요청 로깅 (간단)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// -----------------------------------------------------------------------
// 유틸: 외부 API로 요청을 그대로 흘려보내는 프록시 헬퍼 (http/https 모듈 사용)
// -----------------------------------------------------------------------
/**
 * @param {object} options
 * @param {'http'|'https'} options.protocol
 * @param {string} options.hostname
 * @param {number} options.port
 * @param {string} options.path
 * @param {string} options.method
 * @param {object} [options.headers]
 * @param {Buffer|string} [options.body]
 * @returns {Promise<{statusCode:number, headers:object, body:Buffer}>}
 */
function proxyRequest({ protocol, hostname, port, path, method, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const lib = protocol === 'https' ? https : http;

    const reqOptions = {
      hostname,
      port,
      path,
      method,
      headers,
    };

    const proxyReq = lib.request(reqOptions, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        resolve({
          statusCode: proxyRes.statusCode,
          headers: proxyRes.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    proxyReq.on('error', (err) => reject(err));

    if (body) {
      proxyReq.write(body);
    }
    proxyReq.end();
  });
}

// -----------------------------------------------------------------------
// 1) /api/subway/*  -> swopenapi.seoul.go.kr (실시간 지하철, 포트 80)
// -----------------------------------------------------------------------
app.use('/api/subway', async (req, res, next) => {
  if (req.method !== 'GET') return next();

  try {
    const subPath = '/api/subway' + req.url;
    const result = await proxyRequest({
      protocol: 'http',
      hostname: 'swopenapi.seoul.go.kr',
      port: 80,
      path: subPath,
      method: 'GET',
      headers: {
        Accept: 'application/json, */*',
      },
    });

    res.status(result.statusCode);
    const contentType = result.headers['content-type'] || 'application/json; charset=utf-8';
    res.set('Content-Type', contentType);
    res.send(result.body);
  } catch (err) {
    console.error('[/api/subway] proxy error:', err.message);
    res.status(502).json({
      error: 'Bad Gateway',
      message: '실시간 지하철 API(swopenapi.seoul.go.kr) 호출에 실패했습니다.',
      detail: err.message,
    });
  }
});

// -----------------------------------------------------------------------
// 2) /api/general/* -> openapi.seoul.go.kr:8088 (통계 API)
// -----------------------------------------------------------------------
app.get('/api/general/*path', async (req, res) => {
  try {
    const subPath = '/' + req.params.path.join('/');
    const queryString = req.originalUrl.split('?')[1];
    const fullPath = queryString ? `${subPath}?${queryString}` : subPath;

    const result = await proxyRequest({
      protocol: 'http',
      hostname: 'openapi.seoul.go.kr',
      port: 8088,
      path: subPath,
      method: 'GET',
      headers: {
        Accept: 'application/json, */*',
      },
    });

    res.status(result.statusCode);
    const contentType = result.headers['content-type'] || 'application/json; charset=utf-8';
    res.set('Content-Type', contentType);
    res.send(result.body);
  } catch (err) {
    console.error('[/api/general] proxy error:', err.message);
    res.status(502).json({
      error: 'Bad Gateway',
      message: '통계 API(openapi.seoul.go.kr:8088) 호출에 실패했습니다.',
      detail: err.message,
    });
  }
});

// -----------------------------------------------------------------------
// 3) /api/claude -> api.anthropic.com/v1/messages (stream 지원)
// -----------------------------------------------------------------------
app.post('/api/claude', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'Server Misconfiguration',
      message: 'ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않습니다.',
    });
  }

  const isStream = req.body && req.body.stream === true;
  const payload = JSON.stringify(req.body || {});

  const options = {
    hostname: 'api.anthropic.com',
    port: 443,
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  const upstreamReq = https.request(options, (upstreamRes) => {
    if (isStream) {
      // SSE 스트리밍 응답을 그대로 클라이언트로 중계
      res.status(upstreamRes.statusCode);
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      upstreamRes.on('data', (chunk) => {
        res.write(chunk);
      });
      upstreamRes.on('end', () => {
        res.end();
      });
      upstreamRes.on('error', (err) => {
        console.error('[/api/claude] stream error:', err.message);
        res.end();
      });
    } else {
      // 일반 JSON 응답
      const chunks = [];
      upstreamRes.on('data', (chunk) => chunks.push(chunk));
      upstreamRes.on('end', () => {
        res.status(upstreamRes.statusCode);
        res.set('Content-Type', upstreamRes.headers['content-type'] || 'application/json');
        res.send(Buffer.concat(chunks));
      });
    }
  });

  upstreamReq.on('error', (err) => {
    console.error('[/api/claude] request error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({
        error: 'Bad Gateway',
        message: 'Claude API(api.anthropic.com) 호출에 실패했습니다.',
        detail: err.message,
      });
    } else {
      res.end();
    }
  });

  // 클라이언트가 연결을 끊으면 업스트림 요청도 종료
  req.on('close', () => {
    upstreamReq.destroy();
  });

  upstreamReq.write(payload);
  upstreamReq.end();
});

// -----------------------------------------------------------------------
// 4) 헬스체크 / 진단 엔드포인트
// -----------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime_seconds: process.uptime(),
    timestamp: new Date().toISOString(),
    port: PORT,
  });
});

app.get('/debug', async (req, res) => {
  const results = {};

  // 1) 지하철 실시간 API 진단 (샘플 호출)
  try {
    const r = await proxyRequest({
      protocol: 'http',
      hostname: 'swopenapi.seoul.go.kr',
      port: 80,
      path: '/api/subway/sample/json/realtimeStationArrival/0/5/서울역',
      method: 'GET',
      headers: { Accept: 'application/json, */*' },
    });
    results.subway = {
      reachable: true,
      statusCode: r.statusCode,
      bodyPreview: r.body.toString('utf8').slice(0, 300),
    };
  } catch (err) {
    results.subway = { reachable: false, error: err.message };
  }

  // 2) 통계 API 진단 (샘플 호출)
  try {
    const r = await proxyRequest({
      protocol: 'http',
      hostname: 'openapi.seoul.go.kr',
      port: 8088,
      path: '/sample/json/SearchSTNBySubwayLineInfo/1/5',
      method: 'GET',
      headers: { Accept: 'application/json, */*' },
    });
    results.general = {
      reachable: true,
      statusCode: r.statusCode,
      bodyPreview: r.body.toString('utf8').slice(0, 300),
    };
  } catch (err) {
    results.general = { reachable: false, error: err.message };
  }

  // 3) Claude API 키 설정 여부
  results.claude = {
    apiKeyConfigured: Boolean(ANTHROPIC_API_KEY),
  };

  res.json({
    timestamp: new Date().toISOString(),
    checks: results,
  });
});

// -----------------------------------------------------------------------
// 404 핸들러
// -----------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.originalUrl });
});

// -----------------------------------------------------------------------
// 에러 핸들러
// -----------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

// -----------------------------------------------------------------------
// 서버 시작
// -----------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`서울 지하철 대시보드 프록시 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
  console.log(`  - GET  /api/subway/*path   -> swopenapi.seoul.go.kr`);
  console.log(`  - GET  /api/general/*path  -> openapi.seoul.go.kr:8088`);
  console.log(`  - POST /api/claude         -> api.anthropic.com/v1/messages`);
  console.log(`  - GET  /health`);
  console.log(`  - GET  /debug`);
  if (!ANTHROPIC_API_KEY) {
    console.warn('경고: ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다. /api/claude는 실패합니다.');
  }
});

module.exports = app;
