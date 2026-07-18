import app from "./app";
import { logger } from "./lib/logger";
import { startClvCapture } from "./lib/clv";
import { startModelClvCapture } from "./lib/model-clv";
import { startGrading } from "./lib/grading";
import { startTombstonePurge } from "./lib/tombstones";
import { startLedgerAudit } from "./lib/ledger-audit";
import { startKOutcomeGrading } from "./lib/k-outcomes";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startClvCapture();
  startModelClvCapture();
  startGrading();
  startTombstonePurge();
  startLedgerAudit();
  startKOutcomeGrading();
});
