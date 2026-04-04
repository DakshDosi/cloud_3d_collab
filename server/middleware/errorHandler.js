export function errorHandler(err, req, res, next) {
  console.error(err);

  res.status(err.status || 500).json({
    error: err.message || "Internal server error"
  });
}

export function requestLogger(req, res, next) {
  console.log(`${req.method} ${req.url}`);
  next();
}

export function notFound(req, res) {
  res.status(404).json({ error: `${req.method} ${req.path} not found` });
}