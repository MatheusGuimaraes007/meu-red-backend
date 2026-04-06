import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Usa DIRECT_URL para migrations (sem PgBouncer)
    url: process.env["DIRECT_URL"],
  },
});
