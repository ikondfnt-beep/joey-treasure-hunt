const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database(path.join(__dirname, 'data', 'hunt.db'), (err) => {
    if (err) console.error('Database opening error:', err);
    console.log('Connected to SQLite database.');
});

db.serialize(() => {
    // Upgraded clues table with explicit leader placement hints tracker column
    db.run(`CREATE TABLE IF NOT EXISTS clues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        step_number INTEGER UNIQUE,
        unlock_code TEXT,
        clue_html TEXT,
        leader_location TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS patrol_states (
        patrol_name TEXT PRIMARY KEY,
        current_step INTEGER DEFAULT 0
    )`);

    const defaultPatrols = ['Red', 'Green', 'Blue', 'Yellow'];
    defaultPatrols.forEach(patrol => {
        db.run(`INSERT OR IGNORE INTO patrol_states (patrol_name, current_step) VALUES (?, 0)`, [patrol]);
    });
});

const startClueText = "Welcome Joeys! Find your first code hidden near the main hall doors to get your first real clue.";

function getTargetStepNumber(patrolName, currentStep, totalClues) {
    if (totalClues === 0) return 1;
    let offset = 0;
    if (patrolName === 'Green') offset = 1;
    if (patrolName === 'Blue')  offset = 2;
    if (patrolName === 'Yellow') offset = 3;

    return ((currentStep - 1 + offset) % totalClues) + 1;
}

app.get('/api/patrols', (req, res) => {
    db.all(`SELECT * FROM patrol_states ORDER BY patrol_name ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/clue/:patrol', (req, res) => {
    const patrol = req.params.patrol;

    db.get(`SELECT current_step FROM patrol_states WHERE patrol_name = ?`, [patrol], (err, row) => {
        if (err || !row) return res.status(400).json({ error: "Invalid patrol" });
        const currentStep = row.current_step;

        if (currentStep === 0) {
            return res.json({ clue: startClueText, isFinished: false });
        }

        db.all(`SELECT step_number FROM clues`, [], (err, allClues) => {
            const totalClues = allClues.length;
            
            if (currentStep > totalClues) {
                return res.json({ clue: "CONGRATULATIONS! You have completed the treasure hunt! Return to leadership for your reward.", isFinished: true });
            }

            const dynamicStepTarget = getTargetStepNumber(patrol, currentStep, totalClues);

            db.get(`SELECT clue_html FROM clues WHERE step_number = ?`, [dynamicStepTarget], (err, clueRow) => {
                res.json({ clue: clueRow ? clueRow.clue_html : "Clue configuration error.", isFinished: false });
            });
        });
    });
});

app.post('/api/submit-code', (req, res) => {
    const { patrol, code } = req.body;

    db.get('SELECT current_step FROM patrol_states WHERE patrol_name = ?', [patrol], (err, row) => {
        if (err || !row) return res.status(400).json({ error: "Invalid patrol" });
        const currentStep = row.current_step;

        db.all('SELECT step_number FROM clues', [], (err, allClues) => {
            const totalClues = allClues.length;
            
            // --- 1. Handling the Initial Activation Code ---
            if (currentStep === 0) {
                let expectedStartCode = "0000";
                if (patrol === 'Red') expectedStartCode = "1001";
                if (patrol === 'Green') expectedStartCode = "2002";
                if (patrol === 'Blue') expectedStartCode = "3003";
                if (patrol === 'Yellow') expectedStartCode = "4004";

                if (code === expectedStartCode) {
                    db.run('UPDATE patrol_states SET current_step = 1 WHERE patrol_name = ?', [patrol], (err) => {
                        res.json({ success: true, correct: true, isFinished: false });
                    });
                } else {
                    res.json({ success: true, correct: false, message: "That's not your patrol's starting code! Check your briefing card." });
                }
                return;
            }

            // --- 2. CORRECTED ROUTE TRACK MATRIX LOGIC ---
            // The Joey is currently viewing the clue for their current step index.
            // Therefore, the code they find physically at this location belongs to THIS step index!
            const dynamicStepTarget = getTargetStepNumber(patrol, currentStep, totalClues);

            db.get('SELECT unlock_code FROM clues WHERE step_number = ?', [dynamicStepTarget], (err, targetClueRow) => {
                if (!targetClueRow) {
                    return res.json({ success: true, correct: false, message: "Hunt configuration incomplete!" });
                }

                // If the code matches the station they are physically looking at, advance them
                if (code === targetClueRow.unlock_code) {
                    const nextStep = currentStep + 1;
                    db.run('UPDATE patrol_states SET current_step = ? WHERE patrol_name = ?', [nextStep, patrol], (err) => {
                        // If they have completed all available rooms, mark finished
                        const isFinished = nextStep > totalClues;
                        res.json({ success: true, correct: true, isFinished });
                    });
                } else {
                    res.json({ success: true, correct: false, message: "Incorrect code! Look closely at the token hidden at this location." });
                }
            });
        });
    });
});

// --- ADMIN API ENDPOINTS (Upgraded to map leader instructions data fields) ---
app.get('/api/admin/clues', (req, res) => {
    db.all(`SELECT * FROM clues ORDER BY step_number ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/admin/clues', (req, res) => {
    const { step_number, unlock_code, clue_html, leader_location } = req.body;
    db.run(`INSERT OR REPLACE INTO clues (step_number, unlock_code, clue_html, leader_location) VALUES (?, ?, ?, ?)`,
        [parseInt(step_number), unlock_code, clue_html, leader_location],
        (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ success: true }); }
    );
});

app.post('/api/admin/reset-patrols', (req, res) => {
    db.run(`UPDATE patrol_states SET current_step = 0`, [], (err) => {
        if (err) return res.status(500).json({ error: err.message }); res.json({ success: true, message: "All patrol progress reset to 0!" });
    });
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });

app.listen(PORT, () => { console.log(`Solid background server active on port ${PORT}`); });