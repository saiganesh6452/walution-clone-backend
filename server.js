// server.js - zero-dependency local queue for quick testing
const http = require('http');

// fallback for uuid if not installed (node 18+ has crypto.randomUUID)
function makeUUID() {
  try {
    return require('crypto').randomUUID();
  } catch (e) {
    // simple fallback
    return 'id-' + Date.now() + '-' + Math.floor(Math.random()*1000000);
  }
}

const PORT = process.env.PORT || 3000;
let API_KEYS = new Set(['DEV_KEY_123456']);
let jobs = []; // in-memory queue

function sendJSON(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, {'Content-Type':'application/json','Content-Length': Buffer.byteLength(s)});
  res.end(s);
}

// simple helper to forward to Apps Script webhook if configured in env
function forwardToAppsScript(job, status, detail) {
  const webhookBase = process.env.APPSCRIPT_WEBHOOK || '';
  const webhookSecret = process.env.WEBHOOK_SECRET || '';
  if (!webhookBase) return;
  const body = JSON.stringify({
    spreadsheetId: job.spreadsheetId,
    sheetName: job.sheetName,
    rowIndex: job.rowIndex,
    status: status + (detail ? (': ' + detail) : ''),
    secret: webhookSecret
  });
  try {
    const url = new URL(webhookBase);
    const httpMod = url.protocol === 'https:' ? require('https') : require('http');
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = httpMod.request(opts, (res) => {
      // swallow response
      res.on('data', ()=>{});
    });
    req.on('error', (e) => console.error('forward error', e));
    req.write(body);
    req.end();
  } catch (e) {
    console.error('forward exception', e);
  }
}

const server = http.createServer(async (req, res) => {
  // POST /sendq
  if (req.method === 'POST' && req.url === '/sendq') {
    const key = (req.headers['x-api-key'] || '').toString();
    if (!API_KEYS.has(key)) return sendJSON(res, 401, { error: 'unauthorized' });
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const data = JSON.parse(body);
      const incoming = Array.isArray(data.jobs) ? data.jobs : [];
      const added = incoming.map(j => {
        const id = makeUUID();
        const job = {
          id,
          spreadsheetId: j.spreadsheetId,
          sheetName: j.sheetName,
          rowIndex: j.rowIndex,
          phone: j.phone,
          text: j.text,
          status: 'queued',
          createdAt: new Date().toISOString()
        };
        jobs.push(job);
        return { id, phone: job.phone };
      });
      return sendJSON(res, 200, { message: 'queued', count: added.length, items: added });
    } catch (e) {
      return sendJSON(res, 400, { error: 'invalid json' });
    }
  }

  // GET /next
  if (req.method === 'GET' && req.url === '/next') {
    const key = (req.headers['x-api-key'] || '').toString();
    if (!API_KEYS.has(key)) return sendJSON(res, 401, { error: 'unauthorized' });
    const idx = jobs.findIndex(j => j.status === 'queued');
    if (idx === -1) return res.writeHead(204).end();
    const job = jobs[idx];
    job.status = 'in_progress';
    // attach callback/apikey fields so extension can call /log back properly (optional)
    job.apikey = key;
    sendJSON(res, 200, job);
    return;
  }

  // POST /log
  if (req.method === 'POST' && req.url === '/log') {
    const key = (req.headers['x-api-key'] || '').toString();
    if (!API_KEYS.has(key)) return sendJSON(res, 401, { error: 'unauthorized' });
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { id, status, detail } = JSON.parse(body);
      if (!id || !status) return sendJSON(res, 400, { error: 'missing id or status' });
      const job = jobs.find(j => j.id === id);
      if (!job) return sendJSON(res, 404, { error: 'job not found' });
      job.status = status;
      job.detail = detail || '';
      // forward status to Apps Script webhook if env vars configured
      forwardToAppsScript(job, status, detail);
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 400, { error: 'invalid json' });
    }
  }

  // GET /health
  if (req.method === 'GET' && req.url === '/health') {
    return sendJSON(res, 200, { ok: true, queued: jobs.filter(j => j.status === 'queued').length });
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => console.log(`server-lite listening on ${PORT} (in-memory queue). API key: DEV_KEY_123456`));
