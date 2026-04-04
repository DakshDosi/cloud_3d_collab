// client/js/authManager.js
const API = `${location.protocol}//${location.hostname}:8080/api`;

class AuthManager {
  constructor() {
    this._token = localStorage.getItem('token');
    this._user  = JSON.parse(localStorage.getItem('user') || 'null');
  }

  isLoggedIn()  { return !!this._token; }
  getToken()    { return this._token; }
  getUser()     { return this._user; }

  async login(email, password) {
    const res  = await fetch(`${API}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();

    if (!res.ok) {
      // No account yet — auto-register
      if (data.error === 'Invalid credentials') {
        const username = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20) || 'user' + Date.now();
        return this.register(username, email, password);
      }
      throw new Error(data.error || 'Login failed');
    }

    this._save(data.token, data.user);
    return data;
  }

  async register(username, email, password) {
    const res  = await fetch(`${API}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    this._save(data.token, data.user);
    return data;
  }

  logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    this._token = null;
    this._user  = null;
    location.href = '/pages/login.html';
  }

  async authFetch(url, options = {}) {
    return fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(this._token ? { Authorization: `Bearer ${this._token}` } : {}),
        ...(options.headers || {})
      }
    });
  }

  _save(token, user) {
    this._token = token;
    this._user  = user;
    localStorage.setItem('token', token);
    localStorage.setItem('user',  JSON.stringify(user));
  }
}

export const auth = new AuthManager();