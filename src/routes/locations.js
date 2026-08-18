const express = require("express");
const { z } = require("zod");
const { ClinicLocation } = require("../models");
const { listLocations } = require("../services/locationService");
const { requireAuth } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { asyncHandler } = require("../utils/asyncHandler");
const { badRequest } = require("../utils/errors");
const { audit } = require("../services/auditService");
const { requireObjectIdParam } = require("../middleware/validation");
const { updateLocation } = require("../services/scheduleService");

const router = express.Router();
const schema = z.object({
  clinicName: z.string().min(2).max(160), city: z.string().min(2).max(100),
  code: z.string().regex(/^[A-Za-z0-9]{2,10}$/), fullAddress: z.string().min(2).max(500),
  contactNumber: z.string().max(50).optional(), status: z.enum(["Active", "Inactive", "Coming Soon"]),
  timezone: z.string().min(3), slotDurationMinutes: z.number().int().min(5).max(240),
  sameDayBookingCutoffMinutes: z.number().int().min(0).max(1440),
  appointmentFee: z.number().min(0).optional(), displayOrder: z.number().int().optional(),
  currentDelayMinutes: z.number().int().min(0).max(480).optional(),
  weeklyHours: z.array(z.object({
    day: z.number().int().min(1).max(7),
    isOpen: z.boolean(),
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/)
  })).length(7),
  confirmExistingAppointments: z.boolean().optional()
}).strict();

function publicLocation(location) {
  return {
    id: location._id,
    clinicName: location.clinicName,
    city: location.city,
    code: location.code,
    fullAddress: location.fullAddress,
    contactNumber: location.contactNumber,
    status: location.status,
    isActive: location.status === "Active",
    bookingEnabled: location.status === "Active",
    timezone: location.timezone,
    weeklyHours: location.weeklyHours,
    slotDurationMinutes: location.slotDurationMinutes,
    sameDayBookingCutoffMinutes: location.sameDayBookingCutoffMinutes,
    appointmentFee: location.appointmentFee
  };
}

router.get("/public", asyncHandler(async (req, res) => res.json({ success: true, locations: (await listLocations()).map(publicLocation) })));
router.get("/bookable", asyncHandler(async (req, res) => res.json({ success: true, locations: (await listLocations({ bookableOnly: true })).map(publicLocation) })));
router.get("/", requireAuth, requirePermission("locations.read"), asyncHandler(async (req, res) => {
  const locations = (await listLocations()).map((location) => ({ ...location, isActive: location.status === "Active", bookingEnabled: location.status === "Active" }));
  res.json({ success: true, locations });
}));
router.post("/", requireAuth, requirePermission("locations.manage"), asyncHandler(async (req, res) => {
  const parsed = schema.safeParse(req.body); if (!parsed.success) throw badRequest("Validation failed", parsed.error.flatten());
  const input = { ...parsed.data };
  delete input.confirmExistingAppointments;
  const location = await ClinicLocation.create({ ...input, code: input.code.toUpperCase() });
  await audit({ actorType: "staff", action: "location.created", entityType: "location", entityId: String(location._id), req });
  res.status(201).json({ success: true, location });
}));
router.put("/:id", requireAuth, requirePermission("locations.manage"), requireObjectIdParam("id", "Clinic location was not found."), asyncHandler(async (req, res) => {
  const parsed = schema.partial().safeParse(req.body); if (!parsed.success) throw badRequest("Validation failed", parsed.error.flatten());
  const result = await updateLocation(req.params.id, parsed.data, {
    confirmExistingAppointments: parsed.data.confirmExistingAppointments === true,
    staffUser: req.user
  });
  const location = result.location;
  await audit({ actorType: "staff", action: "location.updated", entityType: "location", entityId: String(location._id), req });
  res.json({ success: true, location, conflictingAppointmentsPreserved: result.conflictingAppointmentsPreserved });
}));

module.exports = router;
