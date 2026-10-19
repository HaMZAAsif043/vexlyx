#!/bin/sh
# Disposable test PKI. These certificates/keys must never be deployed.
set -eu
umask 077
mkdir -p /fixtures/newcerts
cd /fixtures
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=Vexlyx-Test-CA \
    -keyout ca.key -out ca.crt >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=Vexlyx-Untrusted-Test-CA \
    -keyout other-ca.key -out other-ca.crt >/dev/null 2>&1
for name in trusted wrong-host expired untrusted; do
    hostname=mail.roundcube-test.example
    [ "$name" != wrong-host ] || hostname=wrong.roundcube-test.example
    openssl req -new -newkey rsa:2048 -nodes -subj "/CN=$hostname" \
        -keyout "$name.key" -out "$name.csr" >/dev/null 2>&1
    printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "$hostname" > "$name.ext"
    issuer=ca
    [ "$name" != untrusted ] || issuer=other-ca
    openssl x509 -req -in "$name.csr" -CA "$issuer.crt" -CAkey "$issuer.key" \
        -CAcreateserial -days 2 -extfile "$name.ext" -out "$name.crt" >/dev/null 2>&1
done
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=mail.roundcube-test.example \
    -addext subjectAltName=DNS:mail.roundcube-test.example \
    -keyout self-signed.key -out self-signed.crt >/dev/null 2>&1
touch index.txt
echo 1000 > serial
cat > ca.cnf <<'EOF'
[ca]
default_ca = test_ca
[test_ca]
database = /fixtures/index.txt
serial = /fixtures/serial
new_certs_dir = /fixtures/newcerts
certificate = /fixtures/ca.crt
private_key = /fixtures/ca.key
default_md = sha256
policy = test_policy
x509_extensions = test_extensions
[test_policy]
commonName = supplied
[test_extensions]
subjectAltName = DNS:mail.roundcube-test.example
extendedKeyUsage = serverAuth
EOF
openssl ca -batch -config ca.cnf -in expired.csr -out expired.crt \
    -startdate 20200101000000Z -enddate 20200102000000Z >/dev/null 2>&1
