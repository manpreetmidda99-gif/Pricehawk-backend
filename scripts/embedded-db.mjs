// Starts a persistent embedded PostgreSQL cluster for PriceHawk.
// Data lives in <backend>/.pgdata so it survives restarts of this script.
// Run:  PGPW=<db-password> node scripts/embedded-db.mjs
// The backend then connects via DATABASE_URL in .env.
import EmbeddedPostgres from "embedded-postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const password = process.env.PGPW;
if (!password) {
  console.error("embedded-db: PGPW env var is required");
  process.exit(1);
}

const pg = new EmbeddedPostgres({
  // NOTE: the data dir must be creatable *by the postgres user itself*
  // (it ends up postgres-owned, which initdb requires). .pghome is
  // writable by that user, so nest the cluster dir inside it.
  databaseDir: path.join(root, ".pghome", "pgdata"),
  user: "pricehawk",
  password,
  port: 5433,
  persistent: true,
});

await pg.initialise();
await pg.start();
console.log("embedded-db: postgres started on port 5433");

const client = pg.getPgClient();
await client.connect();
try {
  await client.query("CREATE DATABASE pricehawk");
  console.log("embedded-db: database 'pricehawk' created");
} catch (err) {
  if (err && err.code === "42P04") {
    console.log("embedded-db: database 'pricehawk' already exists");
  } else {
    throw err;
  }
} finally {
  await client.end();
}

console.log("embedded-db: ready (keeping process alive)");
setInterval(() => {}, 1 << 30); // stay alive; stop with SIGTERM
