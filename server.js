const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const helmet = require("helmet");
const { Pool } = require("pg");
const { randomUUID } = require("crypto");

const { createAuthRoutes, createAuthenticateJwt } = require("./routes/auth");

dotenv.config();

function resolveDatabaseUrl(rawUrl) {
  if (!rawUrl) {
    return rawUrl;
  }

  const fallbackHost = process.env.DATABASE_HOST_FALLBACK;

  try {
    const parsed = new URL(rawUrl);
    if (fallbackHost && parsed.hostname === "host.containers.internal") {
      parsed.hostname = fallbackHost;
      return parsed.toString();
    }
  } catch (_err) {
    return rawUrl;
  }

  return rawUrl;
}

const app = express();
const port = Number(process.env.PORT || 3001);
const pool = new Pool({ connectionString: resolveDatabaseUrl(process.env.DATABASE_URL) });
const authenticateJwt = createAuthenticateJwt();
const validCategories = new Set(["snhu", "auto", "family", "home", "general"]);

const allowedOrigins = (process.env.AUTH_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(helmet());
app.use(express.json());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Origin not allowed by CORS"));
    },
    credentials: true,
  }),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "taskmaster-api" });
});

app.use("/auth", createAuthRoutes(pool));

const apiRouter = express.Router();
apiRouter.use(authenticateJwt);

async function ensureTasksTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'pending',
      category_id TEXT NOT NULL DEFAULT 'general',
      is_completed BOOLEAN NOT NULL DEFAULT FALSE,
      is_focus BOOLEAN NOT NULL DEFAULT FALSE,
      scheduled_date TEXT,
      recurrence_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query("CREATE INDEX IF NOT EXISTS tasks_user_id_created_at_idx ON tasks (user_id, created_at DESC)");
}

async function ensureListsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query("CREATE INDEX IF NOT EXISTS lists_user_id_created_at_idx ON lists (user_id, created_at DESC)");
}

async function ensureRecurringTasksTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recurring_tasks (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      category_id TEXT NOT NULL DEFAULT 'general',
      pattern TEXT NOT NULL DEFAULT 'daily',
      days_of_week JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(
    "CREATE INDEX IF NOT EXISTS recurring_tasks_user_id_created_at_idx ON recurring_tasks (user_id, created_at DESC)"
  );
}

function getAuthenticatedUserId(req) {
  const userId = String(req.user?.id || req.user?.sub || "");

  if (!/^\d+$/.test(userId)) {
    const err = new Error("Invalid authenticated user id");
    err.statusCode = 401;
    throw err;
  }

  return userId;
}

function mapTask(row) {
  return {
    id: row.id,
    userId: String(row.user_id),
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    categoryId: row.category_id,
    isCompleted: row.is_completed,
    isFocus: row.is_focus,
    scheduledDate: row.scheduled_date,
    recurrenceId: row.recurrence_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeListItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }

  const id = item.id == null ? "" : String(item.id);
  const textValue =
    typeof item.text === "string" ? item.text : typeof item.title === "string" ? item.title : "";
  const text = textValue.trim();

  if (!id || !text) {
    return null;
  }

  return {
    id,
    text,
    isCompleted: item.isCompleted === true || item.is_completed === true,
  };
}

function normalizeListItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  const normalizedItems = [];
  const seenItemIds = new Set();

  for (const item of items) {
    const normalizedItem = normalizeListItem(item);

    if (!normalizedItem || seenItemIds.has(normalizedItem.id)) {
      continue;
    }

    seenItemIds.add(normalizedItem.id);
    normalizedItems.push(normalizedItem);
  }

  return normalizedItems;
}

function mapList(row) {
  return {
    id: row.id,
    userId: String(row.user_id),
    name: row.name,
    items: normalizeListItems(row.items),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRecurringTask(row) {
  return {
    id: row.id,
    userId: String(row.user_id),
    title: row.title,
    categoryId: row.category_id,
    pattern: row.pattern,
    daysOfWeek: Array.isArray(row.days_of_week) ? row.days_of_week : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeCategory(value) {
  return validCategories.has(value) ? value : "general";
}

function taskInput(body = {}) {
  const isCompleted =
    typeof body.isCompleted === "boolean" ? body.isCompleted : body.status === "completed";
  const status = typeof body.status === "string" ? body.status : isCompleted ? "completed" : "pending";

  return {
    title: typeof body.title === "string" ? body.title.trim() : "",
    description: typeof body.description === "string" ? body.description : "",
    priority: typeof body.priority === "string" ? body.priority : "medium",
    status,
    categoryId: normalizeCategory(body.categoryId),
    isCompleted,
    isFocus: Boolean(body.isFocus),
    scheduledDate: typeof body.scheduledDate === "string" ? body.scheduledDate : null,
    recurrenceId: typeof body.recurrenceId === "string" ? body.recurrenceId : null,
  };
}

function taskUpdates(body = {}) {
  const fields = [];
  const values = [];

  const add = (column, value) => {
    values.push(value);
    fields.push(`${column} = $${values.length + 2}`);
  };

  if (typeof body.title === "string") add("title", body.title.trim());
  if (typeof body.description === "string") add("description", body.description);
  if (typeof body.priority === "string") add("priority", body.priority);

  if (typeof body.status === "string") {
    add("status", body.status);
    if (typeof body.isCompleted !== "boolean") {
      add("is_completed", body.status === "completed");
    }
  }

  if (typeof body.categoryId === "string") add("category_id", normalizeCategory(body.categoryId));

  if (typeof body.isCompleted === "boolean") {
    add("is_completed", body.isCompleted);
    if (typeof body.status !== "string") {
      add("status", body.isCompleted ? "completed" : "pending");
    }
  }

  if (typeof body.isFocus === "boolean") add("is_focus", body.isFocus);
  if (typeof body.scheduledDate === "string" || body.scheduledDate === null) add("scheduled_date", body.scheduledDate);
  if (typeof body.recurrenceId === "string" || body.recurrenceId === null) add("recurrence_id", body.recurrenceId);

  add("updated_at", new Date());

  return { fields, values };
}

apiRouter.get("/profile", (req, res) => {
  res.json({ user: req.user });
});

apiRouter.get("/lists", async (req, res) => {
  try {
    await ensureListsTable();
    const userId = getAuthenticatedUserId(req);
    const result = await pool.query("SELECT * FROM lists WHERE user_id = $1 ORDER BY created_at DESC", [userId]);

    res.json(result.rows.map(mapList));
  } catch (err) {
    console.error("LISTS LIST ERROR:", err);
    res.status(err.statusCode || 500).json({ error: "Failed to load lists" });
  }
});

apiRouter.post("/lists", async (req, res) => {
  try {
    await ensureListsTable();
    const userId = getAuthenticatedUserId(req);
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";

    if (!name) {
      return res.status(400).json({ error: "Missing list name" });
    }

    const result = await pool.query(
      "INSERT INTO lists (id, user_id, name) VALUES ($1, $2, $3) RETURNING *",
      [randomUUID(), userId, name]
    );

    res.status(201).json(mapList(result.rows[0]));
  } catch (err) {
    console.error("LIST CREATE ERROR:", err);
    res.status(err.statusCode || 500).json({ error: "Failed to create list" });
  }
});

apiRouter.post("/lists/:id/items", async (req, res) => {
  try {
    await ensureListsTable();
    const userId = getAuthenticatedUserId(req);
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";

    if (!text) {
      return res.status(400).json({ error: "Missing list item text" });
    }

    const newItem = {
      id: randomUUID(),
      text,
      isCompleted: false,
    };

    const result = await pool.query(
      `
        UPDATE lists
        SET items = (
              CASE
                WHEN jsonb_typeof(items) = 'array' THEN items
                ELSE '[]'::jsonb
              END
            ) || $3::jsonb,
            updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING *
      `,
      [req.params.id, userId, JSON.stringify([newItem])]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "List not found" });
    }

    res.status(201).json(mapList(result.rows[0]));
  } catch (err) {
    console.error("LIST ITEM CREATE ERROR:", err);
    res.status(err.statusCode || 500).json({ error: "Failed to create list item" });
  }
});

apiRouter.put("/lists/:id/items/:itemId", async (req, res) => {
  try {
    await ensureListsTable();
    const userId = getAuthenticatedUserId(req);
    const patch = {};

    if (typeof req.body?.text === "string") {
      const text = req.body.text.trim();

      if (!text) {
        return res.status(400).json({ error: "Missing list item text" });
      }

      patch.text = text;
    }

    if (typeof req.body?.isCompleted === "boolean") {
      patch.isCompleted = req.body.isCompleted;
    }

    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: "No list item fields to update" });
    }

    const result = await pool.query(
      `
        UPDATE lists
        SET items = COALESCE(
              (
                WITH current_items AS (
                  SELECT item.value, item.ordinality
                  FROM jsonb_array_elements(
                    CASE
                      WHEN jsonb_typeof(items) = 'array' THEN items
                      ELSE '[]'::jsonb
                    END
                  ) WITH ORDINALITY AS item(value, ordinality)
                ),
                target AS (
                  SELECT ordinality
                  FROM current_items
                  WHERE value->>'id' = $3
                  ORDER BY ordinality
                  LIMIT 1
                )
                SELECT jsonb_agg(
                  CASE
                    WHEN current_items.ordinality = target.ordinality THEN current_items.value || $4::jsonb
                    ELSE current_items.value
                  END
                  ORDER BY current_items.ordinality
                )
                FROM current_items
                CROSS JOIN target
              ),
              '[]'::jsonb
            ),
            updated_at = NOW()
        WHERE id = $1
          AND user_id = $2
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(items) = 'array' THEN items
                ELSE '[]'::jsonb
              END
            ) AS item(value)
            WHERE item.value->>'id' = $3
          )
        RETURNING *
      `,
      [req.params.id, userId, req.params.itemId, JSON.stringify(patch)]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "List item not found" });
    }

    res.json(mapList(result.rows[0]));
  } catch (err) {
    console.error("LIST ITEM UPDATE ERROR:", err);
    res.status(err.statusCode || 500).json({ error: "Failed to update list item" });
  }
});

apiRouter.delete("/lists/:id/items/:itemId", async (req, res) => {
  try {
    await ensureListsTable();
    const userId = getAuthenticatedUserId(req);
    const result = await pool.query(
      `
        UPDATE lists
        SET items = COALESCE(
              (
                WITH current_items AS (
                  SELECT item.value, item.ordinality
                  FROM jsonb_array_elements(
                    CASE
                      WHEN jsonb_typeof(items) = 'array' THEN items
                      ELSE '[]'::jsonb
                    END
                  ) WITH ORDINALITY AS item(value, ordinality)
                ),
                target AS (
                  SELECT ordinality
                  FROM current_items
                  WHERE value->>'id' = $3
                  ORDER BY ordinality
                  LIMIT 1
                )
                SELECT jsonb_agg(current_items.value ORDER BY current_items.ordinality)
                FROM current_items
                CROSS JOIN target
                WHERE current_items.ordinality <> target.ordinality
              ),
              '[]'::jsonb
            ),
            updated_at = NOW()
        WHERE id = $1
          AND user_id = $2
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(items) = 'array' THEN items
                ELSE '[]'::jsonb
              END
            ) AS item(value)
            WHERE item.value->>'id' = $3
          )
        RETURNING *
      `,
      [req.params.id, userId, req.params.itemId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "List item not found" });
    }

    res.json(mapList(result.rows[0]));
  } catch (err) {
    console.error("LIST ITEM DELETE ERROR:", err);
    res.status(err.statusCode || 500).json({ error: "Failed to delete list item" });
  }
});

apiRouter.delete("/lists/:id", async (req, res) => {
  try {
    await ensureListsTable();
    const userId = getAuthenticatedUserId(req);
    const result = await pool.query("DELETE FROM lists WHERE id = $1 AND user_id = $2 RETURNING id", [
      req.params.id,
      userId,
    ]);

    if (!result.rowCount) {
      return res.status(404).json({ error: "List not found" });
    }

    res.status(204).send();
  } catch (err) {
    console.error("LIST DELETE ERROR:", err);
    res.status(err.statusCode || 500).json({ error: "Failed to delete list" });
  }
});

apiRouter.get("/recurring-tasks", async (req, res) => {
  try {
    await ensureRecurringTasksTable();
    const userId = getAuthenticatedUserId(req);
    const result = await pool.query(
      "SELECT * FROM recurring_tasks WHERE user_id = $1 ORDER BY created_at DESC",
      [userId]
    );

    res.json(result.rows.map(mapRecurringTask));
  } catch (err) {
    console.error("RECURRING TASKS LIST ERROR:", err);
    res.status(err.statusCode || 500).json({ error: "Failed to load recurring tasks" });
  }
});

apiRouter.post("/recurring-tasks", async (req, res) => {
  try {
    await ensureRecurringTasksTable();
    const userId = getAuthenticatedUserId(req);
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const categoryId = normalizeCategory(req.body?.categoryId);
    const pattern = typeof req.body?.pattern === "string" ? req.body.pattern : "daily";
    const daysOfWeek = Array.isArray(req.body?.daysOfWeek) ? req.body.daysOfWeek : [];

    if (!title) {
      return res.status(400).json({ error: "Missing recurring task title" });
    }

    const result = await pool.query(
      `
        INSERT INTO recurring_tasks (id, user_id, title, category_id, pattern, days_of_week)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        RETURNING *
      `,
      [randomUUID(), userId, title, categoryId, pattern, JSON.stringify(daysOfWeek)]
    );

    res.status(201).json(mapRecurringTask(result.rows[0]));
  } catch (err) {
    console.error("RECURRING TASK CREATE ERROR:", err);
    res.status(err.statusCode || 500).json({ error: "Failed to create recurring task" });
  }
});

apiRouter.put("/recurring-tasks/:id", async (req, res) => {
  try {
    await ensureRecurringTasksTable();
    const userId = getAuthenticatedUserId(req);
    const fields = [];
    const values = [];

    const add = (column, value, cast = "") => {
      values.push(value);
      fields.push(`${column} = $${values.length + 2}${cast}`);
    };

    if (typeof req.body?.title === "string") add("title", req.body.title.trim());
    if (typeof req.body?.categoryId === "string") add("category_id", normalizeCategory(req.body.categoryId));
    if (typeof req.body?.pattern === "string") add("pattern", req.body.pattern);
    if (Array.isArray(req.body?.daysOfWeek)) add("days_of_week", JSON.stringify(req.body.daysOfWeek), "::jsonb");
    add("updated_at", new Date());

    const result = await pool.query(
      `
        UPDATE recurring_tasks
        SET ${fields.join(", ")}
        WHERE id = $1 AND user_id = $2
        RETURNING *
      `,
      [req.params.id, userId, ...values]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Recurring task not found" });
    }

    res.json(mapRecurringTask(result.rows[0]));
  } catch (err) {
    console.error("RECURRING TASK UPDATE ERROR:", err);
    res.status(err.statusCode || 500).json({ error: "Failed to update recurring task" });
  }
});

apiRouter.delete("/recurring-tasks/:id", async (req, res) => {
  try {
    await ensureRecurringTasksTable();
    const userId = getAuthenticatedUserId(req);
    const result = await pool.query("DELETE FROM recurring_tasks WHERE id = $1 AND user_id = $2 RETURNING id", [
      req.params.id,
      userId,
    ]);

    if (!result.rowCount) {
      return res.status(404).json({ error: "Recurring task not found" });
    }

    res.status(204).send();
  } catch (err) {
    console.error("RECURRING TASK DELETE ERROR:", err);
    res.status(err.statusCode || 500).json({ error: "Failed to delete recurring task" });
  }
});

apiRouter.get("/tasks", async (req, res) => {
  try {
    await ensureTasksTable();
    const userId = getAuthenticatedUserId(req);
    const result = await pool.query("SELECT * FROM tasks WHERE user_id = $1 ORDER BY created_at DESC", [userId]);

    res.json(result.rows.map(mapTask));
  } catch (err) {
    console.error("TASKS LIST ERROR:", err);
    res.status(err.statusCode || 500).json({ error: "Failed to load tasks" });
  }
});

apiRouter.post("/tasks", async (req, res) => {
  try {
    await ensureTasksTable();
    const userId = getAuthenticatedUserId(req);
    const task = taskInput(req.body);

    if (!task.title) {
      return res.status(400).json({ error: "Missing task title" });
    }

    const result = await pool.query(
      `
        INSERT INTO tasks (
          id, user_id, title, description, priority, status, category_id,
          is_completed, is_focus, scheduled_date, recurrence_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
      `,
      [
        randomUUID(),
        userId,
        task.title,
        task.description,
        task.priority,
        task.status,
        task.categoryId,
        task.isCompleted,
        task.isFocus,
        task.scheduledDate,
        task.recurrenceId,
      ]
    );

    res.status(201).json(mapTask(result.rows[0]));
  } catch (err) {
    console.error("TASK CREATE ERROR:", err);
    res.status(err.statusCode || 500).json({ error: "Failed to create task" });
  }
});

apiRouter.put("/tasks/:id", async (req, res) => {
  try {
    await ensureTasksTable();
    const userId = getAuthenticatedUserId(req);
    const { fields, values } = taskUpdates(req.body);

    if (!fields.length) {
      return res.status(400).json({ error: "No task fields to update" });
    }

    const result = await pool.query(
      `
        UPDATE tasks
        SET ${fields.join(", ")}
        WHERE id = $1 AND user_id = $2
        RETURNING *
      `,
      [req.params.id, userId, ...values]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Task not found" });
    }

    res.json(mapTask(result.rows[0]));
  } catch (err) {
    console.error("TASK UPDATE ERROR:", err);
    res.status(err.statusCode || 500).json({ error: "Failed to update task" });
  }
});

apiRouter.delete("/tasks/:id", async (req, res) => {
  try {
    await ensureTasksTable();
    const userId = getAuthenticatedUserId(req);
    const result = await pool.query("DELETE FROM tasks WHERE id = $1 AND user_id = $2 RETURNING id", [
      req.params.id,
      userId,
    ]);

    if (!result.rowCount) {
      return res.status(404).json({ error: "Task not found" });
    }

    res.status(204).send();
  } catch (err) {
    console.error("TASK DELETE ERROR:", err);
    res.status(err.statusCode || 500).json({ error: "Failed to delete task" });
  }
});

app.use("/api", apiRouter);

app.listen(port, "0.0.0.0", () => {
  console.log(`taskmaster-api listening on ${port}`);
});
