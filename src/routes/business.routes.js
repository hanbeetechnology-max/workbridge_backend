import { Router } from "express";
import { guard } from "../middleware/guard.js";
import { listTeam, addTeamMember, removeTeamMember } from "../controllers/business_team.controller.js";

export const businessRouter = Router();

businessRouter.use(guard);
businessRouter.get("/team", listTeam);
businessRouter.post("/team", addTeamMember);
businessRouter.delete("/team/:id", removeTeamMember);
