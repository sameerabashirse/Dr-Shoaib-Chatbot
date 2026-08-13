const { config } = require("./src/config/env");
const { connectDatabase } = require("./src/config/db");
const { createApp } = require("./src/app");
const { startReminderScheduler } = require("./src/services/reminderService");
const { startOwnerEmailScheduler } = require("./src/services/ownerEmailOutboxService");
const { StaffUser, ClinicLocation } = require("./src/models");

async function ensureInitialData() {
  if (config.isProduction) {
    await StaffUser.updateMany(
      { email: /@drsohaibdemo\.com$/i },
      { $set: { isActive: false } }
    );
  }

  const locationCount = await ClinicLocation.countDocuments();
  if (locationCount === 0) {
    const demoLocations = [
      {
        clinicName: "Iqbal Hospital", city: "Bahawalpur", code: "BWP",
        fullAddress: "Noor Mahal Road, Bahawalpur", contactNumber: "+92 300 1234567",
        isActive: true, bookingEnabled: true, timezone: "Asia/Karachi", displayOrder: 1, status: "Active"
      },
      { clinicName: "Bahawalnagar Medical Center", city: "Bahawalnagar", code: "BWN", fullAddress: "Bahawalnagar", isActive: false, bookingEnabled: false, displayOrder: 2, status: "Coming Soon" },
      { clinicName: "Rahim Yar Khan Clinic", city: "Rahim Yar Khan", code: "RYK", fullAddress: "Rahim Yar Khan", isActive: false, bookingEnabled: false, displayOrder: 3, status: "Coming Soon" }
    ];

    for (const loc of demoLocations) {
      await ClinicLocation.updateOne(
        { code: loc.code },
        { $setOnInsert: loc },
        { upsert: true }
      );
    }
  }
}

function main() {
  // 1. Create Express App
  const app = createApp();

  // 2. Start Listening IMMEDIATELY on 0.0.0.0 and process.env.PORT / config.port
  const host = "0.0.0.0";
  const port = config.port || process.env.PORT || 3000;

  const server = app.listen(port, host, () => {
    console.log(`Dr. Sohaib WhatsApp AI Chatbot & Appointment System running on http://${host}:${port}`);

    // 3. Connect to MongoDB asynchronously after server is listening
    connectDatabase()
      .then(async () => {
        // 4. Run seeding and background schedulers after database connection succeeds
        await ensureInitialData();
        startReminderScheduler();
        startOwnerEmailScheduler();
        console.log("Background services and schedulers started successfully.");
      })
      .catch((error) => {
        // Log error safely without terminating Express server process
        console.error("Database background startup error.", {
          name: error?.name || "DatabaseError",
          code: error?.code || "DATABASE_STARTUP_FAILED"
        });
      });
  });

  const shutdown = async (signal) => {
    console.log(`${signal} received. Shutting down gracefully.`);
    server.close(() => process.exit(0));
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
