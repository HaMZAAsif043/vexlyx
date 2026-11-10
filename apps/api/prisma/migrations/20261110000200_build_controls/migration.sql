ALTER TABLE "projects"
  ADD COLUMN "base_directory" TEXT,
  ADD COLUMN "memory_limit" TEXT,
  ADD COLUMN "build_cache_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "build_cache_epoch" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "build_cache_reset_pending" BOOLEAN NOT NULL DEFAULT false;
