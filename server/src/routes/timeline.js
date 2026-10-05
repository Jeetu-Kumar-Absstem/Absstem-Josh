const express = require("express");
const { describeNow } = require("../services/timelineWindow");

const router = express.Router();

/** Public clock so desks use server Asia/Kolkata today, not the PC clock. */
router.get("/now", (_req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  return res.json({ ok: true, ...describeNow() });
});

module.exports = router;
