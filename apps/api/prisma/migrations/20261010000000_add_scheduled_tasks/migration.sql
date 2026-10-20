-- CreateEnum
CREATE TYPE "ScheduledTaskRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED', 'TIMEOUT', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ScheduledTaskRunTrigger" AS ENUM ('SCHEDULED', 'MANUAL');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "max_scheduled_tasks" INTEGER;

-- CreateTable
CREATE TABLE "scheduled_tasks" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "timeout_seconds" INTEGER NOT NULL DEFAULT 300,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_failure" BOOLEAN NOT NULL DEFAULT true,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "last_run_at" TIMESTAMP(3),
    "next_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_task_runs" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "trigger" "ScheduledTaskRunTrigger" NOT NULL,
    "status" "ScheduledTaskRunStatus" NOT NULL,
    "exit_code" INTEGER,
    "output" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "scheduled_task_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduled_tasks_project_id_idx" ON "scheduled_tasks"("project_id");

-- CreateIndex
CREATE INDEX "scheduled_tasks_user_id_idx" ON "scheduled_tasks"("user_id");

-- CreateIndex
CREATE INDEX "scheduled_tasks_enabled_idx" ON "scheduled_tasks"("enabled");

-- CreateIndex
CREATE INDEX "scheduled_task_runs_task_id_idx" ON "scheduled_task_runs"("task_id");

-- CreateIndex
CREATE INDEX "scheduled_task_runs_started_at_idx" ON "scheduled_task_runs"("started_at");

-- AddForeignKey
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_task_runs" ADD CONSTRAINT "scheduled_task_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "scheduled_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
