const express = require("express");

const router = express.Router();

function eventKind(body) {
  const chat = body?.chat;
  if (chat) {
    if (chat.addedToSpacePayload) return "ADDED_TO_SPACE";
    if (chat.removedFromSpacePayload) return "REMOVED_FROM_SPACE";
    if (chat.messagePayload || chat.appCommandPayload) return "MESSAGE";
    return "OTHER";
  }
  return String(body?.type || "").toUpperCase();
}

// Workspace add-on style Chat apps (body.chat) need replies wrapped in hostAppDataAction.
function reply(body, text) {
  if (body?.chat) {
    return { hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text } } } } };
  }
  return { text };
}

// Public: Google Chat posts interaction events here. Replies are static and never expose ERP data.
router.post("/events", (req, res) => {
  const body = req.body || {};
  const kind = eventKind(body);
  const baseUrl = String(process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  const openLine = baseUrl ? `\nOpen Josh: ${baseUrl}` : "";

  if (kind === "ADDED_TO_SPACE") {
    return res.json(reply(body, `Hi! I'm Josh. I'll message you here privately when something in Josh needs your attention.${openLine}`));
  }
  if (kind === "MESSAGE") {
    return res.json(reply(body, `I only send alerts — I can't answer questions yet. Please reply inside Josh.${openLine}`));
  }
  return res.json({});
});

module.exports = router;
