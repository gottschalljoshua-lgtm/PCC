/**
 * GHL MCP Tool Gateway - Live Production Server
 * 
 * This server provides an MCP-compatible gateway to GoHighLevel/LeadConnector APIs
 * using Private Integration Token (PIT) authentication.
 * 
 * Exposes 13 tools matching GHL Private Integration scopes:
 * - contacts_search, contacts_upsert, contacts_update_status
 * - calendar_list_appointments, calendar_create_appointment, calendar_reschedule_appointment, calendar_cancel_appointment
 * - conversations_list_threads, conversations_get_thread, conversations_send_message
 * - tasks_list, tasks_create, tasks_complete
 * 
 * Endpoints:
 * - GET /health - Health check
 * - GET /ready - Environment validation
 * - POST /mcp - JSON-RPC handler (tools/list, tools/call)
 * - GET /mcp - SSE status stream
 * - GET /mcp/tools - Tool manifest (plain JSON)
 * - GET /api/mcp/tools - Tool manifest (plain JSON, alias)
 * - POST /tools/:toolName - Direct tool invocation
 * - GET /oauth* - Returns 410 (OAuth disabled)
 * 
 * Authentication:
 * Supports multiple methods:
 * - Header: x-api-key: <MCP_API_KEY>
 * - Header: Authorization: Bearer <MCP_API_KEY>
 * - Header: Authorization: <MCP_API_KEY> (fallback)
 * 
 * Verification:
 * curl -X POST https://api.command-finfitlife.com/mcp \
 *   -H "Content-Type: application/json" \
 *   -H "Authorization: Bearer <MCP_API_KEY>" \
 *   -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
 * 
 * curl -X GET https://api.command-finfitlife.com/mcp/tools \
 *   -H "Authorization: Bearer <MCP_API_KEY>"
 */

// Load environment variables from .env file
// Use relative path by default (same folder as server.js)
// Support ENV_PATH override for custom deployments
const ENV_PATH = process.env.ENV_PATH || '.env';
const dotenvResult = require('dotenv').config({ path: ENV_PATH });

// Log dotenv load status (without leaking secrets)
if (dotenvResult.error) {
  console.warn(`[GHL MCP Gateway] dotenv load warning: ${dotenvResult.error.message}`);
  console.warn(`[GHL MCP Gateway] Attempted path: ${ENV_PATH}`);
  // Fallback to relative .env in current directory
  const fallbackResult = require('dotenv').config();
  if (fallbackResult.error) {
    console.error(`[GHL MCP Gateway] Failed to load .env from fallback location`);
  } else {
    console.log(`[GHL MCP Gateway] dotenv loaded from fallback: .env`);
  }
} else {
  console.log(`[GHL MCP Gateway] dotenv loaded from: ${ENV_PATH}`);
  console.log(`[GHL MCP Gateway] Loaded ${Object.keys(dotenvResult.parsed || {}).length} environment variables`);
}

const express = require('express');
const cors = require('cors');

const app = express();

// ============================================================================
// Configuration & Environment Variables
// ============================================================================

// Read env vars AFTER dotenv load (runtime getters, no caching)
const MCP_API_KEY = process.env.MCP_API_KEY;
const GHL_PIT_TOKEN = process.env.GHL_PIT_TOKEN;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_API_BASE = process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = process.env.GHL_API_VERSION || '2021-07-28';

// ============================================================================
// Middleware
// ============================================================================

app.use(express.json({ limit: '10mb' }));
app.use(cors({
  origin: true,
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  exposedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
}));

// API Key gate for /mcp and /tools/*
// Supports multiple authentication methods:
// 1. Header: x-api-key == MCP_API_KEY
// 2. Header: Authorization: Bearer <MCP_API_KEY>
// 3. Header: Authorization: <MCP_API_KEY> (fallback)
function requireApiKey(req, res, next) {
  // Extract API key from multiple sources
  const xApiKey = req.headers['x-api-key'];
  const authHeader = req.headers['authorization'];
  const queryKey = req.query.apiKey;
  
  let providedKey = null;
  let authMethod = 'none';
  
  // Try x-api-key header first (existing behavior)
  if (xApiKey) {
    providedKey = xApiKey;
    authMethod = 'x-api-key';
  }
  // Try Authorization: Bearer <token>
  else if (authHeader && authHeader.startsWith('Bearer ')) {
    providedKey = authHeader.substring(7).trim();
    authMethod = 'authorization-bearer';
  }
  // Try Authorization: <token> (fallback)
  else if (authHeader) {
    providedKey = authHeader.trim();
    authMethod = 'authorization-plain';
  }
  // Try query parameter (fallback)
  else if (queryKey) {
    providedKey = queryKey;
    authMethod = 'query-param';
  }
  
  // Log auth attempt for debugging
  console.log(`[MCP] Auth check:`, {
    authMethod,
    hasProvidedKey: !!providedKey,
    providedKeyLength: providedKey?.length || 0,
    providedKeyPreview: providedKey ? `${providedKey.slice(0, 6)}...${providedKey.slice(-4)}` : 'NONE',
    expectedKeyLength: MCP_API_KEY?.length || 0,
    expectedKeyPreview: MCP_API_KEY ? `${MCP_API_KEY.slice(0, 6)}...${MCP_API_KEY.slice(-4)}` : 'NOT SET',
    match: providedKey === MCP_API_KEY,
  });
  
  if (!MCP_API_KEY) {
    console.error(`[MCP] MCP_API_KEY not configured in environment`);
    return res.status(500).json({
      error: 'Server configuration error',
      message: 'MCP_API_KEY not configured',
    });
  }
  
  if (!providedKey) {
    console.error(`[MCP] Missing authentication (tried: x-api-key, Authorization: Bearer, Authorization, query param)`);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing authentication header. Use x-api-key or Authorization: Bearer <token>',
    });
  }
  
  if (providedKey !== MCP_API_KEY) {
    console.error(`[MCP] Invalid API key provided (method: ${authMethod})`);
    return res.status(401).json({
      error: 'Unauthorized',
      message: `Invalid authentication (method: ${authMethod})`,
    });
  }
  
  console.log(`[MCP] ✅ Auth successful (method: ${authMethod})`);
  next();
}

// ============================================================================
// GHL HTTP Client Wrapper
// ============================================================================

/**
 * Makes authenticated requests to GoHighLevel/LeadConnector API
 * @param {string} method - HTTP method
 * @param {string} path - API path (e.g., '/contacts')
 * @param {object} options - { query, body, timeout }
 * @returns {Promise<{ok: boolean, status: number, data?: any, error?: string, details?: any}>}
 */
async function ghlRequest(method, path, options = {}) {
  const { query = {}, body, timeout = 30000 } = options;

  if (!GHL_PIT_TOKEN) {
    return {
      ok: false,
      status: 500,
      error: 'GHL_PIT_TOKEN not configured',
      details: {
        endpoint: path,
        status: 500,
      },
    };
  }

  // Build query string
  const queryParams = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      queryParams.append(key, String(value));
    }
  });
  const queryString = queryParams.toString();
  const url = `${GHL_API_BASE}${path}${queryString ? `?${queryString}` : ''}`;

  // Build headers
  const headers = {
    'Authorization': `Bearer ${GHL_PIT_TOKEN}`,
    'Version': GHL_API_VERSION,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const fetchOptions = {
      method,
      headers,
      signal: controller.signal,
    };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);
    clearTimeout(timeoutId);

    const contentType = response.headers.get('content-type');
    let data;
    
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    if (!response.ok) {
      // Extract safe error message (don't log full payloads)
      let errorMessage = `GHL API error (${response.status})`;
      if (typeof data === 'object' && data?.message) {
        errorMessage = String(data.message);
      } else if (typeof data === 'string' && data.length < 200) {
        errorMessage = data;
      }
      
      const safeDetails = {
        endpoint: path,
        status: response.status,
      };
      if (typeof data === 'object' && data !== null) {
        safeDetails.response = data;
      } else if (typeof data === 'string' && data.length <= 2000) {
        safeDetails.response = data;
      }

      return {
        ok: false,
        status: response.status,
        error: errorMessage,
        details: safeDetails,
      };
    }

    return {
      ok: true,
      status: response.status,
      data,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error.name === 'AbortError') {
      return {
        ok: false,
        status: 504,
        error: 'Request timeout',
        details: {
          endpoint: path,
          status: 504,
          timeout,
        },
      };
    }

    return {
      ok: false,
      status: 502,
      error: 'Upstream request failed',
      details: {
        endpoint: path,
        status: 502,
      },
    };
  }
}

// ============================================================================
// Tool Handlers
// ============================================================================

/**
 * Search contacts by query string
 * 
 * Note: GHL API expects 'pageLimit' (not 'limit'). For backwards compatibility,
 * we accept either 'limit' or 'pageLimit' and translate to 'pageLimit'.
 * Validates pageLimit as positive integer (min 1, max 100).
 */
async function handleContactsSearch(args) {
  const { query, locationId, limit, pageLimit } = args;
  
  if (!query) {
    return { error: 'query parameter is required', status: 400 };
  }

  const locId = locationId || GHL_LOCATION_ID;
  if (!locId) {
    return { error: 'locationId is required', status: 400 };
  }

  // Normalize: accept either pageLimit or limit, default to 10
  const rawPageLimit = pageLimit ?? limit ?? 10;
  
  // Validate and normalize to positive integer
  const ghlPageLimit = Number(rawPageLimit);
  if (isNaN(ghlPageLimit) || ghlPageLimit < 1 || ghlPageLimit > 100 || !Number.isInteger(ghlPageLimit)) {
    return { 
      error: 'pageLimit must be a positive integer between 1 and 100', 
      status: 400 
    };
  }

  const searchBody = {
    locationId: locId,
    query,
    pageLimit: ghlPageLimit, // Always send pageLimit (GHL rejects 'limit' property)
  };

  const result = await ghlRequest('POST', `/contacts/search`, {
    body: searchBody,
  });

  if (!result.ok) {
    return { error: result.error, status: result.status, details: result.details };
  }

  return { contacts: result.data?.contacts || result.data || [] };
}

/**
 * Upsert contact: search by phone/email, update if found, create if not
 */
async function handleContactsUpsert(args) {
  const { firstName, lastName, phone, email, tags, locationId } = args;
  
  const locId = locationId || GHL_LOCATION_ID;
  if (!locId) {
    return { error: 'locationId is required', status: 400 };
  }

  if (!firstName || !lastName) {
    return { error: 'firstName and lastName are required', status: 400 };
  }

  // Build name from firstName and lastName
  const name = `${firstName} ${lastName}`.trim();

  // Search for existing contact using POST /contacts/search
  let existingContact = null;
  if (phone) {
    const searchResult = await ghlRequest('POST', `/contacts/search`, {
      body: {
        locationId: locId,
        phone,
      },
    });
    if (searchResult.ok && searchResult.data?.contacts?.length > 0) {
      existingContact = searchResult.data.contacts[0];
    }
  }
  
  if (!existingContact && email) {
    const searchResult = await ghlRequest('POST', `/contacts/search`, {
      body: {
        locationId: locId,
        email,
      },
    });
    if (searchResult.ok && searchResult.data?.contacts?.length > 0) {
      existingContact = searchResult.data.contacts[0];
    }
  }

  const contactData = {
    name,
    firstName,
    lastName,
    phone,
    email,
    locationId: locId,
  };
  
  if (tags && Array.isArray(tags)) {
    contactData.tags = tags;
  }

  if (existingContact) {
    // Update existing contact
    const result = await ghlRequest('PUT', `/contacts/${existingContact.id}`, {
      body: contactData,
    });
    
    if (!result.ok) {
      return { error: result.error, status: result.status, details: result.details };
    }
    
    return { contact: result.data?.contact || result.data, action: 'updated' };
  } else {
    // Create new contact
    const result = await ghlRequest('POST', `/contacts`, {
      body: contactData,
    });
    
    if (!result.ok) {
      return { error: result.error, status: result.status, details: result.details };
    }
    
    return { contact: result.data?.contact || result.data, action: 'created' };
  }
}

/**
 * Update contact status (tags and/or pipeline stage)
 */
async function handleContactsUpdateStatus(args) {
  const { contactId, addTags, removeTags, stageId, locationId } = args;
  
  if (!contactId) {
    return { error: 'contactId is required', status: 400 };
  }

  const locId = locationId || GHL_LOCATION_ID;
  if (!locId) {
    return { error: 'locationId is required', status: 400 };
  }

  const updateData = {};
  if (addTags && Array.isArray(addTags)) {
    updateData.addTags = addTags;
  }
  if (removeTags && Array.isArray(removeTags)) {
    updateData.removeTags = removeTags;
  }
  if (stageId !== undefined) {
    updateData.stageId = stageId;
  }

  if (Object.keys(updateData).length === 0) {
    return { error: 'addTags, removeTags, or stageId is required', status: 400 };
  }

  const result = await ghlRequest('PUT', `/contacts/${contactId}`, {
    body: updateData,
  });

  if (!result.ok) {
    return { error: result.error, status: result.status, details: result.details };
  }

  return { contact: result.data?.contact || result.data };
}

/**
 * List calendars for a location
 */
async function handleCalendarsList(args) {
  const { locationId } = args || {};
  const locId = locationId || GHL_LOCATION_ID;
  if (!locId) {
    return { error: "locationId is required", status: 400 };
  }

  const result = await ghlRequest("GET", "/calendars/", {
    query: { locationId: locId },
  });

  if (!result.ok) {
    return { error: result.error, status: result.status, details: result.details };
  }

  return { calendars: result.data?.calendars || result.data || [] };
}

/**
 * List free slots for a calendar between dates
 */
async function handleCalendarFreeSlots(args) {
  const { calendarId, startDateTime, endDateTime, timezone, locationId } = args || {};

  if (!calendarId) {
    return { error: 'calendarId is required', status: 400 };
  }
  if (!startDateTime) {
    return { error: 'startDateTime is required', status: 400 };
  }
  if (!endDateTime) {
    return { error: 'endDateTime is required', status: 400 };
  }

  const locId = locationId || GHL_LOCATION_ID;
  if (!locId) {
    return { error: 'locationId is required', status: 400 };
  }

  const startMs = Date.parse(startDateTime);
  const endMs = Date.parse(endDateTime);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return { error: 'startDateTime and endDateTime must be valid ISO strings', status: 400 };
  }

  const query = {
    startDate: startMs,
    endDate: endMs,
  };
  if (timezone) {
    query.timezone = timezone;
  }

  const result = await ghlRequest('GET', '/calendars/' + calendarId + '/free-slots', {
    query,
  });

  if (!result.ok) {
    return { error: result.error, status: result.status, details: result.details };
  }

  return { slots: result.data?.slots || result.data || [] };
}

/**
 * List appointments for a calendar between dates
 */
async function handleCalendarListAppointments(args) {
  const { calendarId, startDateTime, endDateTime, limit, locationId } = args;
  
  if (!calendarId) {
    return { error: 'calendarId is required', status: 400 };
  }
  if (!startDateTime) {
    return { error: 'startDateTime is required', status: 400 };
  }
  if (!endDateTime) {
    return { error: 'endDateTime is required', status: 400 };
  }

  const locId = locationId || GHL_LOCATION_ID;
  if (!locId) {
    return { error: 'locationId is required', status: 400 };
  }

  const query = {
    calendarId,
    startDate: startDateTime,
    endDate: endDateTime,
  };
  if (locId) query.locationId = locId;
  if (limit) query.limit = limit;

  const result = await ghlRequest('GET', `/calendars/events`, {
    query,
  });

  if (!result.ok) {
    return { error: result.error, status: result.status, details: result.details };
  }

  return { events: result.data?.events || result.data || [] };
}

/**
 * Create appointment
 */
async function handleCalendarCreateAppointment(args) {
  const { calendarId, contactId, startTime, startDateTime, endTime, endDateTime, title, notes, locationId, ...otherFields } = args;
  
  if (!calendarId) {
    return { error: 'calendarId is required', status: 400 };
  }
  if (!contactId) {
    return { error: 'contactId is required', status: 400 };
  }
  if (!startTime && !startDateTime) {
    return { error: 'startTime or startDateTime is required', status: 400 };
  }

  const locId = locationId || GHL_LOCATION_ID;
  if (!locId) {
    return { error: 'locationId is required', status: 400 };
  }

  const appointmentData = {
    calendarId,
    contactId,
    title,
    notes,
    locationId: locId,
    ...otherFields,
  };
  
  // Support both startTime/endTime and startDateTime/endDateTime for compatibility
  if (startDateTime) {
    appointmentData.startTime = startDateTime;
  } else {
    appointmentData.startTime = startTime;
  }
  
  if (endDateTime) {
    appointmentData.endTime = endDateTime;
  } else if (endTime) {
    appointmentData.endTime = endTime;
  }

  const result = await ghlRequest('POST', `/calendars/events/appointments`, {
    body: appointmentData,
  });

  if (!result.ok) {
    return { error: result.error, status: result.status, details: result.details };
  }

  return { appointment: result.data?.appointment || result.data };
}

/**
 * Reschedule appointment
 */
async function handleCalendarRescheduleAppointment(args) {
  const { appointmentId, newStartDateTime, newEndDateTime, locationId } = args;
  
  if (!appointmentId) {
    return { error: 'appointmentId is required', status: 400 };
  }
  if (!newStartDateTime) {
    return { error: 'newStartDateTime is required', status: 400 };
  }
  if (!newEndDateTime) {
    return { error: 'newEndDateTime is required', status: 400 };
  }

  const locId = locationId || GHL_LOCATION_ID;
  if (!locId) {
    return { error: 'locationId is required', status: 400 };
  }

  const updateData = {
    startTime: newStartDateTime,
    endTime: newEndDateTime,
  };

  const result = await ghlRequest('PUT', `/appointments/${appointmentId}`, {
    body: updateData,
  });

  if (!result.ok) {
    return { error: result.error, status: result.status, details: result.details };
  }

  return { appointment: result.data?.appointment || result.data };
}

/**
 * Cancel appointment
 */
async function handleCalendarCancelAppointment(args) {
  const { appointmentId, reasonCode, locationId } = args;
  
  if (!appointmentId) {
    return { error: 'appointmentId is required', status: 400 };
  }

  const locId = locationId || GHL_LOCATION_ID;
  if (!locId) {
    return { error: 'locationId is required', status: 400 };
  }

  const cancelData = { locationId: locId };
  if (reasonCode) {
    cancelData.reasonCode = reasonCode;
  }

  const result = await ghlRequest('PUT', `/appointments/${appointmentId}/cancel`, {
    body: cancelData,
  });

  if (!result.ok) {
    return { error: result.error, status: result.status, details: result.details };
  }

  return { success: true, appointment: result.data?.appointment || result.data };
}

/**
 * List location tags
 */
async function handleLocationsTagsList(args) {
  const { locationId } = args;
  const locId = locationId || GHL_LOCATION_ID;
  if (!locId) return { error: 'locationId is required', status: 400 };

  const result = await ghlRequest('GET', `/locations/${locId}/tags`, {});
  if (!result.ok) {
    return { error: result.error, status: result.status, details: result.details };
  }
  return { tags: result.data?.tags || result.data || [] };
}

/**
 * Create a tag for a location
 */
async function handleLocationsTagsCreate(args) {
  const { locationId, name } = args;
  const locId = locationId || GHL_LOCATION_ID;
  if (!locId) return { error: 'locationId is required', status: 400 };
  if (!name) return { error: 'name is required', status: 400 };

  const result = await ghlRequest('POST', `/locations/${locId}/tags`, {
    body: { name },
  });
  if (!result.ok) {
    return { error: result.error, status: result.status, details: result.details };
  }
  return { tag: result.data || null };
}

/**
 * Delete a tag by id for a location
 */
async function handleLocationsTagsDelete(args) {
  const { locationId, tagId } = args;
  const locId = locationId || GHL_LOCATION_ID;
  if (!locId) return { error: 'locationId is required', status: 400 };
  if (!tagId) return { error: 'tagId is required', status: 400 };

  const result = await ghlRequest('DELETE', `/locations/${locId}/tags/${tagId}`, {});
  if (!result.ok) {
    return { error: result.error, status: result.status, details: result.details };
  }
  return { success: true };
}

/**
 * Conversations reports (summary)
 */
async function handleConversationsReport(args) {
  const { locationId, startDate, endDate, timezone, limit, channel } = args;
  const locId = locationId || GHL_LOCATION_ID;
  if (!locId) return { error: 'locationId is required', status: 400 };

  const query = { locationId: locId };
  if (startDate) query.startDate = startDate;
  if (endDate) query.endDate = endDate;
  if (timezone) query.timezone = timezone;
  if (limit) query.limit = limit;
  if (channel && ['email', 'sms'].includes(channel)) query.channel = channel;

  const result = await ghlRequest('GET', `/conversations/reports`, { query });
  if (result.ok) {
    return { report: result.data || {} };
  }

  let lastError = { error: result.error, status: result.status, details: result.details };

  const shouldRetryDates = result.status === 400 && (startDate || endDate);
  if (shouldRetryDates) {
    const normalizeDate = (value, isEnd = false) => {
      if (!value || typeof value !== 'string') return value;
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return isEnd ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`;
      }
      return value;
    };

    const altQuery = { locationId: locId };
    const startIso = normalizeDate(startDate, false);
    const endIso = normalizeDate(endDate, true);
    if (startIso) {
      const ms = Date.parse(startIso);
      if (!Number.isNaN(ms)) altQuery.startDate = ms;
    }
    if (endIso) {
      const ms = Date.parse(endIso);
      if (!Number.isNaN(ms)) altQuery.endDate = ms;
    }
    if (timezone) altQuery.timezone = timezone;

    const retry = await ghlRequest('GET', `/conversations/reports`, { query: altQuery });
    if (retry.ok) {
      return { report: retry.data || {}, _retry: true, _format: 'epoch_ms' };
    }
    // Second retry: some GHL endpoints expect `start`/`end` instead of `startDate`/`endDate`
    const altQuery2 = { locationId: locId };
    if (startIso) {
      const ms = Date.parse(startIso);
      if (!Number.isNaN(ms)) altQuery2.start = ms;
    }
    if (endIso) {
      const ms = Date.parse(endIso);
      if (!Number.isNaN(ms)) altQuery2.end = ms;
    }
    if (timezone) altQuery2.timezone = timezone;

    const retry2 = await ghlRequest('GET', `/conversations/reports`, { query: altQuery2 });
    if (retry2.ok) {
      return { report: retry2.data || {}, _retry: true, _format: 'epoch_ms_start_end' };
    }
    // If GHL treats "reports" as a conversation id, try alternate report endpoints.
    const endpoints = ['/conversations/report', '/conversations/reports/summary'];
    for (const endpoint of endpoints) {
      const alt = await ghlRequest('GET', endpoint, { query: altQuery2 });
      if (alt.ok) {
        return { report: alt.data || {}, _retry: true, _format: 'epoch_ms_start_end', _endpoint: endpoint };
      }
    }
    lastError = { error: retry2.error, status: retry2.status, details: retry2.details };
  }

  // Final fallback: build a lightweight report from conversations search (available in API)
  const searchQuery = { locationId: locId };
  if (limit) searchQuery.limit = limit;
  if (channel && ['email', 'sms'].includes(channel)) searchQuery.channel = channel;
  const search = await ghlRequest('GET', `/conversations/search`, { query: searchQuery });
  if (search.ok) {
    const conversations = search.data?.conversations || search.data || [];
    const byChannel = {};
    const byStatus = {};
    let unread = 0;
    for (const convo of conversations) {
      const c = convo || {};
      const ch = c.channel || c.type || 'unknown';
      byChannel[ch] = (byChannel[ch] || 0) + 1;
      const st = c.status || 'unknown';
      byStatus[st] = (byStatus[st] || 0) + 1;
      if (c.unreadCount > 0 || c.unread === true) unread += 1;
    }
    return {
      report: {
        total: conversations.length,
        unread,
        byChannel,
        byStatus,
        sample: conversations.slice(0, 5),
      },
      _fallback: 'conversations_search',
    };
  }

  return lastError;
}

/**
 * List tasks
 */
async function handleTasksList(args) {
  const { dueWindow, limit, locationId } = args;
  
  const locId = locationId || GHL_LOCATION_ID;
  if (!locId) {
    return { error: 'locationId is required', status: 400 };
  }

  const query = { locationId: locId };
  
  // Map dueWindow to appropriate query parameters
  if (dueWindow === 'overdue') {
    query.status = 'pending';
    // Add date filter for overdue (would need current date logic)
  } else if (dueWindow === 'today') {
    // Add date filter for today
  } else if (dueWindow === 'next7') {
    // Add date filter for next 7 days
  }
  
  if (limit) query.limit = limit;

  const result = await ghlRequest('GET', `/tasks`, {
    query,
  });

  if (!result.ok) {
    return { error: result.error, status: result.status, details: result.details };
  }

  return { tasks: result.data?.tasks || result.data || [] };
}

/**
 * Create task
 */
async function handleTasksCreate(args) {
  const { title, dueDateTime, contactId, priority, locationId } = args;
  
  if (!title) {
    return { error: 'title is required', status: 400 };
  }
  if (!dueDateTime) {
    return { error: 'dueDateTime is required', status: 400 };
  }

  const locId = locationId || GHL_LOCATION_ID;
  if (!locId) {
    return { error: 'locationId is required', status: 400 };
  }

  // contactId is optional - GHL API requires it, so validate if not provided
  if (!contactId) {
    return { error: 'contactId is required by GHL API', status: 400 };
  }

  const taskData = {
    title,
    dueDate: dueDateTime,
  };
  
  if (priority && ['low', 'normal', 'high'].includes(priority)) {
    taskData.priority = priority;
  }

  const result = await ghlRequest('POST', `/contacts/${contactId}/tasks`, {
    body: taskData,
  });

  if (!result.ok) {
    return { error: result.error, status: result.status, details: result.details };
  }

  return { task: result.data?.task || result.data };
}

/**
 * Complete task
 */
async function handleTasksComplete(args) {
  const { taskId, locationId } = args;
  
  if (!taskId) {
    return { error: 'taskId is required', status: 400 };
  }

  const locId = locationId || GHL_LOCATION_ID;
  if (!locId) {
    return { error: 'locationId is required', status: 400 };
  }

  const result = await ghlRequest('PUT', `/tasks/${taskId}/complete`, {
    body: { locationId: locId },
  });

  if (!result.ok) {
    return { error: result.error, status: result.status, details: result.details };
  }

  return { success: true, task: result.data?.task || result.data };
}

/**
 * List conversation threads
 */
async function handleConversationsListThreads(args) {
  const { channel, unreadOnly, limit, locationId } = args;
  
  const locId = locationId || GHL_LOCATION_ID;
  if (!locId) {
    return { error: 'locationId is required', status: 400 };
  }

  const query = { locationId: locId };
  
  if (channel && ['email', 'sms'].includes(channel)) {
    query.channel = channel;
  }
  
  if (unreadOnly === true) {
    query.unreadOnly = true;
  }
  
  if (limit) query.limit = limit;

  const result = await ghlRequest('GET', `/conversations/search`, {
    query,
  });

  if (!result.ok) {
    return { error: result.error, status: result.status, details: result.details };
  }

  return { conversations: result.data?.conversations || result.data || [] };
}

/**
 * Get conversation thread
 */
async function handleConversationsGetThread(args) {
  const { threadId, limitMessages, locationId } = args;
  
  if (!threadId) {
    return { error: 'threadId is required', status: 400 };
  }

  const locId = locationId || GHL_LOCATION_ID;
  if (!locId) {
    return { error: 'locationId is required', status: 400 };
  }

  const query = { locationId: locId };
  if (limitMessages) {
    query.limit = limitMessages;
  }

  const result = await ghlRequest('GET', `/conversations/${threadId}`, {
    query,
  });

  if (!result.ok) {
    return { error: result.error, status: result.status, details: result.details };
  }

  return { conversation: result.data?.conversation || result.data };
}

/**
 * Send message in conversation
 */
async function handleConversationsSendMessage(args) {
  const { threadId, message, channel, locationId } = args;
  
  if (!threadId) {
    return { error: 'threadId is required', status: 400 };
  }
  if (!message) {
    return { error: 'message is required', status: 400 };
  }

  const locId = locationId || GHL_LOCATION_ID;
  if (!locId) {
    return { error: 'locationId is required', status: 400 };
  }

  const messageData = {
    conversationId: threadId,
    message,
    locationId: locId,
  };
  
  if (channel && ['email', 'sms'].includes(channel)) {
    messageData.channel = channel;
  }

  const result = await ghlRequest('POST', `/conversations/messages`, {
    body: messageData,
  });

  if (!result.ok) {
    return { error: result.error, status: result.status, details: result.details };
  }

  return { message: result.data?.message || result.data };
}

/**
 * Start a new email thread (outbound email)
 */
async function handleConversationsSendNewEmail(args) {
  const { contactId, message, subject, email, locationId } = args;

  if (!contactId && !email) {
    return { error: 'contactId or email is required', status: 400 };
  }
  if (!message) {
    return { error: 'message is required', status: 400 };
  }

  const locId = locationId || GHL_LOCATION_ID;
  if (!locId) {
    return { error: 'locationId is required', status: 400 };
  }

  const messageData = {
    locationId: locId,
    type: 'Email',
    message,
    body: message,
    html: message,
    channel: 'email',
  };

  if (contactId) messageData.contactId = contactId;
  if (email) messageData.email = email;
  if (subject) messageData.subject = subject;

  const result = await ghlRequest('POST', `/conversations/messages`, {
    body: messageData,
  });

  if (!result.ok) {
    return { error: result.error, status: result.status, details: result.details };
  }

  return { message: result.data?.message || result.data };
}


// ============================================================================
// Tool Registry
// ============================================================================

// Strict allowlist: Only tools matching GHL Private Integration scopes
// Defense-in-depth: Even if a tool is accidentally added to TOOLS, it won't be exposed
const ALLOWED_TOOLS = new Set([
  'contacts_search',
  'contacts_upsert',
  'contacts_update_status',
  'calendars_list',
  'calendar_free_slots',
  'calendar_list_appointments',
  'calendar_create_appointment',
  'calendar_reschedule_appointment',
  'calendar_cancel_appointment',
  'conversations_list_threads',
  'conversations_get_thread',
  'conversations_send_message',
  'conversations_send_new_email',
  'conversations_report',
  'locations_tags_list',
  'locations_tags_create',
  'locations_tags_delete',
  'tasks_list',
  'tasks_create',
  'tasks_complete',
]);

const TOOLS = {
  contacts_search: {
    name: 'contacts_search',
    description: 'Search contacts by query',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        pageLimit: { type: 'number' },
        limit: { type: 'number' }, // Deprecated: use pageLimit. Accepted for backwards compatibility.
      },
      required: ['query'],
    },
    handler: handleContactsSearch,
  },
  contacts_upsert: {
    name: 'contacts_upsert',
    description: 'Create or update a contact',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['firstName', 'lastName'],
    },
    handler: handleContactsUpsert,
  },
  contacts_update_status: {
    name: 'contacts_update_status',
    description: 'Update tags/stage for a contact',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        contactId: { type: 'string' },
        addTags: { type: 'array', items: { type: 'string' } },
        removeTags: { type: 'array', items: { type: 'string' } },
        stageId: { type: 'string' },
      },
      required: ['contactId'],
    },
    handler: handleContactsUpdateStatus,
  },
  calendars_list: {
    name: "calendars_list",
    description: "List calendars for a location",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        locationId: { type: "string" },
      },
    },
    handler: handleCalendarsList,
  },
  calendar_free_slots: {
    name: "calendar_free_slots",
    description: "List available free slots for a calendar",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        calendarId: { type: "string" },
        startDateTime: { type: "string" },
        endDateTime: { type: "string" },
        timezone: { type: "string" },
        locationId: { type: "string" },
      },
      required: ["calendarId", "startDateTime", "endDateTime"],
    },
    handler: handleCalendarFreeSlots,
  },

  calendar_list_appointments: {
    name: 'calendar_list_appointments',
    description: 'List appointments in a calendar window',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        calendarId: { type: 'string' },
        startDateTime: { type: 'string' },
        endDateTime: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['calendarId', 'startDateTime', 'endDateTime'],
    },
    handler: handleCalendarListAppointments,
  },
  calendar_create_appointment: {
    name: 'calendar_create_appointment',
    description: 'Create an appointment',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        calendarId: { type: 'string' },
        contactId: { type: 'string' },
        title: { type: 'string' },
        startDateTime: { type: 'string' },
        endDateTime: { type: 'string' },
      },
      required: ['calendarId', 'contactId', 'title', 'startDateTime', 'endDateTime'],
    },
    handler: handleCalendarCreateAppointment,
  },
  calendar_reschedule_appointment: {
    name: 'calendar_reschedule_appointment',
    description: 'Reschedule an appointment',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        appointmentId: { type: 'string' },
        newStartDateTime: { type: 'string' },
        newEndDateTime: { type: 'string' },
      },
      required: ['appointmentId', 'newStartDateTime', 'newEndDateTime'],
    },
    handler: handleCalendarRescheduleAppointment,
  },
  calendar_cancel_appointment: {
    name: 'calendar_cancel_appointment',
    description: 'Cancel an appointment',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        appointmentId: { type: 'string' },
        reasonCode: { type: 'string' },
      },
      required: ['appointmentId'],
    },
    handler: handleCalendarCancelAppointment,
  },
  locations_tags_list: {
    name: 'locations_tags_list',
    description: 'List tags for a location',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        locationId: { type: 'string' },
      },
      required: [],
    },
    handler: handleLocationsTagsList,
  },
  locations_tags_create: {
    name: 'locations_tags_create',
    description: 'Create a tag for a location',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        locationId: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['name'],
    },
    handler: handleLocationsTagsCreate,
  },
  locations_tags_delete: {
    name: 'locations_tags_delete',
    description: 'Delete a tag for a location',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        locationId: { type: 'string' },
        tagId: { type: 'string' },
      },
      required: ['tagId'],
    },
    handler: handleLocationsTagsDelete,
  },
  conversations_report: {
    name: 'conversations_report',
    description: 'Get conversations report summary for a location (uses API report if available, otherwise derives from conversations search)',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        locationId: { type: 'string' },
        startDate: { type: 'string' },
        endDate: { type: 'string' },
        timezone: { type: 'string' },
        limit: { type: 'number' },
        channel: { type: 'string', enum: ['email', 'sms'] },
      },
      required: [],
    },
    handler: handleConversationsReport,
  },
  tasks_list: {
    name: 'tasks_list',
    description: 'List tasks by due window',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dueWindow: { type: 'string', enum: ['overdue', 'today', 'next7'] },
        limit: { type: 'number' },
      },
    },
    handler: handleTasksList,
  },
  tasks_create: {
    name: 'tasks_create',
    description: 'Create a task',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string' },
        dueDateTime: { type: 'string' },
        contactId: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
      },
      required: ['title', 'dueDateTime', 'contactId'],
    },
    handler: handleTasksCreate,
  },
  tasks_complete: {
    name: 'tasks_complete',
    description: 'Complete task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        locationId: { type: 'string' },
      },
      required: ['taskId'],
    },
    handler: handleTasksComplete,
  },
  conversations_list_threads: {
    name: 'conversations_list_threads',
    description: 'List recent threads for a channel',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        channel: { type: 'string', enum: ['email', 'sms'] },
        unreadOnly: { type: 'boolean' },
        limit: { type: 'number' },
      },
    },
    handler: handleConversationsListThreads,
  },
  conversations_get_thread: {
    name: 'conversations_get_thread',
    description: 'Fetch messages for a thread',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        threadId: { type: 'string' },
        limitMessages: { type: 'number' },
      },
      required: ['threadId'],
    },
    handler: handleConversationsGetThread,
  },
  conversations_send_message: {
    name: 'conversations_send_message',
    description: 'Send a message into an existing thread',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        threadId: { type: 'string' },
        message: { type: 'string' },
        channel: { type: 'string', enum: ['email', 'sms'] },
      },
      required: ['threadId', 'message'],
    },
    handler: handleConversationsSendMessage,
  },
  conversations_send_new_email: {
    name: 'conversations_send_new_email',
    description: 'Start a new email thread (outbound email)',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        contactId: { type: 'string' },
        email: { type: 'string' },
        subject: { type: 'string' },
        message: { type: 'string' },
        locationId: { type: 'string' },
      },
      required: ['message'],
    },
    handler: handleConversationsSendNewEmail,
  },
};

// ============================================================================
// Tool Handler Router
// ============================================================================

async function handleTool(toolName, args) {
  // Strict allowlist check: reject tools not in ALLOWED_TOOLS
  if (!ALLOWED_TOOLS.has(toolName)) {
    return {
      error: `Tool not available: ${toolName} is not in the allowed tool catalog`,
      status: 404,
      details: {
        endpoint: toolName,
        status: 404,
      },
    };
  }
  
  const tool = TOOLS[toolName];
  
  if (!tool) {
    return {
      error: `Unknown tool: ${toolName}`,
      status: 404,
      details: {
        endpoint: toolName,
        status: 404,
      },
    };
  }

  try {
    const result = await tool.handler(args);
    
    // Normalize error responses - ensure details includes endpoint
    if (result.error) {
      const status = result.status || 500;
      return {
        error: result.error,
        status,
        details: {
          ...result.details,
          endpoint: result.details?.endpoint || toolName,
        },
      };
    }
    
    return result;
  } catch (error) {
    // Don't log full error objects that might contain sensitive data
    console.error(`[tool:${toolName}] Error:`, error.message);
    return {
      error: 'Internal server error',
      status: 500,
      details: {
        endpoint: toolName,
        status: 500,
      },
    };
  }
}

// ============================================================================
// Routes
// ============================================================================

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// Environment validation
// Checks process.env AFTER dotenv load to ensure values are available
app.get('/ready', (req, res) => {
  // Re-read env vars at request time (no caching)
  const pitToken = process.env.GHL_PIT_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  
  const missing = [];
  if (!pitToken) missing.push('GHL_PIT_TOKEN');
  if (!locationId) missing.push('GHL_LOCATION_ID');
  
  // Structured logging for ready check
  console.log(`[GHL MCP Gateway] /ready check:`, {
    hasPitToken: !!pitToken,
    hasLocationId: !!locationId,
    missingCount: missing.length,
    missingKeys: missing.length > 0 ? missing : undefined,
  });
  
  if (missing.length > 0) {
    return res.status(503).json({
      ok: false,
      missing,
      message: 'Server not ready: missing required environment variables',
    });
  }
  
  res.json({ ok: true });
});

// Health check for ALB/load balancer
app.get('/api/mcp/health', (req, res) => {
  res.json({ ok: true });
});

// Tool manifest endpoint (GET) - for Agent Builder discovery
// Returns same format as tools/list JSON-RPC response
app.get('/api/mcp/tools', requireApiKey, (req, res) => {
  // Strict allowlist filter: only expose tools in ALLOWED_TOOLS
  const tools = Object.values(TOOLS)
    .filter(tool => ALLOWED_TOOLS.has(tool.name))
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  
  res.json({ tools });
});

// Tool manifest endpoint (GET) - alias for /mcp/tools
app.get('/mcp/tools', requireApiKey, (req, res) => {
  // Strict allowlist filter: only expose tools in ALLOWED_TOOLS
  const tools = Object.values(TOOLS)
    .filter(tool => ALLOWED_TOOLS.has(tool.name))
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  
  res.json({ tools });
});

// OAuth routes - hard disabled (410)
app.get(/^\/oauth/, (req, res) => {
  res.status(410).json({
    error: 'OAuth is disabled',
    message: 'This server uses Private Integration Token (PIT) authentication only',
  });
});

// Direct tool invocation
app.post('/tools/:toolName', requireApiKey, async (req, res) => {
  const { toolName } = req.params;
  const args = req.body;
  
  const result = await handleTool(toolName, args);
  
  if (result.error) {
    const status = result.status || 500;
    return res.status(status).json({ error: result.error, details: result.details });
  }
  
  res.json(result);
});

// JSON-RPC MCP POST handler (shared)
async function mcpPostHandler(req, res) {
  let requestBody = req.body;
  let requestId = null;
  let requestMethod = null;
  let requestParams = null;
  
  // Handle edge cases - if body is not an object, treat as empty
  if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
    // If body is not an object, treat as empty (might be tools/list with empty body)
    if (Array.isArray(requestBody)) {
      console.log(`[MCP] Body is array, treating as empty`);
      requestBody = {};
    } else if (!requestBody || typeof requestBody !== 'object') {
      console.log(`[MCP] Body is not object, treating as empty`);
      requestBody = {};
    }
  }
  
  // Loosen JSON-RPC parsing - accept id as number or string, missing params
  requestId = requestBody.id !== undefined ? requestBody.id : null;
  requestMethod = requestBody.method || null;
  requestParams = requestBody.params !== undefined ? requestBody.params : null;
  const jsonrpc = requestBody.jsonrpc;
  
  // Normalize method name (handle dot notation variants)
  let normalizedMethod = requestMethod ? String(requestMethod) : "";
  if (normalizedMethod === "tools.list") normalizedMethod = "tools/list";
  if (normalizedMethod === "tools.call") normalizedMethod = "tools/call";
  if (!normalizedMethod) normalizedMethod = null;
  
  // Log minimal info (no secrets, no PHI)
  console.log(`[MCP] ${new Date().toISOString()} - ${normalizedMethod || 'unknown'}`, {
    hasId: requestId !== null,
    idType: requestId !== null ? typeof requestId : null,
    hasParams: requestParams !== null,
    matched: normalizedMethod === 'tools/list' || normalizedMethod === 'tools/call' || normalizedMethod === 'initialize' || normalizedMethod === 'ping',
  });
  
// initialize (Agent Builder handshake)
if (normalizedMethod === "initialize") {
  const params =
    requestParams ||
    (requestBody && requestBody.params) ||
    {};

  const protocolVersion = params.protocolVersion || "2024-11-05";

  const result = {
    protocolVersion,
    capabilities: {
      tools: {},
      prompts: {},
      resources: {}
    },
    serverInfo: {
      name: "ghl-mcp-gateway",
      version: "1.0.0"
    }
  };

  return res.json({
    jsonrpc: "2.0",
    id: requestId ?? null,
    result
  });
}
  
  // Handle tools/list (support multiple formats)
  if (normalizedMethod === 'tools/list' || 
      (!normalizedMethod && (!requestBody || Object.keys(requestBody).length === 0))) {
    // Strict allowlist filter: only expose tools in ALLOWED_TOOLS
    const allTools = Object.values(TOOLS);
    const tools = allTools
      .filter(tool => ALLOWED_TOOLS.has(tool.name))
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    
    // Structured logging for tools/list
    console.log(`[MCP] tools/list`, {
      toolCount: tools.length,
      toolNames: tools.map(t => t.name),
      filteredOut: allTools.filter(t => !ALLOWED_TOOLS.has(t.name)).map(t => t.name),
    });
    
    return res.json({
      jsonrpc: '2.0',
      id: requestId,
      result: { tools },
    });
  }
  
  // For other methods, require JSON-RPC 2.0 but be lenient
  if (jsonrpc && jsonrpc !== '2.0') {
    console.log(`[MCP] ❌ Invalid jsonrpc version: ${jsonrpc}`);
    return res.json({
      jsonrpc: '2.0',
      id: requestId,
      error: {
        code: -32600,
        message: 'Invalid Request: jsonrpc must be "2.0"',
      },
    });
  }
  
  // If no method specified and not empty body, return error
  if (!normalizedMethod && jsonrpc === '2.0') {
    console.log(`[MCP] ❌ Missing method`);
    return res.json({
      jsonrpc: '2.0',
      id: requestId,
      error: {
        code: -32600,
        message: 'Invalid Request: method is required',
      },
    });
  }
  
  // If not JSON-RPC 2.0 and not a recognized method, return error (but as JSON-RPC error, not HTTP 400)
  if (!jsonrpc && normalizedMethod && normalizedMethod !== 'tools/list') {
    console.log(`[MCP] ❌ Missing jsonrpc field`);
    return res.json({
      jsonrpc: '2.0',
      id: requestId,
      error: {
        code: -32600,
        message: 'Invalid Request: jsonrpc field is required',
      },
    });
  }
  
  // Handle tools/call (support both "tools/call" and "tools.call")
  if (normalizedMethod === 'tools/call') {
    const { name, arguments: args } = requestParams || {};
    
    // Structured logging for tools/call (name + arg keys only, no values)
    console.log(`[MCP] tools/call`, {
      toolName: name || 'unknown',
      hasName: !!name,
      hasArgs: !!args,
      argKeys: args ? Object.keys(args) : [],
    });
    
    if (!name) {
      return res.json({
        jsonrpc: '2.0',
        id: requestId,
        error: {
          code: -32602,
          message: 'Invalid params: tool name required',
        },
      });
    }
    
    const result = await handleTool(name, args || {});
    
    // Log result (minimal, no PHI)
    if (result.error) {
      console.log(`[MCP] tools/call - ${name} ERROR`, {
        errorCode: result.status,
      });
    } else {
      console.log(`[MCP] tools/call - ${name} SUCCESS`);
    }
    
    if (result.error) {
      const status = result.status || 500;
      const errorCode = status === 400 ? -32602 : status === 401 || status === 403 ? -32001 : -32000;
      
      // Return safe error data (status and endpoint, not full payloads)
      const safeData = {
        status,
        endpoint: result.details?.endpoint || name,
      };

      // For diagnostics on reports endpoint, include upstream error payload (non-PII).
      if (result.details?.endpoint === '/conversations/reports' && result.details?.response) {
        safeData.response = result.details.response;
      }
      
      // Return JSON-RPC error (not HTTP error status)
      return res.json({
        jsonrpc: '2.0',
        id: requestId,
        error: {
          code: errorCode,
          message: result.error,
          data: safeData,
        },
      });
    }
    
    return res.json({
      jsonrpc: '2.0',
      id: requestId,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result ?? {}, null, 2),
          },
        ],
      },
    });
  }
  
  // Unknown method - return JSON-RPC error (not HTTP 400)
  console.log(`[MCP] ❌ Method not found: ${normalizedMethod}`);
  return res.json({
    jsonrpc: '2.0',
    id: requestId,
    error: {
      code: -32601,
      message: `Method not found: ${normalizedMethod || 'unknown'}`,
    },
  });
}

// JSON-RPC MCP handler - Compatible with OpenAI Agent Builder
app.post('/mcp', requireApiKey, mcpPostHandler);

// JSON-RPC MCP handler (alias)
app.post('/api/mcp', requireApiKey, mcpPostHandler);

// Error handler for JSON parse errors (must be after routes)
app.use((err, req, res, next) => {
  // Handle JSON parse errors specifically for /mcp and /api/mcp routes
  if ((req.path === '/mcp' || req.path === '/api/mcp') && err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.log(`[MCP] JSON parse error`);
    return res.json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error',
      },
    });
  }
  // For other errors, pass to default handler
  next(err);
});

// SSE MCP GET handler (shared)
function mcpSseHandler(req, res) {
  try {
    const acceptHeader = req.headers.accept || '';
    
    if (!acceptHeader.includes('text/event-stream')) {
      return res.status(405).json({
        error: 'Method not allowed',
        message: 'Use POST for JSON-RPC. GET requires Accept: text/event-stream',
      });
    }
    
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    
    // Send initial status
    res.write(`event: status\n`);
    res.write(`data: ${JSON.stringify({ ok: true })}\n\n`);
    
    // Send ping every 25 seconds
    const pingInterval = setInterval(() => {
      try {
        res.write(`event: ping\n`);
        res.write(`data: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
      } catch (error) {
        // Client disconnected
        clearInterval(pingInterval);
      }
    }, 25000);
    
    // Handle client disconnect
    req.on('close', () => {
      clearInterval(pingInterval);
      res.end();
    });
    
    // Handle errors
    req.on('error', (err) => {
      clearInterval(pingInterval);
      console.error('[MCP] SSE request error:', err);
    });
    
    res.on('error', (err) => {
      clearInterval(pingInterval);
      console.error('[MCP] SSE response error:', err);
    });
  } catch (error) {
    console.error('[MCP] SSE handler error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to establish SSE connection',
      });
    }
  }
}

// SSE MCP status stream
app.get('/mcp', requireApiKey, mcpSseHandler);

// SSE MCP status stream (alias)
app.get('/api/mcp', requireApiKey, mcpSseHandler);

// ============================================================================
// Error Handling
// ============================================================================

app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', err);
  
  // Don't send JSON if headers already sent (e.g., SSE stream)
  if (res.headersSent) {
    return next(err);
  }
  
  // Check if this is an SSE request that failed
  const isSSE = req.path === '/mcp' || req.path === '/api/mcp';
  const isGET = req.method === 'GET';
  const wantsSSE = req.headers.accept && req.headers.accept.includes('text/event-stream');
  
  if (isSSE && isGET && wantsSSE) {
    // For SSE errors, try to send error event
    try {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ error: 'Internal server error', message: 'An unexpected error occurred' })}\n\n`);
      res.end();
      return;
    } catch (writeError) {
      // If write fails, connection is likely closed
      return;
    }
  }
  
  res.status(500).json({
    error: 'Internal server error',
    message: 'An unexpected error occurred',
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
  });
});

// ============================================================================
// Start Server
// ============================================================================

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  // Re-read env vars at startup to ensure they're loaded
  const pitToken = process.env.GHL_PIT_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  const mcpKey = process.env.MCP_API_KEY;
  
  console.log(`[GHL MCP Gateway] Server listening on ${HOST}:${PORT}`);
  console.log(`[GHL MCP Gateway] API Base: ${GHL_API_BASE}`);
  console.log(`[GHL MCP Gateway] API Version: ${GHL_API_VERSION}`);
  console.log(`[GHL MCP Gateway] Location ID: ${locationId ? '***' + locationId.slice(-4) : 'NOT SET'}`);
  console.log(`[GHL MCP Gateway] PIT Token: ${pitToken ? 'SET' : 'NOT SET'}`);
  console.log(`[GHL MCP Gateway] MCP API Key: ${mcpKey ? 'SET' : 'NOT SET'}`);
  
  // Log missing keys if any
  const missing = [];
  if (!pitToken) missing.push('GHL_PIT_TOKEN');
  if (!locationId) missing.push('GHL_LOCATION_ID');
  if (!mcpKey) missing.push('MCP_API_KEY');
  
  if (missing.length > 0) {
    console.warn(`[GHL MCP Gateway] ⚠️  Missing environment variables: ${missing.join(', ')}`);
  } else {
    console.log(`[GHL MCP Gateway] ✅ All required environment variables loaded`);
  }
});

module.exports = app;
