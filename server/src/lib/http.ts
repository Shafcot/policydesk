import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}
export const notFound = (what = 'Not found') => new HttpError(404, what, 'not_found');
export const forbidden = (why = 'You do not have access to this') => new HttpError(403, why, 'forbidden');
export const badRequest = (why: string) => new HttpError(400, why, 'bad_request');

/** Wraps an async route so thrown errors reach the error handler. */
export const ah = <T extends Request = Request>(fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req as T, res, next).catch(next); };

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Some fields are invalid', code: 'validation', issues: err.issues });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(err);
  return res.status(500).json({ error: 'Something went wrong on the server', code: 'internal' });
}
