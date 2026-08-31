import { Router } from "express";
import { authRouter } from "./auth.routes.js";
import { projectsRouter } from "./projects.routes.js";
import { walletRouter } from "./wallet.routes.js";
import { reviewsRouter } from "./reviews.routes.js";
import { profilesRouter } from "./profiles.routes.js";
import { adminRouter } from "./admin.routes.js";
import { candidatesRouter } from "./candidates.routes.js";
import { gamificationRouter } from "./gamification.routes.js";
import { blocksRouter } from "./blocks.routes.js";
import { supportRouter } from "./support.routes.js";
import { perksRouter } from "./perks.routes.js";
import { pushRouter } from "./push.routes.js";
import { publicRouter } from "./public.routes.js";
import { notificationsRouter } from "./notifications.routes.js";
import { threadsRouter } from "./threads.routes.js";
import { paymentsRouter } from "./payments.routes.js";
import { businessRouter } from "./business.routes.js";

export const apiRouter = Router();

apiRouter.use("/auth", authRouter); // register/login are the other unguarded routes
apiRouter.use("/projects", projectsRouter);
apiRouter.use("/wallet", walletRouter);
apiRouter.use("/reviews", reviewsRouter);
apiRouter.use("/profiles", profilesRouter); // the one unguarded resource
apiRouter.use("/admin", adminRouter);
apiRouter.use("/candidates", candidatesRouter);
apiRouter.use("/gamification", gamificationRouter);
apiRouter.use("/blocks", blocksRouter);
apiRouter.use("/support", supportRouter);
apiRouter.use("/perks", perksRouter);
apiRouter.use("/push", pushRouter);
apiRouter.use("/public", publicRouter);
apiRouter.use("/notifications", notificationsRouter);
apiRouter.use("/threads", threadsRouter);
// The webhook itself (POST /api/payments/webhook) is NOT here — it's
// mounted directly on `app` in app.js, ahead of the global express.json()
// parser, so its raw request body survives for signature verification.
// This router only ever carries normal JWT-guarded endpoints.
apiRouter.use("/payments", paymentsRouter);
apiRouter.use("/business", businessRouter);

// Dev-only token issuance — never mounted in production. See dev.routes.js.
if (process.env.NODE_ENV !== "production") {
  const { devRouter } = await import("./dev.routes.js");
  apiRouter.use("/dev", devRouter);
}
