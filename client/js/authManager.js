const API = "http://localhost:8080/api";

class AuthManager {

  getToken() {
    return localStorage.getItem("token");
  }

  getUser() {
    return JSON.parse(localStorage.getItem("user"));
  }

  isLoggedIn() {
    return !!this.getToken();
  }

  async login(email, password) {
    const res = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Login failed");
    }

    localStorage.setItem("token", data.token);
    localStorage.setItem("user", JSON.stringify(data.user));

    return data;
  }

  async register(username, email, password) {
    const res = await fetch(`${API}/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ username, email, password })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Registration failed");
    }

    return data;
  }

  logout() {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    location.reload();
  }

  async authFetch(url, options = {}) {
    const token = this.getToken();

    options.headers = {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`
    };

    return fetch(url, options);
  }
}

export const auth = new AuthManager();