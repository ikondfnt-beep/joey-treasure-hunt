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

// Upgraded structural schema build operations
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

    // NEW TABLE: Logs start and end timestamps for every single challenge step
    db.run(`CREATE TABLE IF NOT EXISTS clue_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patrol_name TEXT,
        step_number INTEGER,
        start_time INTEGER,
        end_time INTEGER DEFAULT NULL
    )`);
});

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

                db.get(`SELECT clue_html, unlock_code FROM clues WHERE step_number = ?`, [dynamicStepTarget], (err, clueRow) => {
                    if (err) return res.status(500).json({ error: err.message });
                    
                    const isNumeric = clueRow && /^\d+$/.test(clueRow.unlock_code) && clueRow.unlock_code.length === 4;
                    
                    // Log the exact start time of this step if it hasn't been recorded yet
                    const now = Date.now();
                    db.run(`INSERT OR IGNORE INTO clue_logs (patrol_name, step_number, start_time) 
                            SELECT ?, ?, ? WHERE NOT EXISTS (
                                SELECT 1 FROM clue_logs WHERE patrol_name = ? AND step_number = ?
                            )`, [patrol, dynamicStepTarget, now, patrol, dynamicStepTarget]);

                    res.json({ 
                        clue: clueRow ? clueRow.clue_html : "Clue content definition error.", 
                        isFinished: false,
                        inputType: isNumeric ? 'number' : 'text' 
                    });
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

                    const submittedCode = String(code).trim().toLowerCase();
                    const expectedCode = String(targetClueRow.unlock_code).trim().toLowerCase();

                    if (submittedCode === expectedCode) {
                        const nextStep = currentStep + 1;
                        const now = Date.now();
                        
                        // Transactionally update the state and stamp the completion time
                        db.serialize(() => {
                            db.run(`UPDATE clue_logs SET end_time = ? WHERE patrol_name = ? AND step_number = ? AND end_time IS NULL`, [now, patrol, dynamicStepTarget]);
                            db.run(`UPDATE patrol_states SET current_step = ? WHERE patrol_name = ?`, [nextStep, patrol], (err) => {
                                res.json({ success: true, correct: true, isFinished: nextStep > totalClues });
                            });
                        });
                    } else {
                        res.json({ success: true, correct: false, message: "That answer doesn't match this location. Look closer!" });
                    }
                });
            });
        });
    });
});

// NEW ENDPOINT: Feeds duration tracking statistics up to the live admin dashboard
app.get('/api/admin/durations', (req, res) => {
    db.all(`SELECT patrol_name, step_number, start_time, end_time FROM clue_logs ORDER BY patrol_name ASC, step_number ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

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
    db.serialize(() => {
        db.run(`DELETE FROM clue_logs`); // Clear tracking timers on reset
        db.run(`UPDATE patrol_states SET current_step = 0`, [], (err) => {
            if (err) return res.status(500).json({ error: err.message }); res.json({ success: true, message: "Game status reset to step 0. Waiting for activation inputs." });
        });
    });
});

app.post('/api/admin/clear-all', (req, res) => {
    db.serialize(() => {
        db.run(`DELETE FROM clues`);
        db.run(`DELETE FROM patrol_states`);
        db.run(`DELETE FROM clue_logs`);
        res.json({ success: true, message: "Database tables purged completely." });
    });
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('/tracking', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'tracking.html')); });

// --- NEW: BACKUP SYSTEM DATABASE ENGINES ---
// 1. Export all clues as a downloadable JSON array blueprint
app.get('/api/admin/backup-clues', (req, res) => {
    db.all(`SELECT step_number, unlock_code, clue_html, leader_location FROM clues ORDER BY step_number ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        // Sets headers so the browser treats it as an un-cached download file attachment
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename=joey-hunt-clues-backup.json');
        res.send(JSON.stringify(rows, null, 4));
    });
});

// 2. Import an uploaded JSON blueprint back into SQLite
app.post('/api/admin/restore-clues', (req, res) => {
    const importedClues = req.body;
    
    if (!Array.isArray(importedClues)) {
        return res.status(400).json({ success: false, message: "Invalid backup file format structure." });
    }

    db.serialize(() => {
        // Start fresh by clearing out current structural layout clues table blocks
        db.run(`DELETE FROM clues`);

        const stmt = db.prepare(`INSERT INTO clues (step_number, unlock_code, clue_html, leader_location) VALUES (?, ?, ?, ?)`);
        
        importedClues.forEach(c => {
            stmt.run([parseInt(c.step_number), c.unlock_code, c.clue_html, c.leader_location]);
        });
        
        stmt.finalize((err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: `Successfully restored ${importedClues.length} clue checkpoints!` });
        });
    });
});


app.listen(PORT, () => { console.log(`Production platform tracking engine context initialization standard complete on port ${PORT}`); });