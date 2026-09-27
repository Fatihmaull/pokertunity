CREATE TABLE "agent_identities" (
	"agent_id" uuid NOT NULL,
	"chain_id" integer NOT NULL,
	"registry" text NOT NULL,
	"registry_id" text NOT NULL,
	"register_tx" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_identities_agent_id_chain_id_pk" PRIMARY KEY("agent_id","chain_id")
);
--> statement-breakpoint
ALTER TABLE "attestations" ADD COLUMN "validation_response_tx" text;--> statement-breakpoint
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_identities_token_idx" ON "agent_identities" USING btree ("chain_id","registry","registry_id");--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "registry_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "registry_chain_id";