// server-prog.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Data storage
const DATA_DIR = './data';
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const PROCESSED_ALERTS_FILE = path.join(DATA_DIR, 'processed_alerts.json');

// Ensure data directory exists
async function ensureDataDir() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
    } catch (error) {
        console.error('Error creating data directory:', error);
    }
}

// Load existing data
async function loadData(file) {
    try {
        const data = await fs.readFile(file, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return {};
    }
}

// Save data
async function saveData(file, data) {
    await fs.writeFile(file, JSON.stringify(data, null, 2));
}

// Fetch alerts from Prog API - MUCH SIMPLER!
async function fetchAlertsFromAPI() {
    try {
        const response = await axios.get('https://www.prog.co.il/pakar-tests.php?a=3', {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        // Check if we have valid data
        if (response.data) {
            console.log('📡 Received data from Prog API');
            return response.data;
        }
        return null;
    } catch (error) {
        console.error('Error fetching from Prog API:', error.message);
        return null;
    }
}

// Process and store alerts
async function processAlerts() {
    const apiData = await fetchAlertsFromAPI();
    if (!apiData) return;

    const alerts = await loadData(ALERTS_FILE);
    const processedAlerts = await loadData(PROCESSED_ALERTS_FILE);
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    
    if (!alerts[today]) {
        alerts[today] = [];
    }

    // Process the data based on Prog API structure
    // Note: You'll need to adjust this based on the actual API response structure
    try {
        let newAlerts = [];
        
        // If apiData is an array of alerts
        if (Array.isArray(apiData)) {
            newAlerts = apiData;
        } 
        // If apiData has a property containing the alerts
        else if (apiData.alerts) {
            newAlerts = apiData.alerts;
        }
        // If apiData has a different structure, adjust accordingly
        else if (apiData.data) {
            newAlerts = apiData.data;
        }

        // Process each alert
        for (const alert of newAlerts) {
            // Adjust these fields based on actual API response
            const alertLocation = alert.location || alert.city || alert.area || alert.name;
            const alertTime = alert.time || alert.timestamp || new Date().toISOString();
            const alertId = alert.id || `${alertLocation}_${new Date(alertTime).getTime()}`;
            
            // Check if we've already processed this alert
            if (processedAlerts[alertId]) {
                continue;
            }

            // Check for duplicates within 5 seconds window
            const isDuplicate = alerts[today].some(a => 
                a.location === alertLocation && 
                Math.abs(new Date(a.timestamp) - new Date(alertTime)) < 5000
            );

            if (!isDuplicate) {
                const processedAlert = {
                    id: alertId,
                    location: alertLocation,
                    time: new Date(alertTime).toTimeString().slice(0, 5),
                    timestamp: new Date(alertTime).toISOString(),
                    date: today,
                    raw: alert // Keep raw data for debugging
                };

                alerts[today].push(processedAlert);
                processedAlerts[alertId] = true;

                console.log(`🚨 New alert recorded: ${alertLocation} at ${processedAlert.time}`);
                
                // Emit to connected clients
                if (io) {
                    io.emit('newAlert', processedAlert);
                }
            }
        }

        await saveData(ALERTS_FILE, alerts);
        await saveData(PROCESSED_ALERTS_FILE, processedAlerts);
        
    } catch (error) {
        console.error('Error processing alerts:', error);
        // Log the API response structure for debugging
        console.log('API Response structure:', JSON.stringify(apiData, null, 2).slice(0, 500));
    }
}

// Clean old processed alerts (keep only last 7 days)
async function cleanOldData() {
    const processedAlerts = await loadData(PROCESSED_ALERTS_FILE);
    const cutoffTime = Date.now() - (7 * 24 * 60 * 60 * 1000);
    
    const cleanedAlerts = {};
    for (const [id, _] of Object.entries(processedAlerts)) {
        const timestamp = parseInt(id.split('_')[1]) || Date.now();
        if (timestamp > cutoffTime) {
            cleanedAlerts[id] = true;
        }
    }
    
    await saveData(PROCESSED_ALERTS_FILE, cleanedAlerts);
    console.log('🧹 Cleaned old alert data');
}

// API Routes

// Get alerts for a specific date
app.get('/api/alerts/:date', async (req, res) => {
    try {
        const { date } = req.params;
        const alerts = await loadData(ALERTS_FILE);
        
        if (alerts[date]) {
            res.json(alerts[date]);
        } else {
            res.json([]);
        }
    } catch (error) {
        console.error('Error getting alerts:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get all alerts (with pagination)
app.get('/api/alerts', async (req, res) => {
    try {
        const { from, to, limit = 100, offset = 0 } = req.query;
        const alerts = await loadData(ALERTS_FILE);
        
        let allAlerts = [];
        for (const [date, dateAlerts] of Object.entries(alerts)) {
            if ((!from || date >= from) && (!to || date <= to)) {
                allAlerts = allAlerts.concat(dateAlerts);
            }
        }
        
        // Sort by timestamp descending
        allAlerts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        
        // Apply pagination
        const paginatedAlerts = allAlerts.slice(offset, offset + limit);
        
        res.json({
            alerts: paginatedAlerts,
            total: allAlerts.length,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (error) {
        console.error('Error getting alerts:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get statistics
app.get('/api/stats', async (req, res) => {
    try {
        const alerts = await loadData(ALERTS_FILE);
        const stats = {
            totalDays: Object.keys(alerts).length,
            totalAlerts: 0,
            alertsByLocation: {},
            alertsByHour: {},
            mostActiveDay: null,
            mostActiveLocation: null
        };
        
        let maxAlertsInDay = 0;
        let maxLocationCount = 0;
        
        for (const [date, dateAlerts] of Object.entries(alerts)) {
            stats.totalAlerts += dateAlerts.length;
            
            if (dateAlerts.length > maxAlertsInDay) {
                maxAlertsInDay = dateAlerts.length;
                stats.mostActiveDay = { date, count: dateAlerts.length };
            }
            
            for (const alert of dateAlerts) {
                // Count by location
                if (!stats.alertsByLocation[alert.location]) {
                    stats.alertsByLocation[alert.location] = 0;
                }
                stats.alertsByLocation[alert.location]++;
                
                if (stats.alertsByLocation[alert.location] > maxLocationCount) {
                    maxLocationCount = stats.alertsByLocation[alert.location];
                    stats.mostActiveLocation = alert.location;
                }
                
                // Count by hour
                const hour = parseInt(alert.time.split(':')[0]);
                if (!stats.alertsByHour[hour]) {
                    stats.alertsByHour[hour] = 0;
                }
                stats.alertsByHour[hour]++;
            }
        }
        
        res.json(stats);
    } catch (error) {
        console.error('Error getting stats:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Test API connection
app.get('/api/test-connection', async (req, res) => {
    try {
        const testData = await fetchAlertsFromAPI();
        res.json({
            success: true,
            apiStatus: 'connected',
            dataReceived: testData ? true : false,
            sampleData: testData ? JSON.stringify(testData).slice(0, 200) + '...' : null,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Debug endpoint to see API response structure
app.get('/api/debug', async (req, res) => {
    try {
        const data = await fetchAlertsFromAPI();
        res.json({
            success: true,
            apiResponse: data,
            responseType: typeof data,
            isArray: Array.isArray(data),
            keys: data ? Object.keys(data) : null
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Manual trigger for testing
app.post('/api/check-now', async (req, res) => {
    try {
        await processAlerts();
        res.json({ success: true, message: 'Check completed' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// Socket.io for real-time updates
const server = require('http').createServer(app);
const io = require('socket.io')(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

io.on('connection', (socket) => {
    console.log('👤 Client connected');
    
    socket.on('disconnect', () => {
        console.log('👤 Client disconnected');
    });
});

// Initialize and start server
async function start() {
    await ensureDataDir();
    
    console.log('🚀 Starting Alert Monitoring Server');
    console.log('📡 Using Prog API - No proxy needed!');
    
    // Check for alerts every 10 seconds
    setInterval(processAlerts, 10000);
    
    // Clean old data every day at 3 AM
    cron.schedule('0 3 * * *', cleanOldData);
    
    // Initial check
    console.log('🔍 Performing initial API check...');
    await processAlerts();
    
    server.listen(PORT, () => {
        console.log(`🚨 Alert monitoring server running on port ${PORT}`);
        console.log(`📊 API endpoints:`);
        console.log(`   - GET  /api/alerts/:date     - Get alerts for specific date`);
        console.log(`   - GET  /api/alerts           - Get all alerts with pagination`);
        console.log(`   - GET  /api/stats            - Get statistics`);
        console.log(`   - GET  /api/test-connection  - Test API connection`);
        console.log(`   - GET  /api/debug            - Debug API response`);
        console.log(`   - POST /api/check-now        - Manual check trigger`);
        console.log(`   - GET  /api/health           - Health check`);
        console.log(`\n💡 Visit /api/debug to see the API response structure`);
    });
}

start().catch(console.error);

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

/* 
package.json עבור Prog API (פשוט יותר!):

{
  "name": "alarm-game-server-prog",
  "version": "1.0.0",
  "description": "Alert monitoring server using Prog API",
  "main": "server-prog.js",
  "scripts": {
    "start": "node server-prog.js",
    "dev": "nodemon server-prog.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "axios": "^1.6.0",
    "node-cron": "^3.0.2",
    "socket.io": "^4.6.1"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  }
}

לא צריך את https-proxy-agent! 🎉
*/