const express = require("express");
const bcrypt = require("bcryptjs");
const {
  authenticateJwt,
  extractBearerToken,
  issueAccessToken,
  resolveAuthConfig,
  verifyAccessToken,
} = require("../../libs/auth/server.cjs");

async function ensureUsersTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function createAuthRoutes(pool) {
  const router = express.Router();
  const jwtConfig = resolveAuthConfig();

  router.post("/register", async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Missing email or password" });
    }

    try {
      await ensureUsersTable(pool);
      const hash = await bcrypt.hash(password, 10);

      const result = await pool.query(
        "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email",
        [email.trim().toLowerCase(), hash]
      );

      const user = result.rows[0];
      const token = issueAccessToken(user, jwtConfig);

      res.json({ token, user });
    } catch (err) {
      console.error("REGISTER ERROR:", err);
      if (err.code === "23505") {
        return res.status(409).json({ error: "User already exists" });
      }
      res.status(500).json({ error: "Registration failed" });
    }
  });

  router.post("/login", async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Missing email or password" });
    }

    try {
      await ensureUsersTable(pool);
      const result = await pool.query("SELECT * FROM users WHERE email=$1", [email.trim().toLowerCase()]);

      const user = result.rows[0];
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const token = issueAccessToken(user, jwtConfig);

      res.json({ token, user: { id: user.id, email: user.email } });
    } catch (err) {
      console.error("LOGIN ERROR:", err);
      res.status(500).json({ error: "Login failed" });
    }
  });

  router.get("/me", (req, res) => {
    const token = extractBearerToken(req.headers);
    if (!token) {
      return res.status(401).json({ error: "No token" });
    }

    try {
      const decoded = verifyAccessToken(token, jwtConfig);
      return res.json({ user: decoded });
    } catch (_err) {
      return res.status(401).json({ error: "Invalid token" });
    }
  });

  return router;
}

function createAuthenticateJwt() {
  return authenticateJwt(resolveAuthConfig());
}

module.exports = { createAuthRoutes, createAuthenticateJwt };
