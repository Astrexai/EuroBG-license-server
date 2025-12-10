import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json());

let licenseDB = {}; // временно – после ще сложим база

app.post("/generate", (req, res) => {
    const { count } = req.body;
    let keys = [];

    for (let i = 0; i < count; i++) {
        const key = crypto.randomBytes(16).toString("hex");
        licenseDB[key] = { active: false };
        keys.push(key);
    }

    res.json({ keys });
});

app.post("/activate", (req, res) => {
    const { key } = req.body;

    if (!licenseDB[key]) {
        return res.status(400).json({ error: "Invalid key" });
    }

    licenseDB[key].active = true;
    res.json({ success: true });
});

app.listen(3000, () => console.log("License server running on :3000"));
