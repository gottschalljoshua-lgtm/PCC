// =======================
// Imports (MUST be first)
// =======================
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

// =======================
// Environment
// =======================
dotenv.config();

// =======================
// App setup
// =======================
const app = express();
app.disable("x-powered-by");
app.use(cors());
app.use(express.json());
// --- API Key Auth (protect endpoints) ---
const requireApiKey = (req, res, next) => {
  const provided = req.header("x-api-key");
  const expected = process.env.MCP_API_KEY;

  if (!expected) {
    return res.status(500).json({ error: "Server missing MCP_API_KEY" });
  }

  if (!provided || provided !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
};

const PORT = process.env.PORT || 3333;

// =======================
// Health check
// =======================
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "GHL MCP Server" });
});
app.get("/ready", (req, res) => {
  if (!process.env.MCP_API_KEY) {
    return res.status(503).json({ status: "not_ready", missing: ["MCP_API_KEY"] });
  }

  // Mock mode = system is allowed to run without live CRM
  if (process.env.MOCK_GHL === "true") {
    return res.json({ status: "ready", mode: "mock" });
  }

  // Live mode requires a real GHL key
  if (!process.env.GHL_API_KEY) {
    return res.status(503).json({ status: "not_ready", missing: ["GHL_API_KEY"] });
  }

  return res.json({ status: "ready", mode: "live" });
});


// =======================
// Root check (optional)
// =======================
app.get("/", (req, res) => {
  res.send("GHL MCP Server is running");
});

// =======================
// MCP Tool: crm_read
// =======================
app.use("/tools", requireApiKey);
// =======================
// Tool Endpoints (separate per function) — MOCK FIRST
// =======================

// Helper to return MCP JSON wrapper
const mcpJson = (res, json) => res.json({ content: [{ type: "json", json }] });

// MOCK helper
const isMock = () => process.env.MOCK_GHL === "true";

// -----------------------
// CONTACTS
// -----------------------

// Create/Update contact immediately
app.post("/tools/contacts_upsert", async (req, res) => {
  const { firstName, lastName, phone, email, tags = [] } = req.body || {};

  if (!phone && !email) return res.status(400).json({ error: "phone or email required" });
  if (!firstName || !lastName) return res.status(400).json({ error: "firstName and lastName required" });

  if (isMock()) {
    return mcpJson(res, {
      created: true,
      matchedBy: phone ? "phone" : "email",
      contactId: "mock_contact_" + Math.random().toString(36).slice(2, 10),
      tags,
    });
  }

  return res.status(501).json({ error: "Live OAuth not implemented yet" });
});

// Search contacts
app.post("/tools/contacts_search", async (req, res) => {
  const { query, limit = 5 } = req.body || {};
  if (!query) return res.status(400).json({ error: "query required" });

  if (isMock()) {
    return mcpJson(res, {
      results: [
        {
          contactId: "mock_contact_abc123",
          name: "John Smith",
          phone: "+1561***1212",
          email: "jo***@email.com",
          stage: "App Set",
          tags: ["Warm"],
        },
      ].slice(0, Math.min(limit, 10)),
    });
  }

  return res.status(501).json({ error: "Live OAuth not implemented yet" });
});

// Update tags/stage only
app.post("/tools/contacts_update_status", async (req, res) => {
  const { contactId, addTags = [], removeTags = [], stageId } = req.body || {};
  if (!contactId) return res.status(400).json({ error: "contactId required" });

  const hasUpdate = addTags.length || removeTags.length || !!stageId;
  if (!hasUpdate) return res.status(400).json({ error: "provide addTags/removeTags/stageId" });

  if (isMock()) {
    return mcpJson(res, {
      contactId,
      updated: { addTags, removeTags, stageId: stageId || null },
    });
  }

  return res.status(501).json({ error: "Live OAuth not implemented yet" });
});

// -----------------------
// CALENDAR (RCDM)
// -----------------------

// List appointments
app.post("/tools/calendar_list_appointments", async (req, res) => {
  const { calendarId, startDateTime, endDateTime, limit = 25 } = req.body || {};
  if (!calendarId || !startDateTime || !endDateTime) {
    return res.status(400).json({ error: "calendarId, startDateTime, endDateTime required" });
  }

  if (isMock()) {
    return mcpJson(res, {
      calendarId,
      appointments: [
        {
          appointmentId: "mock_apt_1",
          start: startDateTime,
          end: endDateTime,
          title: "Intro Call",
          contactId: "mock_contact_abc123",
          status: "confirmed",
        },
      ].slice(0, Math.min(limit, 50)),
    });
  }

  return res.status(501).json({ error: "Live OAuth not implemented yet" });
});

// Create appointment
app.post("/tools/calendar_create_appointment", async (req, res) => {
  const { calendarId, contactId, title, startDateTime, endDateTime } = req.body || {};
  if (!calendarId || !contactId || !title || !startDateTime || !endDateTime) {
    return res.status(400).json({ error: "calendarId, contactId, title, startDateTime, endDateTime required" });
  }

  if (isMock()) {
    return mcpJson(res, {
      appointmentId: "mock_apt_" + Math.random().toString(36).slice(2, 8),
      status: "confirmed",
    });
  }

  return res.status(501).json({ error: "Live OAuth not implemented yet" });
});

// Reschedule appointment
app.post("/tools/calendar_reschedule_appointment", async (req, res) => {
  const { appointmentId, newStartDateTime, newEndDateTime } = req.body || {};
  if (!appointmentId || !newStartDateTime || !newEndDateTime) {
    return res.status(400).json({ error: "appointmentId, newStartDateTime, newEndDateTime required" });
  }

  if (isMock()) {
    return mcpJson(res, { appointmentId, status: "rescheduled" });
  }

  return res.status(501).json({ error: "Live OAuth not implemented yet" });
});

// Cancel appointment
app.post("/tools/calendar_cancel_appointment", async (req, res) => {
  const { appointmentId, reasonCode } = req.body || {};
  if (!appointmentId) return res.status(400).json({ error: "appointmentId required" });

  if (isMock()) {
    return mcpJson(res, { appointmentId, status: "cancelled", reasonCode: reasonCode || null });
  }

  return res.status(501).json({ error: "Live OAuth not implemented yet" });
});


app.post("/tools/crm_read", async (req, res) => {
  try {
    const { endpoint } = req.body;

    if (!endpoint) {
      return res.status(400).json({ error: "Missing endpoint" });
    }
if (process.env.MOCK_GHL === "true") {
  return res.json({
    content: [{ type: "json", json: { mocked: true, endpoint, data: [] } }],
  });
}

    const ghlRes = await fetch(
      `https://rest.gohighlevel.com/v1${endpoint}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GHL_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await ghlRes.json();

    res.json({
      content: [{ type: "json", json: data }],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});
// -----------------------
// TASKS
// -----------------------

// List tasks (overdue/today/next7)
app.post("/tools/tasks_list", async (req, res) => {
  const { dueWindow = "today", limit = 25 } = req.body || {};
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 50);

  const allowed = new Set(["overdue", "today", "next7"]);
  if (!allowed.has(dueWindow)) {
    return res.status(400).json({ error: "dueWindow must be overdue|today|next7" });
  }

  if (isMock()) {
    return mcpJson(res, {
      dueWindow,
      tasks: [
        {
          taskId: "mock_task_1",
          title: "Call John Smith",
          dueDateTime: "2026-01-12T10:00:00-05:00",
          contactId: "mock_contact_abc123",
          priority: "high"
        },
        {
          taskId: "mock_task_2",
          title: "Review pipeline report",
          dueDateTime: "2026-01-12T16:00:00-05:00",
          contactId: null,
          priority: "normal"
        }
      ].slice(0, safeLimit)
    });
  }

  return res.status(501).json({ error: "Live OAuth not implemented yet" });
});

// Create a task
app.post("/tools/tasks_create", async (req, res) => {
  const { title, dueDateTime, contactId = null, priority = "normal" } = req.body || {};
  if (!title || !dueDateTime) {
    return res.status(400).json({ error: "title and dueDateTime required" });
  }

  if (isMock()) {
    return mcpJson(res, {
      taskId: "mock_task_" + Math.random().toString(36).slice(2, 8),
      created: true,
      title,
      dueDateTime,
      contactId,
      priority
    });
  }

  return res.status(501).json({ error: "Live OAuth not implemented yet" });
});

// Complete a task
app.post("/tools/tasks_complete", async (req, res) => {
  const { taskId } = req.body || {};
  if (!taskId) return res.status(400).json({ error: "taskId required" });

  if (isMock()) {
    return mcpJson(res, { taskId, status: "completed" });
  }

  return res.status(501).json({ error: "Live OAuth not implemented yet" });
});


// -----------------------
// PIPELINE SNAPSHOT (EXEC DASHBOARD)
// -----------------------
app.post("/tools/pipeline_snapshot", async (req, res) => {
  const { pipelineType = "recruit" } = req.body || {};
  const allowed = new Set(["recruit", "client"]);
  if (!allowed.has(pipelineType)) {
    return res.status(400).json({ error: "pipelineType must be recruit|client" });
  }

  if (isMock()) {
    return mcpJson(res, {
      pipelineType,
      stageCounts: pipelineType === "recruit"
        ? [
            { stage: "New Lead", count: 12 },
            { stage: "Intro Set", count: 5 },
            { stage: "No Show", count: 2 },
            { stage: "App Submitted", count: 3 }
          ]
        : [
            { stage: "Inbound", count: 8 },
            { stage: "Quoted", count: 4 },
            { stage: "Policy In Force", count: 6 }
          ]
    });
  }

  return res.status(501).json({ error: "Live OAuth not implemented yet" });
});
// -----------------------
// CONVERSATIONS (Outlook inside GHL)
// -----------------------
// ACTION — Messaging (send into an existing thread)
app.post("/tools/conversations_send_message", async (req, res) => {
  try {
    const { threadId, message, channel } = req.body || {};
    if (!threadId || !message) {
      return res.status(400).json({ ok: false, error: "threadId and message are required" });
    }

    // MOCK behavior
    if (isMock()) {
      return res.json({
        ok: true,
        mode: "mock",
        threadId,
        channel: channel || "sms",
        messageId: `msg_mock_${Date.now()}`,
        status: "sent"
      });
    }

    // LIVE placeholder (to wire after OAuth)
    return res.status(501).json({ ok: false, error: "Live conversations_send_message not implemented yet" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ACTION — Workflows (trigger a workflow by ID)
app.post("/tools/workflow_trigger", async (req, res) => {
  try {
    const { workflowId, contactId, payload } = req.body || {};
    if (!workflowId) {
      return res.status(400).json({ ok: false, error: "workflowId is required" });
    }

    // MOCK behavior
    if (isMock()) {
      return res.json({
        ok: true,
        mode: "mock",
        workflowId,
        contactId: contactId || null,
        triggered: true,
        payload: payload || null
      });
    }

    // LIVE placeholder (to wire after OAuth)
    return res.status(501).json({ ok: false, error: "Live workflow_trigger not implemented yet" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// List threads (unread emails, recent activity)
app.post("/tools/conversations_list_threads", async (req, res) => {
  const {
    channel = "email",        // "email" | "sms" (keep tight)
    unreadOnly = true,
    limit = 20
  } = req.body || {};

  const allowedChannels = new Set(["email", "sms"]);
  if (!allowedChannels.has(channel)) {
    return res.status(400).json({ error: "channel must be email|sms" });
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);

  if (isMock()) {
    return mcpJson(res, {
      channel,
      unreadOnly,
      threads: [
        {
          threadId: "mock_thread_1",
          contactId: "mock_contact_abc123",
          lastMessageAt: "2026-01-12T09:12:00-05:00",
          unreadCount: unreadOnly ? 1 : 0,
          snippet: "Can we move tomorrow’s call to 4pm?"
        },
        {
          threadId: "mock_thread_2",
          contactId: "mock_contact_def456",
          lastMessageAt: "2026-01-12T08:41:00-05:00",
          unreadCount: unreadOnly ? 1 : 0,
          snippet: "Thanks Bill — what’s the next step?"
        }
      ].slice(0, safeLimit)
    });
  }

  return res.status(501).json({ error: "Live OAuth not implemented yet" });
});

// Get a specific thread (for summarization)
app.post("/tools/conversations_get_thread", async (req, res) => {
  const { threadId, limitMessages = 10 } = req.body || {};
  if (!threadId) return res.status(400).json({ error: "threadId required" });

  const safeLimit = Math.min(Math.max(Number(limitMessages) || 10, 1), 20);

  if (isMock()) {
    const messages = [
      { at: "2026-01-12T09:12:00-05:00", from: "contact", text: "Can we move tomorrow’s call to 4pm?" },
      { at: "2026-01-12T09:15:00-05:00", from: "bill", text: "Yes—4pm works. I’ll send an updated invite." }
    ].slice(0, safeLimit);

    return mcpJson(res, { threadId, messages });
  }

  return res.status(501).json({ error: "Live OAuth not implemented yet" });
});


app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP server running on port ${PORT}`);
});









