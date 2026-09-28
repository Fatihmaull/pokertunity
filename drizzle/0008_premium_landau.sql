DROP INDEX "deposit_intents_tx_idx";--> statement-breakpoint
ALTER TABLE "deposit_intents" ADD COLUMN "log_index" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_intents_tx_idx" ON "deposit_intents" USING btree ("chain_id","tx_hash","log_index");