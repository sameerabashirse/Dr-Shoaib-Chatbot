const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.CORS_ORIGINS = "https://clinic.example";
process.env.FRONTEND_URL = "https://clinic.example";

const { config } = require("../src/config/env");
const { createApp } = require("../src/app");
const { StaffUser, Counter } = require("../src/models");
const { setupSuperAdmin, setRefreshCookie } = require("../src/services/authService");
const { inspectInitialData } = require("../server");
const { safeError, safeMetadata, sanitizeText } = require("../src/utils/safeLogger");
const { auditDemoAccounts } = require("../scripts/audit-demo-accounts");

let mongod;

function productionEnvironment(overrides = {}) {
  return {
    ...process.env,
    DOTENV_CONFIG_PATH: path.join(__dirname, "nonexistent.env"),
    NODE_ENV: "production",
    PORT: "3999",
    MONGODB_URI: "mongodb://dbuser:UltraSecretDatabasePassword123!@127.0.0.1:1/clinic?authSource=admin",
    JWT_ACCESS_SECRET: "g7N!2pQ#8vR$4xZ@9mK%6cT&3wY*5uHs",
    JWT_REFRESH_SECRET: "r4F!8dL#2sW$7qP@6vX%9mN&5kT*3zBc",
    COOKIE_SECRET: "c9H!3nM#7xK$2wQ@8pR%4vZ&6sY*5dLf",
    FRONTEND_URL: "https://clinic.example",
    CORS_ORIGINS: "https://clinic.example",
    TRUST_PROXY: "1",
    CLINIC_TIMEZONE: "Asia/Karachi",
    CLINIC_CONTACT_NUMBER: "+923001112222",
    DEFAULT_CLINIC_LOCATION_CODE: "BWP",
    PUBLIC_WHATSAPP_NUMBER: "+923003334444",
    ADMIN_PANEL_URL: "https://clinic.example/#/admin",
    APPOINTMENT_CONSENT_TEXT: "The clinic uses submitted information to manage appointments and reminders.",
    APPOINTMENT_CONSENT_VERSION: "consent-v1",
    WHATSAPP_GRAPH_VERSION: "v20.0",
    WHATSAPP_ACCESS_TOKEN: "EAAGStrongProductionAccessToken9876543210",
    WHATSAPP_PHONE_NUMBER_ID: "123456789012345",
    WHATSAPP_BUSINESS_ACCOUNT_ID: "987654321098765",
    WHATSAPP_VERIFY_TOKEN: "VerifyTokenStrongRandomValue987654321",
    META_APP_SECRET: "MetaAppSecretStrongRandomValue987654321",
    WHATSAPP_TEMPLATE_APPOINTMENT_CONFIRMATION: "appointment_confirmation_v1",
    WHATSAPP_TEMPLATE_APPOINTMENT_CONFIRMATION_LANGUAGE: "en_US",
    WHATSAPP_TEMPLATE_APPOINTMENT_REMINDER: "appointment_reminder_v1",
    WHATSAPP_TEMPLATE_APPOINTMENT_REMINDER_LANGUAGE: "en_US",
    WHATSAPP_TEMPLATE_RESCHEDULE_CONFIRMATION: "reschedule_confirmation_v1",
    WHATSAPP_TEMPLATE_RESCHEDULE_CONFIRMATION_LANGUAGE: "en_US",
    WHATSAPP_TEMPLATE_CANCELLATION_CONFIRMATION: "cancellation_confirmation_v1",
    WHATSAPP_TEMPLATE_CANCELLATION_CONFIRMATION_LANGUAGE: "en_US",
    EMAIL_ENABLED: "true",
    EMAIL_HOST: "smtp.clinic.test",
    EMAIL_PORT: "587",
    EMAIL_USER: "smtp-user",
    EMAIL_PASSWORD: "StrongSmtpCredential987654321",
    EMAIL_FROM: "notifications@clinic.test",
    EMAIL_FROM_NAME: "Clinic Notifications",
    OWNER_EMAIL: "owner@clinic.test",
    EMAIL_SECURE: "false",
    STORAGE_PROVIDER: "s3",
    STORAGE_ENDPOINT: "https://storage.clinic.test",
    STORAGE_REGION: "pk-1",
    STORAGE_BUCKET: "clinic-private-files",
    STORAGE_ACCESS_KEY_ID: "StorageAccessKey987654321",
    STORAGE_SECRET_ACCESS_KEY: "StorageSecretKeyStrong987654321",
    STORAGE_MAX_UPLOAD_BYTES: "10485760",
    STORAGE_SIGNED_URL_EXPIRY_SECONDS: "300",
    ...overrides
  };
}

function runNode(args, env) {
  return spawnSync(process.execPath, args, {
    cwd: path.resolve(__dirname, ".."),
    env,
    encoding: "utf8",
    timeout: 15_000
  });
}

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { autoIndex: true });
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  await Promise.all([StaffUser.deleteMany({}), Counter.deleteMany({})]);
});

test("startup inspection never creates demo or other staff accounts", async () => {
  assert.deepEqual(await inspectInitialData(), { staffCount: 0, locationCount: 0 });
  assert.equal(await StaffUser.countDocuments(), 0);
});

test("demo-account audit is read-only and reports only safe account metadata", async () => {
  await StaffUser.create({
    name: "Legacy Demo",
    email: "admin@drsohaibdemo.com",
    passwordHash: "not-selected-by-audit",
    role: "super_admin",
    isActive: true
  });
  const result = await auditDemoAccounts();
  assert.equal(result.length, 1);
  assert.equal(result[0].email, "admin@drsohaibdemo.com");
  assert.equal("passwordHash" in result[0], false);
  assert.equal(await StaffUser.countDocuments(), 1);
});

test("Super Admin bootstrap requires a strong password and works only once", async () => {
  await assert.rejects(() => setupSuperAdmin({ name: "Owner", email: "owner@clinic.test", password: "weak" }), /at least 12/);
  const user = await setupSuperAdmin({ name: "Clinic Owner", email: "owner@clinic.test", password: "Str0ng!UniqueClinicRoot2026" });
  assert.equal(user.role, "super_admin");
  await assert.rejects(() => setupSuperAdmin({ name: "Second", email: "second@clinic.test", password: "An0ther!UniqueRootValue2026" }), /already/);
  assert.equal(await StaffUser.countDocuments(), 1);
});

test("destructive demo seeding is blocked in production before database access", () => {
  const result = runNode(["scripts/seed.js"], productionEnvironment());
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /MongoDB connected|External MongoDB|UltraSecretDatabasePassword123/);
});

test("missing or weak critical production variables stop configuration loading", () => {
  const missing = productionEnvironment();
  delete missing.JWT_ACCESS_SECRET;
  const absent = runNode(["-e", "require('./src/config/env')"], missing);
  assert.notEqual(absent.status, 0);
  assert.match(`${absent.stdout}${absent.stderr}`, /JWT_ACCESS_SECRET/);

  const weak = runNode(["-e", "require('./src/config/env')"], productionEnvironment({ COOKIE_SECRET: "short" }));
  assert.notEqual(weak.status, 0);
  assert.doesNotMatch(`${weak.stdout}${weak.stderr}`, /UltraSecretDatabasePassword123/);
});

test("a private MongoDB URI override replaces a stuck legacy hosting value", () => {
  const overrideUri = "mongodb://overrideuser:OverrideDatabasePassword987!@127.0.0.1:2/clinic?authSource=admin";
  const result = runNode(
    ["-e", "process.stdout.write(require('./src/config/env').config.mongoUri)"],
    productionEnvironment({ MONGODB_URI: "", MONGODB_URI_V2: overrideUri })
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, overrideUri);
});

test("production database failure never reveals its URI", () => {
  const result = runNode(["-e", `
    const { connectDatabase } = require('./src/config/db');
    const { logError } = require('./src/utils/safeLogger');
    connectDatabase()
      .then(() => process.exit(0))
      .catch((error) => {
        logError('Database startup attempt failed', error);
        process.exit(1);
      });
  `], productionEnvironment());
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(output, /UltraSecretDatabasePassword123|mongodb:\/\/dbuser/);
  assert.match(output, /Database startup attempt failed/);
});

test("safe logging removes database URIs, bearer tokens and secret assignments", () => {
  const input = "mongodb://user:secret@db.example/clinic Bearer abc.def.ghi password=hunter2";
  const sanitized = sanitizeText(input);
  assert.doesNotMatch(sanitized, /user:secret|abc\.def|hunter2/);
  assert.doesNotMatch(JSON.stringify(safeMetadata({ path: "/callback?token=hidden-value", password: "hidden-value" })), /hidden-value/);
  const prior = config.isProduction;
  config.isProduction = true;
  assert.equal("message" in safeError(new Error(input)), false);
  assert.equal(
    safeError(new Error("Missing required production environment variable: JWT_ACCESS_SECRET")).message,
    "Missing required production environment variable: JWT_ACCESS_SECRET"
  );
  assert.equal("message" in safeError(new Error("Database failed for internal reason")), false);
  config.isProduction = prior;
});

test("production HTTPS, CORS and sensitive-file protections remain active", async () => {
  const prior = { isProduction: config.isProduction, corsOrigins: config.corsOrigins };
  config.isProduction = true;
  config.corsOrigins = ["https://clinic.example"];
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const insecure = await fetch(`${base}/api/health`);
    assert.equal(insecure.status, 426);
    const cors = await fetch(`${base}/api/health`, { headers: { origin: "https://evil.example", "x-forwarded-proto": "https" } });
    assert.equal(cors.status, 403);
    for (const file of ["/.env", "/.env.example", "/package.json", "/package-lock.json", "/server.js", "/src/", "/src/config/env.js", "/scripts/", "/tests/", "/private-storage/", "/logs/app.log", "/data.db", "/..%2fpackage.json"]) {
      const response = await fetch(`${base}${file}`, { headers: { "x-forwarded-proto": "https" } });
      assert.equal(response.status, 404, file);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    config.isProduction = prior.isProduction;
    config.corsOrigins = prior.corsOrigins;
  }
});

test("production refresh cookies are Secure, HttpOnly and SameSite", () => {
  const prior = config.isProduction;
  config.isProduction = true;
  let captured;
  setRefreshCookie({ cookie(name, value, options) { captured = { name, value, options }; } }, "opaque-token", new Date(Date.now() + 60_000));
  config.isProduction = prior;
  assert.equal(captured.options.secure, true);
  assert.equal(captured.options.httpOnly, true);
  assert.equal(captured.options.sameSite, "lax");
  assert.equal(captured.options.signed, true);
});

test("Docker publishes no MongoDB port and runs the application non-root", () => {
  const compose = fs.readFileSync(path.resolve(__dirname, "../docker-compose.yml"), "utf8");
  const dockerfile = fs.readFileSync(path.resolve(__dirname, "../Dockerfile"), "utf8");
  assert.doesNotMatch(compose, /27017\s*:\s*27017/);
  assert.doesNotMatch(compose, /^\s+mongo:\s*$/m);
  assert.match(compose, /restart:\s+unless-stopped/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /HEALTHCHECK/);
});
