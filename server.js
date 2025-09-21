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
        
        // Initialize missing fields for existing tokens
        let dbChanged = false;
        db.tokens.forEach(token => {
            if (token.amount === undefined) {
                token.amount = 0;
                dbChanged = true;
            }
            if (token.currentPrice === undefined) {
                token.currentPrice = null;
                dbChanged = true;
            }
            if (token.totalPrize === undefined) {
                token.totalPrize = null;
                dbChanged = true;
            }
        });
        
        // Save database if any changes were made
        if (dbChanged) {
            saveDatabase(db);
        }
        
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
        
        // Add new token with history arrays
        const newToken = {
            id: Date.now(),
            name: token.name.toUpperCase(),
            slug: token.slug.toLowerCase(),
            topToday: parseFloat(token.topToday),
            topYesterday: parseFloat(token.topYesterday),
            volumeToday: null,
            volumeYesterday: null,
            amount: parseFloat(token.amount) || 0, // Amount for prize calculation
            currentPrice: null, // Current token price from API
            totalPrize: null, // Total prize = currentPrice × amount
            lastUpdated: null,
            status: 'ongoing', // All new tokens start as ongoing
            // New historical data arrays
            topVolumeHistory: [
                {
                    date: new Date().toISOString().split('T')[0],
                    value: parseFloat(token.topToday),
                    timestamp: new Date().toISOString(),
                    type: 'manual_entry'
                }
            ],
            tradingVolumeHistory: []
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
        
        const token = db.tokens[tokenIndex];
        const currentDate = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD format in local timezone
        const currentTimestamp = new Date().toISOString();
        
        // Initialize history arrays if they don't exist (for existing tokens)
        if (!token.topVolumeHistory) token.topVolumeHistory = [];
        if (!token.tradingVolumeHistory) token.tradingVolumeHistory = [];
        
        // Handle top volume changes with special logic for shift operations
        if (updates.topToday !== undefined && updates.topToday !== token.topToday) {
            // Check if this is a shift operation (today's value becomes yesterday's)
            const isShiftOperation = updates.topYesterday !== undefined && 
                                   updates.topYesterday === token.topToday &&
                                   updates.topToday !== token.topToday;
            
            if (isShiftOperation) {
                // This is a shift operation - record the new today value
                token.topVolumeHistory.push({
                    date: currentDate,
                    value: parseFloat(updates.topToday),
                    previousValue: token.topToday,
                    timestamp: currentTimestamp,
                    type: 'manual_shift_update'
                });
                
                // Record the shifted yesterday value
                const yesterday = new Date();
                yesterday.setDate(yesterday.getDate() - 1);
                const yesterdayDate = yesterday.toLocaleDateString('en-CA'); // YYYY-MM-DD format in local timezone
                
                // No need to create "shifted_from_today" entries for top volume - the manual_shift_update entry is sufficient
            } else {
                // Regular manual update
                token.topVolumeHistory.push({
                    date: currentDate,
                    value: parseFloat(updates.topToday),
                    previousValue: token.topToday,
                    timestamp: currentTimestamp,
                    type: 'manual_update'
                });
            }
        }
        
        // Handle standalone topYesterday updates (for legacy compatibility)
        if (updates.topYesterday !== undefined && updates.topYesterday !== token.topYesterday && updates.topToday === undefined) {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayDate = yesterday.toLocaleDateString('en-CA'); // YYYY-MM-DD format in local timezone
            
            const existingEntry = token.topVolumeHistory.find(entry => entry.date === yesterdayDate);
            if (existingEntry) {
                existingEntry.value = parseFloat(updates.topYesterday);
                existingEntry.timestamp = currentTimestamp;
                existingEntry.type = 'manual_correction';
            } else {
                token.topVolumeHistory.push({
                    date: yesterdayDate,
                    value: parseFloat(updates.topYesterday),
                    previousValue: token.topYesterday,
                    timestamp: currentTimestamp,
                    type: 'manual_backfill'
                });
            }
        }
        
        // Track trading volume changes
        if (updates.volumeYesterday !== undefined && updates.volumeYesterday !== token.volumeYesterday) {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayDate = yesterday.toLocaleDateString('en-CA'); // YYYY-MM-DD format in local timezone
            
            token.tradingVolumeHistory.push({
                date: yesterdayDate,
                value: parseFloat(updates.volumeYesterday),
                previousValue: token.volumeYesterday,
                timestamp: currentTimestamp,
                type: 'manual_backfill'
            });
        }
        
        // Update token
        Object.assign(token, updates);
        db.lastUpdated = currentTimestamp;
        
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
        
        // Check if token is archived - don't update volumes for finished competitions
        if (token.status === 'archived') {
            return res.status(400).json({ error: 'Cannot update volume for archived token. Competition has ended.' });
        }
        
        const currentDate = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD format in local timezone
        const currentTimestamp = new Date().toISOString();
        
        // Initialize history arrays if they don't exist (for existing tokens)
        if (!token.topVolumeHistory) token.topVolumeHistory = [];
        if (!token.tradingVolumeHistory) token.tradingVolumeHistory = [];
        
        // Store previous volume as yesterday's volume if not set
        if (token.volumeYesterday === null && token.volumeToday !== null) {
            token.volumeYesterday = token.volumeToday;
            
            // Add to trading volume history
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayDate = yesterday.toLocaleDateString('en-CA'); // YYYY-MM-DD format in local timezone
            
            token.tradingVolumeHistory.push({
                date: yesterdayDate,
                value: token.volumeToday,
                previousValue: null, // No previous value available when shifting
                timestamp: currentTimestamp,
                type: 'shifted_from_today'
            });
        }
        
        // Capture the current volume before updating (this will be the previous value)
        const previousVolume = token.volumeToday;
        
        // Update current volume and add to history
        token.volumeToday = volume;
        token.lastUpdated = currentTimestamp;
        
        // Update price and calculate totalPrize if price is provided
        if (req.body.price !== undefined) {
            token.currentPrice = req.body.price;
            // Calculate total prize: currentPrice × amount
            if (token.amount && token.currentPrice) {
                token.totalPrize = token.currentPrice * token.amount;
            }
        }
        
        // Add current volume to trading history
        token.tradingVolumeHistory.push({
            date: currentDate,
            value: volume,
            previousValue: previousVolume, // Use the captured previous value
            timestamp: currentTimestamp,
            type: 'api_fetch'
        });
        
        db.lastUpdated = currentTimestamp;
        
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
                return {
                    volume: rank1Cex.volumeUsd,
                    price: rank1Cex.price
                };
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
        const currentDate = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD format in local timezone
        const currentTimestamp = new Date().toISOString();
        
        for (const token of db.tokens) {
            // Skip archived tokens - no need to fetch volumes for finished competitions
            if (token.status === 'archived') {
                console.log(`⏭️  Skipping ${token.name} (archived)`);
                continue;
            }
            
            console.log(`Processing ${token.name}...`);
            
            // Initialize history arrays if they don't exist (for existing tokens)
            if (!token.topVolumeHistory) token.topVolumeHistory = [];
            if (!token.tradingVolumeHistory) token.tradingVolumeHistory = [];
            
            // Fetch new volume and price
            const volumeData = await fetchVolumeForToken(token);
            
            if (volumeData !== null) {
                // Store today's volume as yesterday's in history before shifting
                if (token.volumeToday !== null) {
                    const yesterday = new Date();
                    yesterday.setDate(yesterday.getDate() - 1);
                    const yesterdayDate = yesterday.toLocaleDateString('en-CA'); // YYYY-MM-DD format in local timezone
                    
                    token.tradingVolumeHistory.push({
                        date: yesterdayDate,
                        value: token.volumeToday,
                        previousValue: token.volumeYesterday, // Add previous value
                        timestamp: currentTimestamp,
                        type: 'daily_shift'
                    });
                }
                
                // Capture the current volume before updating (this will be the previous value)
                const previousVolume = token.volumeToday;
                
                // Shift volumes: today → yesterday, new → today
                token.volumeYesterday = token.volumeToday;
                token.volumeToday = volumeData.volume;
                
                // Update price and calculate total prize
                token.currentPrice = volumeData.price;
                token.totalPrize = token.amount && token.currentPrice ? token.amount * token.currentPrice : null;
                
                token.lastUpdated = currentTimestamp;
                
                // Add new volume to history
                token.tradingVolumeHistory.push({
                    date: currentDate,
                    value: volumeData.volume,
                    previousValue: previousVolume, // Use the captured previous value
                    timestamp: currentTimestamp,
                    type: 'daily_fetch'
                });
                
                updatedCount++;
                console.log(`✅ Updated ${token.name}: New volume = $${volumeData.volume.toLocaleString()}, Price = $${volumeData.price}, Total Prize = $${token.totalPrize ? token.totalPrize.toLocaleString() : 'N/A'}`);
            } else {
                console.log(`❌ Failed to fetch volume for ${token.name}`);
            }
            
            // Small delay between requests
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Save updated database
        db.lastUpdated = currentTimestamp;
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

// Get historical data for a token
app.get('/api/tokens/:id/history', (req, res) => {
    try {
        const { id } = req.params;
        const db = loadDatabase();
        const token = db.tokens.find(t => t.id === parseInt(id));
        
        if (!token) {
            return res.status(404).json({ error: 'Token not found' });
        }
        
        // Initialize history arrays if they don't exist
        const topVolumeHistory = token.topVolumeHistory || [];
        const tradingVolumeHistory = token.tradingVolumeHistory || [];
        
        res.json({
            tokenName: token.name,
            topVolumeHistory: topVolumeHistory.sort((a, b) => new Date(b.date) - new Date(a.date)),
            tradingVolumeHistory: tradingVolumeHistory.sort((a, b) => new Date(b.date) - new Date(a.date))
        });
        
    } catch (error) {
        res.status(500).json({ error: 'Failed to get token history' });
    }
});

// Get all tokens with summary statistics
app.get('/api/tokens/stats', (req, res) => {
    try {
        const db = loadDatabase();
        const stats = db.tokens.map(token => {
            const topHistory = token.topVolumeHistory || [];
            const tradingHistory = token.tradingVolumeHistory || [];
            
            return {
                id: token.id,
                name: token.name,
                slug: token.slug,
                topToday: token.topToday,
                topYesterday: token.topYesterday,
                volumeToday: token.volumeToday,
                volumeYesterday: token.volumeYesterday,
                lastUpdated: token.lastUpdated,
                historyCount: {
                    topVolume: topHistory.length,
                    tradingVolume: tradingHistory.length
                },
                firstRecorded: {
                    topVolume: topHistory.length > 0 ? topHistory[topHistory.length - 1].date : null,
                    tradingVolume: tradingHistory.length > 0 ? tradingHistory[tradingHistory.length - 1].date : null
                }
            };
        });
        
        res.json(stats);
        
    } catch (error) {
        res.status(500).json({ error: 'Failed to get token statistics' });
    }
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

// Migration function to add history arrays to existing tokens
function migrateExistingTokens() {
    const db = loadDatabase();
    let hasChanges = false;
    
    for (const token of db.tokens) {
        if (!token.topVolumeHistory) {
            token.topVolumeHistory = [];
            hasChanges = true;
            console.log(`Added topVolumeHistory array to ${token.name}`);
        }
        if (!token.tradingVolumeHistory) {
            token.tradingVolumeHistory = [];
            hasChanges = true;
            console.log(`Added tradingVolumeHistory array to ${token.name}`);
        }
        if (!token.status) {
            token.status = 'ongoing'; // All existing tokens are ongoing by default
            hasChanges = true;
            console.log(`Set status to 'ongoing' for ${token.name}`);
        }
    }
    
    if (hasChanges) {
        saveDatabase(db);
        console.log('✅ Migration completed: Added history arrays and status to existing tokens');
    }
}

// Run migration on server startup
migrateExistingTokens();

// Archive/Unarchive token (admin only)
app.put('/api/tokens/:id/archive', (req, res) => {
    try {
        const { id } = req.params;
        const { adminPassword, archived } = req.body;
        
        if (!isAdmin(adminPassword)) {
            return res.status(401).json({ error: 'Unauthorized: Invalid admin password' });
        }
        
        const db = loadDatabase();
        const tokenIndex = db.tokens.findIndex(t => t.id === parseInt(id));
        
        if (tokenIndex === -1) {
            return res.status(404).json({ error: 'Token not found' });
        }
        
        const token = db.tokens[tokenIndex];
        const currentTimestamp = new Date().toISOString();
        
        // Initialize history arrays if they don't exist
        if (!token.topVolumeHistory) token.topVolumeHistory = [];
        if (!token.tradingVolumeHistory) token.tradingVolumeHistory = [];
        
        // Update status
        const newStatus = archived ? 'archived' : 'ongoing';
        const oldStatus = token.status || 'ongoing';
        
        if (newStatus !== oldStatus) {
            token.status = newStatus;
            token.archivedAt = archived ? currentTimestamp : null;
            
            // Add history entry for status change
            token.topVolumeHistory.push({
                date: new Date().toISOString().split('T')[0],
                value: token.topToday,
                timestamp: currentTimestamp,
                type: archived ? 'competition_archived' : 'competition_restored',
                note: archived ? 'Token moved to finished competition' : 'Token restored to ongoing competition'
            });
        }
        
        db.lastUpdated = currentTimestamp;
        
        if (saveDatabase(db)) {
            res.json({ 
                success: true, 
                token: db.tokens[tokenIndex],
                message: archived ? 'Token archived successfully' : 'Token restored to ongoing competition'
            });
        } else {
            res.status(500).json({ error: 'Failed to update token status' });
        }
        
    } catch (error) {
        res.status(500).json({ error: 'Failed to archive/unarchive token' });
    }
});
