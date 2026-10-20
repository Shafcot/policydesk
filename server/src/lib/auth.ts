import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config.js';
import type { Role } from '../domain.js';

export type TokenPayload = { sub: string; agencyId: string; role: Role };

export const hashPassword = (pw: string) => bcrypt.hash(pw, 11);
export const checkPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);
export const signToken = (p: TokenPayload) =>
  jwt.sign(p, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions);
export const verifyToken = (token: string) => jwt.verify(token, env.JWT_SECRET) as TokenPayload & jwt.JwtPayload;
