import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: '15mb' }));
   app.use(express.urlencoded({ extended: true, limit: '15mb' }));

app.use("/api", router);

// Explicit 404 for unmatched /api routes so unknown API paths return JSON.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API endpoint not found" });
});

export default app;
