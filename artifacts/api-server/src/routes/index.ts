import { Router, type IRouter } from "express";
import healthRouter from "./health";
import sportsRouter from "./sports";
import edgesRouter from "./edges";
import topPlaysRouter from "./top-plays";
import eventsRouter from "./events";
import propsRouter from "./props";
import rankingsRouter from "./rankings";
import betsRouter from "./bets";
import dashboardRouter from "./dashboard";
import analysisRouter from "./analysis";
import modelEdgesRouter from "./model-edges";
import modelSlateRouter from "./model-edges-slate";
import paperTradesRouter from "./paper-trades";
import auditRouter from "./audit";
import mlbRouter from "./mlb";

const router: IRouter = Router();

router.use(healthRouter);
router.use(sportsRouter);
router.use(edgesRouter);
router.use(topPlaysRouter);
router.use(eventsRouter);
router.use(propsRouter);
router.use(rankingsRouter);
router.use(betsRouter);
router.use(dashboardRouter);
router.use(analysisRouter);
router.use(modelEdgesRouter);
router.use(modelSlateRouter);
router.use(paperTradesRouter);
router.use(auditRouter);
router.use(mlbRouter);

export default router;
