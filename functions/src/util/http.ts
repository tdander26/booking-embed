import type { Request, Response, NextFunction } from 'express';
import { logger } from 'firebase-functions';

/** Throwable error that maps to an HTTP status + safe client message.
 * `details` is an optional safe-to-expose object (e.g. per-field validation
 * errors) merged into the JSON response. */
export class ApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg: string, code = 'bad_request', details?: Record<string, unknown>) =>
  new ApiError(400, code, msg, details);
export const notFound = (msg = 'Not found', code = 'not_found') =>
  new ApiError(404, code, msg);
export const conflict = (msg: string, code = 'conflict') =>
  new ApiError(409, code, msg);
export const unauthorized = (msg = 'Unauthorized', code = 'unauthorized') =>
  new ApiError(401, code, msg);
export const forbidden = (msg = 'Forbidden', code = 'forbidden') =>
  new ApiError(403, code, msg);
export const serverError = (msg = 'Server error', code = 'server_error') =>
  new ApiError(500, code, msg);

/** Wrap an async express handler so thrown errors hit the error middleware. */
export function wrap(
  fn: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** Express error-handling middleware (must be registered last). */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    const body: Record<string, unknown> = { error: err.code, message: err.message };
    if (err.details && typeof err.details === 'object') Object.assign(body, err.details);
    res.status(err.status).json(body);
    return;
  }
  // Log internals server-side only; never leak details (or PII) to the client.
  logger.error('Unhandled API error', err);
  res.status(500).json({ error: 'server_error', message: 'Something went wrong.' });
}
