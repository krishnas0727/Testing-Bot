/**
 * @file middleware.ts
 * @description Phase 13: Core API Middleware
 *
 * Implements authentication, role-based authorization, rate limiting,
 * request ID tracking, CORS headers, idempotency checks, and sensitive data scrubbing.
 */

import {
  ApiRequest,
  ApiResponseWriter,
  MiddlewareHandler,
  UserRole,
  AuthUser,
} from "../types";

// In-memory valid API keys for testing & development
const DEFAULT_API_KEYS: Record<string, AuthUser> = {
  "admin-secret-key-999": {
    id: "user-admin-1",
    username: "superadmin",
    role: "ADMIN",
  },
  "operator-key-456": {
    id: "user-op-1",
    username: "arbitrage-operator",
    role: "OPERATOR",
  },
  "viewer-readonly-key-123": {
    id: "user-view-1",
    username: "dashboard-viewer",
    role: "VIEWER",
  },
};

// ─────────────────────────────────────────────────────────────────────────
// 1. REQUEST ID & STRUCTURED LOGGING MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────

export const requestIdMiddleware: MiddlewareHandler = async (req, res, next) => {
  const reqId =
    (req.headers["x-request-id"] as string) ||
    `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  req.requestId = reqId;
  res.header("X-Request-ID", reqId);

  const start = Date.now();
  console.log(`[HTTP Request] [${reqId}] ${req.method} ${req.pathname} from ${req.clientIp}`);

  await next();

  const duration = Date.now() - start;
  console.log(`[HTTP Response] [${reqId}] ${req.method} ${req.pathname} (${duration}ms)`);
};

// ─────────────────────────────────────────────────────────────────────────
// 2. CORS & SECURITY HEADERS MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────

export const corsMiddleware: MiddlewareHandler = async (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-API-Key, X-Request-ID, Idempotency-Key"
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  await next();
};

export const securityHeadersMiddleware: MiddlewareHandler = async (_req, res, next) => {
  res.header("X-Content-Type-Options", "nosniff");
  res.header("X-Frame-Options", "DENY");
  res.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.header("Referrer-Policy", "strict-origin-when-cross-origin");
  res.header("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  res.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; img-src 'self' data:;"
  );
  await next();
};

// ─────────────────────────────────────────────────────────────────────────
// 3. RATE LIMITING MIDDLEWARE (Sliding Window)
// ─────────────────────────────────────────────────────────────────────────

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

const rateLimitStore = new Map<string, RateLimitRecord>();

export function createRateLimiter(options: {
  maxRequests: number;
  windowMs: number;
}): MiddlewareHandler {
  return async (req, res, next) => {
    const key = req.clientIp || "unknown";
    const now = Date.now();
    const record = rateLimitStore.get(key);

    if (!record || now > record.resetTime) {
      rateLimitStore.set(key, {
        count: 1,
        resetTime: now + options.windowMs,
      });
      res.header("X-RateLimit-Limit", options.maxRequests.toString());
      res.header("X-RateLimit-Remaining", (options.maxRequests - 1).toString());
      await next();
      return;
    }

    if (record.count >= options.maxRequests) {
      res.status(429).json({
        success: false,
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: `Too many requests. Limit is ${options.maxRequests} requests per ${options.windowMs / 1000}s.`,
        },
        requestId: req.requestId,
        timestamp: now,
      });
      return;
    }

    record.count++;
    res.header("X-RateLimit-Limit", options.maxRequests.toString());
    res.header("X-RateLimit-Remaining", (options.maxRequests - record.count).toString());
    await next();
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 4. AUTHENTICATION MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────

export const authMiddleware: MiddlewareHandler = async (req, res, next) => {
  // Public paths that do not require authentication
  if (
    req.pathname === "/api/health" ||
    req.pathname === "/api/health/ready" ||
    req.pathname === "/" ||
    req.pathname.startsWith("/dashboard") ||
    req.pathname.endsWith(".html") ||
    req.pathname.endsWith(".css") ||
    req.pathname.endsWith(".js") ||
    req.pathname.endsWith(".ico")
  ) {
    await next();
    return;
  }

  // Check X-API-Key header
  const apiKey = (req.headers["x-api-key"] as string) || "";
  if (apiKey && DEFAULT_API_KEYS[apiKey]) {
    req.user = DEFAULT_API_KEYS[apiKey];
    await next();
    return;
  }

  // Check Authorization Bearer header
  const authHeader = (req.headers["authorization"] as string) || "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    if (DEFAULT_API_KEYS[token]) {
      req.user = DEFAULT_API_KEYS[token];
      await next();
      return;
    }
  }

  res.status(401).json({
    success: false,
    error: {
      code: "UNAUTHORIZED",
      message: "Missing or invalid authentication credentials. Provide a valid X-API-Key or Bearer token.",
    },
    requestId: req.requestId,
    timestamp: Date.now(),
  });
};

// ─────────────────────────────────────────────────────────────────────────
// 5. ROLE-BASED AUTHORIZATION GUARD
// ─────────────────────────────────────────────────────────────────────────

const ROLE_HIERARCHY: Record<UserRole, number> = {
  ADMIN: 3,
  OPERATOR: 2,
  VIEWER: 1,
};

export function requireRole(minimumRole: UserRole): MiddlewareHandler {
  return async (req, res, next) => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication required to access this resource",
        },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
      return;
    }

    const userLevel = ROLE_HIERARCHY[req.user.role] || 0;
    const requiredLevel = ROLE_HIERARCHY[minimumRole] || 0;

    if (userLevel < requiredLevel) {
      res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: `Insufficient permissions. Required role: ${minimumRole}, current role: ${req.user.role}`,
        },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
      return;
    }

    await next();
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 6. SENSITIVE DATA SCRUBBER (Zero Secret Leakage)
// ─────────────────────────────────────────────────────────────────────────

const SENSITIVE_KEYS = new Set([
  "privatekey",
  "private_key",
  "mnemonic",
  "secret",
  "apikey",
  "deployer_private_key",
  "password",
]);

export function scrubSensitiveData(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map(scrubSensitiveData);
  }

  const clean: Record<string, any> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      clean[key] = "[REDACTED_SECRET]";
    } else if (typeof val === "object") {
      clean[key] = scrubSensitiveData(val);
    } else {
      clean[key] = val;
    }
  }
  return clean;
}

// ─────────────────────────────────────────────────────────────────────────
// 7. IDEMPOTENCY MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────

const processedIdempotencyKeys = new Map<string, { response: any; timestamp: number }>();

export const idempotencyMiddleware: MiddlewareHandler = async (req, res, next) => {
  if (req.method === "POST" || req.method === "PUT") {
    const key = req.headers["idempotency-key"] as string;
    if (key) {
      const existing = processedIdempotencyKeys.get(key);
      if (existing) {
        res.status(200).json(existing.response);
        return;
      }

      const origJson = res.json.bind(res);
      res.json = (data: any) => {
        processedIdempotencyKeys.set(key, { response: data, timestamp: Date.now() });
        origJson(data);
      };
    }
  }
  await next();
};
