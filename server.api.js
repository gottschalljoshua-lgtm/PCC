const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const ENABLE_LEGACY_TOOLS = process.env.ENABLE_LEGACY_TOOLS === "1";

function requireApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!process.env.MCP_API_KEY) {
    return res.status(500).json({ ok: false, error: "MCP_API_KEY not set" });
  }
  if (!apiKey || apiKey !== process.env.MCP_API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// --- CORS ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-api-key"
  );
  next();
});

// --- Health check ---
app.get("/api/mcp/health", (req, res) => {
  res.status(200).type("text/plain").send("ok");
});

// --- Manifest loader ---
const MANIFEST_PATH = "/home/ec2-user/mcp-ghl/tools.manifest.json";

function sendManifest(res) {
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, "utf8");
    const parsed = JSON.parse(raw);
    res.setHeader("Content-Type", "application/json");
    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "Failed to load tools.manifest.json",
      detail: String(err),
    });
  }
}

// --- MCP endpoints (PROTECTED) ---
app.get("/tools.manifest.json", requireApiKey, (req, res) => sendManifest(res));
app.get("/api/mcp/manifest", requireApiKey, (req, res) => sendManifest(res));
app.get("/api/mcp/tools", requireApiKey, (req, res) => sendManifest(res));
app.get("/api/mcp/tools.manifest.json", requireApiKey, (req, res) => sendManifest(res));

// --- Mock tool executor (FAST PATH) ---
// Any POST to /tools/<tool> returns a deterministic mock JSON response.
// Later we replace this with real GHL + OAuth.
app.use(express.json());

app.post("/tools/:toolName", requireApiKey, (req, res) => {
  if (!ENABLE_LEGACY_TOOLS) {
    return res.status(404).json({ ok: false, error: "Not found" });
  }
  const { toolName } = req.params;

  // OPTIONAL: enforce API key at app layer too (if nginx not used)
  // if (!req.headers["x-api-key"]) return res.status(401).json({ ok:false, error:"Missing x-api-key" });

  return res.status(200).json({
    ok: true,
    mode: "mock",
    tool: toolName,
    result: {
      message: `Mock response for ${toolName}`,
      timestamp: new Date().toISOString(),
    },
  });
});

// --- Default fallback ---
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Route not found",
    path: req.path,
  });
});

// --- Start server ---
const PORT = 3334;
app.listen(PORT, "127.0.0.1", () => {
  console.log(`GHL MCP Server running on port ${PORT}`);
});
