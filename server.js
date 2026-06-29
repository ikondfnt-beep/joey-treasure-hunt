const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize SQLite database file
const db = new sqlite3.Database(path.join(__dirname, 'data', 'hunt.db'), (err) => {
    if (err) console.error('Database opening error:', err);
    console.log('Connected to SQLite database.');
});

// Create tables for Clues and Patrol Progress
db.serialize(() => {
    // Clues table ordered by step_number
    db.run(`CREATE TABLE IF NOT EXISTS clues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        step_number INTEGER UNIQUE,
        unlock_code TEXT,
        clue_html TEXT
    )`);

    // Patrol states table
    db.run(`CREATE TABLE IF NOT EXISTS patrol_states (
        patrol_name TEXT PRIMARY KEY,
        current_step INTEGER DEFAULT 0
    )`);

    // Insert standard patrols if they don't exist
    const defaultPatrols = ['Bilby', 'Wombat', 'Possum', 'Kookaburra'];
    defaultPatrols.forEach(patrol => {
        db.run(`INSERT OR IGNORE INTO patrol_states (patrol_name, current_step) VALUES (?, 0)`, [patrol]);
    });
});

// STARTING CLUE CONSTANT (When a team is on step 0)
const startClueText = "Welcome Joeys! Find your first code hidden near the main hall doors to get your first real clue.";

// API: Get current clue for a patrol
app.get('/api/clue/:patrol', (req, res) => {
    const patrol = req.params.patrol;

    db.get(`SELECT current_step FROM patrol_states WHERE patrol_name = ?`, [patrol], (err, row) => {
        if (err || !row) return res.status(400).json({ error: "Invalid patrol" });
        const currentStep = row.current_step;

        if (currentStep === 0) {
            return res.json({ clue: startClueText, isFinished: false });
        }

        // Fetch the clue unlocked by their last successful code entry
        db.get(`SELECT clue_html FROM clues WHERE step_number = ?`, [currentStep], (err, clueRow) => {
            if (err) return res.status(500).json({ error: "Database error" });
            
            // Check if there are any higher steps remaining
            db.get(`SELECT MAX(step_number) as max_step FROM clues`, [], (err, maxRow) => {
                const isFinished = currentStep > (maxRow.max_step || 0);
                const textToShow = clueRow ? clueRow.clue_html : "CONGRATULATIONS! You have completed the treasure hunt! Return to leadership for your reward.";
                res.json({ clue: textToShow, isFinished });
            });
        });
    });
});

// API: Submit a code for a patrol
app.post('/api/submit-code', (req, res) => {
    const { patrol, code } = req.body;

    db.get(`SELECT current_step FROM patrol_states WHERE patrol_name = ?`, [patrol], (err, row) => {
        if (err || !row) return res.status(400).json({ error: "Invalid patrol" });
        const currentStep = row.current_step;

        // The next code they need to find is assigned to step_number = currentStep + 1
        const targetStep = currentStep + 1;

        db.get(`SELECT unlock_code, clue_html FROM clues WHERE step_number = ?`, [targetStep], (err, nextClueRow) => {
            if (err) return res.status(500).json({ error: "Database error" });

            if (!nextClueRow) {
                return res.json({ success: true, correct: false, message: "No more challenges found! You might be at the end." });
            }

            if (code === nextClueRow.unlock_code) {
                // Advance the patrol step forward by 1
                db.run(`UPDATE patrol_states SET current_step = ? WHERE patrol_name = ?`, [targetStep, patrol], (err) => {
                    db.get(`SELECT MAX(step_number) as max_step FROM clues`, [], (err, maxRow) => {
                        const isFinished = targetStep >= maxRow.max_step;
                        res.json({ success: true, correct: true, nextClue: nextClueRow.clue_html, isFinished });
                    });
                });
            } else {
                res.json({ success: true, correct: false, message: "Incorrect code, try again!" });
            }
        });
    });
});

// --- ADMIN API ENDPOINTS (For Adding Tasks) ---

// Get all tasks (for admin panel)
app.get('/api/admin/clues', (req, res) => {
    db.all(`SELECT * FROM clues ORDER BY step_number ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Add or update a task
app.post('/api/admin/clues', (req, res) => {
    const { step_number, unlock_code, clue_html } = req.body;
    db.run(`INSERT OR REPLACE INTO clues (step_number, unlock_code, clue_html) VALUES (?, ?, ?)`,
        [parseInt(step_number), unlock_code, clue_html],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        }
    );
});

// Reset all patrol progress back to 0 for a new game
app.post('/api/admin/reset-patrols', (req, res) => {
    db.run(`UPDATE patrol_states SET current_step = 0`, [], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: "All patrol progress reset to 0!" });
    });
});

app.listen(PORT, () => {
    console.log(`Database-backed treasure hunt server running on port ${PORT}`);
});