import { ZodError } from 'zod';
export class HttpError extends Error {
    status;
    code;
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
export const notFound = (what = 'Not found') => new HttpError(404, what, 'not_found');
export const forbidden = (why = 'You do not have access to this') => new HttpError(403, why, 'forbidden');
export const badRequest = (why) => new HttpError(400, why, 'bad_request');
/** Wraps an async route so thrown errors reach the error handler. */
export const ah = (fn) => (req, res, next) => { fn(req, res, next).catch(next); };
export function errorHandler(err, _req, res, _next) {
    if (err instanceof ZodError) {
        return res.status(400).json({ error: 'Some fields are invalid', code: 'validation', issues: err.issues });
    }
    if (err instanceof HttpError)
        return res.status(err.status).json({ error: err.message, code: err.code });
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong on the server', code: 'internal' });
}
//# sourceMappingURL=http.js.map