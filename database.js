// Load environment variables first
require('dotenv').config({ path: __dirname + '/.env' });

const { Pool } = require('pg');

// PostgreSQL connection configuration
const pool = new Pool({
    host: process.env.DB_HOST || '',
    port: process.env.DB_PORT || '',
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || '',
    ssl: {
        rejectUnauthorized: false,
        sslmode: 'require'
    },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 0
});

// Test database connection
async function testConnection() {
    try {
        const client = await pool.connect();
        console.log('🐘 PostgreSQL connected successfully!');
        const res = await client.query('SELECT NOW()');
        console.log('📅 Database time:', res.rows[0].now);
        client.release();
        return true;
    } catch (err) {
        console.error('❌ Database connection failed:', err.message);
        return false;
    }
}

// Initialize database tables
async function initializeTables() {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // Create tokens table
        await client.query(`
            CREATE TABLE IF NOT EXISTS tokens (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL UNIQUE,
                slug VARCHAR(100) NOT NULL,
                top_today DECIMAL(20,8) DEFAULT 0,
                top_yesterday DECIMAL(20,8) DEFAULT 0,
                volume_today DECIMAL(20,8),
                volume_yesterday DECIMAL(20,8),
                amount DECIMAL(20,8) DEFAULT 0,
                current_price DECIMAL(20,8),
                total_prize DECIMAL(20,8),
                last_updated TIMESTAMP,
                status VARCHAR(20) DEFAULT 'ongoing',
                archived_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        
        // Create top volume history table
        await client.query(`
            CREATE TABLE IF NOT EXISTS top_volume_history (
                id SERIAL PRIMARY KEY,
                token_id INTEGER REFERENCES tokens(id) ON DELETE CASCADE,
                date DATE NOT NULL,
                value DECIMAL(20,8) NOT NULL,
                previous_value DECIMAL(20,8),
                timestamp TIMESTAMP NOT NULL,
                type VARCHAR(50) NOT NULL,
                note TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        
        // Create trading volume history table
        await client.query(`
            CREATE TABLE IF NOT EXISTS trading_volume_history (
                id SERIAL PRIMARY KEY,
                token_id INTEGER REFERENCES tokens(id) ON DELETE CASCADE,
                date DATE NOT NULL,
                value DECIMAL(20,8) NOT NULL,
                previous_value DECIMAL(20,8),
                timestamp TIMESTAMP NOT NULL,
                type VARCHAR(50) NOT NULL,
                note TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        
        // Create indexes for better performance
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_tokens_status ON tokens(status);
            CREATE INDEX IF NOT EXISTS idx_tokens_name ON tokens(name);
            CREATE INDEX IF NOT EXISTS idx_top_volume_history_token_date ON top_volume_history(token_id, date);
            CREATE INDEX IF NOT EXISTS idx_trading_volume_history_token_date ON trading_volume_history(token_id, date);
        `);
        
        await client.query('COMMIT');
        console.log('✅ Database tables initialized successfully!');
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error initializing tables:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// Database helper functions
const db = {
    // Execute query with parameters
    async query(text, params) {
        const client = await pool.connect();
        try {
            const res = await client.query(text, params);
            return res;
        } finally {
            client.release();
        }
    },
    
    // Get all tokens
    async getAllTokens() {
        const res = await this.query(`
            SELECT 
                id, name, slug, top_today, top_yesterday, volume_today, volume_yesterday, 
                amount, current_price, total_prize, status, 
                last_updated AT TIME ZONE 'UTC' as last_updated,
                archived_at AT TIME ZONE 'UTC' as archived_at,
                created_at AT TIME ZONE 'UTC' as created_at,
                updated_at AT TIME ZONE 'UTC' as updated_at
            FROM tokens 
            ORDER BY created_at DESC
        `);
        // Convert snake_case to camelCase for frontend compatibility
        return res.rows.map(token => ({
            id: token.id,
            name: token.name,
            slug: token.slug,
            topToday: parseFloat(token.top_today) || 0,
            topYesterday: parseFloat(token.top_yesterday) || 0,
            volumeToday: parseFloat(token.volume_today) || null,
            volumeYesterday: parseFloat(token.volume_yesterday) || null,
            amount: parseFloat(token.amount) || 0,
            currentPrice: parseFloat(token.current_price) || null,
            totalPrize: parseFloat(token.total_prize) || null,
            lastUpdated: token.last_updated,
            status: token.status || 'ongoing',
            archivedAt: token.archived_at,
            createdAt: token.created_at,
            updatedAt: token.updated_at
        }));
    },
    
    // Get token by ID
    async getTokenById(id) {
        const res = await this.query(`
            SELECT 
                id, name, slug, top_today, top_yesterday, volume_today, volume_yesterday, 
                amount, current_price, total_prize, status, 
                last_updated AT TIME ZONE 'UTC' as last_updated,
                archived_at AT TIME ZONE 'UTC' as archived_at,
                created_at AT TIME ZONE 'UTC' as created_at,
                updated_at AT TIME ZONE 'UTC' as updated_at
            FROM tokens WHERE id = $1
        `, [id]);
        const token = res.rows[0];
        if (!token) return null;
        
        // Convert snake_case to camelCase for frontend compatibility
        return {
            id: token.id,
            name: token.name,
            slug: token.slug,
            topToday: parseFloat(token.top_today) || 0,
            topYesterday: parseFloat(token.top_yesterday) || 0,
            volumeToday: parseFloat(token.volume_today) || null,
            volumeYesterday: parseFloat(token.volume_yesterday) || null,
            amount: parseFloat(token.amount) || 0,
            currentPrice: parseFloat(token.current_price) || null,
            totalPrize: parseFloat(token.total_prize) || null,
            lastUpdated: token.last_updated,
            status: token.status || 'ongoing',
            archivedAt: token.archived_at,
            createdAt: token.created_at,
            updatedAt: token.updated_at
        };
    },
    
    // Create new token
    async createToken(tokenData) {
        const {
            name, slug, topToday, topYesterday, amount
        } = tokenData;
        
        const res = await this.query(`
            INSERT INTO tokens (name, slug, top_today, top_yesterday, amount, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
            RETURNING *
        `, [name.toUpperCase(), slug.toLowerCase(), topToday, topYesterday, amount || 0]);
        
        const token = res.rows[0];
        // Convert snake_case to camelCase for frontend compatibility
        return {
            id: token.id,
            name: token.name,
            slug: token.slug,
            topToday: parseFloat(token.top_today) || 0,
            topYesterday: parseFloat(token.top_yesterday) || 0,
            volumeToday: parseFloat(token.volume_today) || null,
            volumeYesterday: parseFloat(token.volume_yesterday) || null,
            amount: parseFloat(token.amount) || 0,
            currentPrice: parseFloat(token.current_price) || null,
            totalPrize: parseFloat(token.total_prize) || null,
            lastUpdated: token.last_updated,
            status: token.status || 'ongoing',
            archivedAt: token.archived_at,
            createdAt: token.created_at,
            updatedAt: token.updated_at
        };
    },
    
    // Update token
    async updateToken(id, updates) {
        const fields = [];
        const values = [];
        let paramCount = 1;
        
        Object.keys(updates).forEach(key => {
            if (key === 'id') return; // Skip ID field
            
            // Handle timestamp fields explicitly as UTC
            if (key === 'lastUpdated') {
                fields.push(`last_updated = $${paramCount}::timestamp AT TIME ZONE 'UTC'`);
            } else {
                fields.push(`${key.replace(/([A-Z])/g, '_$1').toLowerCase()} = $${paramCount}`);
            }
            values.push(updates[key]);
            paramCount++;
        });
        
        if (fields.length === 0) return null;
        
        fields.push(`updated_at = NOW()`);
        values.push(id);
        
        const query = `
            UPDATE tokens 
            SET ${fields.join(', ')}
            WHERE id = $${paramCount}
            RETURNING 
                id, name, slug, top_today, top_yesterday, volume_today, volume_yesterday, 
                amount, current_price, total_prize, status, 
                last_updated AT TIME ZONE 'UTC' as last_updated,
                archived_at AT TIME ZONE 'UTC' as archived_at,
                created_at AT TIME ZONE 'UTC' as created_at,
                updated_at AT TIME ZONE 'UTC' as updated_at
        `;
        
        const res = await this.query(query, values);
        const token = res.rows[0];
        if (!token) return null;
        
        // Convert snake_case to camelCase for frontend compatibility
        return {
            id: token.id,
            name: token.name,
            slug: token.slug,
            topToday: parseFloat(token.top_today) || 0,
            topYesterday: parseFloat(token.top_yesterday) || 0,
            volumeToday: parseFloat(token.volume_today) || null,
            volumeYesterday: parseFloat(token.volume_yesterday) || null,
            amount: parseFloat(token.amount) || 0,
            currentPrice: parseFloat(token.current_price) || null,
            totalPrize: parseFloat(token.total_prize) || null,
            lastUpdated: token.last_updated,
            status: token.status || 'ongoing',
            archivedAt: token.archived_at,
            createdAt: token.created_at,
            updatedAt: token.updated_at
        };
    },
    
    // Delete token
    async deleteToken(id) {
        const res = await this.query(
            'DELETE FROM tokens WHERE id = $1 RETURNING *',
            [id]
        );
        return res.rows[0] || null;
    },
    
    // Get token history
    async getTokenHistory(tokenId) {
        const topVolumeRes = await this.query(`
            SELECT date, value, previous_value, timestamp, type, note
            FROM top_volume_history 
            WHERE token_id = $1 
            ORDER BY timestamp DESC
        `, [tokenId]);
        
        const tradingVolumeRes = await this.query(`
            SELECT date, value, previous_value, timestamp, type, note
            FROM trading_volume_history 
            WHERE token_id = $1 
            ORDER BY timestamp DESC
        `, [tokenId]);
        
        return {
            topVolumeHistory: topVolumeRes.rows,
            tradingVolumeHistory: tradingVolumeRes.rows
        };
    },
    
    // Add top volume history entry
    async addTopVolumeHistory(tokenId, historyData) {
        const { date, value, previousValue, timestamp, type, note } = historyData;
        
        const res = await this.query(`
            INSERT INTO top_volume_history (token_id, date, value, previous_value, timestamp, type, note)
            VALUES ($1, $2, $3, $4, $5::timestamp AT TIME ZONE 'UTC', $6, $7)
            RETURNING *
        `, [tokenId, date, value, previousValue, timestamp, type, note || null]);
        
        return res.rows[0];
    },
    
    // Add trading volume history entry
    async addTradingVolumeHistory(tokenId, historyData) {
        const { date, value, previousValue, timestamp, type, note } = historyData;
        
        const res = await this.query(`
            INSERT INTO trading_volume_history (token_id, date, value, previous_value, timestamp, type, note)
            VALUES ($1, $2, $3, $4, $5::timestamp AT TIME ZONE 'UTC', $6, $7)
            RETURNING *
        `, [tokenId, date, value, previousValue, timestamp, type, note || null]);
        
        return res.rows[0];
    },
    
    // Get top volume history for a token
    async getTopVolumeHistory(tokenId) {
        const res = await this.query(`
            SELECT date, value, previous_value, 
                   timestamp AT TIME ZONE 'UTC' as timestamp, 
                   type, note
            FROM top_volume_history 
            WHERE token_id = $1 
            ORDER BY timestamp DESC
        `, [tokenId]);
        
        // Convert snake_case to camelCase for frontend compatibility
        return res.rows.map(entry => ({
            date: entry.date,
            value: parseFloat(entry.value) || 0,
            previousValue: entry.previous_value ? parseFloat(entry.previous_value) : null,
            timestamp: entry.timestamp,
            type: entry.type,
            note: entry.note
        }));
    },
    
    // Get trading volume history for a token
    async getTradingVolumeHistory(tokenId) {
        const res = await this.query(`
            SELECT date, value, previous_value, 
                   timestamp AT TIME ZONE 'UTC' as timestamp, 
                   type, note
            FROM trading_volume_history 
            WHERE token_id = $1 
            ORDER BY timestamp DESC
        `, [tokenId]);
        
        // Convert snake_case to camelCase for frontend compatibility
        return res.rows.map(entry => ({
            date: entry.date,
            value: parseFloat(entry.value) || 0,
            previousValue: entry.previous_value ? parseFloat(entry.previous_value) : null,
            timestamp: entry.timestamp,
            type: entry.type,
            note: entry.note
        }));
    }
};

module.exports = {
    pool,
    testConnection,
    initializeTables,
    db
};
