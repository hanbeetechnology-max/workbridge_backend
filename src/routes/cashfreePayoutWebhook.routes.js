import { Router } from "express";
import { handleCashfreePayoutWebhook } from "../controllers/cashfreePayoutWebhook.controller.js";

// Deliberately NOT guarded — Cashfree calls this server-to-server with no
// JWT, same as the other webhook routes. Mounted directly on `app`, not
// under apiRouter, so it can sit ahead of the global express.json() body
// parser (see app.js) once the real payload shape/signature scheme is
// confirmed and this needs raw bytes.
export const cashfreePayoutWebhookRouter = Router();

cashfreePayoutWebhookRouter.post("/", handleCashfreePayoutWebhook);
