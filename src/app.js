const path = require("path");
const { randomUUID } = require("crypto");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const compression = require("compression");
const mongoSanitize = require("express-mongo-sanitize");
const { config } = require("./config/env");
const { apiLimiter, strictOrigin } = require("./middleware/security");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");

function createApp() {
  const app = express();
  const rootDir = path.resolve(__dirname, "..");

  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    const incoming = String(req.get("x-request-id") || "");
    req.requestId = /^[a-zA-Z0-9._-]{8,100}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    next();
  });

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"]
      }
    }
  }));
  app.use(compression());
  app.use(cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (config.corsOrigins.includes(origin)) return callback(null, true);
      return callback(null, true);
    },
    credentials: true
  }));
  app.use(express.json({
    limit: "10mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  }));
  app.use(express.urlencoded({ extended: false, limit: "10mb" }));
  app.use(cookieParser(config.cookieSecret));
  const sanitizeRequest = mongoSanitize();
  app.use((req, res, next) => {
    // Meta requires dotted query parameter names for webhook verification.
    // The route performs no database query and validates the token itself.
    if (req.method === "GET" && req.path === "/api/whatsapp/webhook") return next();
    return sanitizeRequest(req, res, next);
  });
  app.use(strictOrigin);
  app.use("/api", apiLimiter);

  // Mount API Routes
  app.use("/api/auth", require("./routes/auth"));
  app.use("/api/appointments", require("./routes/appointments"));
  app.use("/api/availability", require("./routes/availability"));
  app.use("/api/whatsapp", require("./routes/whatsapp"));
  app.use("/api/settings", require("./routes/settings"));
  app.use("/api/clinic-locations", require("./routes/locations"));
  app.use("/api/clinics", require("./routes/locations"));
  app.use("/api/doctors", require("./routes/doctors"));
  app.use("/api/health", require("./routes/health"));
  app.use("/api/dashboard", require("./routes/dashboard"));
  app.use("/api/reports", require("./routes/reports"));
  app.use("/api/consultations", require("./routes/consultations"));
  app.use("/api/online-consultations", require("./routes/consultations"));
  app.use("/api/emergencies", require("./routes/emergencies"));
  app.use("/api/emergency-alerts", require("./routes/emergencies"));
  app.use("/api/conversations", require("./routes/conversations"));
  app.use("/api/patients", require("./routes/patients"));
  app.use("/api/reminders", require("./routes/reminders"));

  app.use(express.static(rootDir, {
    index: false,
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-store");
    }
  }));

  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(rootDir, "index.html"));
  });

  app.use("/api", notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
