import { Router, type IRouter } from "express";
import healthRouter from "./health";
import sportsRouter from "./sports";
import edgesRouter from "./edges";
import betsRouter from "./bets";
import dashboardRouter from "./dashboard";
import analysisRouter from "./analysis";

const router: IRouter = Router();

router.use(healthRouter);
router.use(sportsRouter);
router.use(edgesRouter);
router.use(betsRouter);
router.use(dashboardRouter);
router.use(analysisRouter);

export default router;
