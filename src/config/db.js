const mongoose = require("mongoose");
const { config } = require("./env");

let mongod = null;

async function connectDatabase() {
  mongoose.set("strictQuery", true);
  try {
    await mongoose.connect(config.mongoUri, {
      autoIndex: !config.isProduction,
      serverSelectionTimeoutMS: 5000
    });
    console.log("MongoDB connected successfully.");
  } catch (error) {
    if (config.isProduction || process.env.NODE_ENV === "production") {
      console.error("Production MongoDB connection failed.", {
        name: error?.name || "DatabaseError",
        code: error?.code || "DATABASE_CONNECTION_FAILED"
      });
      throw error;
    }

    console.log("External MongoDB unavailable. Using temporary in-memory database.");
    console.log("Data will be removed when the server stops.");
    try {
      const { MongoMemoryServer } = require("mongodb-memory-server");
      mongod = await MongoMemoryServer.create();
      const uri = mongod.getUri();
      await mongoose.connect(uri, { autoIndex: true });
      console.log("In-memory MongoDB connected successfully.");
    } catch (memError) {
      console.error("In-memory MongoDB startup error:", memError.message);
      throw error;
    }
  }
}

async function disconnectDatabase() {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

module.exports = { connectDatabase, disconnectDatabase };
