const http = require('http');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { runScanForDomain } = require('./shopscanner2');

try {
  require('dotenv').config();
} catch (error) {
  // Optional dependency; ignore if not installed.
}

const PORT = process.env.PORT || 3000;
const DB_HOST = process.env.DB_HOST || '';
const DB_USER = process.env.DB_USER || '';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || '';
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_AUTO_MIGRATE = (process.env.DB_AUTO_MIGRATE || 'true').toLowerCase() === 'true';
const DB_TABLE_RAW = process.env.DB_TABLE || 'scan_results';
const DB_TABLE = DB_TABLE_RAW.replace(/[^a-zA-Z0-9_]/g, '') || 'scan_results';
const SCANNER_PASSWORD = process.env.SCANNER_PASSWORD || '';
let scanInProgress = false;
const activeSessions = new Map();

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ShopScanner</title>
    <style>
      :root { color-scheme: light; }
      body { font-family: Arial, sans-serif; margin: 24px; color: #1a1a1a; }
      h1 { margin-bottom: 6px; }
      p { margin: 4px 0 12px; color: #444; }
      form { display: flex; gap: 8px; flex-wrap: wrap; margin: 16px 0; }
      input[type="text"] { flex: 1 1 320px; padding: 10px; font-size: 16px; }
      button { padding: 10px 16px; font-size: 16px; cursor: pointer; }
      .status { margin: 12px 0; font-weight: bold; }
      .card { border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin: 10px 0; }
      .muted { color: #666; }
      ul { padding-left: 18px; }
      code { background: #f4f4f4; padding: 2px 4px; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>ShopScanner</h1>
    <p>Enter the access password to unlock scanning.</p>
    <form id="authForm">
      <input id="passwordInput" type="password" placeholder="Password" required />
      <button id="unlockButton" type="submit">Unlock</button>
    </form>
    <form id="scanForm" style="display:none;">
      <input id="urlInput" type="text" placeholder="example.com or https://example.com" required />
      <button id="scanButton" type="submit">Run Scan</button>
    </form>
    <div id="status" class="status"></div>
    <div id="results"></div>
    <script>
      const authForm = document.getElementById('authForm');
      const scanForm = document.getElementById('scanForm');
      const statusEl = document.getElementById('status');
      const resultsEl = document.getElementById('results');
      const buttonEl = document.getElementById('scanButton');
      const unlockButtonEl = document.getElementById('unlockButton');
      const inputEl = document.getElementById('urlInput');
      const passwordEl = document.getElementById('passwordInput');

      const clearResults = () => {
        resultsEl.innerHTML = '';
      };

      const setStatus = (text, isError = false) => {
        statusEl.textContent = text;
        statusEl.style.color = isError ? '#b00020' : '#1a1a1a';
      };

      const addCard = (title, lines) => {
        const card = document.createElement('div');
        card.className = 'card';
        const h3 = document.createElement('h3');
        h3.textContent = title;
        card.appendChild(h3);
        lines.forEach(line => {
          const p = document.createElement('p');
          p.textContent = line;
          card.appendChild(p);
        });
        resultsEl.appendChild(card);
      };

      const addListCard = (title, items) => {
        const card = document.createElement('div');
        card.className = 'card';
        const h3 = document.createElement('h3');
        h3.textContent = title;
        card.appendChild(h3);
        if (!items.length) {
          const p = document.createElement('p');
          p.className = 'muted';
          p.textContent = 'None found.';
          card.appendChild(p);
        } else {
          const ul = document.createElement('ul');
          items.forEach(item => {
            const li = document.createElement('li');
            li.textContent = item;
            ul.appendChild(li);
          });
          card.appendChild(ul);
        }
        resultsEl.appendChild(card);
      };

      const setUnlocked = (unlocked) => {
        if (unlocked) {
          authForm.style.display = 'none';
          scanForm.style.display = '';
          setStatus('Scanner unlocked.');
        } else {
          authForm.style.display = '';
          scanForm.style.display = 'none';
        }
      };

      const checkAuth = async () => {
        try {
          const response = await fetch('/api/auth/check');
          const data = await response.json();
          setUnlocked(Boolean(data && data.authenticated));
        } catch (error) {
          setUnlocked(false);
        }
      };

      authForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const password = passwordEl.value;
        if (!password) return;
        setStatus('Unlocking...');
        unlockButtonEl.disabled = true;
        try {
          const response = await fetch('/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
          });
          const data = await response.json();
          if (!response.ok || !data.success) {
            setStatus(data.error || 'Invalid password.', true);
            return;
          }
          passwordEl.value = '';
          setUnlocked(true);
        } catch (error) {
          setStatus('Unlock failed: ' + error.message, true);
        } finally {
          unlockButtonEl.disabled = false;
        }
      });

      scanForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const url = inputEl.value.trim();
        if (!url) return;

        clearResults();
        setStatus('Scanning... this can take a few minutes.');
        buttonEl.disabled = true;

        try {
          const response = await fetch('/api/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
          });
          const data = await response.json();
          if (!response.ok || !data.success) {
            setStatus(data.error || 'Scan failed.', true);
            return;
          }

          setStatus('Scan complete.');
          addCard('Summary', [
            'Domain: ' + data.domain,
            'Scanned URL: ' + data.scannedUrl,
            'Free items: ' + data.freeItemsFound,
            'Duration: ' + data.durationSeconds + 's'
          ]);

          const freeItems = (data.freeItems || []).map(item =>
            item.title + ' - $' + Number(item.price).toFixed(2)
          );
          addListCard('Free Items', freeItems);

          const lowestPriced = (data.lowestPricedItems || []).map(item =>
            item.title + ' - $' + Number(item.price).toFixed(2)
          );
          addListCard('Lowest Priced Items', lowestPriced);

          addCard('Files', [
            'Text: ' + data.outputFile,
            'CSV: ' + data.csvFile
          ]);
          addCard('Database', [
            'Saved: ' + (data.savedToDatabase ? 'Yes' : 'No'),
            'Key: ' + (data.databaseKey || 'N/A'),
            'Table: ' + (data.databaseTable || 'N/A')
          ]);
        } catch (error) {
          setStatus('Scan failed: ' + error.message, true);
        } finally {
          buttonEl.disabled = false;
        }
      });

      checkAuth();
    </script>
  </body>
</html>`;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendHtml(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 2000) {
        req.destroy();
        reject(new Error('Payload too large.'));
      }
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(data || '{}');
        resolve(parsed);
      } catch (error) {
        reject(new Error('Invalid JSON payload.'));
      }
    });
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach(pair => {
    const index = pair.indexOf('=');
    if (index === -1) return;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

function createSession(res) {
  const token = crypto.randomBytes(24).toString('hex');
  const expires = Date.now() + 1000 * 60 * 60 * 8;
  activeSessions.set(token, expires);
  const cookie = `scan_auth=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 8}`;
  res.setHeader('Set-Cookie', cookie);
}

function isAuthenticated(req) {
  const cookies = parseCookies(req);
  const token = cookies.scan_auth;
  if (!token) return false;
  const expires = activeSessions.get(token);
  if (!expires || expires < Date.now()) {
    activeSessions.delete(token);
    return false;
  }
  return true;
}

let dbPool = null;

function isDbConfigured() {
  return DB_HOST && DB_USER && DB_PASSWORD && DB_NAME;
}

function getDbPool() {
  if (!isDbConfigured()) return null;
  if (!dbPool) {
    dbPool = mysql.createPool({
      host: DB_HOST,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      port: DB_PORT,
      connectionLimit: 5,
      charset: 'utf8mb4'
    });
  }
  return dbPool;
}

async function ensureTable(pool) {
  if (!DB_AUTO_MIGRATE) return;
  const sql = `
    CREATE TABLE IF NOT EXISTS \`${DB_TABLE}\` (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      domain VARCHAR(255) NOT NULL,
      scan_date DATE NOT NULL,
      scan_timestamp DATETIME NOT NULL,
      scanned_url VARCHAR(2048) NULL,
      free_items_count INT NOT NULL DEFAULT 0,
      duration_seconds DECIMAL(6,1) NULL,
      output_file VARCHAR(1024) NULL,
      csv_file VARCHAR(1024) NULL,
      result_json JSON NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_domain_date (domain, scan_date),
      KEY idx_scan_timestamp (scan_timestamp)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  await pool.query(sql);
}

async function saveScanResult(result) {
  const pool = getDbPool();
  if (!pool) {
    return { saved: false, reason: 'Database not configured' };
  }

  await ensureTable(pool);

  const now = new Date();
  const scanDate = now.toISOString().slice(0, 10);
  const scanTimestamp = now.toISOString().slice(0, 19).replace('T', ' ');

  const sql = `
    INSERT INTO \`${DB_TABLE}\`
      (domain, scan_date, scan_timestamp, scanned_url, free_items_count, duration_seconds, output_file, csv_file, result_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const payload = JSON.stringify(result);
  await pool.execute(sql, [
    result.domain,
    scanDate,
    scanTimestamp,
    result.scannedUrl || null,
    Number(result.freeItemsFound || 0),
    result.durationSeconds || null,
    result.outputFile || null,
    result.csvFile || null,
    payload
  ]);

  return { saved: true, key: `${result.domain}-${scanTimestamp}`, table: DB_TABLE };
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html')) {
    return sendHtml(res);
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, scanInProgress });
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/auth/check') {
    return sendJson(res, 200, { authenticated: isAuthenticated(req) });
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/auth') {
    try {
      const body = await readJsonBody(req);
      const password = (body.password || '').toString();
      if (!SCANNER_PASSWORD) {
        return sendJson(res, 500, { success: false, error: 'Scanner password not configured.' });
      }
      if (password !== SCANNER_PASSWORD) {
        return sendJson(res, 401, { success: false, error: 'Invalid password.' });
      }
      createSession(res);
      return sendJson(res, 200, { success: true });
    } catch (error) {
      return sendJson(res, 500, { success: false, error: error.message });
    }
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/scan') {
    if (!isAuthenticated(req)) {
      return sendJson(res, 401, { success: false, error: 'Unauthorized.' });
    }
    if (scanInProgress) {
      return sendJson(res, 409, { success: false, error: 'A scan is already running. Please wait.' });
    }

    try {
      const body = await readJsonBody(req);
      const url = (body.url || '').toString().trim();
      if (!url || url.length > 500) {
        return sendJson(res, 400, { success: false, error: 'Please provide a valid URL or domain.' });
      }

      scanInProgress = true;
      const result = await runScanForDomain(url);
      if (!result.success) {
        return sendJson(res, 400, result);
      }
      const dbResult = await saveScanResult(result);
      result.savedToDatabase = dbResult.saved;
      result.databaseKey = dbResult.key || null;
      result.databaseTable = dbResult.table || null;
      if (!dbResult.saved) {
        result.databaseError = dbResult.reason || 'Failed to save to database';
      }
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, 500, { success: false, error: error.message });
    } finally {
      scanInProgress = false;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`ShopScanner web server listening on http://localhost:${PORT}`);
});
