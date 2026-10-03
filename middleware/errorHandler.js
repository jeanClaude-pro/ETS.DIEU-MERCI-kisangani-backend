// Final JSON handlers. Express's built-in handler renders an HTML page that
// includes the stack trace (and so server file paths) whenever NODE_ENV is
// not "production" — these never send internals to the client.

function notFoundHandler(req, res) {
  res.status(404).json({ message: "Resource not found", error: "Resource not found" });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  // Malformed JSON, oversized bodies and similar client-side problems.
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Invalid request", error: "Invalid request" });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ message: "Request too large", error: "Request too large" });
  }
  if (err?.message === "Not allowed by CORS") {
    return res.status(403).json({ message: "Forbidden", error: "Forbidden" });
  }

  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) {
    console.error("Unhandled request error:", err?.name, err?.message);
  }
  const message = status === 500 ? "Internal server error" : "Invalid request";
  return res.status(status).json({ message, error: message });
}

module.exports = { notFoundHandler, errorHandler };
