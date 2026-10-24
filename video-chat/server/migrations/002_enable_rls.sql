-- Supabase exposes the public schema through its REST API using a key that's
-- shipped to browsers. The server connects directly as the database owner, so
-- it isn't affected; enabling row level security with no policies blocks the
-- REST API from reading or writing any of these tables.
alter table users enable row level security;
alter table credit_lots enable row level security;
alter table refunds enable row level security;
alter table reports enable row level security;
alter table settings enable row level security;
alter table schema_migrations enable row level security;
