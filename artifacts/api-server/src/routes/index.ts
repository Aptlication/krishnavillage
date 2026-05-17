import { Router, type IRouter } from "express";
import healthRouter from "./health";
import guestsRouter from "./guests";
import notificationsRouter from "./notificationsRoute";
import maintenanceRouter from "./maintenanceRoute";
import housekeepingRouter from "./housekeepingRoute";
import smsRouter from "./smsRoute";
import staffRouter from "./staffRoute";
import expensesRouter from "./expensesRoute";
import storageRouter from "./storage";
import servicesRouter from "./servicesRoute";

const router: IRouter = Router();

router.use(healthRouter);
router.use(staffRouter);
router.use(guestsRouter);
router.use(notificationsRouter);
router.use(maintenanceRouter);
router.use(housekeepingRouter);
router.use(smsRouter);
router.use(expensesRouter);
router.use(storageRouter);
router.use(servicesRouter);

export default router;
