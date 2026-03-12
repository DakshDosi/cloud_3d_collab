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
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
}