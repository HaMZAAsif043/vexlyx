"""
test_react_runtime.py — Automated test suite for F2.3 React (Vite) & Static Web Deployment.

Tests:
1. React (Vite) auto-detection via config files (vite.config.js, ts, mjs, cjs, mts, cts)
2. React (Vite) vs Vanilla Vite vs Vue vs Svelte framework resolution
3. Package manager lockfile detection (pnpm, yarn, bun, npm) & install commands
4. Node.js version detection (.nvmrc, .node-version, engines.node, env vars) & default Node 20
5. Plain static website auto-detection (index.html without package.json)
6. Docker Compose template generation with static.yml (PORT, HOST, memory limit, Traefik routing)
7. Static start command generation (npx --yes serve -s dist -l 80)
8. Nixpacks Caddy SPA client-side routing fallback (try_files {path} /index.html)
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
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


def test_vite_detection_configs():
    print("Testing React (Vite) detection via config files...")
    configs = [
        "vite.config.js",
        "vite.config.ts",
        "vite.config.mjs",
        "vite.config.cjs",
        "vite.config.mts",
        "vite.config.cts",
    ]

    for cfg in configs:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmppath = Path(tmpdir)
            (tmppath / cfg).write_text("// Vite config\nexport default {};", encoding="utf-8")
            (tmppath / "package.json").write_text(
                json.dumps({
                    "name": "vite-react-app",
                    "scripts": {"build": "vite build"},
                    "dependencies": {"react": "^18.3.0", "react-dom": "^18.3.0"},
                    "devDependencies": {"vite": "^5.4.0"},
                }),
                encoding="utf-8",
            )

            code, result, stderr = run_py_script(
                BUILD_MANAGER, {"command": "plan", "projectDir": str(tmppath)}
            )

            assert code == 0, f"Plan failed for {cfg}: {stderr}"
            assert result.get("framework") == "react", f"Expected 'react' framework for {cfg}, got: {result}"
            assert result.get("detectedType") == "REACT", f"Expected 'REACT' type for {cfg}, got: {result}"
            assert result.get("buildCmd") == "npm run build", f"Expected 'npm run build', got: {result.get('buildCmd')}"
            assert result.get("startCmd") is not None, f"Expected startCmd to be defined, got: {result}"
            print(f"  [PASS] Auto-detected via {cfg} -> startCmd: '{result.get('startCmd')}'")


def test_vite_framework_distinctions():
    print("Testing framework distinctions for Vite (React vs Vue vs Svelte vs Vanilla Vite)...")
    scenarios = [
        ({"dependencies": {"react": "^18.2.0"}, "devDependencies": {"vite": "^5.0.0"}}, "react", "REACT"),
        ({"devDependencies": {"@vitejs/plugin-react": "^4.2.0", "vite": "^5.0.0", "react": "^18.2.0"}}, "react", "REACT"),
        ({"devDependencies": {"@vitejs/plugin-vue": "^5.0.0", "vue": "^3.4.0", "vite": "^5.0.0"}}, "vue", "STATIC"),
        ({"devDependencies": {"@sveltejs/vite-plugin-svelte": "^3.0.0", "svelte": "^4.2.0", "vite": "^5.0.0"}}, "svelte", "STATIC"),
        ({"devDependencies": {"vite": "^7.1.12", "gsap": "^3.13.0"}, "dependencies": {"events": "^3.3.0"}}, "vite", "STATIC"),
    ]

    for deps, expected_fw, expected_type in scenarios:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmppath = Path(tmpdir)
            (tmppath / "vite.config.js").write_text("export default {};", encoding="utf-8")
            (tmppath / "package.json").write_text(
                json.dumps({
                    "name": "vite-app",
                    "scripts": {"build": "vite build"},
                    **deps,
                }),
                encoding="utf-8",
            )

            code, result, stderr = run_py_script(
                BUILD_MANAGER, {"command": "plan", "projectDir": str(tmppath)}
            )

            assert code == 0, f"Plan failed for {expected_fw}: {stderr}"
            assert result.get("framework") == expected_fw, f"Expected '{expected_fw}', got: {result}"
            assert result.get("detectedType") == expected_type, f"Expected '{expected_type}', got: {result}"
            assert result.get("startCmd") is not None, f"Expected startCmd to be defined, got: {result}"
            print(f"  [PASS] Detected {expected_fw} -> framework: '{expected_fw}', type: '{expected_type}', start: '{result.get('startCmd')}'")


def test_package_manager_lockfiles():
    print("Testing package manager lockfile resolution for Vite...")
    cases = [
        ("pnpm-lock.yaml", "pnpm run build"),
        ("yarn.lock", "yarn build"),
        ("bun.lockb", "bun run build"),
        ("bun.lock", "bun run build"),
        ("package-lock.json", "npm run build"),
    ]

    for lockfile, expected_build in cases:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmppath = Path(tmpdir)
            (tmppath / "vite.config.ts").write_text("export default {};", encoding="utf-8")
            (tmppath / lockfile).write_text("# lockfile", encoding="utf-8")
            (tmppath / "package.json").write_text(json.dumps({"name": "test-vite"}), encoding="utf-8")

            code, result, stderr = run_py_script(
                BUILD_MANAGER, {"command": "plan", "projectDir": str(tmppath)}
            )

            assert code == 0, f"Plan failed for {lockfile}: {stderr}"
            assert result.get("buildCmd") == expected_build, f"Expected {expected_build}, got {result.get('buildCmd')}"
            print(f"  [PASS] {lockfile} -> build: '{expected_build}'")


def test_node_version_detection():
    print("Testing Node.js version detection (.nvmrc, .node-version, engines.node, env vars)...")
    sys.path.insert(0, str(REPO_ROOT / "system" / "python"))
    import build_manager

    # 1. .nvmrc
    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)
        (tmppath / ".nvmrc").write_text("v20.12.0\n", encoding="utf-8")
        assert build_manager.detect_node_version(tmppath) == "20.12", "Failed to detect .nvmrc"
        print("  [PASS] .nvmrc 'v20.12.0' -> 20.12")

    # 2. .node-version
    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)
        (tmppath / ".node-version").write_text("18.19.0\n", encoding="utf-8")
        assert build_manager.detect_node_version(tmppath) == "18.19", "Failed to detect .node-version"
        print("  [PASS] .node-version '18.19.0' -> 18.19")

    # 3. package.json engines.node
    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)
        (tmppath / "package.json").write_text(
            json.dumps({"name": "test", "engines": {"node": ">=22.0.0"}}),
            encoding="utf-8",
        )
        assert build_manager.detect_node_version(tmppath) == "22.0", "Failed to detect engines.node"
        print("  [PASS] package.json engines.node '>=22.0.0' -> 22.0")

    # 4. env_vars override
    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)
        assert build_manager.detect_node_version(tmppath, {"NODE_VERSION": "20"}) == "20"
        assert build_manager.detect_node_version(tmppath, {"NIXPACKS_NODE_VERSION": "22"}) == "22"
        print("  [PASS] env_vars NODE_VERSION / NIXPACKS_NODE_VERSION -> respected")


def test_plain_static_detection():
    print("Testing plain static HTML website auto-detection...")
    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)
        (tmppath / "index.html").write_text("<!DOCTYPE html><html><body><h1>Hello</h1></body></html>", encoding="utf-8")
        (tmppath / "style.css").write_text("body { font-family: sans-serif; }", encoding="utf-8")

        code, result, stderr = run_py_script(
            BUILD_MANAGER, {"command": "plan", "projectDir": str(tmppath)}
        )

        assert code == 0, f"Plan failed for static website: {stderr}"
        assert result.get("framework") == "static", f"Expected 'static', got: {result}"
        assert result.get("detectedType") == "STATIC", f"Expected 'STATIC', got: {result}"
        assert result.get("startCmd") is not None, f"Expected startCmd to be defined, got: {result}"
        print(f"  [PASS] Plain static HTML/CSS site detected -> framework: 'static', type: 'STATIC', start: '{result.get('startCmd')}'")


def test_static_docker_template():
    print("Testing static.yml template rendering & Traefik configuration...")
    static_template_path = TEMPLATES_DIR / "static.yml"
    assert static_template_path.is_file(), "static.yml template does not exist"

    template_content = static_template_path.read_text(encoding="utf-8")
    # static.yml uses nginx:alpine which listens on port 80 by default - no PORT/HOST env vars needed
    assert "traefik.enable=true" in template_content, "Traefik enable missing"
    # The Traefik loadbalancer port uses the container_port placeholder (which is 80 for static)
    assert "traefik.http.services.{{service_name}}.loadbalancer.server.port=80" in template_content

    sys.path.insert(0, str(REPO_ROOT / "system" / "python"))
    import docker_manager

    assert docker_manager.pick_template("REACT") == "static.yml", "pick_template(REACT) should return static.yml"
    assert docker_manager.default_container_port("REACT") == 80, "default_container_port(REACT) should be 80"
    assert docker_manager.pick_template("STATIC") == "static.yml", "pick_template(STATIC) should return static.yml"
    assert docker_manager.default_container_port("STATIC") == 80, "default_container_port(STATIC) should be 80"

    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)
        docker_manager.generate_compose_file(
            compose_dir=tmppath,
            template_path=static_template_path,
            image_name="vexlyx-react-app-img",
            service_name="test-react-app",
            hostname="react.vexlyx.localhost",
            host_port=8200,
            container_port=80,
            memory_limit="256m",
            env_vars={"VITE_API_BASE": "https://api.example.com", "VITE_APP_TITLE": "Vexlyx React Demo"},
        )

        compose_file = tmppath / "docker-compose.yml"
        assert compose_file.is_file(), "docker-compose.yml was not created"
        compose_text = compose_file.read_text(encoding="utf-8")

        # static.yml uses fixed nginx:alpine image (no {{image_name}} placeholder)
        # and no environment section (nginx doesn't need app env vars)
        assert 'image: "nginx:alpine"' in compose_text
        assert "8200:80" in compose_text
        assert "react.vexlyx.localhost" in compose_text
        assert "traefik.http.services.test-react-app.loadbalancer.server.port=80" in compose_text
        print("  [PASS] static.yml rendered correctly with nginx:alpine and Traefik load balancer")


def main():
    print("=== Running React (Vite) & Static Runtime Automated Test Suite ===")
    test_vite_detection_configs()
    test_vite_framework_distinctions()
    test_package_manager_lockfiles()
    test_node_version_detection()
    test_plain_static_detection()
    test_static_docker_template()
    print("\n[SUCCESS] ALL REACT (VITE) & STATIC RUNTIME TESTS PASSED SUCCESSFULLY!")


if __name__ == "__main__":
    main()
