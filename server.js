const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. Define your hunt progression here (Code unlocks the NEXT clue)
const huntConfig = {
    startClue: "Welcome Joeys! Find your first code hidden near the main hall doors to get your first real clue.",
    stages: [
        { code: "1234", clue: "Great job! Your next clue is hidden under the big water tank outside.", type: "text" },
        { code: "5678", clue: "You found it! Watch this video for your next challenge: <br><br><video width='320' controls><source src='clue3.mp4' type='video/mp4'>Your browser does not support the video tag.</video>", type: "video" },
        { code: "9999", clue: "CONGRATULATIONS! You have completed the treasure hunt! Return to leadership for your reward.", type: "text" }
    ]
};

// 2. Track the current stage index (0, 1, 2...) for each Patrol
const patrolStates = {
    "Bilby": 0,
    "Wombat": 0,
    "Possum": 0,
    "Kookaburra": 0
};

// API: Get current clue for a patrol
app.get('/api/clue/:patrol', (req, res) => {
    const patrol = req.params.patrol;
    if (!patrolStates.hasOwnProperty(patrol)) {
        return res.status(400).json({ error: "Invalid patrol" });
    }
    
    const currentStageIndex = patrolStates[patrol];
    
    if (currentStageIndex === 0) {
        res.json({ clue: huntConfig.startClue, isFinished: false });
    } else {
        res.json({ clue: huntConfig.stages[currentStageIndex - 1].clue, isFinished: currentStageIndex > huntConfig.stages.length });
    }
});

// API: Submit a code for a patrol
app.post('/api/submit-code', (req, res) => {
    const { patrol, code } = req.body;
    const currentIndex = patrolStates[patrol];

    // Check if they are already finished
    if (currentIndex >= huntConfig.stages.length) {
        return res.json({ success: true, message: "Already finished!" });
    }

    // Verify if the entered code matches the expected code for their CURRENT stage
    const expectedStage = huntConfig.stages[currentIndex];
    
    if (code === expectedStage.code) {
        patrolStates[patrol] += 1; // Advance them to the next stage
        const nextClue = expectedStage.clue;
        const isFinished = patrolStates[patrol] >= huntConfig.stages.length;
        return res.json({ success: true, correct: true, nextClue, isFinished });
    } else {
        return res.json({ success: true, correct: false, message: "Incorrect code, try again!" });
    }
});

app.listen(PORT, () => {
    console.log(`Treasure hunt server running on port ${PORT}`);
});