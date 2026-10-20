import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { Queue, Worker, type Processor, type JobsOptions } from "bullmq";
import { env } from "./env.js";

declare module "fastify" {
  interface FastifyInstance {
    queues: Map<string, Queue>;
    registerQueue: (queue: Queue, worker?: Worker) => void;
  }
}

// ---------------------------------------------------------------------------
// Connection config — derived from REDIS_URL once
// ---------------------------------------------------------------------------

function redisConnection() {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
  };
}

// ---------------------------------------------------------------------------
// Exported helpers — used by feature modules to register their own queues
// ---------------------------------------------------------------------------

export function createQueue(name: string, defaultJobOptions?: JobsOptions): Queue {
  return new Queue(name, {
    connection: redisConnection(),
    ...(defaultJobOptions ? { defaultJobOptions } : {}),
  });
}

export function createWorker<T>(
  name: string,
  processor: (job: { id?: string; name: string; data: T }) => Promise<void>,
  app: FastifyInstance,
  options?: { concurrency?: number },
): Worker {
  const worker = new Worker(name, processor as unknown as Processor, {
    connection: redisConnection(),
    concurrency: options?.concurrency ?? env.BUILD_CONCURRENCY ?? 5,
  });

  worker.on("completed", (job) => {
    app.log.debug({ jobId: job?.id, queue: name }, "Job completed");
  });

  worker.on("failed", (job, err) => {
    app.log.error({ jobId: job?.id, queue: name, err }, "Job failed");
  });

  return worker;
}

// ---------------------------------------------------------------------------
// Fastify plugin — registers queue infrastructure on app startup
// Feature modules (build, etc.) call registerQueue() to add their queues.
// ---------------------------------------------------------------------------

async function queuePlugin(app: FastifyInstance) {
  const queues = new Map<string, Queue>();
  const workers: Worker[] = [];

  app.decorate("queues", queues);

  // Allow feature modules to register queues + workers that get shut down
  // cleanly with the server.
  app.decorate(
    "registerQueue",
    (queue: Queue, worker?: Worker) => {
      queues.set(queue.name, queue);
      if (worker) workers.push(worker);
    },
  );

  app.log.info("BullMQ queue infrastructure ready");

  app.addHook("onClose", async () => {
    for (const worker of workers) {
      await worker.close();
    }
    for (const queue of queues.values()) {
      await queue.close();
    }
  });
}

export const queuePlugin_ = fp(queuePlugin, {
  name: "queue",
  dependencies: ["redis"],
});
