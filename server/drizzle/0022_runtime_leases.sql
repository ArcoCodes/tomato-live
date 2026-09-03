CREATE TABLE `runtime_leases` (
	`key` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`until_ms` integer NOT NULL
);
