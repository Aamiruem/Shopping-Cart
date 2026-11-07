"""Creates the store's first admin. For production, where scripts.seed refuses to run:

    ADMIN_EMAIL=you@yourstore.in ADMIN_PASSWORD='a long unique password' python -m scripts.create_admin

The password comes from the environment so that it never ends up in the shell history.
"""

import asyncio
import os
import sys

from app.core.security import hash_password
from app.db.postgres import close_postgres, connect_postgres

MIN_PASSWORD_LENGTH = 12


async def main() -> None:
    email = os.environ.get("ADMIN_EMAIL", "").strip().lower()
    password = os.environ.get("ADMIN_PASSWORD", "")
    if not email or len(password) < MIN_PASSWORD_LENGTH:
        sys.exit(f"Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least {MIN_PASSWORD_LENGTH} characters.")
    pool = await connect_postgres()
    try:
        await pool.execute(
            """INSERT INTO users (name, email, password, role) VALUES ('Admin', $1, $2, 'admin')
               ON CONFLICT (email) DO UPDATE SET password = EXCLUDED.password, role = 'admin'""",
            email,
            hash_password(password),
        )
    finally:
        await close_postgres()
    print(f"Admin ready: {email}")


if __name__ == "__main__":
    asyncio.run(main())
