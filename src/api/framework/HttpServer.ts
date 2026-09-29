/**
 * @file HttpServer.ts
 * @description Phase 13: Lightweight Zero-Dependency REST Framework
 *
 * Implements an Express-style HTTP server with route parameter matching,
 * middleware execution pipeline, query string parsing, JSON payload handling,
 * and centralized error formatting on top of Node.js native http module.
 */

import * as http from "http";
import { URL } from "url";
import {
  ApiRequest,
  ApiResponseWriter,
  ApiResponseData,
  HttpMethod,
  MiddlewareHandler,
  RouteHandler,
} from "../types";

interface RouteEntry {
  method: HttpMethod;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export class HttpServer {
  private server: http.Server | null = null;
  private readonly middlewares: MiddlewareHandler[] = [];
  private readonly routes: RouteEntry[] = [];
  private notFoundHandler: RouteHandler;
  private errorHandler: (err: any, req: ApiRequest, res: ApiResponseWriter) => void;

  constructor() {
    this.notFoundHandler = async (req, res) => {
      res.status(404).json({
        success: false,
        error: {
          code: "NOT_FOUND",
          message: `Endpoint ${req.method} ${req.pathname} not found`,
        },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    };

    this.errorHandler = (err, req, res) => {
      console.error(`[API Error] [${req.requestId}]`, err);
      const statusCode = err.statusCode || 500;
      res.status(statusCode).json({
        success: false,
        error: {
          code: err.code || "INTERNAL_SERVER_ERROR",
          message: err.message || "An unexpected error occurred",
          details: err.details,
        },
        requestId: req.requestId,
        timestamp: Date.now(),
      });
    };
  }

  /**
   * Registers global middleware.
   */
  public use(middleware: MiddlewareHandler): this {
    this.middlewares.push(middleware);
    return this;
  }

  /**
   * Registers a route pattern.
   */
  public route(method: HttpMethod, path: string, handler: RouteHandler): this {
    const paramNames: string[] = [];
    const regexPattern = path
      .replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
        paramNames.push(name);
        return "([^/]+)";
      })
      .replace(/\//g, "\\/");

    const pattern = new RegExp(`^${regexPattern}$`);
    this.routes.push({ method, pattern, paramNames, handler });
    return this;
  }

  public get(path: string, handler: RouteHandler): this {
    return this.route("GET", path, handler);
  }

  public post(path: string, handler: RouteHandler): this {
    return this.route("POST", path, handler);
  }

  public put(path: string, handler: RouteHandler): this {
    return this.route("PUT", path, handler);
  }

  public patch(path: string, handler: RouteHandler): this {
    return this.route("PATCH", path, handler);
  }

  public delete(path: string, handler: RouteHandler): this {
    return this.route("DELETE", path, handler);
  }

  /**
   * Handles incoming HTTP requests.
   */
  public async handleRequest(rawReq: http.IncomingMessage, rawRes: http.ServerResponse): Promise<void> {
    const parsedUrl = new URL(rawReq.url || "/", `http://${rawReq.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;
    const query: Record<string, string> = {};
    parsedUrl.searchParams.forEach((val, key) => {
      query[key] = val;
    });

    const bodyBuffer: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      rawReq.on("data", (chunk) => bodyBuffer.push(chunk));
      rawReq.on("end", () => resolve());
      rawReq.on("error", reject);
    });

    let body: any = {};
    const rawBodyStr = Buffer.concat(bodyBuffer).toString("utf-8");
    if (rawBodyStr.trim()) {
      try {
        body = JSON.parse(rawBodyStr);
      } catch {
        body = rawBodyStr;
      }
    }

    const requestId = (rawReq.headers["x-request-id"] as string) || `req_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const clientIp = (rawReq.headers["x-forwarded-for"] as string) || rawReq.socket.remoteAddress || "127.0.0.1";

    const req: ApiRequest = {
      method: (rawReq.method?.toUpperCase() as HttpMethod) || "GET",
      url: rawReq.url || "/",
      pathname,
      params: {},
      query,
      headers: rawReq.headers,
      body,
      requestId,
      clientIp,
      timestamp: Date.now(),
    };

    let sent = false;
    let statusCode = 200;
    const headersOut: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Request-ID": requestId,
    };

    const res: ApiResponseWriter = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      header(key: string, value: string) {
        headersOut[key] = value;
        return this;
      },
      hasSent() {
        return sent;
      },
      json<T>(data: ApiResponseData<T>) {
        if (sent) return;
        sent = true;
        const serialized = JSON.stringify(data);
        headersOut["Content-Type"] = "application/json";
        rawRes.writeHead(statusCode, headersOut);
        rawRes.end(serialized);
      },
      send(content: string, contentType: string = "text/plain") {
        if (sent) return;
        sent = true;
        headersOut["Content-Type"] = contentType;
        rawRes.writeHead(statusCode, headersOut);
        rawRes.end(content);
      },
    };

    try {
      // Execute middleware chain
      let index = 0;
      const next = async (): Promise<void> => {
        if (index < this.middlewares.length) {
          const currentMiddleware = this.middlewares[index++];
          await currentMiddleware(req, res, next);
        } else {
          // Dispatch to route handler
          await this.dispatchRoute(req, res);
        }
      };

      await next();
    } catch (err: any) {
      if (!res.hasSent()) {
        this.errorHandler(err, req, res);
      }
    }
  }

  /**
   * Matches request to route and dispatches.
   */
  private async dispatchRoute(req: ApiRequest, res: ApiResponseWriter): Promise<void> {
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const match = req.pathname.match(route.pattern);
      if (match) {
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1]);
        });
        req.params = params;
        await route.handler(req, res);
        return;
      }
    }

    await this.notFoundHandler(req, res);
  }

  /**
   * Starts listening on the given port.
   */
  public async listen(port: number, host: string = "0.0.0.0"): Promise<http.Server> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(port, host, () => {
        resolve(this.server!);
      });
    });
  }

  /**
   * Closes the server.
   */
  public async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
