const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const { GoogleGenAI } = require('@google/genai'); 
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
    user: 'scoutmaster',
    host: 'joey-hunt-db',
    database: 'joey_hunt_prod',
    password: 'JoeyScoutSecretPass123',
    port: 5432,
});

let CURRENT_GAME_ID = 'default-hunt';

const initSchema = async () => {
    const client = await pool.connect();
    try {
        // Core persistent table tracking runtime system values
        await client.query(`
            CREATE TABLE IF NOT EXISTS server_state (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        `);

        // Seed default active target parameters cleanly
        await client.query(`
            INSERT INTO server_state (key, value) 
            VALUES ('active_game_id', 'default-hunt') 
            ON CONFLICT DO NOTHING
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS games (
                game_id TEXT PRIMARY KEY,
                game_title TEXT,
                game_password TEXT NOT NULL DEFAULT 'hunt123',
                created_at BIGINT
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS clues (
                id SERIAL PRIMARY KEY,
                game_id TEXT DEFAULT 'default-hunt',
                step_number INTEGER,
                unlock_code TEXT,
                clue_html TEXT,
                leader_location TEXT,
                UNIQUE(game_id, step_number)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS patrol_states (
                game_id TEXT DEFAULT 'default-hunt',
                patrol_name TEXT,
                patrol_color TEXT,
                current_step INTEGER DEFAULT 0,
                PRIMARY KEY (game_id, patrol_name)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS clue_logs (
                id SERIAL PRIMARY KEY,
                game_id TEXT DEFAULT 'default-hunt',
                patrol_name TEXT,
                step_number INTEGER,
                start_time BIGINT,
                end_time BIGINT DEFAULT NULL,
                UNIQUE(game_id, patrol_name, step_number)
            )
        `);

        await client.query(`INSERT INTO games (game_id, game_title, game_password, created_at) VALUES ('default-hunt', 'Standard Field Map', 'hunt123', $1) ON CONFLICT DO NOTHING`, [Date.now()]);
        
        // Synchronize memory cache variables directly with structural storage states
        const stateRes = await client.query(`SELECT value FROM server_state WHERE key = 'active_game_id'`);
        if (stateRes.rows[0]) CURRENT_GAME_ID = stateRes.rows[0].value;

        console.log('Decoupled multi-game PostgreSQL layout tables validated. Active:', CURRENT_GAME_ID);
    } catch (err) {
        console.error('Database migration routing crash:', err);
    } finally {
        client.release();
    }
};
initSchema();

function getTargetStepNumber(patrolIndex, currentStep, totalClues) {
    if (totalClues === 0) return 1;
    return ((currentStep - 1 + patrolIndex) % totalClues) + 1;
}

// --- GOOGLE GEMINI AI CLUE GENERATOR ENDPOINT ---
app.post('/api/admin/generate-clue', async (req, res) => {
    const { location, style } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) return res.status(400).json({ error: "Gemini API key configuration is missing on the server backend." });
    if (!location) return res.status(400).json({ error: "Please enter a physical location first." });

    try {
        const ai = new GoogleGenAI({ apiKey: apiKey });
        let sectionGuideline = "";
        
        if (style === 'joey') {
            sectionGuideline = `Target Audience: Joey Scouts (Ages 5-7). \n- Use very simple, clear, literal words.\n- Focus on colors, basic shapes, and obvious landmarks.`;
        } else if (style === 'cub') {
            sectionGuideline = `Target Audience: Cub Scouts (Ages 8-10).\n- Write it as a fun, active rhyming riddle.\n- Include slight mystery, requiring deduction of specific objects.`;
        } else if (style === 'scout') {
            sectionGuideline = `Target Audience: Scouts (Ages 11-14).\n- Make it a challenge. Use cryptic phrasing, compass references, or wordplay.`;
        }

        const systemPrompt = `You are an expert scout leader creating an outdoor treasure hunt game. Write a clue guiding a patrol to: "${location}". ${sectionGuideline} Rules: Output ONLY clue text. Do not mention the final hiding spot explicitly. 2-3 sentences max.`;

        const response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite',
            contents: systemPrompt,
        });

        res.json({ success: true, clue: response.text.trim() });
    } catch (err) {
        res.status(500).json({ error: `Assistant Engine Error: ${err.message}` });
    }
});

// --- MULTI-TENANCY GAME SWITCHING APIS ---
app.get('/api/admin/games', async (req, res) => {
    try {
        const stateRes = await pool.query(`SELECT value FROM server_state WHERE key = 'active_game_id'`);
        const currentActive = stateRes.rows[0] ? stateRes.rows[0].value : 'default-hunt';
        CURRENT_GAME_ID = currentActive;

        const result = await pool.query(`SELECT * FROM games ORDER BY created_at DESC`);
        res.json({ active_game: CURRENT_GAME_ID, games: result.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/games/switch', async (req, res) => {
    const { game_id } = req.body;
    if (!game_id) return res.status(400).json({ error: "Missing parameter details" });
    try {
        await pool.query(`UPDATE server_state SET value = $1 WHERE key = 'active_game_id'`, [game_id.trim()]);
        CURRENT_GAME_ID = game_id.trim();
        res.json({ success: true, active_game: CURRENT_GAME_ID });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/games/create', async (req, res) => {
    const { game_id, game_title, game_password } = req.body;
    const cleanId = game_id.replace(/[^a-zA-Z0-9-_]/g, '').toLowerCase();
    const passwordToStore = game_password ? game_password.trim() : 'hunt123';
    try {
        await pool.query(
            `INSERT INTO games (game_id, game_title, game_password, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, 
            [cleanId, game_title, passwordToStore, Date.now()]
        );
        await pool.query(`UPDATE server_state SET value = $1 WHERE key = 'active_game_id'`, [cleanId]);
        CURRENT_GAME_ID = cleanId;
        res.json({ success: true, active_game: CURRENT_GAME_ID });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- SEGMENTED OPERATION API ENGINES ---
app.get('/api/patrols', async (req, res) => {
    try {
        // Fetch clues count for current game
        const cluesRes = await pool.query(`SELECT COUNT(*) FROM clues WHERE game_id = $1`, [CURRENT_GAME_ID]);
        const totalClues = parseInt(cluesRes.rows[0].count) || 0;

        // Fetch patrols
        const result = await pool.query(`SELECT * FROM patrol_states WHERE game_id = $1 ORDER BY patrol_name ASC`, [CURRENT_GAME_ID]);
        
        // Map progress data for each team
        const patrolsWithProgress = result.rows.map(p => {
            const completedSteps = Math.max(0, p.current_step - 1);
            const percentage = totalClues > 0 ? Math.min(100, Math.round((completedSteps / totalClues) * 100)) : 0;
            return {
                ...p,
                totalClues,
                completedSteps,
                progressPercent: p.current_step > totalClues ? 100 : percentage,
                isFinished: p.current_step > totalClues
            };
        });

        res.json(patrolsWithProgress);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/clue/:patrol', async (req, res) => {
    const patrol = req.params.patrol;
    try {
        const allPatrolsRes = await pool.query(`SELECT patrol_name FROM patrol_states WHERE game_id = $1 ORDER BY patrol_name ASC`, [CURRENT_GAME_ID]);
        const patrolIndex = allPatrolsRes.rows.findIndex(p => p.patrol_name === patrol);
        
        const stateRes = await pool.query(`SELECT current_step FROM patrol_states WHERE game_id = $1 AND patrol_name = $2`, [CURRENT_GAME_ID, patrol]);
        if (stateRes.rows.length === 0) return res.status(400).json({ error: "Profile mismatch error" });
        const currentStep = stateRes.rows[0].current_step;

        if (currentStep === 0) {
            return res.json({ clue: "Game initialized. Enter your group activation passcode card to view your initial station destination guidelines.", isFinished: false });
        }

        const allCluesRes = await pool.query(`SELECT step_number FROM clues WHERE game_id = $1`, [CURRENT_GAME_ID]);
        const totalClues = allCluesRes.rows.length;
        
        if (currentStep > totalClues) {
            return res.json({ clue: "Operation Complete. You have completed the sequence routes. Return to command base instructions.", isFinished: true });
        }

        const dynamicStepTarget = getTargetStepNumber(patrolIndex, currentStep, totalClues);
        const clueRes = await pool.query(`SELECT clue_html, unlock_code FROM clues WHERE game_id = $1 AND step_number = $2`, [CURRENT_GAME_ID, dynamicStepTarget]);
        const clueRow = clueRes.rows[0];
        
        const isNumeric = clueRow && /^\d+$/.test(clueRow.unlock_code) && clueRow.unlock_code.length === 4;
        
        await pool.query(`
            INSERT INTO clue_logs (game_id, patrol_name, step_number, start_time) 
            VALUES ($1, $2, $3, $4) ON CONFLICT (game_id, patrol_name, step_number) DO NOTHING
        `, [CURRENT_GAME_ID, patrol, dynamicStepTarget, Date.now()]);

        res.json({clue: clueRow ? clueRow.clue_html : "Clue routing definition bounds error.", isFinished: false, inputType: isNumeric ? 'number' : 'text',currentStep: currentStep, totalClues: totalClues });
        if (currentStep > totalClues) {
            return res.json({ 
                clue: "Operation Complete. You have completed the sequence routes. Return to command base instructions.", 
        isFinished: true,
        currentStep: currentStep,
        totalClues: totalClues 
    });
}
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/submit-code', async (req, res) => {
    const { patrol, code } = req.body;
    try {
        const allPatrolsRes = await pool.query(`SELECT patrol_name FROM patrol_states WHERE game_id = $1 ORDER BY patrol_name ASC`, [CURRENT_GAME_ID]);
        const patrolIndex = allPatrolsRes.rows.findIndex(p => p.patrol_name === patrol);

        const stateRes = await pool.query(`SELECT current_step FROM patrol_states WHERE game_id = $1 AND patrol_name = $2`, [CURRENT_GAME_ID, patrol]);
        if (stateRes.rows.length === 0) return res.status(400).json({ error: "Profile parameter error" });
        const currentStep = stateRes.rows[0].current_step;

        const allCluesRes = await pool.query(`SELECT step_number FROM clues WHERE game_id = $1`, [CURRENT_GAME_ID]);
        const totalClues = allCluesRes.rows.length;
        
// 🟢 NEW LOGIC: Start button trigger (No PIN required!)
        if (currentStep === 0) {
            if (code === 'START_GAME' || code === '1001') { // Kept '1001' as a safe backup
                await pool.query(`UPDATE patrol_states SET current_step = 1 WHERE game_id = $1 AND patrol_name = $2`, [CURRENT_GAME_ID, patrol]);
                return res.json({ success: true, correct: true, isFinished: false });
    }
}

        const dynamicStepTarget = getTargetStepNumber(patrolIndex, currentStep, totalClues);
        const clueRes = await pool.query(`SELECT unlock_code FROM clues WHERE game_id = $1 AND step_number = $2`, [CURRENT_GAME_ID, dynamicStepTarget]);
        const targetClueRow = clueRes.rows[0];

        if (!targetClueRow) return res.json({ success: true, correct: false, message: "Mapping parameter boundary crash." });

        if (String(code).trim().toLowerCase() === String(targetClueRow.unlock_code).trim().toLowerCase()) {
            const nextStep = currentStep + 1;
            await pool.query(`UPDATE clue_logs SET end_time = $1 WHERE game_id = $2 AND patrol_name = $3 AND step_number = $4 AND end_time IS NULL`, [Date.now(), CURRENT_GAME_ID, patrol, dynamicStepTarget]);
            await pool.query(`UPDATE patrol_states SET current_step = $1 WHERE game_id = $2 AND patrol_name = $3`, [nextStep, CURRENT_GAME_ID, patrol]);
            res.json({ success: true, correct: true, isFinished: nextStep > totalClues });
        } else { 
            res.json({ success: true, correct: false, message: "That answer doesn't match this location. Look closer!" }); 
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/durations', async (req, res) => {
    try {
        const result = await pool.query(`SELECT patrol_name, step_number, start_time, end_time FROM clue_logs WHERE game_id = $1 ORDER BY patrol_name ASC, step_number ASC`, [CURRENT_GAME_ID]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/clues', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM clues WHERE game_id = $1 ORDER BY step_number ASC`, [CURRENT_GAME_ID]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/clues', async (req, res) => {
    const { step_number, unlock_code, clue_html, leader_location } = req.body;
    try {
        await pool.query(`
            INSERT INTO clues (game_id, step_number, unlock_code, clue_html, leader_location) 
            VALUES ($1, $2, $3, $4, $5) ON CONFLICT (game_id, step_number) 
            DO UPDATE SET unlock_code = EXCLUDED.unlock_code, clue_html = EXCLUDED.clue_html, leader_location = EXCLUDED.leader_location
        `, [CURRENT_GAME_ID, parseInt(step_number), unlock_code, clue_html, leader_location]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/patrols', async (req, res) => {
    const { patrol_name, patrol_color } = req.body;
    try {
        await pool.query(`INSERT INTO patrol_states (game_id, patrol_name, patrol_color, current_step) VALUES ($1, $2, $3, 0) ON CONFLICT DO NOTHING`, [CURRENT_GAME_ID, patrol_name, patrol_color]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/patrols/:name', async (req, res) => {
    try {
        await pool.query(`DELETE FROM patrol_states WHERE game_id = $1 AND patrol_name = $2`, [CURRENT_GAME_ID, req.params.name]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/start-game', async (req, res) => {
    try {
        await pool.query(`DELETE FROM clue_logs WHERE game_id = $1`, [CURRENT_GAME_ID]);
        await pool.query(`UPDATE patrol_states SET current_step = 0 WHERE game_id = $1`, [CURRENT_GAME_ID]);
        res.json({ success: true, message: "Active progress reset successful." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/clear-all', async (req, res) => {
    try {
        await pool.query(`DELETE FROM clues WHERE game_id = $1`, [CURRENT_GAME_ID]);
        await pool.query(`DELETE FROM patrol_states WHERE game_id = $1`, [CURRENT_GAME_ID]);
        await pool.query(`DELETE FROM clue_logs WHERE game_id = $1`, [CURRENT_GAME_ID]);
        res.json({ success: true, message: "Active profile records purged completely." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/backup-clues', async (req, res) => {
    try {
        const result = await pool.query(`SELECT step_number, unlock_code, clue_html, leader_location FROM clues WHERE game_id = $1 ORDER BY step_number ASC`, [CURRENT_GAME_ID]);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=hunt-backup-${CURRENT_GAME_ID}.json`);
        res.send(JSON.stringify(result.rows, null, 4));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/restore-clues', async (req, res) => {
    const importedClues = req.body;
    if (!Array.isArray(importedClues)) return res.status(400).json({ success: false, message: "Invalid array profile" });
    try {
        await pool.query(`DELETE FROM clues WHERE game_id = $1`, [CURRENT_GAME_ID]);
        for (const c of importedClues) {
            await pool.query(`INSERT INTO clues (game_id, step_number, unlock_code, clue_html, leader_location) VALUES ($1, $2, $3, $4, $5)`, 
                [CURRENT_GAME_ID, parseInt(c.step_number), c.unlock_code, c.clue_html, c.leader_location]);
        }
        res.json({ success: true, message: `Successfully loaded ${importedClues.length} clue elements.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('/tracking', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'tracking.html')); });

// --- GAME ACCESS AND SECURITY CONTROL PIPELINES ---
app.post('/api/auth-admin', async (req, res) => {
    const { gameId, password } = req.body;
    const GLOBAL_OVERRIDE = "ScoutMaster";

    if (password === GLOBAL_OVERRIDE) return res.json({ authenticated: true, role: 'global' });

    try {
        const result = await pool.query(`SELECT game_password FROM games WHERE game_id = $1`, [gameId]);
        const game = result.rows[0];

        if (game && game.game_password === password) {
            return res.json({ authenticated: true, role: 'game-admin' });
        }
        res.status(401).json({ authenticated: false, message: "Invalid access token." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/delete-game', async (req, res) => {
    const { gameId, password } = req.body;
    const GLOBAL_OVERRIDE = "ScoutMaster";

    try {
        const result = await pool.query(`SELECT game_password FROM games WHERE game_id = $1`, [gameId]);
        const game = result.rows[0];

        if (password === GLOBAL_OVERRIDE || (game && game.game_password === password)) {
            await pool.query(`DELETE FROM clues WHERE game_id = $1`, [gameId]);
            await pool.query(`DELETE FROM patrol_states WHERE game_id = $1`, [gameId]);
            await pool.query(`DELETE FROM clue_logs WHERE game_id = $1`, [gameId]);
            await pool.query(`DELETE FROM games WHERE game_id = $1`, [gameId]);
            
            // If deleting the active map, fall back safely to default hunt parameters
            const currentActiveRes = await pool.query(`SELECT value FROM server_state WHERE key = 'active_game_id'`);
            if (currentActiveRes.rows[0] && currentActiveRes.rows[0].value === gameId) {
                await pool.query(`UPDATE server_state SET value = 'default-hunt' WHERE key = 'active_game_id'`);
                CURRENT_GAME_ID = 'default-hunt';
            }

            return res.json({ success: true, message: "Game files wiped successfully." });
        }
        res.status(403).json({ success: false, message: "Unauthorized destruction sequence." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => { console.log(`Production tracking engine complete on port ${PORT}`); });