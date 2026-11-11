"""Exercise generated routes through real Traefik with certificate verification."""
import os
import signal
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

root = Path(os.environ["AUTOCONFIG_TEST_DIR"])
path = "/.well-known/autoconfig/mail/config-v1.1.xml"

def request(tls, suffix, host="example.test"):
    port = 8443 if tls else 8080
    args = ["curl", "--noproxy", "*", "--silent", "--show-error", "--max-time", "3", "--resolve", f"{host}:{port}:127.0.0.1", "--write-out", "\n%{http_code}"]
    if tls:
        args += ["--cacert", str(root / "docker/traefik/certs/domain-d1.crt")]
    result = subprocess.run(args + [f"{'https' if tls else 'http'}://{host}:{port}{suffix}"], capture_output=True, text=True)
    if result.returncode:
        return "", 0
    body, status = result.stdout.rsplit("\n", 1)
    return body, int(status)

def wait_for(check):
    for _ in range(60):
        if check():
            return
        time.sleep(0.5)
    raise AssertionError("Traefik did not reach the expected state")

wait_for(lambda: request(True, path)[1] == 200)
body, status = request(True, path + "?emailaddress=ignored%40other.test")
provider = ET.fromstring(body).find("emailProvider")
assert provider.find("incomingServer/hostname").text == "mx.provider.test"
assert provider.find("incomingServer/port").text == "993"
assert provider.find("incomingServer/socketType").text == "SSL"
assert provider.find("outgoingServer/port").text == "587"
assert provider.find("outgoingServer/socketType").text == "STARTTLS"
assert provider.find("incomingServer/username").text == "%EMAILADDRESS%"
assert request(False, path)[1] in (301, 302, 307, 308)
assert request(True, "/")[0] == "project website"
assert request(False, path, "unknown.test")[1] == 404
os.kill(int(os.environ["AUTOCONFIG_FIXTURE_PID"]), signal.SIGUSR1)
wait_for(lambda: request(False, path)[0] == "project website")
assert not (root / "docker/traefik/dynamic/mail-autoconfig-d1.yml").exists()
os.kill(int(os.environ["AUTOCONFIG_FIXTURE_PID"]), signal.SIGUSR2)
wait_for(lambda: request(False, "/")[1] == 404)
print("Traefik discovery, verified TLS, redirects, website routing and withdrawal passed")
