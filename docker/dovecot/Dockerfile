FROM alpine:3.20

# Install Dovecot (IMAP + LMTP + auth + doveadm + Pigeonhole Sieve), OpenSSL, and utilities
RUN apk add --no-cache \
    dovecot \
    dovecot-lmtpd \
    dovecot-pigeonhole-plugin \
    openssl \
    ca-certificates \
    bash

# Create required directories
RUN mkdir -p /etc/dovecot /etc/dovecot/certs /var/mail/vhosts /var/run/dovecot

# Copy configuration
COPY dovecot.conf /etc/dovecot/dovecot.conf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY mail-state.sh /usr/local/bin/mail-state.sh
COPY users-security.sh /usr/local/bin/users-security.sh

RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && \
    sed -i 's/\r$//' /usr/local/bin/mail-state.sh && \
    sed -i 's/\r$//' /usr/local/bin/users-security.sh && \
    chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/mail-state.sh /usr/local/bin/users-security.sh

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 CMD /usr/local/bin/mail-state.sh health

# Expose IMAP (143), IMAPS (993), LMTP (24), and the internal SASL auth port (12345)
EXPOSE 143 993 24 12345

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
