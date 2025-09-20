const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
const fs = require('fs');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_FILE = './database.json';

// Enable CORS for all routes
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Load database
function loadDatabase() {
    try {
        if (fs.existsSync(DATABASE_FILE)) {
            const data = fs.readFileSync(DATABASE_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error loading database:', error);
    }
    return { tokens: [], lastUpdated: null };
}

// Save database
function saveDatabase(data) {
    try {
        fs.writeFileSync(DATABASE_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('Error saving database:', error);
        return false;
    }
}

// Check if user is admin
function isAdmin(password) {
    return password === process.env.ADMIN_PASSWORD;
}

// Get all tokens (public endpoint)
app.get('/api/tokens', (req, res) => {
    try {
        const db = loadDatabase();
        res.json(db.tokens);
    } catch (error) {
        res.status(500).json({ error: 'Failed to load tokens' });
    }
});

// Add token (admin only)
app.post('/api/tokens', (req, res) => {
    try {
        const { token, adminPassword } = req.body;
        
        if (!isAdmin(adminPassword)) {
            return res.status(401).json({ error: 'Unauthorized: Invalid admin password' });
        }
        
        const db = loadDatabase();
        
        // Check if token already exists
        if (db.tokens.find(t => t.slug.toLowerCase() === token.slug.toLowerCase())) {
            return res.status(400).json({ error: 'Token with this slug already exists' });
        }
        
        // Add new token
        const newToken = {
            id: Date.now(),
            name: token.name.toUpperCase(),
            slug: token.slug.toLowerCase(),
            topToday: parseFloat(token.topToday),
            topYesterday: parseFloat(token.topYesterday),
            volumeToday: null,
            volumeYesterday: null,
            lastUpdated: null
        };
        
        db.tokens.push(newToken);
        db.lastUpdated = new Date().toISOString();
        
        if (saveDatabase(db)) {
            res.json({ success: true, token: newToken });
        } else {
            res.status(500).json({ error: 'Failed to save token' });
        }
        
    } catch (error) {
        res.status(500).json({ error: 'Failed to add token' });
    }
});

// Update token (admin only)
app.put('/api/tokens/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { updates, adminPassword } = req.body;
        
        if (!isAdmin(adminPassword)) {
            return res.status(401).json({ error: 'Unauthorized: Invalid admin password' });
        }
        
        const db = loadDatabase();
        const tokenIndex = db.tokens.findIndex(t => t.id === parseInt(id));
        
        if (tokenIndex === -1) {
            return res.status(404).json({ error: 'Token not found' });
        }
        
        // Update token
        Object.assign(db.tokens[tokenIndex], updates);
        db.lastUpdated = new Date().toISOString();
        
        if (saveDatabase(db)) {
            res.json({ success: true, token: db.tokens[tokenIndex] });
        } else {
            res.status(500).json({ error: 'Failed to update token' });
        }
        
    } catch (error) {
        res.status(500).json({ error: 'Failed to update token' });
    }
});

// Delete token (admin only)
app.delete('/api/tokens/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { adminPassword } = req.body;
        
        if (!isAdmin(adminPassword)) {
            return res.status(401).json({ error: 'Unauthorized: Invalid admin password' });
        }
        
        const db = loadDatabase();
        const tokenIndex = db.tokens.findIndex(t => t.id === parseInt(id));
        
        if (tokenIndex === -1) {
            return res.status(404).json({ error: 'Token not found' });
        }
        
        // Remove token
        const deletedToken = db.tokens.splice(tokenIndex, 1)[0];
        db.lastUpdated = new Date().toISOString();
        
        if (saveDatabase(db)) {
            res.json({ success: true, token: deletedToken });
        } else {
            res.status(500).json({ error: 'Failed to delete token' });
        }
        
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete token' });
    }
});

// Update volume for token (admin only)
app.put('/api/tokens/:id/volume', (req, res) => {
    try {
        const { id } = req.params;
        const { volume, adminPassword } = req.body;
        
        if (!isAdmin(adminPassword)) {
            return res.status(401).json({ error: 'Unauthorized: Invalid admin password' });
        }
        
        const db = loadDatabase();
        const token = db.tokens.find(t => t.id === parseInt(id));
        
        if (!token) {
            return res.status(404).json({ error: 'Token not found' });
        }
        
        // Store previous volume as yesterday's volume if not set
        if (token.volumeYesterday === null && token.volumeToday !== null) {
            token.volumeYesterday = token.volumeToday;
        }
        
        token.volumeToday = volume;
        token.lastUpdated = new Date().toISOString();
        db.lastUpdated = new Date().toISOString();
        
        if (saveDatabase(db)) {
            res.json({ success: true, token });
        } else {
            res.status(500).json({ error: 'Failed to update volume' });
        }
        
    } catch (error) {
        res.status(500).json({ error: 'Failed to update volume' });
    }
});

// Check admin status
app.post('/api/admin/verify', (req, res) => {
    const { password } = req.body;
    res.json({ isAdmin: isAdmin(password) });
});

// Automated volume fetching functions
async function fetchVolumeForToken(token) {
    try {
        const apiUrl = `https://api.coinmarketcap.com/data-api/v3/cryptocurrency/market-pairs/latest?slug=${token.slug}&start=1&limit=10&category=spot&centerType=all&sort=volume_24h_strict&direction=desc&spotUntracked=false&exchangeIds=12524`;
        
        console.log(`Fetching volume for ${token.name}...`);
        
        const response = await fetch(apiUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.data && data.data.marketPairs && data.data.marketPairs.length > 0) {
            const rank1Cex = data.data.marketPairs.find(pair => 
                pair.rank === 1 && pair.type === 'cex'
            );
            
            if (rank1Cex) {
                return rank1Cex.volumeUsd;
            } else {
                console.log(`No rank 1 CEX data found for ${token.name}`);
                return null;
            }
        } else {
            console.log(`No market data found for ${token.name}`);
            return null;
        }
        
    } catch (error) {
        console.error(`Error fetching volume for ${token.name}:`, error.message);
        return null;
    }
}

async function performDailyVolumeUpdate() {
    console.log('🕐 Starting daily volume update at 7 AM UTC+7...');
    
    try {
        const db = loadDatabase();
        let updatedCount = 0;
        
        for (const token of db.tokens) {
            console.log(`Processing ${token.name}...`);
            
            // Fetch new volume
            const newVolume = await fetchVolumeForToken(token);
            
            if (newVolume !== null) {
                // Shift volumes: today → yesterday, new → today
                token.volumeYesterday = token.volumeToday;
                token.volumeToday = newVolume;
                token.lastUpdated = new Date().toISOString();
                updatedCount++;
                
                console.log(`✅ Updated ${token.name}: New volume = $${newVolume.toLocaleString()}`);
            } else {
                console.log(`❌ Failed to fetch volume for ${token.name}`);
            }
            
            // Small delay between requests
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Save updated database
        db.lastUpdated = new Date().toISOString();
        if (saveDatabase(db)) {
            console.log(`🎉 Daily volume update completed! Updated ${updatedCount}/${db.tokens.length} tokens`);
        } else {
            console.error('❌ Failed to save database after daily update');
        }
        
    } catch (error) {
        console.error('❌ Error during daily volume update:', error);
    }
}

// Manual trigger endpoint for testing (admin only)
app.post('/api/admin/trigger-update', async (req, res) => {
    const { adminPassword } = req.body;
    
    if (!isAdmin(adminPassword)) {
        return res.status(401).json({ error: 'Unauthorized: Invalid admin password' });
    }
    
    try {
        // Run the update in the background
        performDailyVolumeUpdate();
        res.json({ success: true, message: 'Daily volume update started' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to start daily update' });
    }
});

// Schedule daily volume updates at 7:00 AM UTC+7 (12:00 AM UTC)
// Cron format: minute hour day-of-month month day-of-week
// 7 AM UTC+7 = 12 AM UTC (midnight UTC)
cron.schedule('0 0 * * *', () => {
    console.log('📅 Daily volume update: Running scheduled update at 7 AM UTC+7');
    performDailyVolumeUpdate();
}, {
    timezone: "Asia/Bangkok" // UTC+7
});

console.log('📅 Daily volume update scheduled for 7:00 AM UTC+7');

// Get next scheduled run time for display
app.get('/api/schedule-info', (req, res) => {
    const now = new Date();
    const nextRun = new Date();
    
    // Set to next 7 AM UTC+7
    nextRun.setUTCHours(0, 0, 0, 0); // 12:00 AM UTC = 7:00 AM UTC+7
    if (nextRun <= now) {
        nextRun.setDate(nextRun.getDate() + 1); // Next day
    }
    
    res.json({
        currentTime: now.toISOString(),
        nextScheduledRun: nextRun.toISOString(),
        timezone: 'UTC+7',
        localTime: '7:00 AM',
        testMode: false
    });
});

// API proxy endpoint
app.get('/api/volume/:slug', async (req, res) => {
    try {
        const { slug } = req.params;
        const apiUrl = `https://api.coinmarketcap.com/data-api/v3/cryptocurrency/market-pairs/latest?slug=${slug}&start=1&limit=10&category=spot&centerType=all&sort=volume_24h_strict&direction=desc&spotUntracked=false&exchangeIds=12524`;
        
        console.log(`Fetching data for ${slug}...`);
        
        const response = await fetch(apiUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        res.json(data);
        
    } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).json({ 
            error: 'Failed to fetch data', 
            message: error.message 
        });
    }
});

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`📊 Token tracker is ready!`);
});
