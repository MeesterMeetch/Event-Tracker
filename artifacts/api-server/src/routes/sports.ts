import { Router, type IRouter } from "express";
import { ListSportsResponse } from "@workspace/api-zod";
import { getSupportedSports } from "../lib/sports";

const router: IRouter = Router();

router.get("/sports", async (req, res): Promise<void> => {
  try {
    const sports = await getSupportedSports();
    res.json(ListSportsResponse.parse(sports));
  } catch (err) {
    req.log.error({ err }, "sports: failed to list sports");
    res.status(502).json({ error: "Failed to load sports. Try again shortly." });
  }
});

export default router;
