const fs = require('fs');
const path = require('path');
const { testConnection, initializeTables, db } = require('./database.js');

// Migration script to move data from JSON to PostgreSQL
async function migrateData() {
    console.log('🚀 Starting migration from JSON to PostgreSQL...');
    
    try {
        // Test database connection
        const connected = await testConnection();
        if (!connected) {
            throw new Error('Could not connect to PostgreSQL database');
        }
        
        // Initialize tables
        await initializeTables();
        
        // Read existing JSON data
        const jsonPath = path.join(__dirname, 'database.json');
        if (!fs.existsSync(jsonPath)) {
            console.log('📄 No database.json found, starting with empty database');
            return;
        }
        
        const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        console.log(`📊 Found ${jsonData.tokens.length} tokens in JSON database`);
        
        // Migrate each token
        let migratedCount = 0;
        let historyCount = 0;
        
        for (const token of jsonData.tokens) {
            console.log(`Processing token: ${token.name}...`);
            
            // Check if token already exists
            const existingTokens = await db.getAllTokens();
            let existingToken = existingTokens.find(t => t.name === token.name);
            
            let tokenRecord;
            if (existingToken) {
                console.log(`  Token ${token.name} exists, updating...`);
                // Update existing token
                tokenRecord = await db.updateToken(existingToken.id, {
                    slug: token.slug,
                    topToday: token.topToday || 0,
                    topYesterday: token.topYesterday || 0,
                    amount: token.amount || 0,
                    volumeToday: token.volumeToday,
                    volumeYesterday: token.volumeYesterday,
                    currentPrice: token.currentPrice,
                    totalPrize: token.totalPrize,
                    lastUpdated: token.lastUpdated,
                    status: token.status || 'ongoing',
                    archivedAt: token.archivedAt
                });
                tokenRecord.id = existingToken.id;
            } else {
                console.log(`  Creating new token: ${token.name}...`);
                // Create new token record
                tokenRecord = await db.createToken({
                    name: token.name,
                    slug: token.slug,
                    topToday: token.topToday || 0,
                    topYesterday: token.topYesterday || 0,
                    amount: token.amount || 0
                });
                
                // Update additional fields
                await db.updateToken(tokenRecord.id, {
                    volumeToday: token.volumeToday,
                    volumeYesterday: token.volumeYesterday,
                    currentPrice: token.currentPrice,
                    totalPrize: token.totalPrize,
                    lastUpdated: token.lastUpdated,
                    status: token.status || 'ongoing',
                    archivedAt: token.archivedAt
                });
            }
            
            // Migrate top volume history
            if (token.topVolumeHistory && Array.isArray(token.topVolumeHistory)) {
                // Clear existing history for this token to avoid duplicates
                if (existingToken) {
                    console.log(`  Clearing existing history for ${token.name}...`);
                    // We could add a function to clear history, but for now we'll skip duplicates
                }
                
                for (const entry of token.topVolumeHistory) {
                    await db.addTopVolumeHistory(tokenRecord.id, {
                        date: entry.date,
                        value: entry.value,
                        previousValue: entry.previousValue,
                        timestamp: entry.timestamp,
                        type: entry.type,
                        note: entry.note
                    });
                    historyCount++;
                }
            }
            
            // Migrate trading volume history
            if (token.tradingVolumeHistory && Array.isArray(token.tradingVolumeHistory)) {
                for (const entry of token.tradingVolumeHistory) {
                    await db.addTradingVolumeHistory(tokenRecord.id, {
                        date: entry.date,
                        value: entry.value,
                        previousValue: entry.previousValue,
                        timestamp: entry.timestamp,
                        type: entry.type,
                        note: entry.note
                    });
                    historyCount++;
                }
            }
            
            migratedCount++;
            console.log(`✅ Migrated ${token.name} with history`);
        }
        
        console.log(`🎉 Migration completed successfully!`);
        console.log(`📊 Migrated ${migratedCount} tokens`);
        console.log(`📈 Migrated ${historyCount} history entries`);
        
        // Create backup of JSON file
        const backupPath = path.join(__dirname, `database_backup_${Date.now()}.json`);
        fs.copyFileSync(jsonPath, backupPath);
        console.log(`💾 Created backup: ${backupPath}`);
        
    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        console.error(error);
        process.exit(1);
    }
}

// Test database connection and show current data
async function testDatabase() {
    try {
        await testConnection();
        const tokens = await db.getAllTokens();
        console.log(`📊 Current database has ${tokens.length} tokens:`);
        tokens.forEach(token => {
            console.log(`- ${token.name} (${token.status})`);
        });
    } catch (error) {
        console.error('❌ Database test failed:', error.message);
    }
}

// Command line interface
const command = process.argv[2];

if (command === 'migrate') {
    migrateData();
} else if (command === 'test') {
    testDatabase();
} else {
    console.log('🔧 Migration Script Usage:');
    console.log('  npm run migrate     - Migrate data from JSON to PostgreSQL');
    console.log('  npm run test-db     - Test database connection and show current data');
    console.log('');
    console.log('Manual usage:');
    console.log('  node migrate.js migrate');
    console.log('  node migrate.js test');
}

module.exports = { migrateData, testDatabase };
