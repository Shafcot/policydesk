import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config.js';
export const hashPassword = (pw) => bcrypt.hash(pw, 11);
export const checkPassword = (pw, hash) => bcrypt.compare(pw, hash);
export const signToken = (p) => jwt.sign(p, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
export const verifyToken = (token) => jwt.verify(token, env.JWT_SECRET);
//# sourceMappingURL=auth.js.map