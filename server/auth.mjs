import crypto from 'node:crypto';

const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;

export class Auth {
  constructor(store) {
    this.store = store;
    this.tokens = new Map();
  }

  login(username, password) {
    if (!this.store.verifyLogin(username, password)) return null;
    const token = crypto.randomBytes(24).toString('hex');
    this.tokens.set(token, Date.now() + TOKEN_TTL_MS);
    this._gc();
    return token;
  }

  verify(token) {
    const exp = this.tokens.get(String(token || ''));
    if (!exp) return false;
    if (Date.now() > exp) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  logout(token) {
    this.tokens.delete(String(token || ''));
  }

  _gc() {
    const now = Date.now();
    for (const [token, exp] of this.tokens) {
      if (now > exp) this.tokens.delete(token);
    }
  }
}

export function bearerToken(req) {
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1] : '';
}