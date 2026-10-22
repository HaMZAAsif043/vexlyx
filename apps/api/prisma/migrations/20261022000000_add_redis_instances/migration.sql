-- CreateEnum
CREATE TYPE "RedisInstanceStatus" AS ENUM ('CREATING', 'RUNNING', 'STOPPED', 'ERROR');

-- CreateEnum
CREATE TYPE "RedisPersistence" AS ENUM ('NONE', 'RDB', 'AOF');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "max_redis_instances" INTEGER;

-- CreateTable
CREATE TABLE "redis_instances" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "container_name" TEXT NOT NULL,
    "image_tag" TEXT NOT NULL,
    "memory_limit_mb" INTEGER NOT NULL,
    "eviction_policy" TEXT NOT NULL,
    "persistence" "RedisPersistence" NOT NULL DEFAULT 'RDB',
    "password_encrypted" TEXT NOT NULL,
    "status" "RedisInstanceStatus" NOT NULL DEFAULT 'CREATING',
    "user_id" TEXT NOT NULL,
    "project_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "redis_instances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "redis_instances_user_id_name_key" ON "redis_instances"("user_id", "name");

-- CreateIndex
CREATE INDEX "redis_instances_user_id_idx" ON "redis_instances"("user_id");

-- AddForeignKey
ALTER TABLE "redis_instances" ADD CONSTRAINT "redis_instances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "redis_instances" ADD CONSTRAINT "redis_instances_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
