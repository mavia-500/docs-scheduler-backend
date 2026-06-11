import express from "express";
import cors from "cors";
import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? "http://localhost:3000";
const TRUCKS_PER_SLOT = 3;

// ─── DB Pool ────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

// ─── Helper ─────────────────────────────────────────────────────────────────
function serializeBooking(row: any) {
  return {
    id:            row.id,
    dockId:        row.dockId        ?? row.dockid,
    startTime:     new Date(row.startTime  ?? row.starttime).toISOString(),
    endTime:       new Date(row.endTime    ?? row.endtime).toISOString(),
    requesterName: row.requesterName ?? row.requestername,
    truckReference:row.truckReference?? row.truckreference,
    driverName:    row.driverName    ?? row.drivername,
    driverPhone:   row.driverPhone   ?? row.driverphone,
    licensePlate:  row.licensePlate  ?? row.licenseplate,
    type:          row.type,
    direction:     row.direction,
    createdAt:     new Date(row.createdAt  ?? row.createdat).toISOString(),
  };
}

// ─── GET /api/bookings ───────────────────────────────────────────────────────
app.get("/api/bookings", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM "Booking" ORDER BY "startTime" ASC`
    );
    res.json(rows.map(serializeBooking));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to load bookings" });
  }
});

// ─── POST /api/bookings/batch ────────────────────────────────────────────────
app.post("/api/bookings/batch", async (req, res) => {
  const bookingRequests = req.body.bookings;
  if (!Array.isArray(bookingRequests) || bookingRequests.length === 0) {
    return res.status(400).json({ error: "Booking list is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // In-memory slot counter for this batch
    const slotCounts = new Map<string, { existingCount: number; newCount: number }>();
    const created: any[] = [];

    for (const booking of bookingRequests) {
      const startTime = new Date(booking.startTime);
      const endTime   = new Date(booking.endTime);
      const slotKey   = `${booking.dockId}:${startTime.toISOString()}:${endTime.toISOString()}`;

      // Fetch existing count once per unique slot
      if (!slotCounts.has(slotKey)) {
        const { rows } = await client.query(
          `SELECT COUNT(*)::int AS cnt FROM "Booking"
           WHERE "dockId" = $1 AND "startTime" = $2 AND "endTime" = $3`,
          [booking.dockId, startTime, endTime]
        );
        slotCounts.set(slotKey, { existingCount: rows[0].cnt, newCount: 0 });
      }

      const slotInfo = slotCounts.get(slotKey)!;
      if (slotInfo.existingCount + slotInfo.newCount >= TRUCKS_PER_SLOT) {
        throw new Error("SLOT_FULL");
      }

      const { rows: insertedRows } = await client.query(
        `INSERT INTO "Booking"
           (id, "dockId", "startTime", "endTime",
            "requesterName", "truckReference",
            "driverName", "driverPhone", "licensePlate",
            type, direction)
         VALUES
           (gen_random_uuid(), $1, $2, $3,
            $4, $5, $6, $7, $8,
            $9::"BookingType", $10)
         RETURNING *`,
        [
          booking.dockId,
          startTime,
          endTime,
          booking.requesterName,
          booking.truckReference,
          booking.driverName,
          booking.driverPhone,
          booking.licensePlate,
          booking.type ?? "manual",
          booking.direction ?? "inbound",
        ]
      );

      slotInfo.newCount += 1;
      slotCounts.set(slotKey, slotInfo);
      created.push(insertedRows[0]);
    }

    await client.query("COMMIT");
    res.status(201).json(created.map(serializeBooking));
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    if (error instanceof Error && error.message === "SLOT_FULL") {
      return res.status(409).json({ error: "This dock slot is full." });
    }
    // Unique-constraint violation (code 23505)
    if ((error as any).code === "23505") {
      return res.status(409).json({ error: "This dock slot is already booked." });
    }
    res.status(500).json({ error: "Unable to create bookings." });
  } finally {
    client.release();
  }
});

// ─── PUT /api/bookings/:id ───────────────────────────────────────────────────
app.put("/api/bookings/:id", async (req, res) => {
  const bookingId = req.params.id;
  const p         = req.body;

  try {
    const { rows } = await pool.query(
      `UPDATE "Booking"
       SET "dockId"         = $1,
           "startTime"      = $2,
           "endTime"        = $3,
           "requesterName"  = $4,
           "truckReference" = $5,
           "driverName"     = $6,
           "driverPhone"    = $7,
           "licensePlate"   = $8,
           type             = $9::"BookingType",
           direction        = $10
       WHERE id = $11
       RETURNING *`,
      [
        p.dockId,
        new Date(p.startTime),
        new Date(p.endTime),
        p.requesterName,
        p.truckReference,
        p.driverName,
        p.driverPhone,
        p.licensePlate,
        p.type ?? "manual",
        p.direction ?? "inbound",
        bookingId,
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Booking not found." });
    }
    res.json(serializeBooking(rows[0]));
  } catch (error) {
    console.error(error);
    if ((error as any).code === "23505") {
      return res.status(409).json({ error: "This dock slot is already booked." });
    }
    res.status(500).json({ error: "Unable to update booking." });
  }
});

// ─── DELETE /api/bookings/:id ────────────────────────────────────────────────
app.delete("/api/bookings/:id", async (req, res) => {
  const bookingId = req.params.id;
  try {
    await pool.query(`DELETE FROM "Booking" WHERE id = $1`, [bookingId]);
    res.status(204).end();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to delete booking." });
  }
});


// app.listen(PORT, () => {
//   console.log(`Server running on http://localhost:${PORT}`);
// });

// module.exports = app;

module.exports = app;