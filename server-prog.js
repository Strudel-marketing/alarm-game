// Simplified server without external dependencies
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Data files
const DATA_DIR = path.join(__dirname, 'data');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const PROCESSED_FILE = path.join(DATA_DIR, 'processed_alerts.json');
const GAME_DATA_FILE = path.join(DATA_DIR, 'game_data.json');
const SAMPLE_API = path.join(__dirname, 'sample_api_response.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  for (const file of [ALERTS_FILE, PROCESSED_FILE, GAME_DATA_FILE]) {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify({}));
    }
  }
}

function loadData(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveData(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function fetchAlertsFromAPI() {
  try {
    return JSON.parse(fs.readFileSync(SAMPLE_API, 'utf8'));
  } catch (err) {
    console.error('Failed to read sample API data:', err.message);
    return null;
  }
}

function processAlerts() {
  const apiData = fetchAlertsFromAPI();
  if (!apiData) return;

  const alerts = loadData(ALERTS_FILE);
  const processed = loadData(PROCESSED_FILE);
  const today = new Date().toISOString().split('T')[0];

  if (!alerts[today]) alerts[today] = [];

  for (const alert of apiData) {
    const location = alert.location;
    const time = alert.time;
    const id = `${location}_${time}`;

    if (processed[id]) continue;

    alerts[today].push({ location, time, timestamp: new Date().toISOString() });
    processed[id] = true;
  }

  saveData(ALERTS_FILE, alerts);
  saveData(PROCESSED_FILE, processed);
}

function getStats(alerts) {
  const stats = { totalAlerts: 0, alertsByLocation: {}, alertsByHour: {} };

  for (const date of Object.keys(alerts)) {
    for (const a of alerts[date]) {
      stats.totalAlerts++;
      stats.alertsByLocation[a.location] = (stats.alertsByLocation[a.location] || 0) + 1;
      const hour = parseInt(a.time.split(':')[0], 10);
      stats.alertsByHour[hour] = (stats.alertsByHour[hour] || 0) + 1;
    }
  }

  return stats;
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
}

function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return serveStatic(res, path.join(__dirname, 'public', 'index.html'));
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/alerts')) {
    const alerts = loadData(ALERTS_FILE);
    const date = url.pathname.split('/')[3];
    if (date) {
      return res.end(JSON.stringify(alerts[date] || []));
    }
    return res.end(JSON.stringify(alerts));
  }

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    const alerts = loadData(ALERTS_FILE);
    return res.end(JSON.stringify(getStats(alerts)));
  }

  if (req.method === 'GET' && url.pathname === '/api/debug') {
    const data = fetchAlertsFromAPI();
    return res.end(JSON.stringify({ success: true, apiResponse: data }));
  }

  if (req.method === 'POST' && url.pathname === '/api/check-now') {
    processAlerts();
    return res.end(JSON.stringify({ success: true }));
  }

  if (req.method === 'GET' && url.pathname === '/api/gameData') {
    const data = loadData(GAME_DATA_FILE);
    return res.end(JSON.stringify(data));
  }

  if (req.method === 'POST' && url.pathname === '/api/gameData') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) req.connection.destroy();
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        saveData(GAME_DATA_FILE, data);
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  }

  res.writeHead(404);
  res.end('Not found');
}

ensureDataDir();
processAlerts();
setInterval(processAlerts, 10000);

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }
  handleRequest(req, res);
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
