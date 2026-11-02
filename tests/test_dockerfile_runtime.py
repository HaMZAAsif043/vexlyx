"""
test_dockerfile_runtime.py — Automated test suite for F2.5 Custom Dockerfile Deployment.

Tests:
1. Dockerfile framework auto-detection in `plan` command over nixpacks defaults.
2. EXPOSE port parsing (single port, multi-port, tcp/udp protocol tags).
3. HEALTHCHECK directive parsing from Dockerfile.
4. Dockerfile & .dockerignore CRUD management via `dockerfile-save` and `dockerfile-get`.
5. Docker Compose template generation with docker.yml (custom container port and Traefik routing).
6. Environment variable injection into docker.yml.
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


def test_dockerfile_detection_and_parsing():
    print("Testing Dockerfile detection, EXPOSE port, and HEALTHCHECK parsing...")

    # Case A: Standard Dockerfile with EXPOSE 8080 and HEALTHCHECK
    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)
        (tmppath / "Dockerfile").write_text(
            "FROM python:3.11-slim\n"
            "WORKDIR /app\n"
            "COPY . .\n"
            "EXPOSE 8080\n"
            "HEALTHCHECK --interval=30s --timeout=5s CMD curl -f http://localhost:8080/health || exit 1\n"
            "CMD [\"python\", \"app.py\"]\n",
            encoding="utf-8",
        )
        # Even if package.json or requirements.txt exists, Dockerfile takes priority
        (tmppath / "package.json").write_text('{"name": "test-pkg"}', encoding="utf-8")

        code, result, stderr = run_py_script(
            BUILD_MANAGER, {"command": "plan", "projectDir": str(tmppath)}
        )

        assert code == 0, f"Plan failed: {stderr}"
        assert result.get("framework") == "dockerfile", f"Expected dockerfile, got: {result}"
        assert result.get("detectedType") == "DOCKER"
        assert result.get("isDockerfile") is True
        assert result.get("exposedPorts") == [8080], f"Expected [8080], got: {result.get('exposedPorts')}"
        assert result.get("baseImage") == "python:3.11-slim"
        assert "health" in str(result.get("healthCheck"))
        print("  [PASS] Custom Dockerfile prioritized over package.json -> framework=dockerfile, port=8080")

    # Case B: Multi-port EXPOSE 80/tcp 443/tcp 3000
    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)
        (tmppath / "Dockerfile").write_text(
            "FROM node:20-alpine\n"
            "WORKDIR /app\n"
            "EXPOSE 80/tcp 443/tcp 3000\n"
            "CMD [\"npm\", \"start\"]\n",
            encoding="utf-8",
        )

        code, result, stderr = run_py_script(
            BUILD_MANAGER, {"command": "plan", "projectDir": str(tmppath)}
        )

        assert code == 0, f"Plan failed: {stderr}"
        assert result.get("exposedPorts") == [80, 443, 3000], f"Expected [80, 443, 3000], got: {result.get('exposedPorts')}"
        print("  [PASS] Multi-port EXPOSE directives with protocol tags parsed accurately -> [80, 443, 3000]")


def test_dockerfile_crud_management():
    print("Testing Dockerfile & .dockerignore CRUD management commands...")

    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)

        # 1. Save Dockerfile and .dockerignore
        save_payload = {
            "command": "dockerfile-save",
            "projectDir": str(tmppath),
            "dockerfile": "FROM golang:1.22-alpine\nWORKDIR /app\nEXPOSE 9090\nCMD [\"./server\"]",
            "dockerignore": ".git\n.env\n*.exe\n",
        }
        code, save_res, stderr = run_py_script(BUILD_MANAGER, save_payload)

        assert code == 0, f"dockerfile-save failed: {stderr}"
        assert save_res.get("success") is True
        assert save_res.get("hasDockerfile") is True
        assert save_res.get("hasDockerignore") is True
        assert save_res.get("exposedPorts") == [9090]
        assert save_res.get("baseImage") == "golang:1.22-alpine"
        assert (tmppath / "Dockerfile").is_file()
        assert (tmppath / ".dockerignore").is_file()
        print("  [PASS] dockerfile-save safely writes Dockerfile + .dockerignore to project directory")

        # 2. Get Dockerfile and .dockerignore
        get_payload = {
            "command": "dockerfile-get",
            "projectDir": str(tmppath),
        }
        code, get_res, stderr = run_py_script(BUILD_MANAGER, get_payload)

        assert code == 0, f"dockerfile-get failed: {stderr}"
        assert get_res.get("hasDockerfile") is True
        assert "golang:1.22-alpine" in get_res.get("dockerfile", "")
        assert "*.exe" in get_res.get("dockerignore", "")
        assert get_res.get("exposedPorts") == [9090]
        print("  [PASS] dockerfile-get retrieves content, .dockerignore, and directive metadata")


def test_docker_compose_template_generation():
    print("Testing docker.yml Docker Compose template generation...")

    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)

        deploy_payload = {
            "command": "deploy",
            "projectId": "test-dockerfile-project-123",
            "projectName": "my-custom-container",
            "projectDir": str(tmppath),
            "imageName": "vexlyx-custom-app:latest",
            "projectType": "DOCKER",
            "containerPort": 8080,
            "hostPort": 8850,
            "baseDomain": "vexlyx.localhost",
            "memoryLimit": "512m",
            "envVars": {
                "NODE_ENV": "production",
                "API_KEY": "secret_key_123",
                "PORT": "8080",
            },
        }

        # Generate compose file without starting container
        sys.path.insert(0, str(REPO_ROOT / "system" / "python"))
        import docker_manager  # type: ignore

        template_path = TEMPLATES_DIR / "docker.yml"
        assert template_path.is_file(), f"docker.yml template missing at {template_path}"

        compose_dir = tmppath / "deploy"
        docker_manager.generate_compose_file(
            compose_dir=compose_dir,
            template_path=template_path,
            image_name="vexlyx-custom-app:latest",
            service_name="test-dockerfile-project",
            hostname="my-custom-container.vexlyx.localhost",
            host_port=8850,
            container_port=8080,
            memory_limit="512m",
            env_vars=deploy_payload["envVars"],
        )

        compose_file = compose_dir / "docker-compose.yml"
        assert compose_file.is_file(), "docker-compose.yml was not generated"

        content = compose_file.read_text(encoding="utf-8")
        assert "image: \"vexlyx-custom-app:latest\"" in content
        assert "8850:8080" in content
        assert "memory: \"512m\"" in content
        assert "Host(`my-custom-container.vexlyx.localhost`)" in content
        assert "server.port=8080" in content
        assert "NODE_ENV: \"production\"" in content
        assert "API_KEY: \"secret_key_123\"" in content
        assert "name: vexlyx-apps" in content
        assert "traefik-net" not in content
        assert "healthcheck:" not in content
        assert "wget" not in content
        assert "curl" not in content
        print("  [PASS] docker.yml generated without assuming health-check tools in the custom image")


def main():
    print("=====================================================================")
    print("Vexlyx F2.5 Custom Dockerfile Deployment Runtime Automated Test Suite")
    print("=====================================================================")

    try:
        test_dockerfile_detection_and_parsing()
        test_dockerfile_crud_management()
        test_docker_compose_template_generation()
        print("\n[SUCCESS] All F2.5 Custom Dockerfile tests passed successfully!")
    except AssertionError as err:
        print(f"\n[FAIL] Test assertion failed: {err}")
        sys.exit(1)
    except Exception as err:
        print(f"\n[ERROR] Unexpected error: {err}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
