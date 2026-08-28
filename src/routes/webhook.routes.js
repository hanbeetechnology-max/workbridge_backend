import { Router } from "express";
import { handleRazorpayWebhook } from "../controllers/webhook.controller.js";

// Deliberately NOT guarded — Razorpay calls this server-to-server with no
// JWT, only its own HMAC signature (verified inside the handler itself
// against the raw body express.raw() preserves for this one route — see
// app.js). Mounted directly on `app`, not under apiRouter, so it can sit
// ahead of the global express.json() body parser.
export const webhookRouter = Router();

webhookRouter.post("/", handleRazorpayWebhook);
