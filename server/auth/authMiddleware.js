import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

/* -------- ACCESS TOKEN -------- */

export function signAccessToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      username: user.username
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

/* -------- PASSWORD RESET TOKEN -------- */

export function signResetToken(userId) {
  return jwt.sign(
    { id: userId, type: "reset" },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
}

/* -------- AUTH MIDDLEWARE -------- */

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;

  if (!header) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = header.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    if (req.user.id && !req.user.userId) req.user.userId = req.user.id;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
}

export function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return next();
  
  const token = header.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    if (req.user.id && !req.user.userId) req.user.userId = req.user.id;
  } catch (err) {}
  next();
}

export function verifyWsToken(token) {
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET()); }
  catch { return null; }
}