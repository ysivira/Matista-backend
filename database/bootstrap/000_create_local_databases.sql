-- Bootstrap local explicito. No es ejecutado por el runner de migraciones.
-- Requiere una cuenta MySQL con permiso CREATE DATABASE.

CREATE DATABASE IF NOT EXISTS matista_dev
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

CREATE DATABASE IF NOT EXISTS matista_test
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
