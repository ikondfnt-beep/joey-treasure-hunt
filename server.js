const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configure connection credentials targeting your Docker database container name
const pool = new Pool({
    user: 'scoutmaster',
    host: 'joey-hunt-db', // Routes directly to the isolated database container over joey-net
    database: 'joey_hunt_prod',
    password: 'JoeyScoutSecretPass123',
    port: 5432,
});

// Structural schema initialization operations using standard PostgreSQL notation
const initSchema = async () => {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS clues (
                id SERIAL PRIMARY KEY,
                step_number INTEGER UNIQUE,
                unlock_code TEXT,
                clue_html TEXT,
                leader_location TEXT
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS patrol_states (
                patrol_name TEXT PRIMARY KEY,
                patrol_color TEXT,
                current_step INTEGER DEFAULT 0
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS clue_logs (
                id SERIAL PRIMARY KEY,
                patrol_name TEXT,
                step_number INTEGER,
                start_time BIGINT,
                end_time BIGINT DEFAULT NULL,
                UNIQUE(patrol_name, step_number)
            )
        `);
        console.log('Connected to PostgreSQL persistent container storage successfully.');
    } catch (err) {
        console.error('Database configuration load failure:', err);
    } finally {
        client.release();
    }
};
initSchema();

function getTargetStepNumber(patrolIndex, currentStep, totalClues) {
    if (totalClues === 0) return 1;
    return ((currentStep - 1 + patrolIndex) % totalClues) + 1;
}

app.get('/api/patrols', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM patrol_states ORDER BY patrol_name ASC`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/clue/:patrol', async (req, res) => {
    const patrol = req.params.patrol;
    try {
        const allPatrolsRes = await pool.query(`SELECT patrol_name FROM patrol_states ORDER BY patrol_name ASC`);
        const patrolIndex = allPatrolsRes.rows.findIndex(p => p.patrol_name === patrol);
        
        const stateRes = await pool.query(`SELECT current_step FROM patrol_states WHERE patrol_name = $1`, [patrol]);
        if (stateRes.rows.length === 0) return res.status(400).json({ error: "Invalid team mapping profile" });
        const currentStep = stateRes.rows[0].current_step;

        if (currentStep === 0) {
            return res.json({ clue: "Game initialized. Enter your group activation passcode card to view your initial station destination guidelines.", isFinished: false });
        }

        const allCluesRes = await pool.query(`SELECT step_number FROM clues`);
        const totalClues = allCluesRes.rows.length;
        
        if (currentStep > totalClues) {
            return res.json({ clue: "Operation Complete. You have completed the sequence routes. Return to command base instructions.", isFinished: true });
        }

        const dynamicStepTarget = getTargetStepNumber(patrolIndex, currentStep, totalClues);

        const clueRes = await pool.query(`SELECT clue_html, unlock_code FROM clues WHERE step_number = $1`, [dynamicStepTarget]);
        const clueRow = clueRes.rows[0];
        
        const isNumeric = clueRow && /^\d+$/.test(clueRow.unlock_code) && clueRow.unlock_code.length === 4;
        
        const now = Date.now();
        await pool.query(`
            INSERT INTO clue_logs (patrol_name, step_number, start_time) 
            VALUES ($1, $2, $3) 
            ON CONFLICT (patrol_name, step_number) DO NOTHING
        `, [patrol, dynamicStepTarget, now]);

        res.json({ 
            clue: clueRow ? clueRow.clue_html : "Clue content definition error.", 
            isFinished: false,
            inputType: isNumeric ? 'number' : 'text' 
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/submit-code', async (req, res) => {
    const { patrol, code } = req.body;
    try {
        const allPatrolsRes = await pool.query(`SELECT patrol_name FROM patrol_states ORDER BY patrol_name ASC`);
        const patrolIndex = allPatrolsRes.rows.findIndex(p => p.patrol_name === patrol);

        const stateRes = await pool.query(`SELECT current_step FROM patrol_states WHERE patrol_name = $1`, [patrol]);
        if (stateRes.rows.length === 0) return res.status(400).json({ error: "Invalid team mapping profile" });
        const currentStep = stateRes.rows[0].current_step;

        const allCluesRes = await pool.query(`SELECT step_number FROM clues`);
        const totalClues = allCluesRes.rows.length;
        
        if (currentStep === 0) {
            const expectedStartCode = String(1001 + patrolIndex);
            if (code === expectedStartCode) {
                await pool.query(`UPDATE patrol_states SET current_step = 1 WHERE patrol_name = $1`, [patrol]);
                res.json({ success: true, correct: true, isFinished: false });
            } else {
                res.json({ success: true, correct: false, message: "Invalid activation code mapping sequence parameters." });
            }
            return;
        }

        const dynamicStepTarget = getTargetStepNumber(patrolIndex, currentStep, totalClues);

        const clueRes = await pool.query(`SELECT unlock_code FROM clues WHERE step_number = $1`, [dynamicStepTarget]);
        const targetClueRow = clueRes.rows[0];

        if (!targetClueRow) return res.json({ success: true, correct: false, message: "Configuration mapping bounds error." });

        const submittedCode = String(code).trim().toLowerCase();
        const expectedCode = String(targetClueRow.unlock_code).trim().toLowerCase();

        if (submittedCode === expectedCode) {
            const nextStep = currentStep + 1;
            const now = Date.now();
            
            await pool.query(`UPDATE clue_logs SET end_time = $1 WHERE patrol_name = $2 AND step_number = $3 AND end_time IS NULL`, [now, patrol, dynamicStepTarget]);
            await pool.query(`UPDATE patrol_states SET current_step = $1 WHERE patrol_name = $2`, [nextStep, patrol]);
            
            res.json({ success: true, correct: true, isFinished: nextStep > totalClues });
        } else {
            res.json({ success: true, correct: false, message: "That answer doesn't match this location. Look closer!" });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- SYSTEM MANAGEMENT CONFIGURATION ENDPOINTS ---
app.get('/api/admin/durations', async (req, res) => {
    try {
        const result = await pool.query(`SELECT patrol_name, step_number, start_time, end_time FROM clue_logs ORDER BY patrol_name ASC, step_number ASC`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/clues', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM clues ORDER BY step_number ASC`);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/clues', async (req, res) => {
    const { step_number, unlock_code, clue_html, leader_location } = req.body;
    try {
        await pool.query(`
            INSERT INTO clues (step_number, unlock_code, clue_html, leader_location) 
            VALUES ($1, $2, $3, $4) 
            ON CONFLICT (step_number) 
            DO UPDATE SET unlock_code = EXCLUDED.unlock_code, clue_html = EXCLUDED.clue_html, leader_location = EXCLUDED.leader_location
        `, [parseInt(step_number), unlock_code, clue_html, leader_location]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/patrols', async (req, res) => {
    const { patrol_name, patrol_color } = req.body;
    try {
        await pool.query(`INSERT INTO patrol_states (patrol_name, patrol_color, current_step) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING`, [patrol_name, patrol_color]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/patrols/:name', async (req, res) => {
    try {
        await pool.query(`DELETE FROM patrol_states WHERE patrol_name = $1`, [req.params.name]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/start-game', async (req, res) => {
    try {
        await pool.query(`DELETE FROM clue_logs`);
        await pool.query(`UPDATE patrol_states SET current_step = 0`);
        res.json({ success: true, message: "Game status reset to step 0. Waiting for activation inputs." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/clear-all', async (req, res) => {
    try {
        await pool.query(`DELETE FROM clues`);
        await pool.query(`DELETE FROM patrol_states`);
        await pool.query(`DELETE FROM clue_logs`);
        res.json({ success: true, message: "Database tables purged completely." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- BACKUP SYSTEMS ---
app.get('/api/admin/backup-clues', async (req, res) => {
    try {
        const result = await pool.query(`SELECT step_number, unlock_code, clue_html, leader_location FROM clues ORDER BY step_number ASC`);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename=joey-hunt-clues-backup.json');
        res.send(JSON.stringify(result.rows, null, 4));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/restore-clues', async (req, res) => {
    const importedClues = req.body;
    if (!Array.isArray(importedClues)) return res.status(400).json({ success: false, message: "Invalid backup format." });
    
    try {
        await pool.query(`DELETE FROM clues`);
        for (const c of importedClues) {
            await pool.query(`INSERT INTO clues (step_number, unlock_code, clue_html, leader_location) VALUES ($1, $2, $3, $4)`, 
                [parseInt(c.step_number), c.unlock_code, c.clue_html, c.leader_location]);
        }
        res.json({ success: true, message: `Successfully restored ${importedClues.length} clue checkpoints!` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('/tracking', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'tracking.html')); });

app.listen(PORT, () => { console.log(`Production platform tracking engine context initialization complete on port ${PORT}`); });