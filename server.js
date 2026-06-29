const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database(path.join(__dirname, 'data', 'hunt.db'), (err) => {
    if (err) console.error('Database configuration load failure:', err);
    console.log('Connected to SQLite persistent database storage.');
});

// Structural schema build operations
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS clues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        step_number INTEGER UNIQUE,
        unlock_code TEXT,
        clue_html TEXT,
        leader_location TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS patrol_states (
        patrol_name TEXT PRIMARY KEY,
        patrol_color TEXT,
        current_step INTEGER DEFAULT 0
    )`);
});

// Dynamic Step Index Sequence Generator based on active data lists
function getTargetStepNumber(patrolIndex, currentStep, totalClues) {
    if (totalClues === 0) return 1;
    return ((currentStep - 1 + patrolIndex) % totalClues) + 1;
}

app.get('/api/patrols', (req, res) => {
    db.all(`SELECT * FROM patrol_states ORDER BY rowid ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/clue/:patrol', (req, res) => {
    const patrol = req.params.patrol;

    db.all(`SELECT patrol_name FROM patrol_states ORDER BY rowid ASC`, [], (err, allPatrols) => {
        if (err) return res.status(500).json({ error: err.message });
        const patrolIndex = allPatrols.findIndex(p => p.patrol_name === patrol);
        
        db.get(`SELECT current_step FROM patrol_states WHERE patrol_name = ?`, [patrol], (err, row) => {
            if (err || !row) return res.status(400).json({ error: "Invalid team mapping profile" });
            const currentStep = row.current_step;

            if (currentStep === 0) {
                return res.json({ clue: "Game initialized. Enter your group activation passcode card to view your initial station destination guidelines.", isFinished: false });
            }

            db.all(`SELECT step_number FROM clues`, [], (err, allClues) => {
                const totalClues = allClues.length;
                
                if (currentStep > totalClues) {
                    return res.json({ clue: "Operation Complete. You have completed the sequence routes. Return to command base instructions.", isFinished: true });
                }

                const dynamicStepTarget = getTargetStepNumber(patrolIndex, currentStep, totalClues);

                db.get(`SELECT clue_html FROM clues WHERE step_number = ?`, [dynamicStepTarget], (err, clueRow) => {
                    res.json({ clue: clueRow ? clueRow.clue_html : "Clue content definition structural exception.", isFinished: false });
                });
            });
        });
    });
});

app.post('/api/submit-code', (req, res) => {
    const { patrol, code } = req.body;

    db.all(`SELECT patrol_name FROM patrol_states ORDER BY rowid ASC`, [], (err, allPatrols) => {
        if (err) return res.status(500).json({ error: err.message });
        const patrolIndex = allPatrols.findIndex(p => p.patrol_name === patrol);

        db.get(`SELECT current_step FROM patrol_states WHERE patrol_name = ?`, [patrol], (err, row) => {
            if (err || !row) return res.status(400).json({ error: "Invalid team mapping profile" });
            const currentStep = row.current_step;

            db.all(`SELECT step_number FROM clues`, [], (err, allClues) => {
                const totalClues = allClues.length;
                
                if (currentStep === 0) {
                    const expectedStartCode = String(1001 + patrolIndex);
                    if (code === expectedStartCode) {
                        db.run(`UPDATE patrol_states SET current_step = 1 WHERE patrol_name = ?`, [patrol], (err) => {
                            res.json({ success: true, correct: true, isFinished: false });
                        });
                    } else {
                        res.json({ success: true, correct: false, message: "Invalid activation code mapping sequence parameters." });
                    }
                    return;
                }

                const dynamicStepTarget = getTargetStepNumber(patrolIndex, currentStep, totalClues);

                db.get(`SELECT unlock_code FROM clues WHERE step_number = ?`, [dynamicStepTarget], (err, targetClueRow) => {
                    if (!targetClueRow) return res.json({ success: true, correct: false, message: "Configuration mapping bounds error." });

                    if (code === targetClueRow.unlock_code) {
                        const nextStep = currentStep + 1;
                        db.run(`UPDATE patrol_states SET current_step = ? WHERE patrol_name = ?`, [nextStep, patrol], (err) => {
                            res.json({ success: true, correct: true, isFinished: nextStep > totalClues });
                        });
                    } else {
                        res.json({ success: true, correct: false, message: "Code mismatch. Check checkpoint designation marker parameters." });
                    }
                });
            });
        });
    });
});

// --- SYSTEM MANAGEMENT CONFIGURATION ENDPOINTS ---
app.get('/api/admin/clues', (req, res) => {
    db.all(`SELECT * FROM clues ORDER BY step_number ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message }); res.json(rows);
    });
});

app.post('/api/admin/clues', (req, res) => {
    const { step_number, unlock_code, clue_html, leader_location } = req.body;
    db.run(`INSERT OR REPLACE INTO clues (step_number, unlock_code, clue_html, leader_location) VALUES (?, ?, ?, ?)`,
        [parseInt(step_number), unlock_code, clue_html, leader_location],
        (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ success: true }); }
    );
});

app.post('/api/admin/patrols', (req, res) => {
    const { patrol_name, patrol_color } = req.body;
    db.run(`INSERT OR IGNORE INTO patrol_states (patrol_name, patrol_color, current_step) VALUES (?, ?, 0)`, 
        [patrol_name, patrol_color], 
        (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ success: true }); }
    );
});

app.delete('/api/admin/patrols/:name', (req, res) => {
    db.run(`DELETE FROM patrol_states WHERE patrol_name = ?`, [req.params.name], (err) => {
        if (err) return res.status(500).json({ error: err.message }); res.json({ success: true });
    });
});

app.post('/api/admin/start-game', (req, res) => {
    db.run(`UPDATE patrol_states SET current_step = 0`, [], (err) => {
        if (err) return res.status(500).json({ error: err.message }); res.json({ success: true, message: "Game status reset to step 0. Waiting for activation inputs." });
    });
});

app.post('/api/admin/clear-all', (req, res) => {
    db.serialize(() => {
        db.run(`DELETE FROM clues`);
        db.run(`DELETE FROM patrol_states`);
        res.json({ success: true, message: "Database tables purged completely." });
    });
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });

app.listen(PORT, () => { console.log(`Production platform tracking engine context initialization standard complete on port ${PORT}`); });