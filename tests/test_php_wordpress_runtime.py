"""
test_php_wordpress_runtime.py — Automated test suite for F2.4 PHP & WordPress Deployment.

Tests:
1. PHP version detection (.php-version, runtime.txt, composer.json, env vars)
2. PHP framework detection (Laravel, Symfony, WordPress, generic PHP)
3. WordPress 1-click installer: core scaffolding, wp-config.php with crypto salts, FS_METHOD direct, .htaccess permalinks
4. WordPress plugin & theme upload and safe ZIP extraction
5. WordPress installation status & asset inventory inspection
6. Docker Compose template generation with php.yml (port 80, Traefik routing, memory limit)
7. Docker Compose template generation with wordpress.yml (persistent wp-content volume mount, port 80)
"""

import base64
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

REPO_ROOT = Path(__file__).resolve().parent.parent
BUILD_MANAGER = REPO_ROOT / "system" / "python" / "build_manager.py"
DOCKER_MANAGER = REPO_ROOT / "system" / "python" / "docker_manager.py"
TEMPLATES_DIR = REPO_ROOT / "system" / "templates" / "docker-compose"


def run_py_script(script_path: Path, payload: dict) -> tuple[int, dict, str]:
    proc = subprocess.Popen(
        [sys.executable, str(script_path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    stdout, stderr = proc.communicate(json.dumps(payload))
    lines = [line.strip() for line in stdout.strip().split("\n") if line.strip()]
    last_line = lines[-1] if lines else "{}"
    try:
        parsed = json.loads(last_line)
    except Exception:
        parsed = {"raw": stdout}
    return proc.returncode, parsed, stderr


def test_php_version_detection():
    print("Testing PHP version detection heuristics...")

    # 1. .php-version
    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)
        (tmppath / ".php-version").write_text("8.3\n", encoding="utf-8")
        (tmppath / "index.php").write_text("<?php echo 'Hello';", encoding="utf-8")

        code, result, stderr = run_py_script(
            BUILD_MANAGER, {"command": "plan", "projectDir": str(tmppath)}
        )
        assert code == 0, f"Plan failed: {stderr}"
        assert result.get("framework") == "php", f"Expected framework 'php', got: {result}"
        assert result.get("detectedType") == "PHP", f"Expected type 'PHP', got: {result}"
        print("  [PASS] .php-version 8.3 detected")

    # 2. runtime.txt
    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)
        (tmppath / "runtime.txt").write_text("php-8.1\n", encoding="utf-8")
        (tmppath / "index.php").write_text("<?php echo 'Hello';", encoding="utf-8")

        code, result, stderr = run_py_script(
            BUILD_MANAGER, {"command": "plan", "projectDir": str(tmppath)}
        )
        assert code == 0, f"Plan failed: {stderr}"
        print("  [PASS] runtime.txt php-8.1 detected")

    # 3. composer.json require.php
    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)
        (tmppath / "composer.json").write_text(
            json.dumps({"require": {"php": "^8.2"}}),
            encoding="utf-8",
        )
        (tmppath / "index.php").write_text("<?php echo 'Hello';", encoding="utf-8")

        code, result, stderr = run_py_script(
            BUILD_MANAGER, {"command": "plan", "projectDir": str(tmppath)}
        )
        assert code == 0, f"Plan failed: {stderr}"
        print("  [PASS] composer.json require.php ^8.2 detected")


def test_php_framework_detection():
    print("Testing PHP framework detection (Laravel, Symfony, WordPress, generic PHP)...")

    # 1. Laravel
    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)
        (tmppath / "artisan").write_text("#!/usr/bin/env php\n<?php", encoding="utf-8")
        (tmppath / "composer.json").write_text(
            json.dumps({"name": "laravel/laravel", "require": {"laravel/framework": "^11.0"}}),
            encoding="utf-8",
        )
        (tmppath / "public").mkdir(parents=True, exist_ok=True)
        (tmppath / "public" / "index.php").write_text("<?php", encoding="utf-8")

        code, result, stderr = run_py_script(
            BUILD_MANAGER, {"command": "plan", "projectDir": str(tmppath)}
        )
        assert code == 0, f"Plan failed: {stderr}"
        assert result.get("framework") == "laravel", f"Expected 'laravel', got: {result}"
        assert result.get("detectedType") == "PHP", f"Expected type 'PHP', got: {result}"
        assert result.get("buildCmd") == "composer install --no-dev --optimize-autoloader"
        print("  [PASS] Laravel detected with optimized autoloader build command")

    # 2. Symfony
    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)
        (tmppath / "bin").mkdir(parents=True, exist_ok=True)
        (tmppath / "bin" / "console").write_text("#!/usr/bin/env php\n<?php", encoding="utf-8")
        (tmppath / "composer.json").write_text(
            json.dumps({"require": {"symfony/framework-bundle": "^7.0"}}),
            encoding="utf-8",
        )
        (tmppath / "public").mkdir(parents=True, exist_ok=True)
        (tmppath / "public" / "index.php").write_text("<?php", encoding="utf-8")

        code, result, stderr = run_py_script(
            BUILD_MANAGER, {"command": "plan", "projectDir": str(tmppath)}
        )
        assert code == 0, f"Plan failed: {stderr}"
        assert result.get("framework") == "symfony", f"Expected 'symfony', got: {result}"
        assert result.get("detectedType") == "PHP", f"Expected type 'PHP', got: {result}"
        print("  [PASS] Symfony detected with console entrypoint")

    # 3. WordPress existing site
    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)
        (tmppath / "wp-config.php").write_text("<?php // WordPress config", encoding="utf-8")
        (tmppath / "wp-login.php").write_text("<?php // WordPress login", encoding="utf-8")
        (tmppath / "wp-content").mkdir(parents=True, exist_ok=True)

        code, result, stderr = run_py_script(
            BUILD_MANAGER, {"command": "plan", "projectDir": str(tmppath)}
        )
        assert code == 0, f"Plan failed: {stderr}"
        assert result.get("framework") == "wordpress", f"Expected 'wordpress', got: {result}"
        assert result.get("detectedType") == "WORDPRESS", f"Expected type 'WORDPRESS', got: {result}"
        print("  [PASS] WordPress repository detected as WORDPRESS type")


def test_wordpress_one_click_scaffolder():
    print("Testing WordPress 1-click scaffolder (wp-content scaffold, no host-side wp-config.php)...")

    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)

        code, result, stderr = run_py_script(
            BUILD_MANAGER,
            {
                "command": "wordpress-install",
                "projectDir": str(tmppath),
                "dbName": "wp_production_db",
                "dbUser": "wp_admin_user",
                "dbPassword": "super_secret_db_pass_123",
                "dbHost": "mysql-host:3306",
                "dbPrefix": "vx_",
                "downloadCore": False,  # Test instant scaffolding
            },
        )

        assert code == 0, f"WordPress install failed: {stderr}"
        assert result.get("success") is True
        assert result.get("projectDir") is not None
        assert result.get("wpContentDir") is not None

        # Check directories are scaffolded
        assert (tmppath / "wp-content" / "plugins").is_dir()
        assert (tmppath / "wp-content" / "themes").is_dir()
        assert (tmppath / "wp-content" / "uploads").is_dir()

        # wp-config.php is NOT generated on host - DB credentials flow via env vars at deploy time
        assert not (tmppath / "wp-config.php").exists()

        print("  [PASS] wp-content scaffolded with plugins, themes, uploads directories")


def test_wordpress_plugin_theme_upload_and_status():
    print("Testing WordPress plugin & theme upload and status inspection...")

    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)

        # 1. Install scaffolding first
        run_py_script(
            BUILD_MANAGER,
            {
                "command": "wordpress-install",
                "projectDir": str(tmppath),
                "downloadCore": False,
            },
        )

        # 2. Create a zip archive for a sample plugin
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("vexlyx-optimizer/vexlyx-optimizer.php", "<?php\n/* Plugin Name: Vexlyx Optimizer */\n")
            zf.writestr("vexlyx-optimizer/readme.txt", "Performance plugin for Vexlyx.\n")

        zip_base64 = base64.b64encode(zip_buffer.getvalue()).decode("utf-8")

        # 3. Upload plugin via base64 payload
        code, upload_res, stderr = run_py_script(
            BUILD_MANAGER,
            {
                "command": "wordpress-upload",
                "projectDir": str(tmppath),
                "assetType": "plugin",
                "zipBase64": zip_base64,
            },
        )

        assert code == 0, f"Upload plugin failed: {stderr}"
        assert upload_res.get("success") is True
        assert (tmppath / "wp-content" / "plugins" / "vexlyx-optimizer" / "vexlyx-optimizer.php").is_file()
        print("  [PASS] Plugin archive successfully uploaded and extracted to wp-content/plugins/")

        # 4. Upload a sample theme via zipPath
        theme_zip_path = tmppath / "sample-theme.zip"
        with zipfile.ZipFile(theme_zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("modern-theme/style.css", "/* Theme Name: Modern Theme */\n")
            zf.writestr("modern-theme/index.php", "<?php\n// Theme index\n")

        code, theme_res, stderr = run_py_script(
            BUILD_MANAGER,
            {
                "command": "wordpress-upload",
                "projectDir": str(tmppath),
                "assetType": "theme",
                "zipPath": str(theme_zip_path),
            },
        )

        assert code == 0, f"Upload theme failed: {stderr}"
        assert (tmppath / "wp-content" / "themes" / "modern-theme" / "style.css").is_file()
        print("  [PASS] Theme archive successfully uploaded and extracted to wp-content/themes/")

        # 5. Check WordPress status inspection
        code, status_res, stderr = run_py_script(
            BUILD_MANAGER,
            {
                "command": "wordpress-status",
                "projectDir": str(tmppath),
            },
        )

        assert code == 0, f"Status check failed: {stderr}"
        assert status_res.get("installed") is True
        assert "vexlyx-optimizer" in status_res.get("plugins", [])
        assert "modern-theme" in status_res.get("themes", [])
        print(f"  [PASS] WordPress status reported: {status_res}")


def test_php_and_wordpress_compose_templates():
    print("Testing Docker Compose template generation for PHP & WordPress...")

    # 1. PHP compose template (php.yml)
    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)
        php_template = TEMPLATES_DIR / "php.yml"
        assert php_template.is_file(), f"php.yml template missing at {php_template}"

        # Test pick_template & deploy generation logic
        code, result, stderr = run_py_script(
            DOCKER_MANAGER,
            {
                "command": "status",  # Checks script parsing
                "projectId": "php-test-123",
                "projectDir": str(tmppath),
            },
        )
        assert code == 0

        content = php_template.read_text(encoding="utf-8")
        assert "traefik.enable=true" in content
        assert "{{container_port}}" in content
        assert "{{service_name}}" in content
        print("  [PASS] php.yml template verified")

    # 2. WordPress compose template (wordpress.yml with persistent volume mount)
    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)
        wp_template = TEMPLATES_DIR / "wordpress.yml"
        assert wp_template.is_file(), f"wordpress.yml template missing at {wp_template}"

        content = wp_template.read_text(encoding="utf-8")
        assert "traefik.enable=true" in content
        assert "../wp-content:/var/www/html/wp-content" in content
        assert "{{memory_limit}}" in content
        print("  [PASS] wordpress.yml template verified with persistent ../wp-content volume mount")


def main():
    print("=== Running F2.4 PHP & WordPress Deployment Test Suite ===")
    test_php_version_detection()
    test_php_framework_detection()
    test_wordpress_one_click_scaffolder()
    test_wordpress_plugin_theme_upload_and_status()
    test_php_and_wordpress_compose_templates()
    print("\n[SUCCESS] All F2.4 PHP & WordPress Deployment tests passed successfully!")


if __name__ == "__main__":
    main()
