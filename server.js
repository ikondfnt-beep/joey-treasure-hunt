const express = require('express');
const path = require('path');
const { Pool } = require('pg');
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

// Track the globally selected active game workspace profile session ID state
let CURRENT_GAME_ID = 'default-hunt';

const initSchema = async () => {
    const client = await pool.connect();
    try {
        // Parent table managing standalone distinct game profile sessions
        await client.query(`
            CREATE TABLE IF NOT EXISTS games (
                game_id TEXT PRIMARY KEY,
                game_title TEXT,
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

        // Initialize our default base profile token row safely if completely empty
        await client.query(`INSERT INTO games (game_id, game_title, created_at) VALUES ('default-hunt', 'Standard Field Map', $1) ON CONFLICT DO NOTHING`, [Date.now()]);
        console.log('Decoupled multi-game PostgreSQL layout tables validated.');
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

// --- NEW: MULTI-TENANCY GAME SWITCHING APIS ---
app.get('/api/admin/games', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM games ORDER BY created_at DESC`);
        res.json({ active_game: CURRENT_GAME_ID, games: result.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/games/switch', async (req, res) => {
    const { game_id } = req.body;
    if (!game_id) return res.status(400).json({ error: "Missing parameter details" });
    CURRENT_GAME_ID = game_id.trim();
    res.json({ success: true, active_game: CURRENT_GAME_ID });
});

app.post('/api/admin/games/create', async (req, res) => {
    const { game_id, game_title } = req.body;
    const cleanId = game_id.replace(/[^a-zA-Z0-9-_]/g, '').toLowerCase();
    try {
        await pool.query(`INSERT INTO games (game_id, game_title, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [cleanId, game_title, Date.now()]);
        CURRENT_GAME_ID = cleanId;
        res.json({ success: true, active_game: CURRENT_GAME_ID });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- SEGMENTED OPERATION API ENGINES WRITTEN DOWNWARD ---
app.get('/api/patrols', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM patrol_states WHERE game_id = $1 ORDER BY patrol_name ASC`, [CURRENT_GAME_ID]);
        res.json(result.rows);
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
        
        const now = Date.now();
        await pool.query(`
            INSERT INTO clue_logs (game_id, patrol_name, step_number, start_time) 
            VALUES ($1, $2, $3, $4) 
            ON CONFLICT (game_id, patrol_name, step_number) DO NOTHING
        `, [CURRENT_GAME_ID, patrol, dynamicStepTarget, now]);

        res.json({ clue: clueRow ? clueRow.clue_html : "Clue routing definition bounds error.", isFinished: false, inputType: isNumeric ? 'number' : 'text' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/submit-code', async (req, res) => {
    const { patrol, code } = req.body;
    try {
        const allPatrolsRes = await pool.query(`SELECT patrol_name FROM patrol_states WHERE game_id = $1 ORDER BY patrol_name ASC`, [CURRENT_GAME_ID]);
        const patrolIndex = allPatrolsRes.rows.findIndex(p => p.patrol_name === patrol);

        const stateRes = await pool.query(`SELECT current_step FROM patrol_states WHERE game_id = $1 AND patrol_name = $2`, [CURRENT_GAME_ID, patrol]);
        if (stateRes.rows.length === 0) return res.status(400).json({ error: "Profile bound parameter error" });
        const currentStep = stateRes.rows[0].current_step;

        const allCluesRes = await pool.query(`SELECT step_number FROM clues WHERE game_id = $1`);
        const totalClues = allCluesRes.rows.length;
        
        if (currentStep === 0) {
            const expectedStartCode = String(1001 + patrolIndex);
            if (code === expectedStartCode) {
                await pool.query(`UPDATE patrol_states SET current_step = 1 WHERE game_id = $1 AND patrol_name = $2`, [CURRENT_GAME_ID, patrol]);
                res.json({ success: true, correct: true, isFinished: false });
            } else { res.json({ success: true, correct: false, message: "Invalid activation mapping sequence codes." }); }
            return;
        }

        const dynamicStepTarget = getTargetStepNumber(patrolIndex, currentStep, totalClues);

        const clueRes = await pool.query(`SELECT unlock_code FROM clues WHERE game_id = $1 AND step_number = $2`, [CURRENT_GAME_ID, dynamicStepTarget]);
        const targetClueRow = clueRes.rows[0];

        if (!targetClueRow) return res.json({ success: true, correct: false, message: "Mapping parameter boundary crash." });

        const submittedCode = String(code).trim().toLowerCase();
        const expectedCode = String(targetClueRow.unlock_code).trim().toLowerCase();

        if (submittedCode === expectedCode) {
            const nextStep = currentStep + 1;
            const now = Date.now();
            
            await pool.query(`UPDATE clue_logs SET end_time = $1 WHERE game_id = $2 AND patrol_name = $3 AND step_number = $4 AND end_time IS NULL`, [now, CURRENT_GAME_ID, patrol, dynamicStepTarget]);
            await pool.query(`UPDATE patrol_states SET current_step = $1 WHERE game_id = $2 AND patrol_name = $3`, [nextStep, CURRENT_GAME_ID, patrol]);
            
            res.json({ success: true, correct: true, isFinished: nextStep > totalClues });
        } else { res.json({ success: true, correct: false, message: "That answer doesn't match this location. Look closer!" }); }
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
            VALUES ($1, $2, $3, $4, $5) 
            ON CONFLICT (game_id, step_number) 
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

// UPGRADED: Resets live log timestamps and updates current steps back to 0 without deleting patrols or clues!
app.post('/api/admin/start-game', async (req, res) => {
    try {
        await pool.query(`DELETE FROM clue_logs WHERE game_id = $1`, [CURRENT_GAME_ID]);
        await pool.query(`UPDATE patrol_states SET current_step = 0 WHERE game_id = $1`, [CURRENT_GAME_ID]);
        res.json({ success: true, message: "Active workspace tracking logs purged. All patrol checkpoints rolled back to briefing rooms." });
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
        res.json({ success: true, message: `Successfully loaded ${importedClues.length} clue elements down this active track map!` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('/tracking', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'tracking.html')); });

app.listen(PORT, () => { console.log(`Production platform tracking engine initialization complete on port ${PORT}`); });