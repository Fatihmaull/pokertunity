ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN IF NOT EXISTS "demo" boolean DEFAULT false NOT NULL;