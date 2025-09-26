// Load environment variables first
require('dotenv').config({ path: __dirname + '/.env' });

const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
const cron = require('node-cron');
const { testConnection, initializeTables, db } = require('./database.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Timezone utility functions (UTC+7 local timezone to UTC database)
const TIMEZONE_OFFSET = 7 * 60 * 60 * 1000; // UTC+7 in milliseconds

function getCurrentDateInUTC7() {
    // Get current time in UTC+7
    const now = new Date();
    const utc7Time = new Date(now.getTime() + TIMEZONE_OFFSET);
    return utc7Time.toISOString().split('T')[0]; // YYYY-MM-DD format
}

function getCurrentTimestampInUTC() {
    // Return current UTC timestamp for database storage
    return new Date().toISOString();
}

function getYesterdayDateInUTC7() {
    // Get yesterday's date in UTC+7
    const now = new Date();
    const utc7Time = new Date(now.getTime() + TIMEZONE_OFFSET);
    const yesterday = new Date(utc7Time.getTime() - 24 * 60 * 60 * 1000);
    return yesterday.toISOString().split('T')[0]; // YYYY-MM-DD format
}

// Enable CORS for all routes
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Check if user is admin
function isAdmin(password) {
    return password === process.env.ADMIN_PASSWORD;
}

// Get all tokens (public endpoint)
app.get('/api/tokens', async (req, res) => {
    try {
        const tokens = await db.getAllTokens();
        res.json(tokens);
    } catch (error) {
        console.error('Error loading tokens:', error);
        res.status(500).json({ error: 'Failed to load tokens' });
    }
});

// Add token (admin only)
app.post('/api/tokens', async (req, res) => {
    try {
        const { token, adminPassword } = req.body;
        
        if (!isAdmin(adminPassword)) {
            return res.status(401).json({ error: 'Unauthorized: Invalid admin password' });
        }
        
        // Check if token already exists
        const existingTokens = await db.getAllTokens();
        if (existingTokens.find(t => t.slug.toLowerCase() === token.slug.toLowerCase())) {
            return res.status(400).json({ error: 'Token with this slug already exists' });
        }
        
        // Create new token
        const newToken = await db.createToken({
            name: token.name.toUpperCase(),
            slug: token.slug.toLowerCase(),
            topToday: parseFloat(token.topToday) || 0,
            topYesterday: parseFloat(token.topYesterday) || 0,
            amount: parseFloat(token.amount) || 0
        });
        
        // Add initial history entry
        await db.addTopVolumeHistory(newToken.id, {
            date: getCurrentDateInUTC7(),
            value: parseFloat(token.topToday) || 0,
            timestamp: getCurrentTimestampInUTC(),
            type: 'manual_entry'
        });
        
        res.json({ success: true, token: newToken });
        
    } catch (error) {
        console.error('Error adding token:', error);
        res.status(500).json({ error: 'Failed to add token' });
    }
});

// Update token (admin only)
// Update token (admin only)
app.put('/api/tokens/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { updates, adminPassword } = req.body;
        
        if (!isAdmin(adminPassword)) {
            return res.status(401).json({ error: 'Unauthorized: Invalid admin password' });
        }
        
        const tokens = await db.getAllTokens();
        const token = tokens.find(t => t.id === parseInt(id));
        
        if (!token) {
            return res.status(404).json({ error: 'Token not found' });
        }
        
        const currentDate = getCurrentDateInUTC7(); // YYYY-MM-DD format in UTC+7
        const currentTimestamp = getCurrentTimestampInUTC();
        
        // Handle top volume changes with history tracking
        if (updates.topToday !== undefined && updates.topToday !== token.topToday) {
            // Check if this is a shift operation (today's value becomes yesterday's)
            const isShiftOperation = updates.topYesterday !== undefined && 
                                   updates.topYesterday === token.topToday &&
                                   updates.topToday !== token.topToday;
            
            if (isShiftOperation) {
                // This is a shift operation - record the new today value
                await db.addTopVolumeHistory(token.id, {
                    date: currentDate,
                    value: parseFloat(updates.topToday),
                    previousValue: token.topToday,
                    timestamp: currentTimestamp,
                    type: 'manual_shift_update'
                });
            } else {
                // Regular manual update
                await db.addTopVolumeHistory(token.id, {
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
            const yesterdayDate = getYesterdayDateInUTC7(); // YYYY-MM-DD format in UTC+7
            
            await db.addTopVolumeHistory(token.id, {
                date: yesterdayDate,
                value: parseFloat(updates.topYesterday),
                previousValue: token.topYesterday,
                timestamp: currentTimestamp,
                type: 'manual_backfill'
            });
        }
        
        // Track trading volume changes
        if (updates.volumeYesterday !== undefined && updates.volumeYesterday !== token.volumeYesterday) {
            const yesterdayDate = getYesterdayDateInUTC7(); // YYYY-MM-DD format in UTC+7
            
            await db.addTradingVolumeHistory(token.id, {
                date: yesterdayDate,
                value: parseFloat(updates.volumeYesterday),
                previousValue: token.volumeYesterday,
                timestamp: currentTimestamp,
                type: 'manual_backfill'
            });
        }
        
        // Update token in database
        const updatedToken = await db.updateToken(token.id, updates);
        
        res.json({ success: true, token: updatedToken });
        
    } catch (error) {
        console.error('Error updating token:', error);
        res.status(500).json({ error: 'Failed to update token' });
    }
});

// Delete token (admin only)
app.delete('/api/tokens/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { adminPassword } = req.body;
        
        if (!isAdmin(adminPassword)) {
            return res.status(401).json({ error: 'Unauthorized: Invalid admin password' });
        }
        
        const tokens = await db.getAllTokens();
        const token = tokens.find(t => t.id === parseInt(id));
        
        if (!token) {
            return res.status(404).json({ error: 'Token not found' });
        }
        
        // Delete token from database
        await db.deleteToken(parseInt(id));
        
        res.json({ success: true, token });
        
    } catch (error) {
        console.error('Error deleting token:', error);
        res.status(500).json({ error: 'Failed to delete token' });
    }
});

// Update volume for token (admin only) - now supports both today and yesterday volumes
app.put('/api/tokens/:id/volume', async (req, res) => {
    try {
        const { id } = req.params;
        const { volumeToday, volumeYesterday, adminPassword } = req.body;
        
        if (!isAdmin(adminPassword)) {
            return res.status(401).json({ error: 'Unauthorized: Invalid admin password' });
        }
        
        const tokens = await db.getAllTokens();
        const token = tokens.find(t => t.id === parseInt(id));
        
        if (!token) {
            return res.status(404).json({ error: 'Token not found' });
        }
        
        // Check if token is archived - don't update volumes for finished competitions
        if (token.status === 'archived') {
            return res.status(400).json({ error: 'Cannot update volume for archived token. Competition has ended.' });
        }
        
        const currentDate = getCurrentDateInUTC7(); // YYYY-MM-DD format in UTC+7
        const currentTimestamp = getCurrentTimestampInUTC();
        
        // Store previous volumes before updating
        const previousVolumeToday = token.volumeToday;
        
        // Prepare update data
        const updateData = {
            lastUpdated: currentTimestamp
        };
        
        // Update both today's and yesterday's volumes directly from API data
        if (volumeToday !== undefined) {
            updateData.volumeToday = volumeToday;
        }
        if (volumeYesterday !== undefined) {
            updateData.volumeYesterday = volumeYesterday;
        }
        
        // Update price and calculate totalPrize if price is provided
        if (req.body.price !== undefined) {
            updateData.currentPrice = req.body.price;
            // Calculate total prize: currentPrice × amount
            if (token.amount && req.body.price) {
                updateData.totalPrize = req.body.price * token.amount;
            }
        }
        
        // Update token in database
        const updatedToken = await db.updateToken(parseInt(id), updateData);
        
        // Add current volume to trading history (API fetch doesn't track previous values)
        if (volumeToday !== undefined) {
            await db.addTradingVolumeHistory(parseInt(id), {
                date: currentDate,
                value: volumeToday,
                previousValue: null, // API fetches don't track previous values
                timestamp: currentTimestamp,
                type: 'api_fetch_2day' // New type to indicate this came from 2-day API call
            });
        }
        
        res.json({ success: true, token: updatedToken });
        
    } catch (error) {
        console.error('Error updating volume:', error);
        res.status(500).json({ error: 'Failed to update volume' });
    }
});

// Check admin status
app.post('/api/admin/verify', (req, res) => {
    const { password } = req.body;
    res.json({ isAdmin: isAdmin(password) });
});

// Automated volume fetching functions
// Get alphaId for a token symbol from Binance Alpha token list
async function getAlphaIdForToken(tokenSymbol) {
    try {
        console.log(`🔍 Getting alphaId for token symbol: ${tokenSymbol}`);
        
        const apiUrl = 'https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list';
        
        const response = await fetch(apiUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        
        if (!response.ok) {
            console.log(`❌ Token list API error: ${response.status} ${response.statusText}`);
            throw new Error(`Token list API error: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        console.log(`📡 Token list API response success: ${data.success}, data count: ${data.data ? data.data.length : 0}`);
        
        if (data.success && data.data) {
            // Find token by exact symbol match
            const tokenData = data.data.find(token => 
                token.symbol && token.symbol.toUpperCase() === tokenSymbol.toUpperCase()
            );
            
            if (tokenData && tokenData.alphaId) {
                console.log(`✅ Found alphaId for ${tokenSymbol}: ${tokenData.alphaId}`);
                console.log(`   Token details: name=${tokenData.name}, symbol=${tokenData.symbol}`);
                return tokenData.alphaId;
            } else {
                console.log(`❌ No alphaId found for token symbol: ${tokenSymbol}`);
                console.log(`   Available tokens (first 5):`, data.data.slice(0, 5).map(t => ({ symbol: t.symbol, name: t.name, alphaId: t.alphaId })));
                return null;
            }
        } else {
            console.log(`❌ Token list API returned unsuccessful response:`, data);
            return null;
        }
        
    } catch (error) {
        console.error(`❌ Error getting alphaId for ${tokenSymbol}:`, error.message);
        return null;
    }
}

// Fetch volume data from Binance Alpha API
async function fetchVolumeForToken(token) {
    try {
        // First get the alphaId for the token
        const alphaId = await getAlphaIdForToken(token.name);
        
        if (!alphaId) {
            console.log(`Cannot fetch volume for ${token.name}: alphaId not found`);
            return null;
        }
        
        // Construct the klines API URL with limit=2 to get today and yesterday data
        const apiUrl = `https://www.binance.com/bapi/defi/v1/public/alpha-trade/klines?interval=1d&limit=2&symbol=${alphaId}USDT`;
        
        console.log(`Fetching volume for ${token.name} (alphaId: ${alphaId}) with 2-day data...`);
        
        const response = await fetch(apiUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.success && data.data && data.data.length > 0) {
            // klineData structure: [timestamp, open, high, low, close, volume, closeTime, quoteAssetVolume, count, takerBuyBaseAssetVolume, takerBuyQuoteAssetVolume, ignore]
            // We need the quoteAssetVolume (index 7) which is the 1D volume in USDT
            // Array is chronologically ordered: [0] = yesterday, [1] = today
            
            const yesterdayData = data.data[0]; // Older day (yesterday)
            const yesterdayVolume = parseFloat(yesterdayData[7]);
            
            let todayVolume = null;
            let todayPrice = null;
            if (data.data.length > 1) {
                const todayData = data.data[1]; // Newer day (today)
                todayVolume = parseFloat(todayData[7]);
                todayPrice = parseFloat(todayData[4]); // Close price
            }
            
            console.log(`Volume data for ${token.name}: today=${todayVolume}, yesterday=${yesterdayVolume}, price=${todayPrice}`);
            
            return {
                volumeToday: todayVolume,
                volumeYesterday: yesterdayVolume,
                price: todayPrice
            };
        } else {
            console.log(`No kline data found for ${token.name}`);
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
        const tokens = await db.getAllTokens();
        let updatedCount = 0;
        const currentDate = getCurrentDateInUTC7(); // YYYY-MM-DD format in UTC+7
        const currentTimestamp = getCurrentTimestampInUTC();
        
        for (const token of tokens) {
            // Skip archived tokens - no need to fetch volumes for finished competitions
            if (token.status === 'archived') {
                console.log(`⏭️  Skipping ${token.name} (archived)`);
                continue;
            }
            
            console.log(`Processing ${token.name}...`);
            
            // Initialize history arrays if they don't exist (for existing tokens)
            if (!token.topVolumeHistory) token.topVolumeHistory = [];
            if (!token.tradingVolumeHistory) token.tradingVolumeHistory = [];
            
            // Fetch new volume and price data (2-day data: today + yesterday)
            const volumeData = await fetchVolumeForToken(token);
            
            if (volumeData !== null) {
                // Store the previous values before updating
                const previousVolumeToday = token.volumeToday;
                
                // Prepare update data
                const updateData = {
                    volumeToday: volumeData.volumeToday,
                    volumeYesterday: volumeData.volumeYesterday,
                    lastUpdated: currentTimestamp
                };
                
                // Update price and total prize if available
                if (volumeData.price) {
                    updateData.currentPrice = volumeData.price;
                    if (token.amount) {
                        updateData.totalPrize = volumeData.price * token.amount;
                    }
                }
                
                // Update token in database
                await db.updateToken(token.id, updateData);
                
                // Add entry to trading volume history
                await db.addTradingVolumeHistory(token.id, {
                    date: currentDate,
                    value: volumeData.volumeToday,
                    previousValue: previousVolumeToday,
                    timestamp: currentTimestamp,
                    type: 'daily_fetch_2day' // Updated type to indicate 2-day fetch
                });
                
                updatedCount++;
                console.log(`✅ Updated ${token.name}: Today = $${volumeData.volumeToday.toLocaleString()}, Yesterday = $${volumeData.volumeYesterday ? volumeData.volumeYesterday.toLocaleString() : 'N/A'}, Price = $${volumeData.price}, Total Prize = $${updateData.totalPrize ? updateData.totalPrize.toLocaleString() : 'N/A'}`);
            } else {
                console.log(`❌ Failed to fetch volume for ${token.name}`);
            }
            
            // Small delay between requests
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        console.log(`🎉 Daily volume update completed! Updated ${updatedCount}/${tokens.length} tokens`);
        
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

// Schedule daily volume updates at 7:00 AM UTC+7 
// Cron format: minute hour day-of-month month day-of-week
// Using Asia/Bangkok timezone (UTC+7) so 7 AM local time
cron.schedule('1 7 * * *', () => {
    console.log('📅 Daily volume update: Running scheduled update at 7:01 AM UTC+7');
    performDailyVolumeUpdate();
}, {
    timezone: "Asia/Bangkok" // UTC+7
});

console.log('📅 Daily volume update scheduled for 7:01 AM UTC+7');

// Get next scheduled run time for display
app.get('/api/schedule-info', (req, res) => {
    const now = new Date();
    
    // Calculate next 7:01 AM UTC+7 run time
    // 7:01 AM UTC+7 = 12:01 AM UTC (00:01 UTC)
    const nextRun = new Date();
    nextRun.setUTCHours(0, 1, 0, 0); // 12:01 AM UTC = 7:01 AM UTC+7
    
    // If current time is past today's scheduled time, move to next day
    if (nextRun <= now) {
        nextRun.setDate(nextRun.getDate() + 1);
    }
    
    res.json({
        currentTime: now.toISOString(),
        nextScheduledRun: nextRun.toISOString(),
        timezone: 'UTC+7',
        localTime: '7:01 AM',
        testMode: false
    });
});

// Get historical data for a token
app.get('/api/tokens/:id/history', async (req, res) => {
    try {
        const { id } = req.params;
        const tokens = await db.getAllTokens();
        const token = tokens.find(t => t.id === parseInt(id));
        
        if (!token) {
            return res.status(404).json({ error: 'Token not found' });
        }
        
        // Get history from database
        const topVolumeHistory = await db.getTopVolumeHistory(parseInt(id));
        const tradingVolumeHistory = await db.getTradingVolumeHistory(parseInt(id));
        
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
app.get('/api/tokens/stats', async (req, res) => {
    try {
        const tokens = await db.getAllTokens();
        const stats = [];
        
        for (const token of tokens) {
            const topHistory = await db.getTopVolumeHistory(token.id);
            const tradingHistory = await db.getTradingVolumeHistory(token.id);
            
            stats.push({
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
            });
        }
        
        res.json(stats);
        
    } catch (error) {
        res.status(500).json({ error: 'Failed to get token statistics' });
    }
});

// API proxy endpoint - now uses Binance Alpha API
app.get('/api/volume/:tokenSymbol', async (req, res) => {
    try {
        const { tokenSymbol } = req.params;
        
        console.log(`📊 API Request: Fetching volume data for ${tokenSymbol}...`);
        
        // First get the alphaId for the token
        const alphaId = await getAlphaIdForToken(tokenSymbol);
        
        if (!alphaId) {
            console.log(`❌ AlphaId not found for ${tokenSymbol}`);
            return res.status(404).json({ 
                error: 'Token not found', 
                message: `No alphaId found for token symbol: ${tokenSymbol}. Please check if the token symbol is correct and exists in Binance Alpha.` 
            });
        }
        
        console.log(`✅ Found alphaId for ${tokenSymbol}: ${alphaId}`);
        
        // Fetch kline data from Binance Alpha API with limit=2 to get today and yesterday
        const apiUrl = `https://www.binance.com/bapi/defi/v1/public/alpha-trade/klines?interval=1d&limit=2&symbol=${alphaId}USDT`;
        console.log(`🔗 Calling klines API: ${apiUrl}`);
        
        const response = await fetch(apiUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        
        console.log(`📡 Klines API response status: ${response.status}`);
        
        if (!response.ok) {
            console.log(`❌ Klines API error: ${response.status} ${response.statusText}`);
            throw new Error(`Klines API error: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        console.log(`📋 Klines API response:`, JSON.stringify(data, null, 2));
        
        if (data.success && data.data && data.data.length > 0) {
            // Array is chronologically ordered: [0] = yesterday, [1] = today
            const yesterdayData = data.data[0]; // Older day (yesterday)
            const yesterdayVolume = parseFloat(yesterdayData[7]); // quoteAssetVolume (1D volume in USDT)
            
            let todayVolume = null;
            let todayPrice = null;
            if (data.data.length > 1) {
                const todayData = data.data[1]; // Newer day (today)
                todayVolume = parseFloat(todayData[7]);
                todayPrice = parseFloat(todayData[4]); // Close price
            }
            
            console.log(`💰 Extracted data for ${tokenSymbol}: today_volume=${todayVolume}, yesterday_volume=${yesterdayVolume}, price=${todayPrice}`);
            
            // Return data with both today and yesterday volumes
            res.json({
                success: true,
                volumeToday: todayVolume,
                volumeYesterday: yesterdayVolume,
                price: todayPrice,
                symbol: `${alphaId}USDT`,
                rawData: data
            });
        } else {
            console.log(`❌ No kline data found for ${tokenSymbol}:`, data);
            res.status(404).json({ 
                error: 'No trading data found', 
                message: `No kline data available for ${tokenSymbol} (${alphaId}). This token might not be actively traded.`,
                apiResponse: data
            });
        }
        
    } catch (error) {
        console.error(`❌ API Error for ${req.params.tokenSymbol}:`, error);
        res.status(500).json({ 
            error: 'Failed to fetch volume data', 
            message: error.message,
            tokenSymbol: req.params.tokenSymbol
        });
    }
});

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Initialize database on startup
async function initializeServer() {
    try {
        console.log('🔧 Initializing server...');
        await testConnection();
        await initializeTables();
        console.log('✅ Database initialized successfully');
        
        app.listen(PORT, () => {
            console.log(`🚀 Server running at http://localhost:${PORT}`);
            console.log(`📊 Token tracker is ready!`);
        });
    } catch (error) {
        console.error('❌ Failed to initialize server:', error);
        process.exit(1);
    }
}

// Start the server
initializeServer();

// Archive/Unarchive token (admin only)
app.put('/api/tokens/:id/archive', async (req, res) => {
    try {
        const { id } = req.params;
        const { adminPassword, archived } = req.body;
        
        if (!isAdmin(adminPassword)) {
            return res.status(401).json({ error: 'Unauthorized: Invalid admin password' });
        }
        
        const tokens = await db.getAllTokens();
        const token = tokens.find(t => t.id === parseInt(id));
        
        if (!token) {
            return res.status(404).json({ error: 'Token not found' });
        }
        
        const currentTimestamp = getCurrentTimestampInUTC();
        
        // Update status
        const newStatus = archived ? 'archived' : 'ongoing';
        const oldStatus = token.status || 'ongoing';
        
        if (newStatus !== oldStatus) {
            const updateData = {
                status: newStatus,
                archivedAt: archived ? currentTimestamp : null
            };
            
            const updatedToken = await db.updateToken(parseInt(id), updateData);
            
            // Add history entry for status change
            await db.addTopVolumeHistory(parseInt(id), {
                date: getCurrentDateInUTC7(),
                value: token.topToday,
                timestamp: currentTimestamp,
                type: archived ? 'competition_archived' : 'competition_restored',
                note: archived ? 'Token moved to finished competition' : 'Token restored to ongoing competition'
            });
            
            console.log(`${archived ? '📦' : '🔄'} Token ${token.name} ${archived ? 'archived' : 'restored'} by admin`);
            res.json({ 
                success: true, 
                token: updatedToken,
                message: archived ? 'Token archived successfully' : 'Token restored to ongoing competition'
            });
        } else {
            res.json({ 
                success: true, 
                token,
                message: 'No status change needed'
            });
        }
        
    } catch (error) {
        console.error('Error archiving token:', error);
        res.status(500).json({ error: 'Failed to archive/unarchive token' });
    }
});
