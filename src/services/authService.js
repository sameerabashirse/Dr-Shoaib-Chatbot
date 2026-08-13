const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { StaffUser, RefreshTokenSession } = require("../models");
const { config } = require("../config/env");
const { badRequest, conflict, forbidden, unauthorized, notFound } = require("../utils/errors");
const { randomToken, sha256 } = require("../utils/security");
const { refreshCookieName } = require("../middleware/auth");

const lockoutAttempts = 5;
const lockoutMinutes = 15;

function validatePassword(password) {
  const value = String(password || "");
  if (value.length < 12) return "Password must be at least 12 characters long.";
  if (!/[A-Z]/.test(value)) return "Password must include an uppercase letter.";
  if (!/[a-z]/.test(value)) return "Password must include a lowercase letter.";
  if (!/\d/.test(value)) return "Password must include a number.";
  if (!/[^A-Za-z0-9]/.test(value)) return "Password must include a symbol.";
  return "";
}

async function setupRequired() {
  const filter = config.isProduction
    ? { isActive: true, email: { $not: /@drsohaibdemo\.com$/i } }
    : {};
  const count = await StaffUser.countDocuments(filter);
  return count === 0;
}

async function createStaffUser({ name, email, password, role = "receptionist" }) {
  const passwordError = validatePassword(password);
  if (passwordError) throw badRequest(passwordError);
  const exists = await StaffUser.findOne({ email: String(email).toLowerCase() });
  if (exists) throw conflict("A staff user with this email already exists.");
  const passwordHash = await bcrypt.hash(password, 12);
  return StaffUser.create({ name, email, passwordHash, role });
}

async function setupSuperAdmin(input) {
  if (!(await setupRequired())) throw conflict("Super Admin has already been configured.");
  return createStaffUser({ ...input, role: "super_admin" });
}

function signAccessToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), role: user.role, name: user.name },
    config.jwtAccessSecret,
    { expiresIn: config.accessTokenTtl }
  );
}

async function issueRefreshToken(user, req) {
  const token = randomToken(64);
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
  await RefreshTokenSession.create({
    staffUser: user._id,
    tokenHash: sha256(token),
    userAgent: req?.get?.("user-agent"),
    ip: req?.ip,
    expiresAt
  });
  return { token, expiresAt };
}

function setRefreshCookie(res, token, expiresAt) {
  res.cookie(refreshCookieName, token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "lax",
    signed: true,
    expires: expiresAt,
    path: "/api/auth"
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(refreshCookieName, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "lax",
    signed: true,
    path: "/api/auth"
  });
}

async function login({ email, password }, req, res) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (config.isProduction && /@drsohaibdemo\.com$/i.test(normalizedEmail)) {
    throw unauthorized("Invalid email or password.");
  }
  const user = await StaffUser.findOne({ email: normalizedEmail }).select("+passwordHash");
  if (!user || !user.isActive) throw unauthorized("Invalid email or password.");

  if (user.lockUntil && user.lockUntil > new Date()) {
    throw forbidden("Account is temporarily locked after repeated failed login attempts.");
  }

  const matches = await bcrypt.compare(String(password || ""), user.passwordHash);
  if (!matches) {
    user.failedLoginAttempts += 1;
    if (user.failedLoginAttempts >= lockoutAttempts) {
      user.lockUntil = new Date(Date.now() + lockoutMinutes * 60 * 1000);
    }
    await user.save();
    throw unauthorized("Invalid email or password.");
  }

  user.failedLoginAttempts = 0;
  user.lockUntil = undefined;
  user.lastLoginAt = new Date();
  await user.save();

  const accessToken = signAccessToken(user);
  const refresh = await issueRefreshToken(user, req);
  setRefreshCookie(res, refresh.token, refresh.expiresAt);
  return { accessToken, user: publicStaffUser(user) };
}

async function refresh(req, res) {
  const token = req.signedCookies?.[refreshCookieName];
  if (!token) throw unauthorized("Refresh session is missing.");
  const session = await RefreshTokenSession.findOne({
    tokenHash: sha256(token),
    revokedAt: { $exists: false },
    expiresAt: { $gt: new Date() }
  }).populate("staffUser");

  if (!session || !session.staffUser || !session.staffUser.isActive) {
    clearRefreshCookie(res);
    throw unauthorized("Refresh session is invalid.");
  }

  session.revokedAt = new Date();
  await session.save();

  const accessToken = signAccessToken(session.staffUser);
  const nextRefresh = await issueRefreshToken(session.staffUser, req);
  setRefreshCookie(res, nextRefresh.token, nextRefresh.expiresAt);
  return { accessToken, user: publicStaffUser(session.staffUser) };
}

async function logout(req, res) {
  const token = req.signedCookies?.[refreshCookieName];
  if (token) {
    await RefreshTokenSession.updateOne({ tokenHash: sha256(token) }, { $set: { revokedAt: new Date() } });
  }
  clearRefreshCookie(res);
}

function publicStaffUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive
  };
}

async function listStaffUsers() {
  const users = await StaffUser.find().sort({ createdAt: -1 });
  return users.map(publicStaffUser);
}

async function updateStaffUser(id, input) {
  const updates = {};
  ["name", "role", "isActive"].forEach((key) => {
    if (input[key] !== undefined) updates[key] = input[key];
  });
  const user = await StaffUser.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true });
  if (!user) throw notFound("Staff user was not found.");
  return publicStaffUser(user);
}

module.exports = {
  validatePassword,
  setupRequired,
  setupSuperAdmin,
  createStaffUser,
  login,
  refresh,
  logout,
  publicStaffUser,
  listStaffUsers,
  updateStaffUser
};
