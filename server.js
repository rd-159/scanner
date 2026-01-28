const http = require('http');
const crypto = require('crypto');
const { runScanForDomain } = require('./shopscanner2');

try {
  require('dotenv').config();
} catch (error) {
  // Optional dependency; ignore if not installed.
}

const PORT = process.env.PORT || 3000;
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
    <div id="exportBar" style="display:none; margin: 12px 0;">
      <button id="exportCsv">Export CSV</button>
      <button id="exportXls">Export XLS</button>
    </div>
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
      const exportBarEl = document.getElementById('exportBar');
      const exportCsvEl = document.getElementById('exportCsv');
      const exportXlsEl = document.getElementById('exportXls');
      let lastResult = null;

      const clearResults = () => {
        resultsEl.innerHTML = '';
        exportBarEl.style.display = 'none';
        lastResult = null;
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

      const buildTable = (items, label) => {
        const table = document.createElement('table');
        table.style.width = '100%';
        table.style.borderCollapse = 'collapse';

        const headRow = document.createElement('tr');
        ['Type', 'Title', 'Variant', 'Price', 'Available', 'Cart URL', 'Product URL', 'Source', 'Found At'].forEach(text => {
          const th = document.createElement('th');
          th.textContent = text;
          th.style.border = '1px solid #ddd';
          th.style.padding = '6px';
          th.style.textAlign = 'left';
          headRow.appendChild(th);
        });
        table.appendChild(headRow);

        items.forEach(item => {
          const row = document.createElement('tr');
          const cells = [
            label,
            item.title || '',
            item.variant || '',
            Number(item.price || 0).toFixed(2),
            item.available ? 'Yes' : 'No',
            item.cartUrl || '',
            item.productUrl || '',
            item.source || '',
            item.foundAt || ''
          ];
          cells.forEach(text => {
            const td = document.createElement('td');
            td.textContent = text;
            td.style.border = '1px solid #ddd';
            td.style.padding = '6px';
            td.style.verticalAlign = 'top';
            row.appendChild(td);
          });
          table.appendChild(row);
        });
        return table;
      };

      const renderResultsTable = (data) => {
        const items = []
          .concat((data.freeItems || []).map(item => ({ ...item, _label: 'Free Item' })))
          .concat((data.lowestPricedItems || []).map(item => ({ ...item, _label: 'Lowest Priced' })));

        const card = document.createElement('div');
        card.className = 'card';
        const h3 = document.createElement('h3');
        h3.textContent = 'Results';
        card.appendChild(h3);

        if (!items.length) {
          const p = document.createElement('p');
          p.className = 'muted';
          p.textContent = 'No items found.';
          card.appendChild(p);
        } else {
          const table = document.createElement('table');
          table.style.width = '100%';
          table.style.borderCollapse = 'collapse';

          const headRow = document.createElement('tr');
          ['Type', 'Title', 'Variant', 'Price', 'Available', 'Cart URL', 'Product URL', 'Source', 'Found At'].forEach(text => {
            const th = document.createElement('th');
            th.textContent = text;
            th.style.border = '1px solid #ddd';
            th.style.padding = '6px';
            th.style.textAlign = 'left';
            headRow.appendChild(th);
          });
          table.appendChild(headRow);

          items.forEach(item => {
            const row = document.createElement('tr');
            const cells = [
              item._label || '',
              item.title || '',
              item.variant || '',
              Number(item.price || 0).toFixed(2),
              item.available ? 'Yes' : 'No',
              item.cartUrl || '',
              item.productUrl || '',
              item.source || '',
              item.foundAt || ''
            ];
            cells.forEach(text => {
              const td = document.createElement('td');
              td.textContent = text;
              td.style.border = '1px solid #ddd';
              td.style.padding = '6px';
              td.style.verticalAlign = 'top';
              row.appendChild(td);
            });
            table.appendChild(row);
          });

          card.appendChild(table);
        }
        resultsEl.appendChild(card);
      };

      const toCsv = (data) => {
        const rows = [
          ['Type','Title','Variant','Price','Available','Cart URL','Product URL','Source','Found At']
        ];
        const pushRows = (items, label) => {
          (items || []).forEach(item => {
            rows.push([
              label,
              item.title || '',
              item.variant || '',
              Number(item.price || 0).toFixed(2),
              item.available ? 'Yes' : 'No',
              item.cartUrl || '',
              item.productUrl || '',
              item.source || '',
              item.foundAt || ''
            ]);
          });
        };
        pushRows(data.freeItems, 'Free Item');
        pushRows(data.lowestPricedItems, 'Lowest Priced');
        return rows.map(row =>
          row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')
        ).join('\n');
      };

      const downloadFile = (content, filename, mime) => {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      };

      exportCsvEl.addEventListener('click', () => {
        if (!lastResult) return;
        const csv = toCsv(lastResult);
        const name = `${lastResult.domain || 'scan'}-${new Date().toISOString().slice(0,10)}.csv`;
        downloadFile(csv, name, 'text/csv;charset=utf-8;');
      });

      exportXlsEl.addEventListener('click', () => {
        if (!lastResult) return;
        const items = []
          .concat((lastResult.freeItems || []).map(item => ({ ...item, _label: 'Free Item' })))
          .concat((lastResult.lowestPricedItems || []).map(item => ({ ...item, _label: 'Lowest Priced' })));

        const table = buildTable(items, '');
        const html = `
          <html>
            <head><meta charset="utf-8" /></head>
            <body>${table.outerHTML}</body>
          </html>
        `;
        const name = `${lastResult.domain || 'scan'}-${new Date().toISOString().slice(0,10)}.xls`;
        downloadFile(html, name, 'application/vnd.ms-excel');
      });

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
          lastResult = data;
          addCard('Summary', [
            'Domain: ' + data.domain,
            'Scanned URL: ' + data.scannedUrl,
            'Free items: ' + data.freeItemsFound,
            'Duration: ' + data.durationSeconds + 's'
          ]);

          renderResultsTable(data);

          addCard('Files', [
            'Text: ' + data.outputFile,
            'CSV: ' + data.csvFile
          ]);
          exportBarEl.style.display = '';
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
