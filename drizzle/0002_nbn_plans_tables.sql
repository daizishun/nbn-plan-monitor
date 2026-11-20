DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  tier TEXT NOT NULL,
  speed_down INTEGER NOT NULL,
  speed_up INTEGER,
  intro_price REAL,
  intro_months INTEGER,
  ongoing_price REAL NOT NULL,
  tes TEXT,
  data_allowance TEXT NOT NULL DEFAULT '无限流量',
  contract TEXT,
  category TEXT NOT NULL DEFAULT 'cheapest',
  source TEXT NOT NULL,
  source_url TEXT,
  checked_date TEXT NOT NULL,
  promo_end TEXT,
  note TEXT
);
--> statement-breakpoint
CREATE TABLE price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL,
  checked_date TEXT NOT NULL,
  intro_price REAL,
  ongoing_price REAL NOT NULL
);
--> statement-breakpoint
CREATE TABLE providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  website_url TEXT
);
--> statement-breakpoint
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
