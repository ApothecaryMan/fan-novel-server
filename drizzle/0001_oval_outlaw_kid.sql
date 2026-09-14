CREATE TABLE "cover_blobs" (
	"filename" varchar(255) PRIMARY KEY NOT NULL,
	"mime" varchar(50) NOT NULL,
	"data_base64" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
