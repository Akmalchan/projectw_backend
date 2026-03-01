const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

app.get("/health", (req, res) => {
    res.json({ ok: true });
});

app.get("/db-check", async (req, res) => {
    try {
        const r = await pool.query("SELECT NOW() as now");
        res.json({ ok: true, now: r.rows[0].now });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
    }
});

// List wardrobe items for a user
app.get("/wardrobe/list", async (req, res) => {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "Missing userId" });

    try {
        // Ensure user exists (hackathon-simple)
        await pool.query(
            "INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
            [userId]
        );

        const r = await pool.query(
            `SELECT id, user_id, category, label, image_url, phash, created_at
             FROM wardrobe_items
             WHERE user_id = $1
             ORDER BY created_at DESC`,
            [userId]
        );

        res.json({ ok: true, items: r.rows });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
    }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`API listening on ${port}`));