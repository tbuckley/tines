-- Project names address projects in web URLs (/issues/<name>/<number>) and
-- the CLI (<project>/<number>), so they must be unique per user. The API
-- returns a friendly 422 before hitting this; the index is the backstop
-- against racing writes.
CREATE UNIQUE INDEX `project_user_name_unique` ON `project` (`user_id`, `name`);
