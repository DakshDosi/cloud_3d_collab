// const API = "http://localhost:8080/api";

// class AuthManager {

//   getToken() {
//     return localStorage.getItem("token");
//   }

//   getUser() {
//     return JSON.parse(localStorage.getItem("user"));
//   }

//   isLoggedIn() {
//     return !!this.getToken();
//   }

//   async login(email, password) {
//     const res = await fetch(`${API}/auth/login`, {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json"
//       },
//       body: JSON.stringify({ email, password })
//     });

//     const data = await res.json();

//     if (!res.ok) {
//       throw new Error(data.error || "Login failed");
//     }

//     localStorage.setItem("token", data.token);
//     localStorage.setItem("user", JSON.stringify(data.user));

//     return data;
//   }

//   async register(username, email, password) {
//     const res = await fetch(`${API}/auth/register`, {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json"
//       },
//       body: JSON.stringify({ username, email, password })
//     });

//     const data = await res.json();

//     if (!res.ok) {
//       throw new Error(data.error || "Registration failed");
//     }

//     return data;
//   }

//   logout() {
//     localStorage.removeItem("token");
//     localStorage.removeItem("user");
//     location.reload();
//   }

//   async authFetch(url, options = {}) {
//     const token = this.getToken();

//     options.headers = {
//       ...(options.headers || {}),
//       Authorization: `Bearer ${token}`
//     };

//     return fetch(url, options);
//   }
// }

// export const auth = new AuthManager();


// client/js/authManager.js
// Client-side authentication: token storage, request helpers, login state.

const API = `${location.protocol}//${location.hostname}:8080/api`;

export class AuthManager {
  constructor() {
    this.token = localStorage.getItem('token');
    this.user  = JSON.parse(localStorage.getItem('user') || 'null');
    this._listeners = [];
  }

  // ── State ──────────────────────────────────────────────────────────────────
  isLoggedIn()  { return !!this.token && !!this.user; }
  getToken()    { return this.token; }
  getUser()     { return this.user; }
  getUserId()   { return this.user?.id; }
  getUsername() { return this.user?.username; }

  // ── Auth actions ───────────────────────────────────────────────────────────
  async login(email, password) {
    const res  = await this._post('/auth/login', { email, password });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    this._persist(data.token, data.user);
    return data;
  }

  async register(username, email, password) {
    const res  = await this._post('/auth/register', { username, email, password });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    this._persist(data.token, data.user);
    return data;
  }

  logout() {
    this.token = null;
    this.user  = null;
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    this._emit('logout');
    location.href = '/pages/login.html?redirect=' + encodeURIComponent(location.pathname);
  }

  async refreshMe() {
    if (!this.token) return;
    try {
      const res  = await this.authFetch('/auth/me');
      const data = await res.json();
      if (res.ok) {
        this.user = data.user;
        localStorage.setItem('user', JSON.stringify(data.user));
      } else if (res.status === 401) {
        this.logout();
      }
    } catch { /* network error — keep existing user */ }
  }

  // ── Authenticated fetch helpers ────────────────────────────────────────────
  async authFetch(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...(options.headers || {})
    };
    const res = await fetch(`${API}${path}`, { ...options, headers });

    if (res.status === 401) {
      this.logout();
    }
    return res;
  }

  async authGet(path) {
    return this.authFetch(path);
  }

  async authPost(path, body) {
    return this.authFetch(path, { method: 'POST', body: JSON.stringify(body) });
  }

  async authPatch(path, body) {
    return this.authFetch(path, { method: 'PATCH', body: JSON.stringify(body) });
  }

  async authDelete(path) {
    return this.authFetch(path, { method: 'DELETE' });
  }

  // ── WS URL builder (injects token into query string) ─────────────────────
  buildWsUrl(sceneId, host = null) {
    const base  = host || `ws://${location.hostname}:8080`;
    const params = new URLSearchParams({ ...(this.token ? { token: this.token } : {}) });
    return `${base}?${params}`;
  }

  // ── Guards ─────────────────────────────────────────────────────────────────
  requireAuth(redirectTo = null) {
    if (!this.isLoggedIn()) {
      const dest = redirectTo || location.pathname + location.search;
      location.href = `/pages/login.html?redirect=${encodeURIComponent(dest)}`;
      return false;
    }
    return true;
  }

  // ── Event subscriptions ────────────────────────────────────────────────────
  on(event, cb) {
    this._listeners.push({ event, cb });
    return () => { this._listeners = this._listeners.filter(l => l.cb !== cb); };
  }

  _emit(event, data) {
    this._listeners.filter(l => l.event === event).forEach(l => l.cb(data));
  }

  // ── Internals ──────────────────────────────────────────────────────────────
  _persist(token, user) {
    this.token = token;
    this.user  = user;
    localStorage.setItem('token', token);
    localStorage.setItem('user',  JSON.stringify(user));
    this._emit('login', user);
  }

  _post(path, body) {
    return fetch(`${API}${path}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    });
  }
}

// Singleton
export const auth = new AuthManager();
export default auth;