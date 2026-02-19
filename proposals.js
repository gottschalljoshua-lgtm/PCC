const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRET_KEY_RE = /(token|secret|password|authorization|cookie|api[_-]?key|apikey|pit|client[_-]?secret|client[_-]?id)/i;
const BEARER_RE = /\bBearer\s+[\w\-\.=:_]+\b/i;
const LONG_TOKEN_RE = /[A-Za-z0-9_-]{20,}/;

function isLikelySecretValue(value) {
  if (typeof value !== 'string') return false;
  if (BEARER_RE.test(value)) return true;
  if (LONG_TOKEN_RE.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value)) return true;
  return false;
}

function redactValue(key, value) {
  if (SECRET_KEY_RE.test(String(key))) return '[REDACTED]';
  if (typeof value === 'string') {
    if (isLikelySecretValue(value)) {
      const head = value.slice(0, 4);
      const tail = value.slice(-4);
      return `${head}…${tail}`;
    }
    if (value.length > 120) return `${value.slice(0, 60)}…${value.slice(-20)}`;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, idx) => redactValue(`${key}[${idx}]`, item));
  }
  if (value && typeof value === 'object') {
    return redactObject(value);
  }
  return value;
}

function redactObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = redactValue(key, value);
  }
  return out;
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function safeWriteJson(filePath, data) {
  ensureDir(filePath);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

class ProposalStore {
  constructor({ ttlSeconds = 900, filePath = '/home/ec2-user/mcp-ghl/.data/proposals.json' } = {}) {
    this.ttlMs = Number(ttlSeconds) * 1000;
    this.filePath = filePath;
    this.store = new Map();
    this._init();
  }

  _init() {
    ensureDir(this.filePath);
    this._load();
    setInterval(() => this._cleanup(), Math.max(10000, Math.floor(this.ttlMs / 2)));
  }

  _load() {
    const payload = safeReadJson(this.filePath);
    if (!payload || !Array.isArray(payload.proposals)) return;
    const now = Date.now();
    for (const proposal of payload.proposals) {
      if (proposal && proposal.proposal_id && proposal.expiresAt > now) {
        this.store.set(proposal.proposal_id, proposal);
      }
    }
  }

  _persist() {
    const proposals = Array.from(this.store.values());
    safeWriteJson(this.filePath, {
      updatedAt: new Date().toISOString(),
      proposals,
    });
  }

  _cleanup() {
    const now = Date.now();
    let changed = false;
    for (const [id, proposal] of this.store.entries()) {
      if (proposal.expiresAt <= now) {
        this.store.delete(id);
        changed = true;
      }
    }
    if (changed) this._persist();
  }

  createProposal(tool, args, params_hash, summary) {
    const now = Date.now();
    const proposal = {
      proposal_id: crypto.randomUUID(),
      tool,
      arguments: args || {},
      params_hash,
      summary,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      status: 'pending',
    };
    this.store.set(proposal.proposal_id, proposal);
    this._persist();
    return proposal;
  }

  get(proposalId) {
    this._cleanup();
    return this.store.get(proposalId) || null;
  }

  list({ limit = 20, status } = {}) {
    this._cleanup();
    let items = Array.from(this.store.values());
    if (status) items = items.filter((p) => p.status === status);
    items.sort((a, b) => b.createdAt - a.createdAt);
    return items.slice(0, limit);
  }

  approve(proposalId, approveBool, execFn) {
    const proposal = this.get(proposalId);
    if (!proposal) return null;

    if (proposal.expiresAt <= Date.now()) {
      proposal.status = 'expired';
      this.store.set(proposalId, proposal);
      this._persist();
      return proposal;
    }

    if (!approveBool) {
      proposal.status = 'rejected';
      this.store.set(proposalId, proposal);
      this._persist();
      return proposal;
    }

    proposal.status = 'approved';
    this.store.set(proposalId, proposal);
    this._persist();

    return execFn(proposal);
  }

  update(proposalId, patch) {
    const proposal = this.store.get(proposalId);
    if (!proposal) return null;
    Object.assign(proposal, patch);
    this.store.set(proposalId, proposal);
    this._persist();
    return proposal;
  }

  toSafeProposal(proposal) {
    if (!proposal) return null;
    return {
      proposal_id: proposal.proposal_id,
      tool: proposal.tool,
      summary: proposal.summary,
      params_hash: proposal.params_hash,
      createdAt: proposal.createdAt,
      expiresAt: proposal.expiresAt,
      status: proposal.status,
      arguments: redactObject(proposal.arguments || {}),
      result_status: proposal.result ? 'stored' : null,
      error_message: proposal.error ? String(proposal.error.message || proposal.error).slice(0, 200) : null,
    };
  }
}

module.exports = { ProposalStore };
