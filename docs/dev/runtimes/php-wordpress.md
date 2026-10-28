# PHP & WordPress Runtime Deployment (F2.4)

> **Feature:** F2.4 — PHP & WordPress Deployment  
> **Status:** Completed  
> **Package:** System Layer (`build_manager.py`, `docker_manager.py`, `php.yml`, `wordpress.yml`), Fastify API (`modules/wordpress`, `modules/build`), Dashboard (`components/projects/WordPressPanel`)

---

## 1. Overview

Vexlyx delivers high-performance, containerized hosting for **PHP web applications** and **WordPress sites**, supporting:
- **WordPress 1-Click Installation**: Automated core downloading, cryptographically secure salt generation, `wp-config.php` auto-wiring, direct filesystem permissions (`FS_METHOD = 'direct'`), and out-of-the-box permalinks rewrite rules.
- **PHP Framework Support**: Auto-detects **Laravel**, **Symfony**, **WordPress**, and generic PHP/Composer applications.
- **PHP Version Pinning**: Selects PHP `8.1`, `8.2`, or `8.3` via `composer.json` (`"require": {"php": "^8.2"}`), `.php-version`, `runtime.txt`, or environment variables (`PHP_VERSION` / `NIXPACKS_PHP_VERSION`).
- **Nginx + PHP-FPM Engine**: Built using Nixpacks container architecture with Nginx serving static assets and proxying dynamic requests to PHP-FPM on port 80.
- **Permalinks & Pretty URLs**: Automatically configures fallback routing (`NIXPACKS_PHP_FALLBACK_PATH=/index.php` and `.htaccess` rewrite rules) so `/about`, `/wp-admin`, and REST API endpoints work without 404 errors.
- **Persistent Volume Isolation**: WordPress sites map `./wp-content:/app/wp-content` to preserve uploads, media, plugins, and custom themes across container re-deploys.
- **Plugin & Theme Uploads**: API endpoints to upload and safely unzip plugin/theme ZIP archives directly into `wp-content/plugins/` and `wp-content/themes/`.

---

## 2. Architecture & Execution Flow

```
┌─────────────────────────────────────────────────────────────┐
│ WordPress 1-Click Action or Git Connect Repository          │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ Framework Detection Heuristics (`build_manager.py plan`)    │
│  - WordPress: wp-config.php, wp-login.php, wp-content/      │
│  - Laravel: artisan, laravel/framework in composer.json     │
│  - Symfony: bin/console, symfony/* in composer.json         │
│  - PHP Version: composer.json, .php-version, runtime.txt    │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ Build Phase (`nixpacks build`)                              │
│  - Fallback path: NIXPACKS_PHP_FALLBACK_PATH=/index.php      │
│  - Public root: NIXPACKS_PHP_ROOT_DIR=/app/public (Laravel) │
│  - PHP version: NIXPACKS_PHP_VERSION=8.2 / 8.3 / 8.1        │
│  - Build command: composer install --no-dev                 │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ Deploy Phase (`docker_manager.py deploy`)                   │
│  - Template: `system/templates/docker-compose/php.yml` or   │
│              `system/templates/docker-compose/wordpress.yml`│
│  - Persistent Volume: `./wp-content:/app/wp-content`        │
│  - Traefik dynamic router & load balancer on port 80        │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Framework & Version Detection

### 1. WordPress
- **Detection**: Presence of `wp-config.php`, `wp-login.php`, `wp-content/`, `wp-includes/`, or `wp-config-sample.php`.
- **Identified Framework**: `wordpress` (displayed as `WordPress`), Project Type: `WORDPRESS`.
- **Default Template**: `system/templates/docker-compose/wordpress.yml`.
- **Persistent Storage**: `./wp-content:/app/wp-content` mounted to preserve uploads and assets.

### 2. Laravel
- **Detection**: Presence of `artisan` file or `laravel/framework` in `composer.json`.
- **Suggested Build Command**: `composer install --no-dev --optimize-autoloader`.
- **Web Root**: `/app/public` automatically assigned via `NIXPACKS_PHP_ROOT_DIR`.
- **Identified Framework**: `laravel` (displayed as `Laravel (PHP)`), Project Type: `PHP`.

### 3. Symfony
- **Detection**: Presence of `bin/console` or `symfony/framework-bundle` in `composer.json`.
- **Suggested Build Command**: `composer install --no-dev --optimize-autoloader`.
- **Web Root**: `/app/public` automatically assigned via `NIXPACKS_PHP_ROOT_DIR`.
- **Identified Framework**: `symfony` (displayed as `Symfony (PHP)`), Project Type: `PHP`.

### 4. Generic PHP / Composer
- **Detection**: `index.php`, `composer.json`, or `.php` source files in repository.
- **Suggested Build Command**: `composer install --no-dev` if `composer.json` is present.
- **Identified Framework**: `php` (displayed as `PHP`), Project Type: `PHP`.

### 5. PHP Version Resolution
PHP version is determined using the following hierarchy:
1. `NIXPACKS_PHP_VERSION` or `PHP_VERSION` environment variable
2. `.php-version` file (e.g. `8.3`)
3. `runtime.txt` file (e.g. `php-8.1`)
4. `composer.json` -> `"require": {"php": "^8.2"}`
5. Default: **8.2** (or **8.3**)

---

## 4. WordPress 1-Click Scaffolding & Generation

When triggering the 1-click installer:

1. **WordPress Core Download**:
   - Downloads official `latest.tar.gz` from `https://wordpress.org/latest.tar.gz` and extracts it into the project directory.
   - Caches the tarball in `~/.cache/vexlyx/wordpress-latest.tar.gz` to allow instant subsequent installations.

2. **`wp-config.php` Auto-Wiring**:
   - Populates database constants: `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_HOST`, and table prefix (`$table_prefix`).
   - Generates 8 unique cryptographically secure 64-character salts using Python's `secrets.token_urlsafe(48)`:
     - `AUTH_KEY`, `SECURE_AUTH_KEY`, `LOGGED_IN_KEY`, `NONCE_KEY`
     - `AUTH_SALT`, `SECURE_AUTH_SALT`, `LOGGED_IN_SALT`, `NONCE_SALT`
   - Configures `define('FS_METHOD', 'direct');` so plugin and theme updates install directly without FTP prompts.
   - Configures reverse proxy SSL detection:
     ```php
     if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') {
         $_SERVER['HTTPS'] = 'on';
     }
     ```

3. **Permalinks Rewrites (`.htaccess`)**:
   - Creates standard WordPress rewrite rules:
     ```apache
     <IfModule mod_rewrite.c>
     RewriteEngine On
     RewriteBase /
     RewriteRule ^index\.php$ - [L]
     RewriteCond %{REQUEST_FILENAME} !-f
     RewriteCond %{REQUEST_FILENAME} !-d
     RewriteRule . /index.php [L]
     </IfModule>
     ```

---

## 5. API Endpoints

### 1. 1-Click WordPress Installation
- **Endpoint**: `POST /api/projects/:id/wordpress/install`
- **Auth**: Required (`requireAuth`)
- **Request Body**:
  ```json
  {
    "dbName": "wp_database",
    "dbUser": "wp_user",
    "dbPassword": "strong_password",
    "dbHost": "localhost:3306",
    "dbPrefix": "wp_",
    "downloadCore": true
  }
  ```
- **Response**:
  ```json
  {
    "message": "WordPress core and configuration installed successfully",
    "success": true,
    "projectDir": "/workspaces/projects/cmth...",
    "hasWpConfig": true,
    "hasHtaccess": true
  }
  ```

### 2. Upload Plugin / Theme ZIP Archive
- **Endpoint**: `POST /api/projects/:id/wordpress/upload`
- **Auth**: Required (`requireAuth`)
- **Request**: `multipart/form-data` with two parts:
  - `assetType` (field): `plugin` or `theme`
  - `file` (file): the `.zip` archive (size ceiling: `FILE_UPLOAD_MAX_MB`)

  Base64-in-JSON is no longer accepted — ordinary theme archives are multiple
  MB and exceeded Fastify's 1 MiB JSON body limit (#154).
- **Response**:
  ```json
  {
    "message": "WordPress plugin uploaded and extracted successfully",
    "success": true,
    "assetType": "plugin",
    "extractedFiles": 14,
    "targetDir": "/workspaces/projects/cmth.../wp-content/plugins"
  }
  ```

### 3. Inspect WordPress Status & Inventory
- **Endpoint**: `GET /api/projects/:id/wordpress/status`
- **Auth**: Required (`requireAuth`)
- **Response**:
  ```json
  {
    "installed": true,
    "coreVersion": "6.7.2",
    "plugins": ["vexlyx-optimizer", "akismet"],
    "themes": ["twentytwentyfour"]
  }
  ```

---

## 6. Testing Guide

Run the automated PHP & WordPress test suite:

```bash
# Run PHP & WordPress tests
python tests/test_php_wordpress_runtime.py

# Run monorepo typecheck & lint
pnpm typecheck
pnpm lint
pnpm test
```
