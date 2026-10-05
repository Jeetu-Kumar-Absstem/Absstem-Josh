const { EventEmitter } = require("events");

/** In-process domain events (Accounts / AR listeners subscribe here). */
const domainEvents = new EventEmitter();
domainEvents.setMaxListeners(50);

module.exports = {
  domainEvents,
};
