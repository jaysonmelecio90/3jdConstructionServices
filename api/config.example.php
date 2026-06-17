<?php
// Template for api/config.php — copy this file to api/config.php and fill in
// the real values for your environment. config.php is gitignored so real
// secrets never reach source control.
//
//   cp api/config.example.php api/config.php   (then edit the values below)

define('DB_HOST', 'localhost');          // DB host (usually localhost on shared hosting)
define('DB_NAME', 'your_db_name');        // database name
define('DB_USER', 'your_db_user');        // database user
define('DB_PASS', 'CHANGE_ME_PASSWORD');  // database password
define('DB_CHARSET', 'utf8mb4');          // connection charset — keep utf8mb4
define('IMPORT_TOKEN', 'CHANGE_ME_LONG_RANDOM_TOKEN'); // Bearer token for api/import.php
