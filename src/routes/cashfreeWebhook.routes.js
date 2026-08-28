import { Router } from "express";
import { handleCashfreeWebhook } from "../controllers/cashfreeWebhook.controller.js";

// Deliberately NOT guarded — Cashfree calls this server-to-server with no
// JWT, same as webhook.routes.js's Razorpay webhook. Mounted directly on
// `app`, not under apiRouter, so it can sit ahead of the global
// express.json() body parser (see app.js).
export const cashfreeWebhookRouter = Router();

cashfreeWebhookRouter.post("/", handleCashfreeWebhook);
