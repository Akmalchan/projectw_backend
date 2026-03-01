// index.js
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const path = require("path");
const fs = require("fs");

const multer = require("multer");
const crypto = require("crypto");
const sharp = require("sharp");
const imghash = require("imghash");

const app = express();
app.use(cors());
app.use(express.json());

// If you're behind a proxy (Railway), this helps req.protocol/host behave better
app.set("trust proxy", 1);

// Postgres connection (Railway provides DATABASE_URL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// Persistent uploads folder (Railway Volume recommended at /data)
const UPLOAD_ROOT =
    process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.UPLOAD_ROOT || __dirname;
const UPLOAD_DIR =
    process.env.UPLOAD_DIR || path.join(UPLOAD_ROOT, "uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Serve images at /uploads/<filename>
app.use("/uploads", express.static(UPLOAD_DIR));

app.get("/health", (req, res) => res.json({ ok: true }));

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

// Multer: store upload in memory, we write ourselves
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
});

function hexToBigInt(hex) {
    // guard: empty/invalid -> 0
    try {
        return BigInt("0x" + hex);
    } catch {
        return 0n;
    }
}

// Hamming distance between two same-length hex hashes
function hammingDistanceHex(a, b) {
    if (!a || !b) return Number.MAX_SAFE_INTEGER;
    if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
    let x = hexToBigInt(a) ^ hexToBigInt(b);
    let dist = 0;
    while (x) {
        dist += Number(x & 1n);
        x >>= 1n;
    }
    return dist;
}

function getBaseUrl(req) {
    // Strongly recommended: set PUBLIC_BASE_URL in Railway variables
    if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
    const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").toString();
    const host = (req.headers["x-forwarded-host"] || req.get("host")).toString();
    return `${proto}://${host}`;
}

// POST /wardrobe/ingest (multipart)
// fields: userId (required), category (optional), label (optional), photo (file, field name "photo")
app.post("/wardrobe/ingest", upload.single("photo"), async (req, res) => {
    const userId = String(req.body.userId || "").trim();
    const category = String(req.body.category || "top").trim();
    const label = String(req.body.label || "Uploaded item").trim();

    if (!userId) return res.status(400).json({ ok: false, error: "Missing userId" });
    if (!req.file) return res.status(400).json({ ok: false, error: "Missing photo file (field name: photo)" });

    const allowed = new Set(["outerwear", "top", "bottom", "shoes", "accessory"]);
    const safeCategory = allowed.has(category) ? category : "top";

    try {
        // Ensure user exists
        await pool.query(
            "INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
            [userId]
        );

        // Normalize to JPEG (size capped)
        const normalizedJpeg = await sharp(req.file.buffer)
            .rotate()
            .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 82, mozjpeg: true })
            .toBuffer();

        // pHash in HEX (consistent lowercase)
        const phash = (await imghash.hash(normalizedJpeg, 16, "hex")).toLowerCase();

        // Fetch recent hashes for same user/category
        const existing = await pool.query(
            `SELECT id, image_url, phash, created_at
             FROM wardrobe_items
             WHERE user_id = $1 AND category = $2 AND phash IS NOT NULL
             ORDER BY created_at DESC
                 LIMIT 80`,
            [userId, safeCategory]
        );

        // Dedup threshold (tweak if needed)
        const THRESH = Number(process.env.DEDUP_THRESH || 7);

        let best = { id: null, dist: Number.MAX_SAFE_INTEGER, image_url: null };

        for (const row of existing.rows) {
            const rowHash = String(row.phash || "").toLowerCase();
            if (rowHash.length !== phash.length) continue; // ignore old-format hashes
            const dist = hammingDistanceHex(phash, rowHash);
            if (dist < best.dist) best = { id: row.id, dist, image_url: row.image_url };
        }

        if (best.id && best.dist <= THRESH) {
            return res.json({
                ok: true,
                deduped: true,
                matchedItemId: best.id,
                matchedImageUrl: best.image_url,
                phash,
                distance: best.dist,
                threshold: THRESH,
            });
        }

        // Save file
        const uuid =
            typeof crypto.randomUUID === "function"
                ? crypto.randomUUID()
                : crypto.randomBytes(16).toString("hex");

        const fileName = `${uuid}.jpg`;
        const filePath = path.join(UPLOAD_DIR, fileName);

        await fs.promises.writeFile(filePath, normalizedJpeg);

        const imageUrl = `${getBaseUrl(req)}/uploads/${fileName}`;

        // Insert item
        const inserted = await pool.query(
            `INSERT INTO wardrobe_items (user_id, category, label, image_url, phash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, category, label, image_url, phash, created_at`,
            [userId, safeCategory, label, imageUrl, phash]
        );

        res.json({ ok: true, deduped: false, item: inserted.rows[0] });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
    }
});

app.get("/test-upload", (req, res) => {
    res.type("html").send(`
    <h2>Test /wardrobe/ingest</h2>
    <form action="/wardrobe/ingest" method="post" enctype="multipart/form-data">
      <label>User ID:</label><br/>
      <input name="userId" value="test_user_1" /><br/><br/>

      <label>Category:</label><br/>
      <input name="category" value="top" /><br/><br/>

      <label>Label:</label><br/>
      <input name="label" value="Test Shirt" /><br/><br/>

      <label>Photo:</label><br/>
      <input type="file" name="photo" accept="image/*" /><br/><br/>

      <button type="submit">Upload</button>
    </form>
  `);
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`API listening on ${port}`));