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
    db.run(`CREATE TABLE IF NOT EXISTS clues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        step_number INTEGER UNIQUE,
        unlock_code TEXT,
        clue_html TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS patrol_states (
        patrol_name TEXT PRIMARY KEY,
        current_step INTEGER DEFAULT 0
    )`);

    // Initialize with your exact color-based patrols
    const defaultPatrols = ['Red', 'Green', 'Blue', 'Yellow'];
    defaultPatrols.forEach(patrol => {
        db.run(`INSERT OR IGNORE INTO patrol_states (patrol_name, current_step) VALUES (?, 0)`, [patrol]);
    });
});

const startClueText = "Welcome Joeys! Find your first code hidden near the main hall doors to get your first real clue.";

// HELPER FUNCTION: Calculates the staggered challenge index for a patrol
// This offsets their route so teams are sent to different stations simultaneously.
function getTargetStepNumber(patrolName, currentStep, totalClues) {
    if (totalClues === 0) return 1;
    
    // Assign an offset rotation value based on the patrol color
    let offset = 0;
    if (patrolName === 'Green') offset = 1;
    if (patrolName === 'Blue')  offset = 2;
    if (patrolName === 'Yellow') offset = 3;

    // Shift the step number sequence cleanly using basic modular math rotation
    let target = ((currentStep - 1 + offset) % totalClues) + 1;
    return target;
}

app.get('/api/patrols', (req, res) => {
    db.all(`SELECT * FROM patrol_states ORDER BY patrol_name ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// API: Get current clue tailored to a patrol's specific staggered track path
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

            // Calculate which physical task matches this team's current staggered route step
            const dynamicStepTarget = getTargetStepNumber(patrol, currentStep, totalClues);

            db.get(`SELECT clue_html FROM clues WHERE step_number = ?`, [dynamicStepTarget], (err, clueRow) => {
                res.json({ clue: clueRow ? clueRow.clue_html : "Clue configuration error.", isFinished: false });
            });
        });
    });
});

// API: Check if code belongs to their specific current target checkpoint
app.post('/api/submit-code', (req, res) => {
    const { patrol, code } = req.body;

    db.get(`SELECT current_step FROM patrol_states WHERE patrol_name = ?`, [patrol], (err, row) => {
        if (err || !row) return res.status(400).json({ error: "Invalid patrol" });
        const currentStep = row.current_step;
        const nextStep = currentStep + 1; // Moving to their next personal step milestone

        db.all(`SELECT step_number FROM clues`, [], (err, allClues) => {
            const totalClues = allClues.length;
            
            // Calculate the task location they are currently trying to unlock a code for
            const dynamicStepTarget = getTargetStepNumber(patrol, currentStep + 1, totalClues);

            db.get(`SELECT unlock_code FROM clues WHERE step_number = ?`, [dynamicStepTarget], (err, targetClueRow) => {
                if (!targetClueRow) {
                    return res.json({ success: true, correct: false, message: "Hunt configuration incomplete!" });
                }

                if (code === targetClueRow.unlock_code) {
                    db.run(`UPDATE patrol_states SET current_step = ? WHERE patrol_name = ?`, [nextStep, patrol], (err) => {
                        const isFinished = nextStep >= totalClues;
                        res.json({ success: true, correct: true, isFinished });
                    });
                } else {
                    res.json({ success: true, correct: false, message: "Incorrect code, look closer at your location!" });
                }
            });
        });
    });
});

// --- ADMIN API ENDPOINTS ---
app.get('/api/admin/clues', (req, res) => {
    db.all(`SELECT * FROM clues ORDER BY step_number ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/admin/clues', (req, res) => {
    const { step_number, unlock_code, clue_html } = req.body;
    db.run(`INSERT OR REPLACE INTO clues (step_number, unlock_code, clue_html) VALUES (?, ?, ?)`,
        [parseInt(step_number), unlock_code, clue_html],
        (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ success: true }); }
    );
});

app.post('/api/admin/patrols', (req, res) => {
    db.run(`INSERT OR IGNORE INTO patrol_states (patrol_name, current_step) VALUES (?, 0)`, [req.body.patrol_name], (err) => {
        if (err) return res.status(500).json({ error: err.message }); res.json({ success: true });
    });
});

app.delete('/api/admin/patrols/:name', (req, res) => {
    db.run(`DELETE FROM patrol_states WHERE patrol_name = ?`, [req.params.name], (err) => {
        if (err) return res.status(500).json({ error: err.message }); res.json({ success: true });
    });
});

app.post('/api/admin/reset-patrols', (req, res) => {
    db.run(`UPDATE patrol_states SET current_step = 0`, [], (err) => {
        if (err) return res.status(500).json({ error: err.message }); res.json({ success: true, message: "All patrol progress reset to 0!" });
    });
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });

app.listen(PORT, () => { console.log(`Staggered route hunt server active on port ${PORT}`); });