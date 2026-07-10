import { Router, type IRouter } from "express";
import { ListSportsResponse } from "@workspace/api-zod";
import { SUPPORTED_SPORTS } from "../lib/sports";

const router: IRouter = Router();

router.get("/sports", (_req, res) => {
  res.json(ListSportsResponse.parse(SUPPORTED_SPORTS));
});

export default router;
