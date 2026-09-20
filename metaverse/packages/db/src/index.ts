import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5433/postgres",
});

export const prisma = new PrismaClient({
  adapter,
});

export default prisma;
export * from "./generated/prisma/client.js";

